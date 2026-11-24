// Cloudflare Workers girişi. Gizli değişken: SERVICE_PRIVATE_KEY (yalnızca küçük bakiyeli hizmet cüzdanı).
import { base } from "viem/chains";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { uygulamaKur } from "./app.js";
import { BASE_LP } from "./lplock.js";

const BASE = {
  noterUsdc: "0x722CC9E982008e55612fB86E184B1730ec9a26Cc",
  noterAgi: "0x246a17b76e5F3cdF960683f70D1169677488f514",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  agi: "0x77c444d787400be0DCE69626ef1234ce7E0CEE80",
  quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  router02: "0x2626664c2603336E57B271c5C0b26F421741e481",
};

// Her istek kendi istemcilerini kurar: Workers'ta istekler arası paylaşılan bekleyen G/Ç takılmaya yol açar.
function kur(env, url) {
  let onbellek;
  if (!env.SERVICE_PRIVATE_KEY) throw new Error("SERVICE_PRIVATE_KEY secret is not set");
  onbellek = uygulamaKur({
    chain: base,
    network: "eip155:8453",
    rpcUrl: (env.RPC_URL ? [env.RPC_URL] : []).concat([
      "https://base-rpc.publicnode.com",
      "https://base.drpc.org",
      "https://mainnet.base.org",
      "https://1rpc.io/base",
      "https://base.llamarpc.com",
    ]),
    privateKey: env.SERVICE_PRIVATE_KEY.startsWith("0x") ? env.SERVICE_PRIVATE_KEY : "0x" + env.SERVICE_PRIVATE_KEY,
    // Coinbase (CDP) anahtarları girilmişse Coinbase'in ödeme onayı kullanılır (Bazaar kataloğuna giriş bunu ister); yoksa PayAI.
    facilitator: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
      ? new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET))
      : new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || "https://facilitator.payai.network" }),
    facilitatorName: env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET ? "coinbase-cdp" : "payai",
    price: env.PRICE || "$0.02",
    adres: BASE,
    lp: BASE_LP,
    lpPrice: env.LP_PRICE || "$0.01",
    publicUrl: env.PUBLIC_URL || new URL(url).origin,
  });
  return onbellek;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await kur(env, request.url).app.fetch(request, env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ error: "service not configured" }), { status: 503, headers: { "content-type": "application/json" } });
    }
  },
};
