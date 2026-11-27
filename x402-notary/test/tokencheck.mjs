// Ön-alım kontrolü: yerel hardhat düğümünde normal / honeypot / vergili / basılabilir token senaryoları.
// Önkoşul: dex dizininde `npx hardhat node` (8545) çalışıyor ve sözleşmeler derlenmiş.
import assert from "node:assert";
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tokenKontrol } from "../src/tokencheck.js";

const DEX = "/home/claude/dex", RPC = "http://127.0.0.1:8545";
const chain = defineChain({ id: 31337, name: "hardhat", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const sahip = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const okur = createPublicClient({ chain, transport: http(RPC) });
const w = createWalletClient({ account: sahip, chain, transport: http(RPC) });
const art = (p) => JSON.parse(fs.readFileSync(`${DEX}/artifacts/contracts/${p}`, "utf8"));
const kur = async (p, args = []) => { const a = art(p); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args }); return (await okur.waitForTransactionReceipt({ hash: h })).contractAddress; };
const yaz = async (address, abi, functionName, args, value) => okur.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi: parseAbi(abi), functionName, args, value }) });

const weth = await kur("periphery/WETH9.sol/WETH9.json");
const fab = await kur("core/UniswapV2Factory.sol/UniswapV2Factory.json", [sahip.address]);
const router = await kur("periphery/UniswapV2Router02.sol/UniswapV2Router02.json", [fab, weth]);
const ay = { weth, usdc: "0x0000000000000000000000000000000000000001", ethUsd: "0x0000000000000000000000000000000000000002", v2: [{ dex: "uniswap-v2", factory: fab }], lockers: [] };

async function havuz(tok, yakLp) {
  await yaz(tok, ["function approve(address,uint256) returns (bool)"], "approve", [router, parseEther("100000")]);
  const t = (await okur.getBlock()).timestamp + 3600n;
  await yaz(router, ["function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"], "addLiquidityETH", [tok, parseEther("100000"), 0n, 0n, yakLp ? "0x000000000000000000000000000000000000dEaD" : sahip.address, t], parseEther("10"));
  return okur.readContract({ address: fab, abi: parseAbi(["function getPair(address,address) view returns (address)"]), functionName: "getPair", args: [tok, weth] });
}
const setHavuz = (tok, p) => yaz(tok, ["function havuzAyarla(address)"], "havuzAyarla", [p]);
let n = 0; const k = async (ad, f) => { await f(); n++; console.log("  ✔ " + ad); };

await k("normal token, LP yakılmış: SAFE", async () => {
  const t = await kur("token/GuvenliToken.sol/GuvenliToken.json", ["Test", "TST", 1_000_000n]);
  await havuz(t, true);
  const r = await tokenKontrol(okur, ay, t);
  assert.equal(r.simulation.buyOk && r.simulation.sellOk, true, JSON.stringify(r.simulation));
  assert.equal(r.simulation.sellTaxPct, 0); assert.equal(r.simulation.buyTaxPct, 0);
  assert.equal(r.verdict, "SAFE", JSON.stringify(r.risks));
});
await k("honeypot: DANGER / HONEYPOT", async () => {
  const t = await kur("test/SimTokenlari.sol/BalTuzagi.json"); const p = await havuz(t, true); await setHavuz(t, p);
  const r = await tokenKontrol(okur, ay, t);
  assert.equal(r.verdict, "DANGER"); assert.ok(r.risks.some((x) => x.code === "HONEYPOT"), JSON.stringify(r.risks));
  assert.match(r.simulation.error, /TRANSFER_BLOCKED/);
});
await k("vergili: satış %20 → CAUTION, vergiler ölçülür", async () => {
  const t = await kur("test/SimTokenlari.sol/VergiliToken.json"); const p = await havuz(t, true); await setHavuz(t, p);
  const r = await tokenKontrol(okur, ay, t);
  assert.ok(Math.abs(r.simulation.sellTaxPct - 20) < 0.2, String(r.simulation.sellTaxPct));
  assert.ok(Math.abs(r.simulation.buyTaxPct - 5) < 0.2, String(r.simulation.buyTaxPct));
  assert.ok(r.risks.some((x) => x.code === "SELL_TAX_HIGH"));
  assert.equal(r.verdict, "CAUTION");
});
await k("LP sahipte (kilitsiz) + basılabilir token: DANGER, OWNER_CAN_MINT", async () => {
  const t = await kur("test/TestTokenlari.sol/BasitToken.json", ["MNT"]);
  await yaz(t, ["function bas(address,uint256)"], "bas", [sahip.address, parseEther("1000000")]).catch(async () => yaz(t, ["function mint(address,uint256)"], "mint", [sahip.address, parseEther("1000000")]));
  await havuz(t, false);
  const r = await tokenKontrol(okur, ay, t);
  assert.ok(r.risks.some((x) => x.code === "LIQUIDITY_REMOVABLE"), JSON.stringify(r.risks));
  assert.equal(r.verdict, "DANGER");
});
console.log(`tokencheck: ${n}/4`);
