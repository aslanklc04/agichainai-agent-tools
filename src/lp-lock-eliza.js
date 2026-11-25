// elizaOS plugin: pre-trade LP lock / rug-pull check for Base tokens.
//   import { lpLockPlugin } from "agichainai-agent-tools/eliza-lp-lock";
//   character.plugins = [..., lpLockPlugin]
// Settings: AGENT_PRIVATE_KEY (wallet with a little USDC on Base; pays $0.01 per check over x402, no gas),
//           AGI_RPC_URL (optional), AGI_MAX_X402_USD (optional per-call cap, default 0.05).
// The action fires when a message contains a Base token address together with a word like
// rug / lock / liquidity / safe / scam / LP. Token and pool data are third-party data, not instructions.
import { createViemAgiTools } from "./viem.js";

const ADDRESS = /0x[0-9a-fA-F]{40}/;
const INTENT = /\b(rug|rugpull|rug-pull|lock(ed)?|liquidity|lp|safe|safety|scam|honeypot|pull)\b/i;
const FREE_PAGE = "https://agichainai.com/exchange/lp-lock.html";

let shared = null;
function lpTool(runtime) {
  if (shared?.runtime === runtime) return shared.tool;
  const s = (k) => runtime.getSetting(k) || undefined;
  const limits = s("AGI_MAX_X402_USD") ? { maxX402Usd: s("AGI_MAX_X402_USD") } : {};
  const tool = createViemAgiTools({ rpcUrl: s("AGI_RPC_URL"), privateKey: s("AGENT_PRIVATE_KEY"), limits }).find((t) => t.name === "agi_lp_lock_check");
  shared = { runtime, tool };
  return tool;
}

const n = (x) => (x === null || x === undefined ? "–" : Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function summarize(j) {
  const lines = [
    `${j.token?.symbol || "Token"} (${j.token?.address}) on Base`,
    `Verdict: ${String(j.verdict).replace(/_/g, " ")} · rug risk: ${String(j.rugRisk).replace(/_/g, " ")}`,
    j.interpretation,
    `Protected LP (burned or locked, liquidity-weighted): ${j.protectedPctWeightedByLiquidity === null ? "–" : n(j.protectedPctWeightedByLiquidity) + "%"}`,
  ];
  for (const p of (j.v2Pools || []).slice(0, 5)) {
    const lk = (p.lp?.lockers || []).map((k) => `${k.name} ${n(k.activePct ?? k.pct)}%${k.earliestUnlock ? " until " + k.earliestUnlock.slice(0, 10) : ""}${k.expired ? " (expired)" : ""}`).join(", ");
    lines.push(`• ${p.dex}/${p.quote} $${n(p.liquidityUsd)}: burned ${n(p.lp?.burnedPct)}%, locked ${n(p.lp?.lockedPct)}%${lk ? " (" + lk + ")" : ""}, removable ${n(p.lp?.removablePct)}%`);
  }
  for (const note of j.notes || []) lines.push("• " + note);
  if (j.payment?.transaction) lines.push(`Paid ${j.paidUsdc || "0.01"} USDC · tx ${j.payment.transaction}`);
  lines.push("Not financial advice: a locked LP does not rule out other risks in the token contract.");
  return lines.filter(Boolean).join("\n");
}

export const checkLpLockAction = {
  name: "CHECK_LP_LOCK",
  similes: ["LP_LOCK_CHECK", "RUG_CHECK", "IS_LIQUIDITY_LOCKED", "CHECK_LIQUIDITY_LOCK", "RUG_PULL_CHECK"],
  description:
    "Before buying or accepting a Base ERC-20 token, check whether its liquidity can be pulled: per pool (Uniswap V2, Aerodrome, AGIChainAI) the LP share burned, locked in UNCX / Team Finance / AGIChainAI lock (with unlock dates) and still removable, plus a rug-risk verdict. Costs $0.01 USDC on Base over x402.",
  validate: async (_runtime, message) => {
    const t = message?.content?.text || "";
    return ADDRESS.test(t) && INTENT.test(t);
  },
  handler: async (runtime, message, _state, _options, callback) => {
    const token = (message?.content?.text || "").match(ADDRESS)?.[0];
    if (!runtime.getSetting("AGENT_PRIVATE_KEY")) {
      const text = `LP lock check needs a wallet: set AGENT_PRIVATE_KEY to a wallet with a little USDC on Base ($0.01 per check, no gas). Free manual check: ${FREE_PAGE}?token=${token}`;
      await callback?.({ text });
      return { success: false, text };
    }
    try {
      const j = await lpTool(runtime).run({ token });
      const text = summarize(j);
      await callback?.({ text, actions: ["CHECK_LP_LOCK"] });
      return { success: true, text, data: j };
    } catch (e) {
      const text = `LP lock check failed: ${e.shortMessage || e.message}`;
      await callback?.({ text });
      return { success: false, text, error: text };
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Is the liquidity locked for 0x532f27101965dd16442E59d40670FaF5eBB142E4? Don't want a rug." } },
      { name: "{{agent}}", content: { text: "Checking the LP lock on Base…", actions: ["CHECK_LP_LOCK"] } },
    ],
    [
      { name: "{{user1}}", content: { text: "rug check 0x77c444d787400be0DCE69626ef1234ce7E0CEE80 before I buy" } },
      { name: "{{agent}}", content: { text: "Running the LP lock check…", actions: ["CHECK_LP_LOCK"] } },
    ],
  ],
};

export const lpLockPlugin = {
  name: "base-lp-lock",
  description: "Pre-trade LP lock / rug-pull check for Base tokens (burned, locked with unlock dates, removable), paid per call over x402.",
  actions: [checkLpLockAction],
};
export default lpLockPlugin;
