// Likidite kilidi analizi: bir Base token'ının V2 tarzı havuzlarında LP paylarının ne kadarı yakılmış, ne kadarı
// bilinen kilit kontratlarında, ne kadarı çekilebilir durumda? V3 havuzları listelenir (kilit durumu NFT bazlı, ölçülmez).
import { parseAbi, getAddress, formatUnits, zeroAddress } from "viem";

const ERC20 = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)",
  "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const V2_FAB = parseAbi(["function getPair(address,address) view returns (address)"]);
const AERO_FAB = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const AERO_VOTER = parseAbi(["function gauges(address) view returns (address)"]);
const PAIR = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)", "function totalSupply() view returns (uint256)"]);
const V3_FAB = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const UNCX = parseAbi([
  "function getNumLocksForToken(address) view returns (uint256)",
  "function tokenLocks(address,uint256) view returns (uint256 lockDate, uint256 amount, uint256 initialAmount, uint256 unlockDate, uint256 lockID, address owner)",
]);
const BIZIM_KILIT = parseAbi(["function aktifMiktar(address,uint256,uint256) view returns (uint256,uint256)"]);
const CHAINLINK = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);

const YAKMA = ["0x000000000000000000000000000000000000dEaD", zeroAddress];

/** Base ana ağı adresleri. */
export const BASE_LP = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  v2: [
    { dex: "uniswap-v2", factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6" },
    { dex: "agichainai", factory: "0xCD7B0C7EA761565CA5A2444bf1cCcd29A126F824" },
  ],
  aerodrome: { factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" },
  v3: { factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", fees: [100, 500, 3000, 10000] },
  lockers: [
    { name: "UNCX (Uniswap V2)", address: "0xc4E637D37113192F4F1F060DaEbD7758De7F4131", type: "uncx" },
    { name: "UNCX (Sushiswap)", address: "0xBeddF48499788607B4c2e704e9099561ab38Aae8", type: "uncx" },
    { name: "UNCX (Aerodrome)", address: "0x30e522deDfFE3e3d11Cd53E27d18Cd4F016eD870", type: "uncx" },
    { name: "Team Finance", address: "0x4f0fd563be89ec8c3e7d595bf3639128c0a7c33a", type: "plain" },
    { name: "AGIChainAI lock", address: "0x3F6b4d102aFb926cb19Db347D8fE6E6a79eC0E7D", type: "agichainai" },
  ],
};

/** Ağ / RPC kaynaklı hata mı (geçici), yoksa sözleşmenin kendi cevabı mı? */
export function agHatasi(e) {
  for (let x = e, i = 0; x && i < 8; x = x.cause, i++) {
    if (/HttpRequestError|TimeoutError|RpcRequestError|LimitExceededRpcError|InternalRpcError|ResourceUnavailableRpcError|WebSocketRequestError/.test(x.name || "")) return true;
    if (/HTTP request failed|timed out|timeout|rate.?limit|429|limit exceeded|request limit|too many requests|fetch failed|network error|ECONNRESET|socket hang up/i.test(String(x.shortMessage || x.message || ""))) return true;
  }
  return false;
}

const yuzde = (pay, payda) => (payda === 0n ? 0 : Number((pay * 1_000_000n) / payda) / 10_000);

/**
 * @param okur viem public client
 * @param ay BASE_LP biçiminde adresler
 * @param token incelenecek token
 * @param simdi saniye cinsinden zaman (test için)
 */
export async function lpKilitAnalizi(okur, ay, token, simdi) {
  token = getAddress(token);
  // "Şimdi" zincirin son bloğunun zamanıdır: kilidin açılıp açılmadığına sözleşme de böyle karar verir.
  if (simdi === undefined) simdi = Number((await okur.getBlock()).timestamp);
  const kod = await okur.getCode({ address: token });
  if (!kod || kod === "0x") { const e = new Error("not a contract on Base"); e.kullanici = true; throw e; }
  const oku = (address, abi, functionName, args = []) => okur.readContract({ address, abi, functionName, args });
  // Sözleşme "yok/geri çevirdi" derse varsayılan değer; ağ/RPC hatasında ise hata yükselir:
  // okunamayan veri asla "kilit yok" ya da "havuz yok" sayılmaz (izleme yanlış alarm vermesin).
  const guvenli = (p, varsay = null) => p.catch((e) => { if (agHatasi(e)) throw e; return varsay; });

  const [ad, sembol, ondalik, arz] = await Promise.all([
    guvenli(oku(token, ERC20, "name")), guvenli(oku(token, ERC20, "symbol")),
    guvenli(oku(token, ERC20, "decimals")), guvenli(oku(token, ERC20, "totalSupply")),
  ]);
  if (ondalik === null || arz === null) { const e = new Error("not an ERC-20 token"); e.kullanici = true; throw e; }

  const quotes = [{ sym: "WETH", address: getAddress(ay.weth), dec: 18 }, { sym: "USDC", address: getAddress(ay.usdc), dec: 6 }]
    .filter((q) => q.address !== token);
  let ethUsd = null;
  try { const r = await oku(ay.ethUsd, CHAINLINK, "latestRoundData"); ethUsd = Number(r[1]) / 1e8; } catch (e) { if (agHatasi(e)) throw e; }
  const usd = (q, ham) => (q.sym === "USDC" ? Number(formatUnits(ham, 6)) : ethUsd ? Number(formatUnits(ham, 18)) * ethUsd : null);

  // 1) V2 tarzı havuzları bul
  const adaylar = [];
  for (const q of quotes) {
    // Fabrika sorguları asla geri çevrilmez (yoksa sıfır adres döner): HER hata RPC kaynaklıdır ve yükselir.
    // Aksi halde boş dönen bir RPC cevabı "havuz yok" sanılır ve izlemede sahte VERDICT_CHANGE üretir.
    for (const f of ay.v2) adaylar.push({ dex: f.dex, q, p: oku(f.factory, V2_FAB, "getPair", [token, q.address]) });
    if (ay.aerodrome) for (const st of [false, true]) adaylar.push({ dex: st ? "aerodrome-stable" : "aerodrome-volatile", q, p: oku(ay.aerodrome.factory, AERO_FAB, "getPool", [token, q.address, st]), aero: true });
  }
  const havuzlar = (await Promise.all(adaylar.map(async (a) => { const adr = await a.p; return adr && adr !== zeroAddress ? { dex: a.dex, q: a.q, pair: getAddress(adr), aero: a.aero } : null; }))).filter(Boolean);

  // 2) Her havuz için LP dağılımı
  const sonuc = await Promise.all(havuzlar.map(async (h) => {
    const [rez, t0, lpArz] = await Promise.all([oku(h.pair, PAIR, "getReserves"), oku(h.pair, PAIR, "token0"), oku(h.pair, PAIR, "totalSupply")]);
    const tokenIlk = getAddress(t0) === token;
    const rToken = tokenIlk ? rez[0] : rez[1], rQuote = tokenIlk ? rez[1] : rez[0];
    const qUsd = usd(h.q, rQuote);
    const yakilan = (await Promise.all(YAKMA.map((a) => oku(h.pair, ERC20, "balanceOf", [a])))).reduce((s, x) => s + x, 0n);
    const bakiyeler = await Promise.all(ay.lockers.map((L) => guvenli(oku(h.pair, ERC20, "balanceOf", [L.address]), 0n)));
    const kilitler = [];
    for (const [i, L] of ay.lockers.entries()) {
      const bak = bakiyeler[i];
      if (bak === 0n) continue;
      const k = { name: L.name, locker: L.address, pct: yuzde(bak, lpArz) };
      if (L.type === "uncx") {
        try {
          const n = await oku(L.address, UNCX, "getNumLocksForToken", [h.pair]);
          let enYakin = null, enUzak = null;
          for (let i = 0n; i < n && i < 20n; i++) {
            const t = await oku(L.address, UNCX, "tokenLocks", [h.pair, i]);
            if (t[1] === 0n) continue;
            const u = Number(t[3]);
            enYakin = enYakin === null ? u : Math.min(enYakin, u); enUzak = enUzak === null ? u : Math.max(enUzak, u);
          }
          if (enYakin !== null) { k.earliestUnlock = new Date(enYakin * 1000).toISOString(); k.latestUnlock = new Date(enUzak * 1000).toISOString(); k.expired = enYakin <= simdi; }
        } catch (e) { if (agHatasi(e)) throw e; }
      } else if (L.type === "agichainai") {
        try { const [aktif] = await oku(L.address, BIZIM_KILIT, "aktifMiktar", [h.pair, 0n, 200n]); k.activePct = yuzde(aktif, lpArz); } catch (e) { if (agHatasi(e)) throw e; }
      }
      kilitler.push(k);
    }
    let gauge = null;
    if (h.aero && ay.aerodrome.voter) {
      try {
        const g = await oku(ay.aerodrome.voter, AERO_VOTER, "gauges", [h.pair]);
        if (g && g !== zeroAddress) { const b = await oku(h.pair, ERC20, "balanceOf", [g]); if (b > 0n) gauge = { address: g, pct: yuzde(b, lpArz) }; }
      } catch {}
    }
    const burnedPct = yuzde(yakilan, lpArz);
    // Süresi dolmuş UNCX kilidi ve bizim kilitteki süresi dolmuş kısım "kilitli" sayılmaz.
    const lockedPct = kilitler.reduce((s, k) => s + (k.expired ? 0 : k.activePct !== undefined ? k.activePct : k.pct), 0);
    const korunan = Math.min(100, burnedPct + lockedPct);
    return ({
      dex: h.dex, pair: h.pair, quote: h.q.sym,
      reserves: { token: formatUnits(rToken, ondalik), [h.q.sym]: formatUnits(rQuote, h.q.dec) },
      liquidityUsd: qUsd === null ? null : Math.round(qUsd * 2 * 100) / 100,
      lp: {
        burnedPct, lockedPct: Math.round(lockedPct * 10_000) / 10_000, lockers: kilitler,
        ...(gauge ? { stakedInGaugePct: gauge.pct, stakedNote: "staked in the Aerodrome gauge: earns rewards but can be withdrawn at any time (not locked)" } : {}),
        removablePct: Math.round((100 - korunan) * 10_000) / 10_000,
      },
    });
  }));

  // 3) V3 havuzları (yalnız varlık ve likidite büyüklüğü)
  const v3 = [];
  if (ay.v3) {
    const isler = [];
    for (const q of quotes) for (const fee of ay.v3.fees) isler.push((async () => {
      const p = await oku(ay.v3.factory, V3_FAB, "getPool", [token, q.address, fee]);
      if (!p || p === zeroAddress) return;
      const [qBak, tBak] = await Promise.all([oku(q.address, ERC20, "balanceOf", [p]).catch(() => 0n), oku(token, ERC20, "balanceOf", [p]).catch(() => 0n)]);
      v3.push({ dex: "uniswap-v3", pool: getAddress(p), fee, quote: q.sym, reserves: { token: formatUnits(tBak, ondalik), [q.sym]: formatUnits(qBak, q.dec) }, liquidityUsd: (() => { const u = usd(q, qBak); return u === null ? null : Math.round(u * 2 * 100) / 100; })() });
    })());
    await Promise.all(isler);
  }

  // 4) Hüküm: likiditesi en büyük V2 havuzuna ve likiditeye göre ağırlıklı ortalamaya göre
  const agirlikli = (() => {
    const L = sonuc.filter((s) => s.liquidityUsd);
    const top = L.reduce((t, s) => t + s.liquidityUsd, 0);
    if (!top) return null;
    return Math.round(L.reduce((t, s) => t + (100 - s.lp.removablePct) * s.liquidityUsd, 0) / top * 100) / 100;
  })();
  const v2Usd = sonuc.reduce((t, s) => t + (s.liquidityUsd || 0), 0), v3Usd = v3.reduce((t, s) => t + (s.liquidityUsd || 0), 0);
  let verdict;
  const gaugeOrani = (() => { const L = sonuc.filter((x) => x.liquidityUsd); const t = L.reduce((q, x) => q + x.liquidityUsd, 0); return t ? L.reduce((q, x) => q + (x.lp.stakedInGaugePct || 0) * x.liquidityUsd, 0) / t : 0; })();
  if (!sonuc.length && !v3.length) verdict = "NO_POOL";
  else if (v3Usd > v2Usd) verdict = "MAIN_LIQUIDITY_IN_V3";
  else {
    const p = agirlikli ?? (100 - sonuc[0].lp.removablePct);
    verdict = p >= 95 ? "LOCKED_OR_BURNED" : p >= 80 ? "MOSTLY_LOCKED" : p >= 20 ? "PARTIAL" : "NOT_LOCKED";
  }
  // Kilitsiz likidite her zaman dolandırıcılık riski değildir: büyük ve teşvik havuzuna yatırılmış likidite genelde çok sayıda bağımsız sağlayıcıya aittir.
  let rugRisk;
  if (verdict === "NO_POOL") rugRisk = "NO_LIQUIDITY";
  else if (verdict === "LOCKED_OR_BURNED") rugRisk = "LOW";
  else if (verdict === "MAIN_LIQUIDITY_IN_V3") rugRisk = "NOT_ASSESSED";
  else if (v2Usd >= 250_000 || gaugeOrani >= 50) rugRisk = verdict === "MOSTLY_LOCKED" ? "LOW" : "MEDIUM";
  else rugRisk = verdict === "MOSTLY_LOCKED" ? "MEDIUM" : "HIGH";
  const yorum = {
    NO_POOL: "No pool against WETH or USDC was found on Uniswap V2/V3, Aerodrome or AGIChainAI.",
    MAIN_LIQUIDITY_IN_V3: "Most liquidity sits in Uniswap V3 positions (NFTs); their lock status is not assessed by this check. V2-style pool details are still listed.",
    LOCKED_OR_BURNED: "At least 95% of the V2-style LP (liquidity-weighted) is burned or in a known locker: it cannot be pulled before the unlock dates shown.",
    MOSTLY_LOCKED: "80-95% of the V2-style LP is burned or locked; the rest can be withdrawn by its holders.",
    PARTIAL: "Only part of the V2-style LP is burned or locked; a large share can be withdrawn by its holders.",
    NOT_LOCKED: "The V2-style LP is not burned or locked. That is normal for large tokens whose liquidity comes from many independent providers (e.g. staked in Aerodrome gauges), but for a new or small token it means whoever holds the LP can pull the liquidity.",
  }[verdict];
  const notlar = [];
  if (v3.length) notlar.push(`Uniswap V3 pools hold about $${Math.round(v3Usd)} of liquidity; V3 positions are NFTs and their lock status is not assessed here.`);
  if (sonuc.some((x) => x.lp.lockers.some((k) => k.expired))) notlar.push("At least one UNCX lock has expired: those LP tokens can be withdrawn by the lock owner.");
  if (rugRisk === "HIGH") notlar.push("Small, unlocked liquidity: if the LP is held by the team or a single wallet, it can be pulled at any time.");

  return {
    token: { address: token, name: ad, symbol: sembol, decimals: Number(ondalik), totalSupply: formatUnits(arz, ondalik) },
    verdict,
    rugRisk,
    interpretation: yorum,
    protectedPctWeightedByLiquidity: agirlikli,
    stakedInGaugePctWeightedByLiquidity: Math.round(gaugeOrani * 100) / 100,
    v2Pools: sonuc.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)),
    v3Pools: v3.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)),
    liquidityUsd: { v2Style: Math.round(v2Usd * 100) / 100, v3: Math.round(v3Usd * 100) / 100 },
    knownLockersChecked: ay.lockers.map((l) => l.name),
    notes: notlar,
    method: "On-chain reads on Base at the time of the call: LP balances of burn addresses (0x…dEaD, 0x0) and known locker contracts divided by LP total supply. Prices from the pools and Chainlink ETH/USD.",
    checkedAt: new Date(simdi * 1000).toISOString(),
  };
}
