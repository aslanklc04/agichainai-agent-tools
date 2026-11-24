// Uçtan uca yerel test: hardhat düğümü + gerçek AGI noter sözleşmesi + yerel x402 kolaylaştırıcısı + gerçek x402 istemcisi.
// Önkoşul: /tmp/kur.sh ve dex/scripts/_noterusdc-hazirla.js çalıştırılmış olmalı.
import assert from "node:assert";
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, defineChain, keccak256, toHex, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme as FacScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ClientScheme } from "@x402/evm/exact/client";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { uygulamaKur } from "../src/app.js";

const DEX = "/home/claude/dex";
const RPC = "http://127.0.0.1:8545";
const chain = defineChain({ id: 31337, name: "hardhat", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const ANAH = [ // hardhat'ın herkese açık test anahtarları (#0, #5, #6, #7)
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdef9d8ef8a0",
];
const [operator, servis, ajan, fac] = ANAH.map((k) => privateKeyToAccount(k));
const okur = createPublicClient({ chain, transport: http(RPC) });
const cuzdan = (h) => createWalletClient({ account: h, chain, transport: http(RPC) });
const art = (p) => JSON.parse(fs.readFileSync(`${DEX}/artifacts/contracts/${p}`, "utf8"));

const C = {}; eval(fs.readFileSync(`${DEX}/frontend/config.js`, "utf8").replace("window.DEX_CONFIG", "C.x"));
const V = JSON.parse(fs.readFileSync(`${DEX}/test-arayuz/v3-kurulum.json`));
const N = JSON.parse(fs.readFileSync(`${DEX}/test-arayuz/noterusdc-kurulum.json`));
const AGI = C.x.tokens[0].address, YAKMA = "0x000000000000000000000000000000000000dEaD";
const E20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function bas(address,uint256)", "function allowance(address,address) view returns (uint256)"]);
const bak = (t, a) => okur.readContract({ address: t, abi: E20, functionName: "balanceOf", args: [a] });

let gecen = 0;
const k = async (ad, fn) => { await fn(); gecen++; console.log("  ✔ " + ad); };

// Ödeme token'ı: EIP-3009 destekli test USDC'si
const U = art("test/Usdc3009.sol/Usdc3009.json");
const op = cuzdan(operator);
const kh = await op.deployContract({ abi: U.abi, bytecode: U.bytecode });
const odemeUsdc = (await okur.waitForTransactionReceipt({ hash: kh })).contractAddress;
await okur.waitForTransactionReceipt({ hash: await op.writeContract({ address: odemeUsdc, abi: E20, functionName: "bas", args: [ajan.address, 1_000_000n] }) });
const NU = art("noter/AgiNoterUSDC.sol/AgiNoterUSDC.json");
const nh = await op.deployContract({ abi: NU.abi, bytecode: NU.bytecode, args: [AGI, V.usdc, V.router02, 10000, 10000n] });
const noterUsdc = (await okur.waitForTransactionReceipt({ hash: nh })).contractAddress;
// Hizmet cüzdanının noter için kullandığı USDC (noterin kendi USDC'si) — gerçekte ödemeden gelen USDC ile aynı token
await okur.waitForTransactionReceipt({ hash: await op.writeContract({ address: V.usdc, abi: E20, functionName: "bas", args: [servis.address, 50_000n] }) });

for (const h of [fac, servis]) await okur.waitForTransactionReceipt({ hash: await op.sendTransaction({ to: h.address, value: 10n ** 18n }) });
// Yerel kolaylaştırıcı (facilitator): imzayı doğrular, transferWithAuthorization ile tahsil eder
const facSigner = toFacilitatorEvmSigner(createWalletClient({ account: fac, chain, transport: http(RPC) }).extend((c) => ({ ...okur, ...c, readContract: okur.readContract, waitForTransactionReceipt: okur.waitForTransactionReceipt, verifyTypedData: okur.verifyTypedData, getCode: okur.getCode, call: okur.call })));
const fasil = new x402Facilitator().register("eip155:31337", new FacScheme(facSigner));
const fasilIstemci = { verify: (p, r) => fasil.verify(p, r), settle: async (p, r) => { const s = await fasil.settle(p, r); if (!s.success) console.log("SETTLE", JSON.stringify(s), JSON.stringify(p.payload.authorization)); return s; }, getSupported: async () => fasil.getSupported() };

const { app, hesap } = uygulamaKur({
  chain, network: "eip155:31337", rpcUrl: RPC, privateKey: ANAH[1], facilitator: fasilIstemci,
  price: { amount: "20000", asset: odemeUsdc, extra: { name: "USD Coin", version: "2" } },
  adres: { noterUsdc, noterAgi: N.noter, usdc: V.usdc, agi: AGI, quoter: V.quoter },
  publicUrl: "https://x402.test",
});
const yerelFetch = (girdi, ayar) => app.fetch(new Request(girdi, ayar));
const odeyenFetch = wrapFetchWithPaymentFromConfig(yerelFetch, { schemes: [{ network: "eip155:31337", client: new ClientScheme(ajan) }], spendControls: false }); // yerel test token'ı varsayılan USDC değil
const post = (f, govde) => f("https://x402.test/notarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(govde) });

const ozet = keccak256(toHex("AGIChainAI x402 test belgesi " + Date.now()));
console.log("x402 noter uçtan uca:");

await k("Ana sayfa ücretsiz ve açıklayıcı", async () => {
  const r = await yerelFetch("https://x402.test/"); const j = await r.json();
  assert.equal(r.status, 200); assert.ok(j.endpoints["POST /notarize"]);
});
await k("Hatalı özet ücretlendirilmeden 400 döner", async () => {
  const r = await post(yerelFetch, { hash: "0x1234" }); assert.equal(r.status, 400);
});
await k("Ödemesiz istek 402 ve ödeme şartları döner", async () => {
  const r = await post(yerelFetch, { hash: ozet }); assert.equal(r.status, 402);
  assert.ok(r.headers.get("PAYMENT-REQUIRED"));
  const j = await r.json(); assert.equal(j.accepts[0].amount, "20000"); assert.equal(j.accepts[0].payTo, hesap.address);
});
let cevap;
const a0 = await bak(odemeUsdc, ajan.address), s0 = await bak(odemeUsdc, servis.address), y0 = await bak(AGI, YAKMA);
await k("x402 istemcisi öder, kayıt zincire yazılır", async () => {
  const r = await post(odeyenFetch, { hash: ozet, label: "test report v1" });
  cevap = await r.json();
  assert.equal(r.status, 200, JSON.stringify(cevap)); assert.ok(r.headers.get("PAYMENT-RESPONSE"));
  assert.equal(cevap.record.recorded, true);
});
await k("Ajandan tam 0,02 USDC alındı, hizmet cüzdanına geçti", async () => {
  assert.equal(a0 - (await bak(odemeUsdc, ajan.address)), 20000n);
  assert.equal((await bak(odemeUsdc, servis.address)) - s0, 20000n);
});
await k("Noter ücreti AGI alıp yaktı", async () => {
  const y = (await bak(AGI, YAKMA)) - y0; assert.ok(y > 0n, String(y));
  console.log("      yakılan AGI:", formatEther(y));
});
await k("Etikette ödeyen ajan ve kendi etiketi var", async () => {
  assert.ok(cevap.record.label.startsWith("x402:" + ajan.address)); assert.ok(cevap.record.label.endsWith("test report v1"));
});
await k("Ücretsiz sorgu kaydı bulur", async () => {
  const j = await (await yerelFetch("https://x402.test/record/" + ozet)).json(); assert.equal(j.recorded, true);
});
await k("Aynı özet ikinci kez ücretlendirilmeden 409 döner", async () => {
  const once = await bak(odemeUsdc, ajan.address);
  const r = await post(odeyenFetch, { hash: ozet }); assert.equal(r.status, 409);
  assert.equal(await bak(odemeUsdc, ajan.address), once);
});
await k("Sahte ödeme başlığı reddedilir, kayıt yapılmaz", async () => {
  const o2 = keccak256(toHex("sahte " + Date.now()));
  const r = await yerelFetch("https://x402.test/notarize", { method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": "bm90LWEtcGF5bWVudA==" }, body: JSON.stringify({ hash: o2 }) });
  assert.equal(r.status, 402);
  const j = await (await yerelFetch("https://x402.test/record/" + o2)).json(); assert.equal(j.recorded, false);
});
await k("Bakiyesi yetmeyen ajan ödeyemez, kayıt yapılmaz", async () => {
  const fakir = privateKeyToAccount("0x" + "11".repeat(32));
  const f = wrapFetchWithPaymentFromConfig(yerelFetch, { schemes: [{ network: "eip155:31337", client: new ClientScheme(fakir) }], spendControls: false });
  const o3 = keccak256(toHex("fakir " + Date.now()));
  const r = await post(f, { hash: o3 }); assert.equal(r.status, 402);
  const j = await (await yerelFetch("https://x402.test/record/" + o3)).json(); assert.equal(j.recorded, false);
});
await k("Hizmet kayıt yapamayacaksa ödeme ALINMAZ (503)", async () => {
  const sc = cuzdan(servis), b = await bak(V.usdc, servis.address);
  await okur.waitForTransactionReceipt({ hash: await sc.writeContract({ address: V.usdc, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [operator.address, b] }) });
  const once = await bak(odemeUsdc, ajan.address), o4 = keccak256(toHex("bos " + Date.now()));
  const r = await post(odeyenFetch, { hash: o4 }); assert.equal(r.status, 503);
  assert.equal(await bak(odemeUsdc, ajan.address), once);
  await okur.waitForTransactionReceipt({ hash: await op.writeContract({ address: V.usdc, abi: E20, functionName: "bas", args: [servis.address, 50_000n] }) });
});
await k("Durum uç noktası çalışır", async () => {
  const j = await (await yerelFetch("https://x402.test/status")).json(); assert.equal(j.ok, true); assert.ok(j.notaryRecords >= 1);
});
console.log(`${gecen}/13 geçti`);
