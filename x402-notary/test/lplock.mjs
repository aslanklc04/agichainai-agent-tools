// LP kilidi kontrolü uçtan uca: gerçek V2 havuzları, yakılmış / UNCX / bizim kilit / kilitsiz senaryoları, x402 ödemesi, AGI yakımı.
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
// Gerçekteki gibi: ödeme token'ı = noterin USDC'si. AGI/USDC %1 havuzunu tam aralıkla aç.
const NPM = parseAbi(["function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)"]);
const FAB3 = parseAbi(["function createPool(address,address,uint24) returns (address)", "function getPool(address,address,uint24) view returns (address)"]);
const HAVUZ = parseAbi(["function initialize(uint160)"]);
const ONAY = parseAbi(["function approve(address,uint256) returns (bool)"]);
const bekle = async (h) => okur.waitForTransactionReceipt({ hash: await h });
{
  const [t0, t1] = AGI.toLowerCase() < odemeUsdc.toLowerCase() ? [AGI, odemeUsdc] : [odemeUsdc, AGI];
  const agiHam = 1_000_000n * 10n ** 18n, usdcHam = 3_400n * 10n ** 6n;
  const [r0, r1] = t0 === AGI ? [agiHam, usdcHam] : [usdcHam, agiHam];
  await bekle(op.writeContract({ address: V.fabrikaV3, abi: FAB3, functionName: "createPool", args: [t0, t1, 10000] }));
  const havuz = await okur.readContract({ address: V.fabrikaV3, abi: FAB3, functionName: "getPool", args: [t0, t1, 10000] });
  const kok = (n) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
  await bekle(op.writeContract({ address: havuz, abi: HAVUZ, functionName: "initialize", args: [kok((r1 << 192n) / r0)] }));
  await bekle(op.writeContract({ address: odemeUsdc, abi: E20, functionName: "bas", args: [operator.address, usdcHam] }));
  await bekle(op.writeContract({ address: AGI, abi: ONAY, functionName: "approve", args: [V.npm, agiHam] }));
  await bekle(op.writeContract({ address: odemeUsdc, abi: ONAY, functionName: "approve", args: [V.npm, usdcHam] }));
  await bekle(op.writeContract({ address: V.npm, abi: NPM, functionName: "mint", args: [{ token0: t0, token1: t1, fee: 10000, tickLower: -887200, tickUpper: 887200, amount0Desired: r0, amount1Desired: r1, amount0Min: 0n, amount1Min: 0n, recipient: operator.address, deadline: 9999999999n }] }));
}
const NU = art("noter/AgiNoterUSDC.sol/AgiNoterUSDC.json");
const nh = await op.deployContract({ abi: NU.abi, bytecode: NU.bytecode, args: [AGI, odemeUsdc, V.router02, 10000, 10000n] });
const noterUsdc = (await okur.waitForTransactionReceipt({ hash: nh })).contractAddress;
// Hizmet cüzdanının noter için kullandığı USDC (noterin kendi USDC'si) — gerçekte ödemeden gelen USDC ile aynı token
await okur.waitForTransactionReceipt({ hash: await op.writeContract({ address: V.usdc, abi: E20, functionName: "bas", args: [servis.address, 50_000n] }) });

for (const h of [fac, servis]) await okur.waitForTransactionReceipt({ hash: await op.sendTransaction({ to: h.address, value: 10n ** 18n }) });
// Yerel kolaylaştırıcı (facilitator): imzayı doğrular, transferWithAuthorization ile tahsil eder
const facSigner = toFacilitatorEvmSigner(createWalletClient({ account: fac, chain, transport: http(RPC) }).extend((c) => ({ ...okur, ...c, readContract: okur.readContract, waitForTransactionReceipt: okur.waitForTransactionReceipt, verifyTypedData: okur.verifyTypedData, getCode: okur.getCode, call: okur.call })));
const fasil = new x402Facilitator().register("eip155:31337", new FacScheme(facSigner));
const fasilIstemci = { verify: (p, r) => fasil.verify(p, r), settle: async (p, r) => { const s = await fasil.settle(p, r); if (!s.success) console.log("SETTLE", JSON.stringify(s), JSON.stringify(p.payload.authorization)); return s; }, getSupported: async () => fasil.getSupported() };


const V2F = parseAbi(["function createPair(address,address) returns (address)", "function getPair(address,address) view returns (address)"]);
const RT = parseAbi(["function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"]);
const BAS = parseAbi(["function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const GT = art("token/GuvenliToken.sol/GuvenliToken.json");
const tokenKur = async (ad) => { const h = await op.deployContract({ abi: GT.abi, bytecode: GT.bytecode, args: [ad, ad, 1_000_000n] }); return (await okur.waitForTransactionReceipt({ hash: h })).contractAddress; };
const havuzAc = async (t, eth) => {
  await bekle(op.writeContract({ address: t, abi: BAS, functionName: "approve", args: [C.x.router, 10n ** 30n] }));
  await bekle(op.writeContract({ address: C.x.router, abi: RT, functionName: "addLiquidityETH", args: [t, 100_000n * 10n ** 18n, 0n, 0n, operator.address, 9999999999n], value: eth }));
  return okur.readContract({ address: C.x.factory, abi: V2F, functionName: "getPair", args: [t, C.x.weth] });
};
const UN = art("test/SahteUncx.sol/SahteUncx.json");
const uncx = (await okur.waitForTransactionReceipt({ hash: await op.deployContract({ abi: UN.abi, bytecode: UN.bytecode }) })).contractAddress;
const KL = art("kilit/LikiditeKilidi.sol/LikiditeKilidi.json");
const kilit = (await okur.waitForTransactionReceipt({ hash: await op.deployContract({ abi: KL.abi, bytecode: KL.bytecode, args: [C.x.factory, AGI] }) })).contractAddress;
const simdi = Number((await okur.getBlock()).timestamp);

const tAcik = await tokenKur("ACIK"), pAcik = await havuzAc(tAcik, 10n ** 18n);
const tYak = await tokenKur("YAK"), pYak = await havuzAc(tYak, 10n ** 18n);
await bekle(op.writeContract({ address: pYak, abi: BAS, functionName: "transfer", args: [YAKMA, await okur.readContract({ address: pYak, abi: BAS, functionName: "balanceOf", args: [operator.address] })] }));
const tUn = await tokenKur("UNX"), pUn = await havuzAc(tUn, 10n ** 18n);
{ const b = await okur.readContract({ address: pUn, abi: BAS, functionName: "balanceOf", args: [operator.address] });
  await bekle(op.writeContract({ address: pUn, abi: BAS, functionName: "approve", args: [uncx, b] }));
  await bekle(op.writeContract({ address: uncx, abi: UN.abi, functionName: "lockLPToken", args: [pUn, (b * 9n) / 10n, BigInt(simdi + 365 * 86400)] })); }
const tEski = await tokenKur("ESKI"), pEski = await havuzAc(tEski, 10n ** 18n);
{ const b = await okur.readContract({ address: pEski, abi: BAS, functionName: "balanceOf", args: [operator.address] });
  await bekle(op.writeContract({ address: pEski, abi: BAS, functionName: "approve", args: [uncx, b] }));
  await bekle(op.writeContract({ address: uncx, abi: UN.abi, functionName: "lockLPToken", args: [pEski, b, BigInt(simdi - 10)] })); }
const tBiz = await tokenKur("BIZ"), pBiz = await havuzAc(tBiz, 10n ** 18n);
{ const b = await okur.readContract({ address: pBiz, abi: BAS, functionName: "balanceOf", args: [operator.address] });
  await bekle(op.writeContract({ address: pBiz, abi: BAS, functionName: "approve", args: [kilit, b] }));
  await bekle(op.writeContract({ address: kilit, abi: KL.abi, functionName: "kilitle", args: [pBiz, b, BigInt(simdi + 200 * 86400), operator.address] })); }
const tYok = await tokenKur("YOK");

const lpAyar = {
  weth: C.x.weth, usdc: odemeUsdc, ethUsd: "0x0000000000000000000000000000000000000001",
  v2: [{ dex: "uniswap-v2", factory: C.x.factory }], aerodrome: null, v3: { factory: V.fabrikaV3, fees: [10000] },
  lockers: [{ name: "UNCX (Uniswap V2)", address: uncx, type: "uncx" }, { name: "AGIChainAI lock", address: kilit, type: "agichainai" }],
};
// servis cüzdanına 0,20 USDC: ilk ücretli çağrıdan sonra yakım eşiği aşılır
await bekle(op.writeContract({ address: odemeUsdc, abi: E20, functionName: "bas", args: [servis.address, 200_000n] }));

const { app } = uygulamaKur({
  chain, network: "eip155:31337", rpcUrl: RPC, privateKey: ANAH[1], facilitator: fasilIstemci,
  price: { amount: "20000", asset: odemeUsdc, extra: { name: "USD Coin", version: "2" } },
  lpPrice: { amount: "10000", asset: odemeUsdc, extra: { name: "USD Coin", version: "2" } },
  adres: { noterUsdc: N.noter, noterAgi: N.noter, usdc: odemeUsdc, agi: AGI, quoter: V.quoter, router02: V.router02 },
  lp: lpAyar, publicUrl: "https://x402.test",
});
const yerel = (g, a) => app.fetch(new Request(g, a));
const ode = wrapFetchWithPaymentFromConfig(yerel, { schemes: [{ network: "eip155:31337", client: new ClientScheme(ajan) }], spendControls: false });
const lp = async (f, t) => { const r = await f("https://x402.test/lp-lock?token=" + t); return [r.status, await r.json()]; };
console.log("LP kilidi kontrolü:");
await k("Yoklama (token'sız) 402 + bazaar", async () => { const [s, j] = await lp(yerel, ""); assert.equal(s, 402); assert.ok(j.extensions.bazaar); });
await k("Ödemesiz istek 402, fiyat 0,01", async () => { const [s, j] = await lp(yerel, tAcik); assert.equal(s, 402); assert.equal(j.accepts[0].amount, "10000"); });
const a0 = await bak(odemeUsdc, ajan.address);
await k("Kilitsiz havuz → UNLOCKED, %100 çekilebilir, 0,01 alındı", async () => {
  const [s, j] = await lp(ode, tAcik); assert.equal(s, 200, JSON.stringify(j));
  assert.equal(j.verdict, "UNLOCKED"); assert.ok(j.v2Pools[0].lp.removablePct > 99.9); assert.ok(j.payment.transaction);
  assert.equal(a0 - (await bak(odemeUsdc, ajan.address)), 10000n);
});
await k("Yakılmış LP → LOCKED_OR_BURNED (burnedPct ~100)", async () => {
  const [s, j] = await lp(ode, tYak); assert.equal(s, 200); assert.equal(j.verdict, "LOCKED_OR_BURNED"); assert.ok(j.v2Pools[0].lp.burnedPct > 99.9, JSON.stringify(j.v2Pools[0].lp));
});
await k("UNCX'te %90 kilit → MOSTLY_LOCKED, açılış tarihi ~1 yıl sonra", async () => {
  const [s, j] = await lp(ode, tUn); assert.equal(s, 200); assert.equal(j.verdict, "MOSTLY_LOCKED", JSON.stringify(j.v2Pools[0].lp));
  const kk = j.v2Pools[0].lp.lockers[0]; assert.ok(Math.abs(kk.pct - 90) < 0.01); assert.equal(kk.expired, false);
  assert.ok(new Date(kk.earliestUnlock).getTime() / 1000 > simdi + 360 * 86400);
});
await k("Süresi dolmuş UNCX kilidi kilitli sayılmaz → UNLOCKED + uyarı", async () => {
  const [s, j] = await lp(ode, tEski); assert.equal(s, 200); assert.equal(j.verdict, "UNLOCKED"); assert.equal(j.v2Pools[0].lp.lockers[0].expired, true);
  assert.ok(j.notes.some((n) => n.includes("expired")));
});
await k("Bizim kilitte (aktif) → LOCKED_OR_BURNED", async () => {
  const [s, j] = await lp(ode, tBiz); assert.equal(s, 200); assert.equal(j.verdict, "LOCKED_OR_BURNED", JSON.stringify(j.v2Pools[0].lp)); assert.ok(j.v2Pools[0].lp.lockers[0].activePct > 99.9);
});
await k("Havuzu olmayan token → NO_POOL", async () => { const [s, j] = await lp(ode, tYok); assert.equal(s, 200); assert.equal(j.verdict, "NO_POOL"); });
await k("AGI'nin V3 havuzu listelenir", async () => { const [s, j] = await lp(ode, AGI); assert.equal(s, 200); assert.ok(j.v3Pools.length >= 1, JSON.stringify(j.v3Pools)); });
await k("Kontrat olmayan adres → 400, ücret YOK", async () => {
  const once = await bak(odemeUsdc, ajan.address); const [s] = await lp(ode, operator.address); assert.equal(s, 400); assert.equal(await bak(odemeUsdc, ajan.address), once);
});
await k("ERC-20 olmayan kontrat → 400, ücret YOK", async () => {
  const once = await bak(odemeUsdc, ajan.address); const [s] = await lp(ode, uncx); assert.equal(s, 400); assert.equal(await bak(odemeUsdc, ajan.address), once);
});
await k("Gelirin yarısı AGI alıp yaktı (eşik aşıldı)", async () => {
  await new Promise((r) => setTimeout(r, 4000));
  const yak = await bak(AGI, YAKMA); const sb = await bak(odemeUsdc, servis.address);
  // 0,20 + 7×0,01 = 0,27 → (0,27-0,05)/2 = 0,11 yakılır; sonra eşik altında kalır
  assert.ok(sb < 200_000n, "servis USDC " + sb); assert.ok(yak > 0n);
  console.log("      servis USDC:", Number(sb) / 1e6, "yakılan AGI toplam:", formatEther(yak));
});
await k("openapi'de /lp-lock var", async () => { const o = await (await yerel("https://x402.test/openapi.json")).json(); assert.ok(o.paths["/lp-lock"].get["x-payment-info"]); });
console.log(`${gecen}/13 geçti`);
process.exit(0);
