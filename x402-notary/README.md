# AGIChainAI x402 Notary

A pay-per-call notary for AI agents. An agent sends the SHA-256 fingerprint of a file or report and pays **$0.02 USDC on Base over [x402](https://x402.org)**. No account, API key, wallet setup or AGI is needed. The fingerprint is written to the verified [AGIChainAI USDC notary](https://basescan.org/address/0x722CC9E982008e55612fB86E184B1730ec9a26Cc). That contract uses its 0.01 USDC fee to buy AGI on Uniswap and burn it.

## Endpoints

| Method | Path | Price | |
|---|---|---|---|
| POST | `/notarize` | $0.02 USDC (x402 `exact`, Base) | body `{"hash":"0x…64 hex","label":"optional, ≤50 ASCII chars"}` |
| GET | `/lp-lock?token=0x…` | $0.01 USDC (x402 `exact`, Base) | Is a Base token's liquidity locked? Returns burned / locked (UNCX, Team Finance, AGIChainAI lock, with unlock dates) / removable LP share for Uniswap V2, Aerodrome and AGIChainAI pools, Aerodrome gauge staking, USD liquidity, V3 pools, a `verdict` and a `rugRisk`. Nothing is charged for an invalid token. Half of the accumulated fees buy and burn AGI. |
| GET | `/record/{hash}` | free | whether and when a fingerprint was recorded (checks both AGIChainAI notaries) |
| GET | `/status` | free | service wallet balances, record count |
| GET | `/` | free | description |
| GET | `/openapi.json`, `/.well-known/x402` | free | discovery documents (x402scan, Bazaar) |

```js
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
const r = await pay(URL + "/notarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hash }) });
```

## Guarantees

- **Nothing is charged unless the record can be written.** Bad input (400), an already-recorded hash (409) and a service that cannot record right now (503) all return before payment. The service also simulates the on-chain write before it settles the payment.
- **The payment is settled before the work is done**, so unpaid or unsettleable payments never cause a write.
- Only the fingerprint goes on-chain, never the content. The record's label shows `x402:<payer address>`.

## Run and deploy

- `npm test`: end-to-end test against a local Hardhat chain, with a real x402 client and a local facilitator (16 checks).
- `npm run build`: bundles the worker to `dist/`. `dist/worker.js` is the bundle deployed on Cloudflare.
- Secret: `SERVICE_PRIVATE_KEY`, a dedicated low-balance service wallet. It needs only a little ETH for gas (about 0.000003 ETH per record on Base) and no starting USDC: each payment is settled before the write and covers the notary fee. Before taking payment, the service simulates the write and checks that its gas balance covers the estimated cost. Settlement goes through the Coinbase CDP facilitator when the `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` secrets are set; this is required for a Bazaar listing. Otherwise it goes through PayAI (`FACILITATOR_URL`).
