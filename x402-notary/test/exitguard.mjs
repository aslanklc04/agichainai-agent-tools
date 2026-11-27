// Exit Guard: yerel hardhat düğümünde elde tutulan pozisyonların çıkış ölçümü ve izleme olayları.
// Önkoşul: dex dizininde `npx hardhat node` (8545) çalışıyor ve sözleşmeler derlenmiş.
import assert from "node:assert";
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, parseEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cuzdanOlc, tokenKesfet, ozet, pozisyonOlaylari, bekciEkle, bekcileriTara, bekciOku } from "../src/exitguard.js";

const DEX = "/home/claude/dex", RPC = "http://127.0.0.1:8545";
const chain = defineChain({ id: 31337, name: "hardhat", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const sahip = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const BOT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const okur = createPublicClient({ chain, transport: http(RPC) });
const w = createWalletClient({ account: sahip, chain, transport: http(RPC) });
const art = (p) => JSON.parse(fs.readFileSync(`${DEX}/artifacts/contracts/${p}`, "utf8"));
const kur = async (p, args = []) => { const a = art(p); const h = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args }); return getAddress((await okur.waitForTransactionReceipt({ hash: h })).contractAddress); };
const yaz = async (address, abi, functionName, args, value) => okur.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi: parseAbi(abi), functionName, args, value }) });

const weth = await kur("periphery/WETH9.sol/WETH9.json");
const fab = await kur("core/UniswapV2Factory.sol/UniswapV2Factory.json", [sahip.address]);
const router = await kur("periphery/UniswapV2Router02.sol/UniswapV2Router02.json", [fab, weth]);
const ay = { weth, usdc: "0x0000000000000000000000000000000000000001", ethUsd: "0x0000000000000000000000000000000000000002", v2: [{ dex: "uniswap-v2", factory: fab }], lockers: [] };
const sonra = async () => (await okur.getBlock()).timestamp + 3600n;
async function havuz(tok) {
  await yaz(tok, ["function approve(address,uint256) returns (bool)"], "approve", [router, parseEther("1000000")]);
  await yaz(router, ["function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)"], "addLiquidityETH", [tok, parseEther("100000"), 0n, 0n, "0x000000000000000000000000000000000000dEaD", await sonra()], parseEther("10"));
  return okur.readContract({ address: fab, abi: parseAbi(["function getPair(address,address) view returns (address)"]), functionName: "getPair", args: [tok, weth] });
}
const ver = (t, a) => yaz(t, ["function transfer(address,uint256) returns (bool)"], "transfer", [BOT, parseEther(String(a))]);
const kv = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async ({ prefix }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) }; };
let n = 0; const k = async (ad, f) => { await f(); n++; console.log("  ✔ " + ad); };
const simdi = () => Math.floor(Date.now() / 1000);

const temiz = await kur("token/GuvenliToken.sol/GuvenliToken.json", ["Clean", "CLN", 1_000_000n]); await havuz(temiz);
const tuzak = await kur("test/SimTokenlari.sol/SonradanTuzak.json"); const tp = await havuz(tuzak); await yaz(tuzak, ["function havuzAyarla(address)"], "havuzAyarla", [tp]);
const bos = await kur("token/GuvenliToken.sol/GuvenliToken.json", ["None", "NON", 1_000_000n]); await havuz(bos);
const basla = await okur.getBlockNumber();
await ver(temiz, 1000); await ver(tuzak, 1000);

await k("keşif: cüzdana gelen tokenler bulunur", async () => {
  const r = await tokenKesfet(okur, BOT, { blokSayisi: 200, parca: 50 });
  assert.ok(r.tokens.includes(temiz) && r.tokens.includes(tuzak), JSON.stringify({ bulunan: r.tokens, temiz, tuzak }));
  assert.ok(!r.tokens.includes(bos));
  assert.ok(r.sonBlok > basla);
});

await k("ölçüm: tam bakiye satılabilir, vergi 0, değer > 0; bakiyesiz token 'held:false'", async () => {
  const o = await cuzdanOlc(okur, ay, BOT, [temiz, tuzak, bos], simdi());
  const [a, b, c] = o.positions;
  assert.equal(a.held && a.sellable, true, JSON.stringify(a)); assert.equal(a.sellTaxPct, 0); assert.ok(a.exitValueEth > 0.09 && a.exitValueEth < 0.1, String(a.exitValueEth));
  assert.equal(b.sellable, true); assert.equal(b.sellTaxPct, 0);
  assert.equal(c.held, false);
  assert.equal(a.balance, "1000");
});

const g = kv(); const bildirilen = [];
const olc = (cz, tl) => cuzdanOlc(okur, ay, cz, tl, simdi());
const kesfet = (cz, o) => tokenKesfet(okur, cz, { ...o, parca: 50 });
const bildir = async (b, ol) => { bildirilen.push(...ol.map((x) => x.type + ":" + x.token)); };
let id;
await k("kayıt: başlangıç olayı yok", async () => {
  const o = await olc(BOT, [temiz, tuzak]);
  const r = await bekciEkle(g, { cuzdan: BOT, webhook: "https://example.com/h", tokenler: [temiz, tuzak], sonBlok: await okur.getBlockNumber({ cacheTime: 0 }), olcum: o }, simdi());
  id = r.bekci.id; assert.equal(r.ilkOlaylar.length, 0, JSON.stringify(r.ilkOlaylar));
});

await k("sahip satış vergisini %90 yapınca SELL_TAX_UP bildirilir (bir kez)", async () => {
  await yaz(tuzak, ["function vergiAyarla(uint256)"], "vergiAyarla", [90n]);
  const r = await bekcileriTara(g, { olc, kesfet, bildir, sonBlok: await okur.getBlockNumber({ cacheTime: 0 }) }, simdi());
  assert.deepEqual(bildirilen, ["SELL_TAX_UP:" + tuzak], JSON.stringify(r));
  await bekcileriTara(g, { olc, kesfet, bildir, sonBlok: await okur.getBlockNumber({ cacheTime: 0 }) }, simdi());
  assert.equal(bildirilen.length, 1);
});

await k("cüzdan engellenince SELL_BLOCKED", async () => {
  await yaz(tuzak, ["function engelle(address)"], "engelle", [BOT]);
  await bekcileriTara(g, { olc, kesfet, bildir, sonBlok: await okur.getBlockNumber({ cacheTime: 0 }) }, simdi());
  assert.equal(bildirilen.at(-1), "SELL_BLOCKED:" + tuzak);
});

await k("fiyat çökünce EXIT_VALUE_DROP; yeni gelen token otomatik eklenir", async () => {
  await yaz(router, ["function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"], "swapExactTokensForETHSupportingFeeOnTransferTokens", [parseEther("150000"), 0n, [temiz, weth], sahip.address, await sonra()]);
  await ver(bos, 500);
  await bekcileriTara(g, { olc, kesfet, bildir, sonBlok: await okur.getBlockNumber({ cacheTime: 0 }) }, simdi());
  assert.equal(bildirilen.at(-1), "EXIT_VALUE_DROP:" + temiz, JSON.stringify(bildirilen));
  const b = await bekciOku(g, id);
  assert.ok(b.tokenler.includes(bos), JSON.stringify(b.tokenler));
  assert.equal(b.son[bos].held, true);
});

await k("kullanıcı kendi sattıysa (bakiye değişti) EXIT_VALUE_DROP üretilmez", async () => {
  const once = { sym: "X", held: true, m: true, bal: "1000", ok: true, tax: 0, eth: 0.1, lp: null };
  const sonra_ = { ...once, bal: "100", eth: 0.01 };
  assert.equal(pozisyonOlaylari("0xT", once, sonra_).olaylar.length, 0);
});

console.log(`exitguard: ${n}/7`);
