// AGI geçişi: bir cüzdan belirli miktarda AGI'yi yakma adresine gönderir (zincirde kalıcı yakım),
// POST /pass/activate ile işlemini bildirir ve 30 gün boyunca ücretli uç noktaları günlük limit
// dahilinde ücretsiz kullanır. Süre dolunca yeniden yakmak gerekir: hiçbir erişim süresiz değildir.
// İsteklerde cüzdan, imzalı bir başlıkla kendini kanıtlar (imza zincire gitmez, para hareketi yok).
//
// Başlık:  AGI-HOLDER: base64(JSON { address, issuedAt, signature })
// İmzalanan mesaj (EIP-191 personal_sign):
//   "AGIChainAI holder access\nAddress: <address>\nIssued: <issuedAt>"
// issuedAt: ISO zaman; en fazla 15 dakika eski olabilir.
import { getAddress, parseAbi } from "viem";

export const HOLDER_MESAJ = (adres, zaman) => `AGIChainAI holder access\nAddress: ${getAddress(adres)}\nIssued: ${zaman}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const YAKMA = ["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"];
export const GECIS_GUN = 30;

// Yakım işlemini doğrular ve geçişi etkinleştirir (ya da uzatır).
export async function gecisEtkinlestir({ okur, kv, agi, minimum, tx, simdiMs = Date.now() }) {
  const hata = (m) => { const e = new Error(m); e.kullanici = true; return e; };
  if (!kv) throw new Error("pass storage not configured");
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx || "")) throw hata("tx must be a 0x-prefixed transaction hash");
  if (await kv.get("pt:" + tx.toLowerCase())) throw hata("this burn transaction was already used for a pass");
  let rc;
  try { rc = await okur.getTransactionReceipt({ hash: tx }); } catch { throw hata("transaction not found on Base (wait for confirmation and retry)"); }
  if (rc.status !== "success") throw hata("transaction failed");
  const blok = await okur.getBlock({ blockNumber: rc.blockNumber });
  if (simdiMs / 1000 - Number(blok.timestamp) > 2 * 86400) throw hata("burn transaction is older than 48 hours");
  let kimden = null, toplam = 0n;
  for (const l of rc.logs) {
    if (l.address.toLowerCase() !== agi.toLowerCase() || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    const to = "0x" + l.topics[2].slice(26);
    if (!YAKMA.includes(to.toLowerCase())) continue;
    const from = getAddress("0x" + l.topics[1].slice(26));
    if (kimden && from !== kimden) continue;
    kimden = from; toplam += BigInt(l.data);
  }
  if (!kimden) throw hata("no AGI burn (transfer to 0x…dEaD) found in this transaction");
  if (toplam < minimum) throw hata(`burned ${toplam / 10n ** 18n} AGI; a pass needs at least ${minimum / 10n ** 18n} AGI`);
  const anahtar = "pass:" + kimden.toLowerCase();
  const mevcut = Number((await kv.get(anahtar)) || 0);
  const kat = toplam / minimum; // 2 kat yakım = 60 gün, en fazla 12 kat
  const sure = Number(kat > 12n ? 12n : kat) * GECIS_GUN * 86400 * 1000;
  const bitis = Math.max(mevcut, simdiMs) + sure;
  await kv.put(anahtar, String(bitis), { expiration: Math.floor(bitis / 1000) + 86400 });
  await kv.put("pt:" + tx.toLowerCase(), kimden, { expirationTtl: 400 * 86400 });
  return { address: kimden, burnedAgi: (toplam / 10n ** 18n).toString(), expiresAt: new Date(bitis).toISOString() };
}

export async function gecisDurumu(kv, adres, simdiMs = Date.now()) {
  const bitis = kv ? Number((await kv.get("pass:" + getAddress(adres).toLowerCase())) || 0) : 0;
  return { address: getAddress(adres), active: bitis > simdiMs, expiresAt: bitis ? new Date(bitis).toISOString() : null };
}

export function holderBaslikCoz(deger) {
  try {
    const j = JSON.parse(atob(String(deger).trim()));
    if (!/^0x[0-9a-fA-F]{40}$/.test(j.address) || !j.issuedAt || !/^0x[0-9a-fA-F]+$/.test(j.signature)) return null;
    return j;
  } catch { return null; }
}

/**
 * @returns {{ ok: true, address, passExpiresAt, remaining } | { ok: false, reason }}
 */
export async function holderDogrula({ okur, kv, agi, minimum, gunluk, baslik, simdiMs = Date.now(), onek = "h" }) {
  const j = holderBaslikCoz(baslik);
  if (!j) return { ok: false, reason: "malformed AGI-HOLDER header" };
  const t = Date.parse(j.issuedAt);
  if (!Number.isFinite(t) || Math.abs(simdiMs - t) > 15 * 60 * 1000) return { ok: false, reason: "AGI-HOLDER signature expired (issuedAt must be within 15 minutes)" };
  let gecerli = false;
  try { gecerli = await okur.verifyMessage({ address: j.address, message: HOLDER_MESAJ(j.address, j.issuedAt), signature: j.signature }); } catch {}
  if (!gecerli) return { ok: false, reason: "AGI-HOLDER signature does not match the address" };
  const adres = getAddress(j.address);
  const g = await gecisDurumu(kv, adres, simdiMs);
  if (!g.active) return { ok: false, reason: `no active AGI pass for ${adres}${g.expiresAt ? " (expired " + g.expiresAt + ")" : ""}: burn ${minimum / 10n ** 18n} AGI to 0x000000000000000000000000000000000000dEaD and POST the tx hash to /pass/activate for ${GECIS_GUN} days of access` };
  let kalan = gunluk;
  if (kv) {
    const gun = new Date(simdiMs).toISOString().slice(0, 10);
    const anahtar = `${onek}:${adres.toLowerCase()}:${gun}`;
    const kullanilan = Number((await kv.get(anahtar)) || 0);
    if (kullanilan >= gunluk) return { ok: false, reason: `holder daily limit of ${gunluk} checks reached; resets at 00:00 UTC` };
    await kv.put(anahtar, String(kullanilan + 1), { expirationTtl: 2 * 86400 });
    kalan = gunluk - kullanilan - 1;
  }
  return { ok: true, address: adres, passExpiresAt: g.expiresAt, remaining: kalan };
}

// Ücretsiz önizleme için IP başına günlük sayaç.
export async function ipSiniri(kv, ip, sinir, simdiMs = Date.now()) {
  if (!kv || !ip) return { ok: true, remaining: sinir };
  const anahtar = `l:${ip}:${new Date(simdiMs).toISOString().slice(0, 10)}`;
  const n = Number((await kv.get(anahtar)) || 0);
  if (n >= sinir) return { ok: false, remaining: 0 };
  await kv.put(anahtar, String(n + 1), { expirationTtl: 2 * 86400 });
  return { ok: true, remaining: sinir - n - 1 };
}
