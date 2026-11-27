import assert from "node:assert/strict";
import { anlik, olaylar, webhookGecerli, izlemeEkle, izlemeleriTara, izlemeOku, olayGovdesi } from "../src/watch.js";
const T0 = 1_800_000_000;
const rapor = (o = {}) => ({ verdict: "LOCKED_OR_BURNED", rugRisk: "LOW", protectedPctWeightedByLiquidity: 98, liquidityUsd: { v2Style: 10000, v3: 0 }, v2Pools: [{ pair: "0xP", lp: { lockers: [{ name: "UNCX (Uniswap V2)", pct: 90, earliestUnlock: new Date((T0 + 20 * 86400) * 1000).toISOString() }] } }], ...o });
// anlik
const a = anlik(rapor(), T0); assert.equal(a.liquidityUsd, 10000); assert.equal(a.kilitler.length, 1); assert.equal(a.kilitler[0].at, T0 + 20 * 86400);
// değişiklik yok → olay yok
assert.equal(olaylar(a, anlik(rapor(), T0 + 3600)).olaylar.length, 0);
// likidite düşüşü + koruma düşüşü + hüküm değişimi
const b = anlik(rapor({ liquidityUsd: { v2Style: 2000, v3: 0 }, protectedPctWeightedByLiquidity: 40, verdict: "PARTIAL", rugRisk: "HIGH" }), T0 + 3600);
const tip = olaylar(a, b).olaylar.map((x) => x.type).sort(); assert.deepEqual(tip, ["LIQUIDITY_DROP", "PROTECTION_DROP", "VERDICT_CHANGE"]);
// kilit yaklaşınca bir kez uyar
const c = anlik(rapor(), T0 + 15 * 86400);
const r1 = olaylar(a, c); assert.deepEqual(r1.olaylar.map((x) => x.type), ["UNLOCK_SOON"]);
assert.equal(olaylar(c, anlik(rapor(), T0 + 16 * 86400), r1.gonderildi).olaylar.length, 0);
// kilit açılınca bir kez
const d = anlik(rapor(), T0 + 21 * 86400); const r2 = olaylar(c, d, r1.gonderildi); assert.deepEqual(r2.olaylar.map((x) => x.type), ["UNLOCKED"]);
assert.equal(olaylar(d, anlik(rapor(), T0 + 22 * 86400), r2.gonderildi).olaylar.length, 0);
// küçük havuzda %30 eşiği tetiklenmez (< $50)
assert.equal(olaylar(anlik(rapor({ liquidityUsd: { v2Style: 40, v3: 0 } }), T0), anlik(rapor({ liquidityUsd: { v2Style: 1, v3: 0 } }), T0)).olaylar.length, 0);
// webhook doğrulama
for (const u of ["https://example.com/hook", "https://hooks.slack.com/x"]) assert.equal(webhookGecerli(u), true, u);
for (const u of ["http://example.com", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "https://u:p@example.com", "nope", "https://a.internal/x"]) assert.equal(webhookGecerli(u), false, u);
// KV ile uçtan uca
const kv = new Map(); const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async (k) => kv.delete(k), list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
const { izleme } = await izlemeEkle(KV, { token: "0xT", hedef: { webhook: "https://example.com/h" } }, rapor(), T0);
assert.ok(await izlemeOku(KV, izleme.id));
const giden = [];
let simdikiRapor = rapor();
const tara = (t) => izlemeleriTara(KV, async () => simdikiRapor, async (w, o, s) => giden.push(olayGovdesi(w, o, s)), t);
assert.deepEqual(await tara(T0 + 3600), { tarandi: 1, olay: 0, hata: 0, bitti: 0 });
simdikiRapor = rapor({ liquidityUsd: { v2Style: 100, v3: 0 } });
const s2 = await tara(T0 + 7200); assert.equal(s2.olay, 1); assert.equal(giden[0].type, "LIQUIDITY_DROP"); assert.equal(giden[0].watchId, izleme.id);
assert.equal((await tara(T0 + 10800)).olay, 0);
assert.equal((await tara(T0 + 31 * 86400)).bitti, 1); assert.equal(await izlemeOku(KV, izleme.id), null);
// Tek seferlik hatalı okuma (ikinci okumada düzelen) alarm üretmez; kalıcı değişiklik üretir.
{
  const kv2 = new Map(); const K2 = { get: async (k) => kv2.get(k) ?? null, put: async (k, v) => kv2.set(k, v), delete: async (k) => kv2.delete(k), list: async ({ prefix }) => ({ keys: [...kv2.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
  const { izleme: z } = await izlemeEkle(K2, { token: "0xT", hedef: { telegram: 1 } }, rapor(), T0);
  const g2 = []; let sira = [];
  const an = async () => sira.shift();
  sira = [rapor({ protectedPctWeightedByLiquidity: 0, verdict: "NOT_LOCKED", rugRisk: "HIGH" }), rapor()];
  let r = await izlemeleriTara(K2, an, async (w, o) => g2.push(o.type), T0 + 3600);
  assert.equal(g2.length, 0, "flap must not alert"); assert.equal(r.dogrulanmadi, 1);
  assert.equal(JSON.parse(kv2.get("w:" + z.id)).son.verdict, "LOCKED_OR_BURNED");
  const kotu = rapor({ protectedPctWeightedByLiquidity: 0, verdict: "NOT_LOCKED", rugRisk: "HIGH" });
  sira = [kotu, kotu];
  r = await izlemeleriTara(K2, an, async (w, o) => g2.push(o.type), T0 + 7200);
  assert.deepEqual(g2.sort(), ["PROTECTION_DROP", "VERDICT_CHANGE"]);
  // okuma hatası: anlık görüntü değişmez, alarm yok
  sira = []; const hatali = async () => { throw new Error("HTTP request failed"); };
  r = await izlemeleriTara(K2, hatali, async (w, o) => g2.push(o.type), T0 + 10800);
  assert.equal(r.hata, 1); assert.equal(g2.length, 2);
}
console.log("watch: all ok");
