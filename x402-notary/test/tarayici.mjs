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
import { serve } from "@hono/node-server";
import nodeHttp from "node:http";
import { chromium } from "playwright";

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

let gecen = 0, gecen2 = 0;
const k2 = (ad, c, d = "") => { if (c) gecen2++; console.log((c ? "  ✔ " : "  ✘ ") + ad + (c ? "" : "  [" + d + "]")); };
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

const { app, hesap } = uygulamaKur({
  chain, network: "eip155:31337", rpcUrl: RPC, privateKey: ANAH[1], facilitator: fasilIstemci,
  price: { amount: "20000", asset: odemeUsdc, extra: { name: "USD Coin", version: "2" } },
  adres: { noterUsdc, noterAgi: N.noter, usdc: odemeUsdc, agi: AGI, quoter: V.quoter },
  publicUrl: "http://127.0.0.1:8787",
});

const sunucu = serve({ fetch: app.fetch, port: 8787 });
// sayfa sunucusu: site dosyaları + yerel ayar
const SITE = "/home/claude/agichainai-website/exchange";
const ayar = `window.X402_AYAR = ${JSON.stringify({ uc: "http://127.0.0.1:8787", zincir: 31337, usdc: odemeUsdc, kasif: "http://kasif", secenek: { spendControls: false } })};`;
const sayfaSunucu = nodeHttp.createServer((q, r) => {
  const yol = q.url.split("?")[0];
  if (yol === "/x402.html") { r.setHeader("content-type", "text/html"); return r.end(fs.readFileSync(SITE + "/x402.html", "utf8").replace('<script src="x402-odeme.js"></script>', `<script>${ayar}</script><script src="x402-odeme.js"></script>`)); }
  if (yol === "/x402-odeme.js") { r.setHeader("content-type", "text/javascript"); return r.end(fs.readFileSync(SITE + "/x402-odeme.js")); }
  r.statusCode = 404; r.end();
}).listen(8788);
const ham = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const b = await chromium.launch({ args: ["--no-sandbox"], executablePath: process.env.CHROME || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome" });
const pg = await b.newPage();
const hatalar = []; pg.on("pageerror", (e) => hatalar.push(String(e)));
let imzaIstendi = 0;
await pg.exposeFunction("__rpc", async (method, params) => {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return JSON.stringify({ result: [ajan.address] });
  if (method === "wallet_switchEthereumChain") return JSON.stringify({ result: null });
  if (method === "eth_signTypedData_v4") imzaIstendi++;
  return JSON.stringify(await ham(method, params));
});
await pg.addInitScript(() => { window.ethereum = { request: async ({ method, params }) => { const r = JSON.parse(await window.__rpc(method, params || [])); if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; } return r.result; }, on() {} }; });
await pg.goto("http://127.0.0.1:8788/x402.html");
await pg.click("#baglan"); await pg.waitForTimeout(1500);
const hesapYazi = await pg.innerText("#hesap");
k2("Cüzdan bağlanır, USDC bakiyesi görünür", hesapYazi.includes("USDC on Base: 1.00"), hesapYazi);
const metin = "AGIChainAI tarayıcı testi " + Date.now();
await pg.fill("#metin", metin); await pg.fill("#etiket", "browser test"); await pg.waitForTimeout(800);
const ozetYazi = await pg.innerText("#ozet");
const a0b = await bak(odemeUsdc, ajan.address), y0b = await bak(AGI, YAKMA);
await pg.click("#ode");
let d = ""; for (let i = 0; i < 60; i++) { d = await pg.innerText("#durum"); if (/Recorded|HTTP|Error|cancel/i.test(d)) break; await pg.waitForTimeout(500); }
k2("Ödeme imzası istenir (1 kez) ve kayıt yazılır", imzaIstendi === 1 && d.startsWith("Recorded"), d + " imza=" + imzaIstendi);
k2("Cüzdandan tam 0,02 USDC çıktı, gaz ödenmedi", a0b - (await bak(odemeUsdc, ajan.address)) === 20000n);
k2("AGI yakıldı", (await bak(AGI, YAKMA)) > y0b);
const oz = ozetYazi.replace("SHA-256: ", "");
const kr = await (await fetch("http://127.0.0.1:8787/record/" + oz)).json();
k2("Kayıt metnin SHA-256'sıyla zincirde", kr.recorded && kr.label.endsWith("browser test"), JSON.stringify(kr));
await pg.fill("#metin", metin + " "); await pg.fill("#metin", metin); await pg.waitForTimeout(1200);
k2("Aynı metin tekrar girilince 'Already recorded' der, buton kapanır", (await pg.innerText("#durum")).includes("Already recorded") && await pg.isDisabled("#ode"));
k2("Sayfa hatası yok", hatalar.length === 0, hatalar.join(" | "));
await b.close(); sunucu.close(); sayfaSunucu.close();
console.log(`${gecen2}/7 geçti`);
process.exit(0);
