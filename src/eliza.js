// elizaOS plugin:
//   import { agiPlugin } from "agichainai-agent-tools/eliza";
//   character.plugins = [..., agiPlugin]
// Settings: AGI_RPC_URL (optional), AGENT_PRIVATE_KEY (optional; read-only without it),
//           AGI_MAX_ETH_PER_SWAP, AGI_MAX_AGI_PER_TX (optional)
import { ModelType } from "@elizaos/core";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createViemAgiTools } from "./viem.js";

const WRITE = new Set(["agi_buy", "agi_sell", "agi_submit_task", "agi_notarize", "agi_register_agent"]);
const KEYWORDS = /\bagi\b|agichainai|notar|task board|bounty|agent directory/i;

let shared = null;
function toolsFor(runtime) {
  if (shared?.runtime === runtime) return shared.tools;
  const s = (k) => runtime.getSetting(k) || undefined;
  const limits = {};
  if (s("AGI_MAX_ETH_PER_SWAP")) limits.maxEthPerSwap = s("AGI_MAX_ETH_PER_SWAP");
  if (s("AGI_MAX_AGI_PER_TX")) limits.maxAgiPerTx = s("AGI_MAX_AGI_PER_TX");
  const tools = createViemAgiTools({ rpcUrl: s("AGI_RPC_URL"), privateKey: s("AGENT_PRIVATE_KEY"), limits });
  shared = { runtime, tools };
  return tools;
}

function toAction(t) {
  const schema = zodToJsonSchema(t.schema, { target: "openApi3" });
  const empty = Object.keys(t.schema.shape).length === 0;
  return {
    name: t.name.toUpperCase(),
    similes: [t.name],
    description: t.description,
    validate: async (runtime, message) => {
      if (WRITE.has(t.name) && !runtime.getSetting("AGENT_PRIVATE_KEY")) return false;
      return KEYWORDS.test(message?.content?.text || "");
    },
    handler: async (runtime, message, state, options, callback) => {
      try {
        let args = {};
        if (!empty) {
          args = await runtime.useModel(ModelType.OBJECT_SMALL, {
            prompt: `Extract the arguments for the tool "${t.name}" (${t.description}) from this request. ` +
              `Use only values the user actually stated; leave optional fields out otherwise.\n\nRequest: ${message.content.text}`,
            schema,
          });
        }
        const result = await t.run(args);
        const text = `${t.name}: ${JSON.stringify(result, null, 2)}`;
        await callback?.({ text, actions: [t.name.toUpperCase()] });
        return { success: true, text, data: result };
      } catch (e) {
        const text = `${t.name} failed: ${e.shortMessage || e.message}`;
        await callback?.({ text });
        return { success: false, text, error: text };
      }
    },
    examples: [],
  };
}

// descriptions/schemas are static; build them once from a read-only instance
const proto = createViemAgiTools({});
export const agiPlugin = {
  name: "agichainai",
  description: "Use the AGI token on Base: live price, buy/sell on the AGIChainAI exchange, paid tasks, on-chain notary, agent directory.",
  actions: proto.map((t) => ({
    ...toAction(t),
    handler: (runtime, ...rest) => toAction(toolsFor(runtime).find((x) => x.name === t.name)).handler(runtime, ...rest),
  })),
};
export default agiPlugin;
