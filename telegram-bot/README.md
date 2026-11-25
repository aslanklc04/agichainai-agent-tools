# AGIChainAI LP Check — Telegram bot

Cloudflare Worker behind https://t.me/AGIChainAI_LPCheck_bot. `/lpcheck 0x…` returns a free LP lock verdict for a Base token.

Secret: `BOT_TOKEN` (from @BotFather). Optional: `RPC_URL`. After deploying, open `/setup` once to register the webhook. The webhook secret is derived from the token and never shown.

Build: `esbuild bot.js --bundle --minify --format=esm --platform=neutral --main-fields=module,main --conditions=worker,browser --outfile=dist/worker.js`
