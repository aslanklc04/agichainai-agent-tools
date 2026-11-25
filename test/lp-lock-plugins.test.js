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
  assert.equal(lpLockPlugin.actions.length, 1);
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
  assert.equal(acts.length, 1); assert.equal(acts[0].name.endsWith("check_lp_lock"), true);
  const d = {}; const eski = globalThis.fetch; globalThis.fetch = sahte(d);
  try {
    const s = await acts[0].invoke({ token: TOKEN });
    const j = JSON.parse(s);
    assert.equal(j.verdict, "LOCKED_OR_BURNED"); assert.equal(j.paidUsdc, "0.01"); assert.equal(d.ok, true);
    const wrong = lpLockActionProvider().getActions({ ...wp, getNetwork: () => ({ chainId: "1" }) });
    assert.match(await wrong[0].invoke({ token: TOKEN }), /Base mainnet/);
  } finally { globalThis.fetch = eski; }
});
