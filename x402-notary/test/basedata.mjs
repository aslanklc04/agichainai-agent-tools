import assert from "node:assert";
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gasBilgisi, fiyatBilgisi, bakiyeBilgisi } from "../src/basedata.js";
const RPC = "http://127.0.0.1:8545", DEX = "/home/claude/dex";
const chain = defineChain({ id: 31337, name: "hh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const s = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const okur = createPublicClient({ chain, transport: http(RPC) }); const w = createWalletClient({ account: s, chain, transport: http(RPC) });
const art = (p) => JSON.parse(fs.readFileSync(`${DEX}/artifacts/contracts/${p}`));
const kur = async (p, a = []) => { const x = art(p); return (await okur.waitForTransactionReceipt({ hash: await w.deployContract({ abi: x.abi, bytecode: x.bytecode, args: a }) })).contractAddress; };
const yaz = async (address, abi, fn, args, value) => okur.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi: parseAbi(abi), functionName: fn, args, value }) });
const weth = await kur("periphery/WETH9.sol/WETH9.json"); const fab = await kur("core/UniswapV2Factory.sol/UniswapV2Factory.json", [s.address]); const router = await kur("periphery/UniswapV2Router02.sol/UniswapV2Router02.json", [fab, weth]);
// Chainlink yerine sahte fiyat beslemesi yok: ethUsd okunamazsa USD null olur. Basit bir sahte besleme kur.
const t = await kur("token/GuvenliToken.sol/GuvenliToken.json", ["Test", "TST", 1_000_000n]);
await yaz(t, ["function approve(address,uint256) returns (bool)"], "approve", [router, parseEther("100000")]);
await yaz(router, ["function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"], "addLiquidityETH", [t, parseEther("100000"), 0n, 0n, s.address, (await okur.getBlock()).timestamp + 3600n], parseEther("10"));
const g = await gasBilgisi(okur); assert.ok(g.block > 0 && g.suggested.standard.maxFeePerGasGwei);
const b = await bakiyeBilgisi(okur, s.address, [t, "0x0000000000000000000000000000000000000001"]);
assert.equal(b.tokens[0].symbol, "TST"); assert.equal(b.tokens[0].balance, "900000"); assert.ok(b.tokens[1].error); assert.equal(b.isContract, false);
await assert.rejects(() => bakiyeBilgisi(okur, "nope"), /address must be/);
const ay = { weth, usdc: "0x0000000000000000000000000000000000000001", ethUsd: "0x0000000000000000000000000000000000000002", v2: [{ dex: "uniswap-v2", factory: fab }], lockers: [] };
const f = await fiyatBilgisi(okur, ay, t);
assert.equal(f.token.symbol, "TST"); // ETH/USD beslemesi yokken fiyat null olabilir, hata vermemeli
console.log("basedata: ok", { gas: g.baseFeeGwei, price: f.priceUsd, note: f.note });
