// Exit Guard: bir cüzdanın ELİNDEKİ her token için "şu an gerçek miktarımla satabilir miyim, ne kadar alırım?"
// sorusunu düzenli olarak ölçer; satış engellenince, satış vergisi yükselince, çıkış değeri çökünce ya da LP
// koruması düşünce webhook'a haber verir. Ölçüm, CikisSim bayt kodunu eth_call içinde state override ile
// CÜZDANIN KENDİ ADRESİNE koyarak yapılır: satış, tokeni gerçekten tutan adresten simüle edilir (kara liste,
// cüzdana özel vergi ve alımdan sonra yükseltilen vergiler dahil). Zincire hiçbir şey gönderilmez.
import { encodeFunctionData, decodeFunctionResult, getAddress, parseAbi, parseAbiItem, formatEther, formatUnits } from "viem";
import { EXIT_CODE, EXIT_ABI } from "./exit-bytecode.js";
import { lpKilitAnalizi, agHatasi } from "./lplock.js";
import { anlik, olaylar as lpOlaylari, webhookGecerli } from "./watch.js";

export const GUARD_GUN = 30;
export const MAX_TOKEN = 20;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const CHAINLINK = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const LP_OLAYLARI = new Set(["PROTECTION_DROP", "UNLOCK_SOON", "UNLOCKED"]);
export const OLAY_TURLERI = ["SELL_BLOCKED", "SELL_TAX_UP", "EXIT_VALUE_DROP", "PROTECTION_DROP", "UNLOCK_SOON", "UNLOCKED"];

const yuzde = (pay, payda) => (payda > 0n ? Math.max(0, Math.round(Number(10000n - (pay * 10000n) / payda)) / 100) : null);
const yuvarla = (x, n = 6) => (x === null || x === undefined ? null : Math.round(x * 10 ** n) / 10 ** n);

/** Cüzdana token gelen Transfer olaylarından token adreslerini bulur (en iyi çaba; RPC aralık sınırı hataları yutulur). */
export async function tokenKesfet(okur, cuzdan, { bitis, blokSayisi = 20000, parca = 5000 } = {}) {
  const son = bitis ?? (await okur.getBlockNumber({ cacheTime: 0 }));
  const bulunan = new Set();
  for (let ust = son; ust > son - BigInt(blokSayisi) && ust > 0n; ust -= BigInt(parca)) {
    const alt = ust - BigInt(parca) + 1n > 0n ? ust - BigInt(parca) + 1n : 0n;
    try {
      const l = await okur.getLogs({ event: TRANSFER, args: { to: cuzdan }, fromBlock: alt, toBlock: ust });
      for (const x of l) bulunan.add(getAddress(x.address));
    } catch { /* aralık çok büyük ya da RPC sınırı: atla */ }
  }
  return { tokens: [...bulunan], sonBlok: son };
}

export async function ethUsd(okur, ay) {
  try { const r = await okur.readContract({ address: ay.ethUsd, abi: CHAINLINK, functionName: "latestRoundData" }); return Number(r[1]) / 1e8; } catch { return null; }
}

/** Tek pozisyonun çıkış ölçümü. */
export async function pozisyonOlc(okur, ay, cuzdan, token, simdi, eth = null) {
  token = getAddress(token); cuzdan = getAddress(cuzdan);
  const lp = await lpKilitAnalizi(okur, ay, token, simdi);
  const temel = { token, symbol: lp.token.symbol, rugRisk: lp.rugRisk, protectedPct: lp.protectedPctWeightedByLiquidity ?? null, lp: anlik(lp, simdi) };
  const havuz = (lp.v2Pools || []).filter((p) => p.quote === "WETH" && p.dex !== "aerodrome-stable").sort((a, b) => Number(b.reserves.WETH) - Number(a.reserves.WETH))[0];
  if (!havuz) return { ...temel, measurable: false, reason: "no V2-style WETH pool (V3-only or USDC-only liquidity)" };
  const data = encodeFunctionData({ abi: EXIT_ABI, functionName: "cik", args: [havuz.pair, token, getAddress(ay.weth), havuz.dex.startsWith("aerodrome"), 0n] });
  let s;
  try {
    const r = await okur.call({ to: cuzdan, data, gas: 6_000_000n, stateOverride: [{ address: cuzdan, code: EXIT_CODE }] });
    s = decodeFunctionResult({ abi: EXIT_ABI, functionName: "cik", data: r.data });
  } catch (e) {
    if (agHatasi(e)) throw e;
    return { ...temel, measurable: true, held: true, pool: havuz.pair, dex: havuz.dex, sellable: false, error: "exit simulation reverted: " + String(e.shortMessage || e.message).split("\n")[0].slice(0, 160) };
  }
  if (s.hata === "no balance") return { ...temel, measurable: true, held: false };
  const ondalik = lp.token.decimals ?? 18;
  const exitEth = Number(formatEther(s.gelenWeth));
  const spotEth = Number(formatEther(s.spotWeth));
  return {
    ...temel, measurable: true, held: true, pool: havuz.pair, dex: havuz.dex,
    balance: formatUnits(s.bakiye, ondalik),
    sellable: s.ok,
    sellTaxPct: s.gonderilen > 0n && s.havuzaUlasan > 0n ? yuzde(s.havuzaUlasan, s.gonderilen) : null,
    priceImpactPct: s.spotWeth > 0n ? yuzde(s.beklenenWeth, s.spotWeth) : null,
    exitLossPct: s.ok && s.spotWeth > 0n ? yuzde(s.gelenWeth, s.spotWeth) : null,
    exitValueEth: s.ok ? yuvarla(exitEth, 8) : 0,
    spotValueEth: yuvarla(spotEth, 8),
    exitValueUsd: s.ok && eth ? yuvarla(exitEth * eth, 2) : s.ok ? null : 0,
    error: s.hata || null,
  };
}

/** Birden fazla token, sınırlı eşzamanlılıkla (okumalar multicall'da birleşir). */
export async function cuzdanOlc(okur, ay, cuzdan, tokenler, simdi, { es = 5 } = {}) {
  const eth = await ethUsd(okur, ay);
  const sonuc = new Array(tokenler.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(es, tokenler.length) }, async () => {
    while (i < tokenler.length) {
      const k = i++;
      try { sonuc[k] = await pozisyonOlc(okur, ay, cuzdan, tokenler[k], simdi, eth); }
      catch (e) { sonuc[k] = { token: tokenler[k], measurable: null, error: e.kullanici ? e.message : agHatasi(e) ? "chain read failed (retry later)" : String(e.shortMessage || e.message).slice(0, 120), gecici: agHatasi(e) }; }
    }
  }));
  return { ethUsd: eth, positions: sonuc };
}

/** Bir ölçümün karşılaştırılabilir kısa hali. */
export function ozet(p) {
  if (!p || p.gecici) return null;
  if (!p.measurable || !p.held) return { sym: p.symbol, held: !!p.held, m: !!p.measurable, lp: p.lp || null };
  return { sym: p.symbol, held: true, m: true, bal: p.balance, ok: p.sellable, tax: p.sellTaxPct, eth: p.exitValueEth, lp: p.lp };
}

/** Önceki ve şimdiki özetten olaylar. */
export function pozisyonOlaylari(token, once, simdi, gonderildi = {}) {
  const ol = [];
  let g = { ...gonderildi };
  if (!simdi || !simdi.held || !simdi.m) return { olaylar: ol, gonderildi: g };
  const ayni = once && once.held && once.m && once.bal && simdi.bal && Math.abs(Number(simdi.bal) - Number(once.bal)) <= Math.max(Number(once.bal) * 0.01, 1e-12);
  if (simdi.ok === false && (!once || once.ok !== false)) ol.push({ token, type: "SELL_BLOCKED", detail: `${simdi.sym || token}: selling your balance now fails in simulation from your own wallet.` });
  const vergiArtti = once && once.ok && simdi.ok && simdi.tax !== null && once.tax !== null && simdi.tax >= once.tax + 5 && simdi.tax >= 10;
  if (vergiArtti) ol.push({ token, type: "SELL_TAX_UP", detail: `${simdi.sym || token}: sell tax for your wallet rose from ${once.tax}% to ${simdi.tax}%.` });
  if (!vergiArtti && ayni && once.ok && simdi.ok && once.eth > 0.0002 && simdi.eth <= once.eth * 0.7) ol.push({ token, type: "EXIT_VALUE_DROP", detail: `${simdi.sym || token}: what you would receive for your full balance fell from ${once.eth} ETH to ${simdi.eth} ETH (${Math.round((1 - simdi.eth / once.eth) * 100)}%).` });
  if (simdi.lp) {
    // LP olayları için tokene özel anahtarlarla tekrarları önle.
    const alt = Object.fromEntries(Object.entries(g).filter(([k]) => k.startsWith(token + "|")).map(([k, v]) => [k.slice(token.length + 1), v]));
    const r = lpOlaylari(once?.lp || null, simdi.lp, alt);
    for (const o of r.olaylar) if (LP_OLAYLARI.has(o.type)) ol.push({ token, type: o.type, detail: `${simdi.sym || token}: ${o.detail}` });
    for (const [k, v] of Object.entries(r.gonderildi)) g[token + "|" + k] = v;
  }
  return { olaylar: ol, gonderildi: g };
}

const rastgeleKimlik = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function tokenListesi(girdi) {
  const l = Array.isArray(girdi) ? girdi : String(girdi || "").split(",");
  const out = [];
  for (const t of l.map((x) => String(x).trim()).filter(Boolean)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) { const e = new Error("tokens must be 0x-prefixed 20-byte addresses"); e.kullanici = true; throw e; }
    const a = getAddress(t); if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Yeni bekçi kaydı. */
export async function bekciEkle(kv, { cuzdan, webhook, tokenler, sonBlok, olcum, odeyen, odemeTx, erisim }, simdi) {
  const id = rastgeleKimlik();
  const son = {}; let gonderildi = {}; const ilk = [];
  for (const p of olcum.positions) {
    const o = ozet(p); if (!o) continue; son[p.token] = o;
    const r = pozisyonOlaylari(p.token, null, o, gonderildi); gonderildi = r.gonderildi; ilk.push(...r.olaylar);
  }
  const g = { id, cuzdan: getAddress(cuzdan), webhook, tokenler, sonBlok: String(sonBlok), olusturma: simdi, bitis: simdi + GUARD_GUN * 86400, son, gonderildi, olaySayisi: 0, odeyen: odeyen || null, odemeTx: odemeTx || null, erisim: erisim || "usdc", t: simdi, yazildi: simdi };
  await kv.put("g:" + id, JSON.stringify(g), { expiration: g.bitis + 86400 });
  return { bekci: g, ilkOlaylar: ilk };
}

export async function bekciOku(kv, id) {
  if (!/^[0-9a-f]{24}$/.test(id || "")) return null;
  const s = await kv.get("g:" + id);
  return s ? JSON.parse(s) : null;
}

async function tumBekciler(kv) {
  const out = []; let cursor;
  do {
    const r = await kv.list({ prefix: "g:", cursor });
    for (const k of r.keys) { const s = await kv.get(k.name); if (s) out.push(JSON.parse(s)); }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out;
}

/**
 * Tüm bekçileri tarar. olc(cuzdan, tokenler) → { positions }, kesfet(cuzdan, {bitis, blokSayisi}) → { tokens, sonBlok },
 * bildir(bekci, olaylar, olcum) → teslim. Değişiklik iki bağımsız okumada da görülmezse bildirilmez.
 */
export async function bekcileriTara(kv, { olc, kesfet, bildir, sonBlok }, simdi, { sinir = 10 } = {}) {
  const liste = (await tumBekciler(kv)).sort((a, b) => (a.t || 0) - (b.t || 0)).slice(0, sinir);
  const sonuc = { tarandi: 0, olay: 0, hata: 0, bitti: 0, dogrulanmadi: 0 };
  for (const g of liste) {
    if (simdi >= g.bitis) { await kv.delete("g:" + g.id); sonuc.bitti++; continue; }
    try {
      // Yeni gelen tokenler
      let listeDegisti = false;
      if (sonBlok && g.sonBlok) {
        const fark = Number(sonBlok - BigInt(g.sonBlok));
        if (fark > 0) {
          const k = await kesfet(g.cuzdan, { bitis: sonBlok, blokSayisi: Math.min(fark, 10000) });
          for (const t of k.tokens) if (!g.tokenler.includes(t) && g.tokenler.length < MAX_TOKEN) { g.tokenler.push(t); listeDegisti = true; }
          g.sonBlok = String(sonBlok);
        }
      }
      const olcum = await olc(g.cuzdan, g.tokenler);
      let ol = []; let gonderildi = g.gonderildi || {}; const yeniSon = { ...g.son };
      for (const p of olcum.positions) {
        const o = ozet(p); if (!o) continue;
        const r = pozisyonOlaylari(p.token, g.son[p.token] || null, o, gonderildi);
        ol.push(...r.olaylar); gonderildi = r.gonderildi; yeniSon[p.token] = o;
      }
      if (ol.length) {
        // Doğrulama: olay görülen tokenleri bir kez daha bağımsız ölç.
        const tl = [...new Set(ol.map((o) => o.token))];
        let ikinci;
        try { ikinci = await olc(g.cuzdan, tl); } catch { sonuc.hata++; continue; }
        const ortak = [];
        for (const p of ikinci.positions) {
          const o = ozet(p); if (!o) continue;
          const r = pozisyonOlaylari(p.token, g.son[p.token] || null, o, g.gonderildi || {});
          for (const x of r.olaylar) if (ol.some((y) => y.token === x.token && y.type === x.type)) ortak.push(x);
        }
        if (!ortak.length) { sonuc.dogrulanmadi++; ol = []; gonderildi = g.gonderildi || {}; for (const t of tl) yeniSon[t] = g.son[t]; }
        else ol = ortak;
      }
      if (ol.length) { try { await bildir(g, ol, olcum); } catch {} }
      const degisti = listeDegisti || ol.length > 0 || JSON.stringify(Object.fromEntries(Object.entries(yeniSon).map(([k, v]) => [k, v && { ...v, eth: undefined, lp: v.lp && { ...v.lp, t: 0 } }]))) !== JSON.stringify(Object.fromEntries(Object.entries(g.son).map(([k, v]) => [k, v && { ...v, eth: undefined, lp: v.lp && { ...v.lp, t: 0 } }])));
      g.son = yeniSon; g.gonderildi = gonderildi; g.olaySayisi += ol.length; g.t = simdi;
      // KV yazma kotası: yalnızca değişince ya da 6 saatte bir.
      if (degisti || simdi - (g.yazildi || 0) > 21600) { g.yazildi = simdi; await kv.put("g:" + g.id, JSON.stringify(g), { expiration: g.bitis + 86400 }); }
      sonuc.tarandi++; sonuc.olay += ol.length;
    } catch { sonuc.hata++; }
  }
  return sonuc;
}

export function olayGovdesi(g, ol, olcum) {
  return {
    guardId: g.id,
    wallet: g.cuzdan,
    events: ol.map((o) => ({ type: o.type, token: o.token, detail: o.detail })),
    positions: (olcum.positions || []).filter((p) => p && p.held && ol.some((o) => o.token === p.token)).map((p) => ({ token: p.token, symbol: p.symbol, sellable: p.sellable, sellTaxPct: p.sellTaxPct, exitValueEth: p.exitValueEth, exitValueUsd: p.exitValueUsd, rugRisk: p.rugRisk })),
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(g.bitis * 1000).toISOString(),
  };
}

export { webhookGecerli };
