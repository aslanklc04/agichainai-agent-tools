// agi_lp_lock_check: fiyatı önce sorar, limiti aşarsa imzalamaz; aksi halde geçerli bir EIP-3009 (x402 exact) imzasıyla öder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTypedData, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createViemAgiTools } from "../src/viem.js";
import { BASE_MAINNET } from "../src/core.js";

const KEY = "0x" + "7".repeat(64);
const acct = privateKeyToAccount(KEY);
const PAYTO = "0x36FBcbB32E384F147919ffbAA918314D9b0C04B6";
const TOKEN = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

function sahteSunucu(amount, durum = {}) {
  const resource = { url: BASE_MAINNET.x402Base + "/lp-lock", description: "lp", mimeType: "application/json" };
  const accepts = [{ scheme: "exact", network: "eip155:8453", amount: String(amount), asset: BASE_MAINNET.usdc, payTo: PAYTO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }];
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const h = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    const imza = h.get("PAYMENT-SIGNATURE") || h.get("X-PAYMENT");
    durum.istekler = (durum.istekler || 0) + 1;
    if (!imza) {
      const pr = { x402Version: 2, resource, accepts };
      return new Response(JSON.stringify(pr), { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64(pr) } });
    }
    const yuk = JSON.parse(Buffer.from(imza, "base64").toString());
    const a = yuk.payload.authorization;
    const ok = await verifyTypedData({
      address: a.from,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_MAINNET.usdc },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: yuk.payload.signature,
    });
    durum.imza = { ok, from: a.from, to: a.to, value: a.value, url };
    return new Response(JSON.stringify({ token: { address: TOKEN }, verdict: "NOT_LOCKED", rugRisk: "MEDIUM", payment: { transaction: "0xabc" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("agi_lp_lock_check pays 0.01 USDC with a valid EIP-3009 signature", async () => {
  const d = {};
  const tools = createViemAgiTools({ privateKey: KEY });
  const t = tools.find((x) => x.name === "agi_lp_lock_check");
  // fetch is injected through a fresh instance with o.fetch
  const { createAgiTools } = await import("../src/core.js");
  const tool = createAgiTools({ read: async () => { throw new Error("no rpc"); }, account: async () => acct.address, send: async () => ({ status: "success", hash: "0x" }), signTypedData: (td) => acct.signTypedData(td), fetch: sahteSunucu(10000, d), x402Options: { spendControls: false } }).find((x) => x.name === "agi_lp_lock_check");
  assert.ok(t);
  const r = await tool.run({ token: TOKEN });
  assert.equal(r.verdict, "NOT_LOCKED"); assert.equal(r.paidUsdc, "0.01");
  assert.equal(d.imza.ok, true); assert.equal(getAddress(d.imza.from), acct.address); assert.equal(getAddress(d.imza.to), PAYTO); assert.equal(d.imza.value, "10000");
  assert.ok(d.imza.url.includes("token=" + TOKEN));
});

test("agi_lp_lock_check refuses to sign above the x402 limit", async () => {
  const d = {};
  const { createAgiTools } = await import("../src/core.js");
  let imzalandi = false;
  const tool = createAgiTools({ read: async () => { throw new Error("no rpc"); }, account: async () => acct.address, send: async () => ({ status: "success", hash: "0x" }), signTypedData: async (td) => { imzalandi = true; return acct.signTypedData(td); }, fetch: sahteSunucu(60000, d) }).find((x) => x.name === "agi_lp_lock_check");
  await assert.rejects(tool.run({ token: TOKEN }), /above this agent's x402 limit/);
  assert.equal(imzalandi, false); assert.equal(d.istekler, 1);
});

test("agi_lp_lock_check rejects bad input and missing signer without network calls", async () => {
  const { createAgiTools } = await import("../src/core.js");
  const d = {};
  const ro = createAgiTools({ read: async () => 0n, fetch: sahteSunucu(10000, d) }).find((x) => x.name === "agi_lp_lock_check");
  await assert.rejects(ro.run({ token: "0x12" }), /20-byte address/);
  await assert.rejects(ro.run({ token: TOKEN }), /sign typed data/);
  assert.equal(d.istekler, undefined);
});
