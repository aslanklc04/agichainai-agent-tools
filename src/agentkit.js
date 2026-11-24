// Coinbase AgentKit adapter:
//   import { agiActionProvider } from "agichainai-agent-tools/agentkit";
//   const agentkit = await AgentKit.from({ walletProvider, actionProviders: [agiActionProvider()] });
// Signing goes through the AgentKit wallet provider (CDP, Privy, viem ...); no key is handled here.
import { customActionProvider } from "@coinbase/agentkit";
import { createAgiTools } from "./core.js";

export function agiActionProvider({ limits, addresses } = {}) {
  let cache = null;
  const toolsFor = (wp) => {
    if (cache?.wp === wp) return cache.tools;
    const net = wp.getNetwork?.();
    const want = String(addresses?.chainId ?? 8453);
    if (net?.chainId && String(net.chainId) !== want) throw new Error(`AGI tools run on Base mainnet; wallet is on chain ${net.chainId}`);
    const tools = createAgiTools({
      addresses, limits,
      read: (p) => wp.readContract(p),
      getEthBalance: wp.getAddress ? async (a) => (a.toLowerCase() === wp.getAddress().toLowerCase() ? wp.getBalance() : undefined) : undefined,
      account: async () => wp.getAddress(),
      signTypedData: wp.signTypedData ? (td) => wp.signTypedData(td) : undefined,
      send: async (tx) => {
        const hash = await wp.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
        const r = await wp.waitForTransactionReceipt(hash);
        return { hash, status: r.status };
      },
    });
    cache = { wp, tools };
    return tools;
  };
  // tool list is static, so build descriptions/schemas from a read-only instance
  const proto = createAgiTools({ read: async () => { throw new Error("unused"); }, limits, addresses });
  return customActionProvider(proto.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.schema,
    invoke: async (walletProvider, args) => {
      try {
        const tool = toolsFor(walletProvider).find((x) => x.name === t.name);
        return JSON.stringify(await tool.run(args));
      } catch (e) {
        return "Error: " + (e.shortMessage || e.message);
      }
    },
  })));
}
