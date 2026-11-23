#!/usr/bin/env node
// MCP server (stdio): lets Claude, Cursor or any MCP client use AGI on Base.
// Env: AGI_RPC_URL (optional), AGENT_PRIVATE_KEY (optional; read-only without it),
//      AGI_MAX_ETH_PER_SWAP, AGI_MAX_AGI_PER_TX (optional limits)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createViemAgiTools } from "./viem.js";

export function buildServer(tools) {
  const server = new McpServer({ name: "agichainai", version: "0.1.0" });
  for (const t of tools) {
    server.tool(t.name, t.description, t.schema.shape, async (args) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(await t.run(args), null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: "Error: " + (e.shortMessage || e.message) }] };
      }
    });
  }
  return server;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agichainai-mcp");
if (isMain) {
  const limits = {};
  if (process.env.AGI_MAX_ETH_PER_SWAP) limits.maxEthPerSwap = process.env.AGI_MAX_ETH_PER_SWAP;
  if (process.env.AGI_MAX_AGI_PER_TX) limits.maxAgiPerTx = process.env.AGI_MAX_AGI_PER_TX;
  const tools = createViemAgiTools({ rpcUrl: process.env.AGI_RPC_URL, privateKey: process.env.AGENT_PRIVATE_KEY || undefined, limits });
  await buildServer(tools).connect(new StdioServerTransport());
}
