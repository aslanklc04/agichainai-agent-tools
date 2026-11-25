// ERC-8257 araç manifestoları (OpenSea Agent Tool Registry).
// Değiştirilirse zincirdeki manifestHash de güncellenmelidir (updateToolMetadata).
const KOK = "https://agichainai-notary.aslanklc04.workers.dev";
const OLUSTURAN = "0x0f3a5d0f1977c2b3863a6903ed18568c55700426";
const ODEME = "eip155:8453:0x36fbcbb32e384f147919ffbaa918314d9b0c04b6";
const USDC = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TIP = "https://ercs.ethereum.org/ERCS/erc-8257#tool-manifest-v1";

export const TOOL_MANIFESTS = {
  "base-lp-lock-check": {
    type: TIP,
    name: "Base LP Lock Check",
    description:
      "Is a Base token's liquidity really locked? Checks every Uniswap V2, Aerodrome and AGIChainAI pool against WETH/USDC: share of LP burned, share in known lockers (UNCX, Team Finance, AGIChainAI) with unlock dates, share still removable, gauge staking, USD liquidity, V3 pools, a verdict and a rug-risk level. Live on-chain reads. Nothing is charged for an invalid token.",
    endpoint: KOK + "/lp-lock",
    inputs: {
      type: "object",
      properties: { token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "ERC-20 token address on Base" } },
      required: ["token"],
    },
    outputs: {
      type: "object",
      properties: {
        verdict: { type: "string", description: "LOCKED_OR_BURNED, MOSTLY_LOCKED, PARTIAL, NOT_LOCKED, MAIN_LIQUIDITY_IN_V3 or NO_POOL" },
        rugRisk: { type: "string", description: "LOW, MEDIUM, HIGH, NOT_ASSESSED or NO_LIQUIDITY" },
        protectedPctWeightedByLiquidity: { type: ["number", "null"] },
        v2Pools: { type: "array" },
        v3Pools: { type: "array" },
        liquidityUsd: { type: "object" },
        notes: { type: "array" },
      },
    },
    version: "1.0.0",
    image: "https://agichainai.com/assets/agi-token-256.png",
    tags: ["security", "defi", "trading", "rug-pull", "liquidity-lock", "token-safety", "base"],
    pricing: [{ amount: "10000", asset: USDC, recipient: ODEME, protocol: "x402" }],
    creatorAddress: OLUSTURAN,
  },
  "base-notary-timestamp": {
    type: TIP,
    name: "Base Notary Timestamp",
    description:
      "Timestamp a SHA-256 hash on Base: proves the exact data existed no later than the recorded block. Send {hash, label}. The first record of a hash wins; the data itself never leaves your agent. Free lookup at GET /record/{hash}. The fee buys and burns AGI.",
    endpoint: KOK + "/notarize",
    inputs: {
      type: "object",
      properties: {
        hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "SHA-256 of your data, 0x-prefixed" },
        label: { type: "string", maxLength: 50, description: "Optional short label stored with the record" },
      },
      required: ["hash"],
    },
    outputs: {
      type: "object",
      properties: { ok: { type: "boolean" }, hash: { type: "string" }, transaction: { type: "string", description: "Base transaction that recorded the hash" }, record: { type: "object" }, payment: { type: "object" } },
    },
    version: "1.0.0",
    image: "https://agichainai.com/assets/agi-token-256.png",
    tags: ["ai", "security", "notary", "timestamp", "proof-of-existence", "base"],
    pricing: [{ amount: "20000", asset: USDC, recipient: ODEME, protocol: "x402" }],
    creatorAddress: OLUSTURAN,
  },
};
