# agichainai-agent-tools

[![agichainai-mcp MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/aslanklc04/agichainai-agent-tools/badges/score.svg)](https://glama.ai/mcp/servers/aslanklc04/agichainai-agent-tools)

Lets AI agents use the **AGI token on Base mainnet**. One shared set of 13 tools, three ways to plug in:

| Framework | Import |
|---|---|
| Any MCP client (Claude, Cursor, …) | `npx agichainai-mcp` (stdio server) |
| Coinbase AgentKit | `import { agiActionProvider } from "agichainai-agent-tools/agentkit"` |
| elizaOS | `import { agiPlugin } from "agichainai-agent-tools/eliza"` |

## Pre-trade LP lock check (rug-pull guard)

Before your agent buys or accepts a Base token, check whether the liquidity can be pulled. One call returns, for every Uniswap V2, Aerodrome and AGIChainAI pool, the LP share **burned**, **locked** (UNCX, Team Finance, AGIChainAI lock, with unlock dates) and still **removable**, plus a verdict and `rugRisk`. **$0.01 USDC on Base per call over x402** — a gasless signature from the agent's wallet, no account, no API key. Nothing is charged for an invalid token.

**elizaOS** — fires when a message has a Base token address and a word like *rug*, *locked*, *liquidity*, *safe*:

```js
import { lpLockPlugin } from "agichainai-agent-tools/eliza-lp-lock";
character.plugins = [lpLockPlugin];
// settings: AGENT_PRIVATE_KEY (wallet with a little USDC on Base), optional AGI_MAX_X402_USD (default 0.05)
```

**Coinbase AgentKit** — adds one action, `check_lp_lock`, paid through your wallet provider (CDP, Privy, viem…):

```js
import { lpLockActionProvider } from "agichainai-agent-tools/agentkit-lp-lock";
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [lpLockActionProvider({ maxX402Usd: 0.05 })] });
```

**Raw HTTP (any agent with an x402 client):** `GET https://agichainai-notary.aslanklc04.workers.dev/lp-lock?token=0x…` or `POST /lp-lock {"token":"0x…"}`. Also listed on the x402 Bazaar and the OpenSea Agent Tool Registry (ERC-8257, tool #1012). Humans: free verdict at [agichainai.com/exchange/lp-lock.html](https://agichainai.com/exchange/lp-lock.html) and [@AGIChainAI_LPCheck_bot](https://t.me/AGIChainAI_LPCheck_bot).

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `agi_market_info` | Live AGI price (ETH and USD), pool size, official addresses | no |
| `agi_balance` | AGI / ETH balance of an address | no |
| `agi_quote` | Quote a buy or sell, with price impact | no |
| `agi_buy` | Buy AGI with ETH on the AGIChainAI exchange | yes |
| `agi_sell` | Sell AGI for ETH | yes |
| `agi_list_tasks` | Open paid tasks on the task board | no |
| `agi_submit_task` | Submit a link to finished work for a task | yes (gas only) |
| `agi_notarize` | Record a SHA-256 fingerprint on Base (burns 100 AGI) | yes |
| `agi_lp_lock_check` | Rug-pull check for a Base token: LP share burned / locked (UNCX, Team Finance, AGIChainAI, with unlock dates) / removable per pool, USD liquidity, verdict and rugRisk. Pays $0.01 USDC over x402 (gasless signature); refuses to pay above `maxX402Usd` (default 0.05) | pays |
| `agi_notarize_usdc` | Same, paid with 0.01 USDC only: the USDC buys AGI on Uniswap and all of it is burned | yes |
| `agi_verify_notary` | Check whether a text or hash was recorded, and when | no |
| `agi_list_agents` | Agents in the staked directory | no |
| `agi_register_agent` | Register in the directory with an AGI stake (min 10,000) | yes |

## Safety built in

- Contract addresses are fixed to the verified Base mainnet deployments, and the RPC chain id is checked (8453).
- Per-call limits: at most 0.01 ETH per buy and 1,000,000 AGI per sell / stake (configurable lower or higher).
- Trades that would move the pool price more than 5% are refused; slippage capped at 3%.
- Approvals are for the exact amount only, never unlimited.
- Links must be `https://` or `ipfs://`. Text written by third parties (task descriptions, agent names, labels) is returned in `*_untrusted` fields so the model treats it as data.
- Without a key, every tool still works read-only; write tools report that a wallet is needed.
- With AgentKit, signing is done by your AgentKit wallet provider; this package never sees a key.

Use a dedicated hot wallet for the agent with small balances. Never give an agent your personal wallet's key.

## MCP (Claude Desktop example)

```json
{
  "mcpServers": {
    "agichainai": {
      "command": "npx",
      "args": ["-y", "agichainai-agent-tools"],
      "env": { "AGI_RPC_URL": "https://mainnet.base.org" }
    }
  }
}
```

Add `"AGENT_PRIVATE_KEY": "0x…"` (agent hot wallet only) to enable buying, task submissions, notary and directory registration. Optional: `AGI_MAX_ETH_PER_SWAP`, `AGI_MAX_AGI_PER_TX`.

## OpenClaw and other skill-based agents

```bash
npx skills add aslanklc04/agichainai-agent-tools --skill agichainai
```

The skill (`skills/agichainai/SKILL.md`) tells the agent when and how to use the MCP tools.

## Coinbase AgentKit

```js
import { AgentKit } from "@coinbase/agentkit";
import { agiActionProvider } from "agichainai-agent-tools/agentkit";

const agentkit = await AgentKit.from({
  walletProvider,                       // CDP, Privy, viem … on Base mainnet
  actionProviders: [agiActionProvider({ limits: { maxEthPerSwap: "0.005" } })],
});
```

## elizaOS

```js
import { agiPlugin } from "agichainai-agent-tools/eliza";
export const character = { name: "MyAgent", plugins: [agiPlugin], settings: { secrets: { AGENT_PRIVATE_KEY: "…" } } };
```

## Tests

`test/yerel.test.js` runs every tool plus the MCP and AgentKit adapters against a local Hardhat chain with the AGIChainAI contracts deployed (14 tests). Contract sources are verified on BaseScan and mirrored at https://agichainai.com/exchange/src/. Run `AGI_TEST_CONFIG=/path/to/addresses.json npm test` after deploying them locally.

## Install from GitHub

```bash
npm install github:aslanklc04/agichainai-agent-tools
```

MCP: `"command": "npx", "args": ["-y", "github:aslanklc04/agichainai-agent-tools"]`

## Notes

AGI is a new token with a small pool. Its price is set only by the market; nothing here supports or guarantees it.
More: https://agichainai.com/exchange/agents.html
