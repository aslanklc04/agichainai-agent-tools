// AGI sahibi erişimi: cüzdanında yeterli AGI tutan ajanlar, imzalı bir başlıkla ücretli kontrolleri
// günlük limit dahilinde ücretsiz kullanır. Para hareketi yok; imza zincire gitmez.
//
// Başlık:  AGI-HOLDER: base64(JSON { address, issuedAt, signature })
// İmzalanan mesaj (EIP-191 personal_sign):
//   "AGIChainAI holder access\nAddress: <address>\nIssued: <issuedAt>"
// issuedAt: ISO zaman; en fazla 15 dakika eski olabilir.
import { getAddress, parseAbi } from "viem";

export const HOLDER_MESAJ = (adres, zaman) => `AGIChainAI holder access\nAddress: ${getAddress(adres)}\nIssued: ${zaman}`;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export function holderBaslikCoz(deger) {
  try {
    const j = JSON.parse(atob(String(deger).trim()));
    if (!/^0x[0-9a-fA-F]{40}$/.test(j.address) || !j.issuedAt || !/^0x[0-9a-fA-F]+$/.test(j.signature)) return null;
    return j;
  } catch { return null; }
}

/**
 * @returns {{ ok: true, address, balance, remaining } | { ok: false, reason }}
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
  const bakiye = await okur.readContract({ address: agi, abi: ERC20, functionName: "balanceOf", args: [adres] });
  if (bakiye < minimum) return { ok: false, reason: `holder access needs at least ${minimum / 10n ** 18n} AGI in ${adres}` };
  let kalan = gunluk;
  if (kv) {
    const gun = new Date(simdiMs).toISOString().slice(0, 10);
    const anahtar = `${onek}:${adres.toLowerCase()}:${gun}`;
    const kullanilan = Number((await kv.get(anahtar)) || 0);
    if (kullanilan >= gunluk) return { ok: false, reason: `holder daily limit of ${gunluk} checks reached; resets at 00:00 UTC` };
    await kv.put(anahtar, String(kullanilan + 1), { expirationTtl: 2 * 86400 });
    kalan = gunluk - kullanilan - 1;
  }
  return { ok: true, address: adres, balance: bakiye, remaining: kalan };
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
