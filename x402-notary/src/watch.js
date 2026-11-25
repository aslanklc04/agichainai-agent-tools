// LP izleme: bir tokenin likidite kilidini zaman içinde takip eder, değişince olay üretir.
// Saf fonksiyonlar (anlik, olaylar) test edilebilir; depolama KV benzeri { get, put, delete, list } arayüzüyle yapılır.

export const IZLEME_GUN = 30;
export const KILIT_UYARI_GUN = 7;

// Analiz sonucundan karşılaştırılabilir kısa bir anlık görüntü çıkarır.
export function anlik(j, simdi) {
  const kilitler = [];
  for (const p of j.v2Pools || []) {
    for (const k of p.lp?.lockers || []) {
      for (const a of k.unlocks || (k.earliestUnlock ? [{ at: k.earliestUnlock, pct: k.activePct ?? k.pct }] : [])) {
        const t = Date.parse(a.at);
        if (!Number.isNaN(t)) kilitler.push({ pair: p.pair, locker: k.name, at: Math.floor(t / 1000), pct: a.pct ?? null });
      }
    }
  }
  const lq = j.liquidityUsd || {};
  return {
    t: simdi,
    verdict: j.verdict,
    rugRisk: j.rugRisk,
    protectedPct: j.protectedPctWeightedByLiquidity ?? null,
    liquidityUsd: Math.round(((lq.v2Style || 0) + (lq.v3 || 0)) * 100) / 100,
    kilitler,
  };
}

// Önceki ve şimdiki anlık görüntüden olay listesi üretir. `gonderildi` aynı uyarının tekrarını önler.
export function olaylar(onceki, simdiki, gonderildi = {}) {
  const ol = [];
  const yeniGonderildi = { ...gonderildi };
  if (onceki) {
    if (onceki.liquidityUsd >= 50 && simdiki.liquidityUsd <= onceki.liquidityUsd * 0.7) {
      ol.push({ type: "LIQUIDITY_DROP", detail: `Liquidity fell from $${onceki.liquidityUsd} to $${simdiki.liquidityUsd} (${Math.round((1 - simdiki.liquidityUsd / onceki.liquidityUsd) * 100)}%).` });
    }
    if (onceki.protectedPct !== null && simdiki.protectedPct !== null && simdiki.protectedPct <= onceki.protectedPct - 5) {
      ol.push({ type: "PROTECTION_DROP", detail: `Burned or locked LP share fell from ${onceki.protectedPct}% to ${simdiki.protectedPct}%: more liquidity can now be withdrawn.` });
    }
    if (onceki.verdict !== simdiki.verdict) {
      ol.push({ type: "VERDICT_CHANGE", detail: `Verdict changed from ${onceki.verdict} to ${simdiki.verdict} (rug risk ${onceki.rugRisk} → ${simdiki.rugRisk}).` });
    }
  }
  for (const k of simdiki.kilitler) {
    const anahtar = `${k.pair}:${k.locker}:${k.at}`;
    const kalan = k.at - simdiki.t;
    if (kalan <= 0 && !yeniGonderildi["u:" + anahtar]) {
      yeniGonderildi["u:" + anahtar] = simdiki.t;
      ol.push({ type: "UNLOCKED", detail: `${k.locker} lock${k.pct !== null ? ` on ${k.pct}% of the LP` : ""} unlocked at ${new Date(k.at * 1000).toISOString()}: that liquidity can now be withdrawn.` });
    } else if (kalan > 0 && kalan <= KILIT_UYARI_GUN * 86400 && !yeniGonderildi["s:" + anahtar]) {
      yeniGonderildi["s:" + anahtar] = simdiki.t;
      ol.push({ type: "UNLOCK_SOON", detail: `${k.locker} lock${k.pct !== null ? ` on ${k.pct}% of the LP` : ""} unlocks in ${Math.ceil(kalan / 86400)} day(s), at ${new Date(k.at * 1000).toISOString()}.` });
    }
  }
  return { olaylar: ol, gonderildi: yeniGonderildi };
}

export function webhookGecerli(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return false;
    if (x.username || x.password) return false;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.startsWith("[")) return false;
    return u.length <= 500;
  } catch { return false; }
}

const rastgeleKimlik = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

// kayit: { token, hedef: { webhook } | { telegram: chatId }, odeyen?, odemeTx? }
export async function izlemeEkle(kv, kayit, ilk, simdi) {
  const id = rastgeleKimlik();
  const w = { id, token: kayit.token, hedef: kayit.hedef, odeyen: kayit.odeyen || null, odemeTx: kayit.odemeTx || null, olusturma: simdi, bitis: simdi + IZLEME_GUN * 86400, son: anlik(ilk, simdi), gonderildi: {}, olaySayisi: 0 };
  // İlk görüntüde zaten yakın olan kilitler için uyarıyı hemen hazırla.
  const { olaylar: ol, gonderildi } = olaylar(null, w.son, {});
  w.gonderildi = gonderildi;
  await kv.put("w:" + id, JSON.stringify(w), { expirationTtl: IZLEME_GUN * 86400 + 86400 });
  return { izleme: w, ilkOlaylar: ol };
}

export async function izlemeOku(kv, id) {
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  const s = await kv.get("w:" + id);
  return s ? JSON.parse(s) : null;
}

export async function izlemeSil(kv, id) { await kv.delete("w:" + id); }

export async function tumIzlemeler(kv) {
  const out = [];
  let cursor;
  do {
    const r = await kv.list({ prefix: "w:", cursor });
    for (const k of r.keys) { const s = await kv.get(k.name); if (s) out.push(JSON.parse(s)); }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out;
}

// Tüm izlemeleri tarar. analiz(token) → analiz sonucu; bildir(izleme, olay) → teslim.
export async function izlemeleriTara(kv, analiz, bildir, simdi, { sinir = 40 } = {}) {
  const liste = (await tumIzlemeler(kv)).sort((a, b) => (a.son?.t || 0) - (b.son?.t || 0)).slice(0, sinir);
  const sonuc = { tarandi: 0, olay: 0, hata: 0, bitti: 0 };
  const onbellek = new Map();
  for (const w of liste) {
    if (simdi >= w.bitis) { await kv.delete("w:" + w.id); sonuc.bitti++; continue; }
    try {
      if (!onbellek.has(w.token)) onbellek.set(w.token, await analiz(w.token));
      const yeni = anlik(onbellek.get(w.token), simdi);
      const { olaylar: ol, gonderildi } = olaylar(w.son, yeni, w.gonderildi);
      for (const o of ol) { try { await bildir(w, o, yeni); } catch {} }
      const degisti = ol.length > 0 || JSON.stringify({ ...w.son, t: 0 }) !== JSON.stringify({ ...yeni, t: 0 });
      w.son = yeni; w.gonderildi = gonderildi; w.olaySayisi += ol.length;
      // KV yazma kotasını korumak için yalnızca değişince ya da 12 saatte bir yaz.
      if (degisti || simdi - (w.yazildi || 0) > 43200) { w.yazildi = simdi; await kv.put("w:" + w.id, JSON.stringify(w), { expiration: w.bitis + 86400 }); }
      sonuc.tarandi++; sonuc.olay += ol.length;
    } catch { sonuc.hata++; }
  }
  return sonuc;
}

export function olayGovdesi(w, o, s) {
  return {
    watchId: w.id,
    token: w.token,
    type: o.type,
    detail: o.detail,
    current: { verdict: s.verdict, rugRisk: s.rugRisk, protectedPct: s.protectedPct, liquidityUsd: s.liquidityUsd },
    checkedAt: new Date(s.t * 1000).toISOString(),
    report: "https://agichainai.com/exchange/lp-lock.html?token=" + w.token,
    expiresAt: new Date(w.bitis * 1000).toISOString(),
  };
}
