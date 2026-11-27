// elizaOS eklentisi ve AgentKit sağlayıcısı: doğru tetiklenir, öder, özet üretir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTypedData, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_MAINNET } from "../src/core.js";

const KEY = "0x" + "7".repeat(64);
const acct = privateKeyToAccount(KEY);
const PAYTO = "0x36FBcbB32E384F147919ffbAA918314D9b0C04B6";
const TOKEN = "0x532f27101965dd16442E59d40670FaF5eBB142E4";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const CEVAP = { token: { address: TOKEN, symbol: "BRETT" }, verdict: "LOCKED_OR_BURNED", rugRisk: "LOW", interpretation: "ok", protectedPctWeightedByLiquidity: 99.5, v2Pools: [{ dex: "uniswap-v2", quote: "WETH", liquidityUsd: 1000, lp: { burnedPct: 50, lockedPct: 49.5, removablePct: 0.5, lockers: [{ name: "UNCX (Uniswap V2)", pct: 49.5, earliestUnlock: "2027-01-01T00:00:00.000Z" }] } }], notes: [], payment: { transaction: "0xabc" } };

function sahte(d) {
  const accepts = [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: BASE_MAINNET.usdc, payTo: PAYTO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }];
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!String(url).startsWith(BASE_MAINNET.x402Base)) return new Response("{}", { status: 200 }); // AgentKit telemetry etc.
    const h = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
    const imza = h.get("PAYMENT-SIGNATURE") || h.get("X-PAYMENT");
    d.n = (d.n || 0) + 1;
    if (!imza) { const pr = { x402Version: 2, resource: { url: BASE_MAINNET.x402Base + "/lp-lock" }, accepts }; return new Response(JSON.stringify(pr), { status: 402, headers: { "PAYMENT-REQUIRED": b64(pr), "content-type": "application/json" } }); }
    const a = JSON.parse(Buffer.from(imza, "base64").toString()).payload;
    d.ok = await verifyTypedData({ address: a.authorization.from, domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_MAINNET.usdc }, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] }, primaryType: "TransferWithAuthorization", message: { ...a.authorization, value: BigInt(a.authorization.value), validAfter: BigInt(a.authorization.validAfter), validBefore: BigInt(a.authorization.validBefore) }, signature: a.signature });
    d.from = a.authorization.from;
    return new Response(JSON.stringify(CEVAP), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("elizaOS action triggers only on address + intent, and pays", async () => {
  const { checkLpLockAction, lpLockPlugin } = await import("../src/lp-lock-eliza.js");
  assert.equal(lpLockPlugin.actions.length, 2);
  const rt = (k) => ({ getSetting: (x) => k[x] });
  const m = (text) => ({ content: { text } });
  assert.equal(await checkLpLockAction.validate(rt({}), m(`rug check ${TOKEN}`)), true);
  assert.equal(await checkLpLockAction.validate(rt({}), m(`send to ${TOKEN}`)), false);
  assert.equal(await checkLpLockAction.validate(rt({}), m("is the liquidity locked?")), false);
  let out = [];
  const r0 = await checkLpLockAction.handler(rt({}), m(`is liquidity locked ${TOKEN}`), null, {}, (x) => out.push(x.text));
  assert.equal(r0.success, false); assert.match(out[0], /AGENT_PRIVATE_KEY/); assert.match(out[0], /lp-lock\.html\?token=/);
  const d = {}; const eski = globalThis.fetch; globalThis.fetch = sahte(d);
  try {
    out = [];
    const r = await checkLpLockAction.handler(rt({ AGENT_PRIVATE_KEY: KEY }), m(`rug check ${TOKEN} pls`), null, {}, (x) => out.push(x.text));
    assert.equal(r.success, true, r.text); assert.equal(d.ok, true); assert.equal(getAddress(d.from), acct.address);
    assert.match(out[0], /LOCKED OR BURNED/); assert.match(out[0], /UNCX \(Uniswap V2\) 49\.5% until 2027-01-01/);
  } finally { globalThis.fetch = eski; }
});

test("AgentKit check_lp_lock pays through the wallet provider", async () => {
  const { lpLockActionProvider } = await import("../src/lp-lock-agentkit.js");
  const p = lpLockActionProvider();
  const wp = { getName: () => "mock", getNetwork: () => ({ chainId: "8453" }), getAddress: () => acct.address, signTypedData: (td) => acct.signTypedData(td), readContract: async () => { throw new Error("no rpc"); } };
  const acts = p.getActions(wp);
  assert.equal(acts.length, 2); const lpAct = acts.find((a) => a.name.endsWith("check_lp_lock")); assert.ok(lpAct);
  const d = {}; const eski = globalThis.fetch; globalThis.fetch = sahte(d);
  try {
    const s = await lpAct.invoke({ token: TOKEN });
    const j = JSON.parse(s);
    assert.equal(j.verdict, "LOCKED_OR_BURNED"); assert.equal(j.paidUsdc, "0.01"); assert.equal(d.ok, true);
    const wrong = lpLockActionProvider().getActions({ ...wp, getNetwork: () => ({ chainId: "1" }) });
    assert.match(await wrong.find((a) => a.name.endsWith("check_lp_lock")).invoke({ token: TOKEN }), /Base mainnet/);
  } finally { globalThis.fetch = eski; }
});

test("agi_token_check: an active AGI pass gets a free check via signed header; no pass pays (holding alone is not enough)", async () => {
  const { createAgiTools, BASE_MAINNET: B } = await import("../src/core.js");
  const calls = [];
  let passActive = true;
  const fakeFetch = async (url, init = {}) => {
    const h = new Headers(init.headers || (typeof url === "object" ? url.headers : undefined));
    calls.push({ url: String(url), holder: h.get("AGI-HOLDER"), pay: h.get("PAYMENT-SIGNATURE") || h.get("X-PAYMENT") });
    if (String(url).includes("/pass/")) return new Response(JSON.stringify({ active: passActive }), { status: 200 });
    if (h.get("AGI-HOLDER")) {
      const j = JSON.parse(atob(h.get("AGI-HOLDER")));
      const { verifyMessage } = await import("viem");
      const valid = await verifyMessage({ address: j.address, message: `AGIChainAI holder access\nAddress: ${j.address}\nIssued: ${j.issuedAt}`, signature: j.signature });
      return new Response(JSON.stringify(valid ? { verdict: "SAFE", access: { type: "agi-holder" } } : { error: "bad" }), { status: valid ? 200 : 402 });
    }
    return sahte({})(url, init);
  };
  const mk = (bal) => createAgiTools({ fetch: fakeFetch, read: async (p) => (p.functionName === "balanceOf" ? bal : 0n), account: async () => acct.address, signTypedData: (td) => acct.signTypedData(td), signMessage: (m) => acct.signMessage({ message: m }), send: async () => { throw new Error("no"); } }).find((t) => t.name === "agi_token_check");
  const zengin = await mk(0n).run({ token: TOKEN });
  assert.equal(zengin.access.type, "agi-holder"); assert.equal(zengin.paidUsdc, "0");
  calls.length = 0; passActive = false;
  const fakir = await mk(10n ** 30n).run({ token: TOKEN });
  assert.equal(fakir.paidUsdc, "0.01"); assert.ok(calls.some((c) => c.pay)); assert.ok(!calls.some((c) => c.holder));
});
