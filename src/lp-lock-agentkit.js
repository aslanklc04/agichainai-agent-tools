// Coinbase AgentKit action provider: pre-trade LP lock / rug-pull check for Base tokens.
//   import { lpLockActionProvider } from "agichainai-agent-tools/agentkit-lp-lock";
//   const agentkit = await AgentKit.from({ walletProvider, actionProviders: [lpLockActionProvider()] });
// Pays $0.01 USDC on Base per call over x402 with the wallet provider's EIP-712 signature (no gas).
// Option: maxX402Usd (default 0.05) — the action refuses to pay more than this per call.
import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { createAgiTools } from "./core.js";

export function lpLockActionProvider({ maxX402Usd } = {}) {
  const limits = maxX402Usd ? { maxX402Usd } : undefined;
  const cache = new WeakMap();
  const toolFor = (wp) => {
    if (cache.has(wp)) return cache.get(wp);
    const net = wp.getNetwork?.();
    if (net?.chainId && String(net.chainId) !== "8453") throw new Error(`LP lock check pays on Base mainnet; wallet is on chain ${net.chainId}`);
    if (!wp.signTypedData) throw new Error("This wallet provider cannot sign EIP-712 typed data, which x402 payments need.");
    const all = createAgiTools({
      limits,
      read: (p) => wp.readContract(p),
      account: async () => wp.getAddress(),
      signTypedData: (td) => wp.signTypedData(td),
      signMessage: wp.signMessage ? (m) => wp.signMessage(m) : undefined,
      send: async () => { throw new Error("not used"); },
    });
    const tool = Object.fromEntries(all.map((t) => [t.name, t]));
    cache.set(wp, tool);
    return tool;
  };
  return customActionProvider([
    {
      name: "check_token_safety",
      description:
        "Pre-trade safety check before buying or accepting a Base ERC-20: simulates buy → wallet transfer → sell against the real pool (honeypot, buy/sell/transfer tax), detects owner powers (mint, blacklist, pause, fee change, trading switch) and upgradeable proxies, and checks whether LP is burned, locked or removable. Returns verdict SAFE / CAUTION / DANGER / UNVERIFIED, a 0-100 score and the risks. Free with an active 30-day AGI pass (burn 1,000,000 AGI; signed holder header); otherwise $0.01 USDC on Base over x402 (signature only, no gas).",
      schema: z.object({ token: z.string().describe("ERC-20 token address on Base (0x…)") }),
      invoke: async (walletProvider, { token }) => {
        try {
          return JSON.stringify(await toolFor(walletProvider).agi_token_check.run({ token }));
        } catch (e) {
          return "Error: " + (e.shortMessage || e.message);
        }
      },
    },
    {
      name: "check_lp_lock",
      description:
        "Rug-pull check before buying or accepting a Base ERC-20 token: is its liquidity locked? Returns, for every Uniswap V2, Aerodrome and AGIChainAI pool, the LP share burned, locked in UNCX / Team Finance / AGIChainAI lock (with unlock dates) and still removable, USD liquidity, V3 pools, a verdict (LOCKED_OR_BURNED, MOSTLY_LOCKED, PARTIAL, NOT_LOCKED, MAIN_LIQUIDITY_IN_V3, NO_POOL) and a rugRisk (LOW, MEDIUM, HIGH, NOT_ASSESSED, NO_LIQUIDITY). Costs $0.01 USDC on Base over x402 (signature only, no gas). Nothing is charged for an invalid token.",
      schema: z.object({ token: z.string().describe("ERC-20 token address on Base (0x…)") }),
      invoke: async (walletProvider, { token }) => {
        try {
          return JSON.stringify(await toolFor(walletProvider).agi_lp_lock_check.run({ token }));
        } catch (e) {
          return "Error: " + (e.shortMessage || e.message);
        }
      },
    },
  ]);
}
export default lpLockActionProvider;
