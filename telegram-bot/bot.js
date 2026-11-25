// AGIChainAI LP Check — Telegram botu (Cloudflare Worker).
// Gizli ayar: BOT_TOKEN. İsteğe bağlı: RPC_URL.
// Webhook gizli anahtarı jetondan türetilir; hiçbir yerde gösterilmez.
import { createPublicClient, http, isAddress, getAddress } from "viem";
import { base } from "viem/chains";
import { lpKilitAnalizi, BASE_LP } from "../x402-notary/src/lplock.js";
import { izlemeEkle, izlemeSil, tumIzlemeler, izlemeleriTara, IZLEME_GUN } from "../x402-notary/src/watch.js";

const SAYFA = "https://agichainai.com/exchange/lp-lock.html";
const API = "https://agichainai-notary.aslanklc04.workers.dev/lp-lock?token=";

async function gizliAnahtar(token) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("agi-tg:" + token));
  return [...new Uint8Array(d)].slice(0, 24).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const tg = (env, yontem, govde) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${yontem}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(govde),
  }).then((r) => r.json());

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const sayi = (x) => (x === null || x === undefined ? "–" : Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const ISARET = { LOW: "🟢", MEDIUM: "🟡", HIGH: "🔴", NOT_ASSESSED: "⚪", NO_LIQUIDITY: "⚫" };

const YARDIM =
  "<b>AGIChainAI LP Check</b>\n" +
  "Is a Base token's liquidity locked, burned or removable?\n\n" +
  "Send <code>/lpcheck 0x…token</code> or just paste a token address.\n\n" +
  "Free verdict from live on-chain reads (Uniswap V2/V3, Aerodrome, AGIChainAI; lockers UNCX, Team Finance, AGIChainAI lock).\n" +
  "Full pool-by-pool report: $0.01 USDC on the web page or over x402 for AI agents.\n\n" +
  "<b>Watch</b> a token for 30 days (free, up to 3 per chat): <code>/watch 0x…</code>. You get a message 7 days before an LP lock unlocks, when it unlocks, when the locked share or liquidity drops, or when the verdict changes. <code>/watches</code> lists them, <code>/unwatch 0x…</code> stops one.\n\n" +
  "Not financial advice.";

export function rapor(j) {
  const link = `${SAYFA}?token=${j.token.address}`;
  const satirlar = [
    `<b>${esc(j.token.name)} (${esc(j.token.symbol)})</b>`,
    `<code>${esc(j.token.address)}</code>`,
    "",
    `${ISARET[j.rugRisk] || "⚪"} <b>${esc(j.verdict.replace(/_/g, " "))}</b> · rug risk: <b>${esc(j.rugRisk.replace(/_/g, " "))}</b>`,
    esc(j.interpretation),
    "",
    `Protected LP (burned or locked): <b>${j.protectedPctWeightedByLiquidity === null ? "–" : sayi(j.protectedPctWeightedByLiquidity) + "%"}</b>`,
    `Liquidity: V2-style $${sayi(j.liquidityUsd.v2Style)} · Uniswap V3 $${sayi(j.liquidityUsd.v3)}`,
  ];
  for (const n of j.notes) satirlar.push("• " + esc(n));
  satirlar.push("", `<a href="${link}">Share / full report ($0.01)</a> · Not financial advice.`);
  return satirlar.join("\n");
}

const RPCLER = ["https://base.drpc.org", "https://1rpc.io/base", "https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.llamarpc.com", "https://base.meowrpc.com"];
async function analiz(env, adres) {
  const rpc = [env.RPC_URL, ...RPCLER].filter(Boolean);
  let son;
  // Her denemede tek bir uç nokta: biri hız sınırına takılırsa diğerine geç.
  for (const u of rpc) {
    try {
      const okur = createPublicClient({ chain: base, transport: http(u, { timeout: 10_000, retryCount: 0 }), batch: { multicall: true } });
      return await lpKilitAnalizi(okur, BASE_LP, getAddress(adres));
    } catch (e) {
      son = e;
      if (/not a contract|returned no data|reverted/i.test(String(e.shortMessage || e.message))) throw e;
    }
  }
  throw son;
}

function adresBul(metin) {
  const m = String(metin || "").match(/0x[0-9a-fA-F]{40}/);
  return m ? m[0] : null;
}

async function isle(env, guncelleme) {
  const msj = guncelleme.message || guncelleme.channel_post;
  if (!msj || !msj.text) return;
  const sohbet = msj.chat.id;
  const metin = msj.text.trim();
  const komut = metin.startsWith("/") ? metin.split(/[\s@]/)[0].toLowerCase() : null;
  const ozel = msj.chat.type === "private";
  if (komut === "/start" || komut === "/help") {
    await tg(env, "sendMessage", { chat_id: sohbet, text: YARDIM, parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }
  if (komut === "/watch" || komut === "/unwatch" || komut === "/watches") {
    const yanit = await izlemeKomutu(env, komut, sohbet, metin);
    await tg(env, "sendMessage", { chat_id: sohbet, reply_to_message_id: msj.message_id, text: yanit, parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }
  // Gruplarda yalnızca /lpcheck komutuna yanıt ver; özel sohbette çıplak adres de olur.
  if (komut !== "/lpcheck" && !(ozel && !komut)) return;
  const adres = adresBul(metin);
  if (!adres || !isAddress(adres)) {
    await tg(env, "sendMessage", { chat_id: sohbet, reply_to_message_id: msj.message_id, text: "Send a Base token address, e.g. /lpcheck 0x…" });
    return;
  }
  await tg(env, "sendChatAction", { chat_id: sohbet, action: "typing" });
  let yanit;
  try {
    yanit = rapor(await analiz(env, adres));
  } catch (e) {
    const m = String(e.shortMessage || e.message || e).split("\n")[0];
    yanit = /not a contract|returned no data|reverted/i.test(m) ? "That address is not an ERC-20 token on Base." : "Could not read the chain right now. Please try again in a minute.";
  }
  await tg(env, "sendMessage", { chat_id: sohbet, reply_to_message_id: msj.message_id, text: yanit, parse_mode: "HTML", disable_web_page_preview: true });
}

const SOHBET_SINIRI = 3;
async function izlemeKomutu(env, komut, sohbet, metin) {
  if (!env.WATCH_KV) return "Watching is not enabled yet.";
  const benim = (await tumIzlemeler(env.WATCH_KV)).filter((w) => w.hedef?.telegram === sohbet);
  if (komut === "/watches") {
    if (!benim.length) return "No active watches. Start one with <code>/watch 0x…</code>";
    return benim.map((w) => `• <code>${esc(w.token)}</code> — ${esc(w.son.verdict.replace(/_/g, " "))}, $${sayi(w.son.liquidityUsd)} liquidity, until ${new Date(w.bitis * 1000).toISOString().slice(0, 10)}`).join("\n");
  }
  const adres = adresBul(metin);
  if (komut === "/unwatch") {
    const sil = benim.filter((w) => /\ball\b/i.test(metin) || (adres && w.token.toLowerCase() === adres.toLowerCase()));
    for (const w of sil) await izlemeSil(env.WATCH_KV, w.id);
    return sil.length ? `Stopped ${sil.length} watch(es).` : "Nothing to stop. Use <code>/unwatch 0x…</code> or <code>/unwatch all</code>.";
  }
  if (!adres || !isAddress(adres)) return "Send <code>/watch 0x…</code> with a Base token address.";
  if (benim.some((w) => w.token.toLowerCase() === adres.toLowerCase())) return "Already watching that token here.";
  if (benim.length >= SOHBET_SINIRI) return `This chat already has ${SOHBET_SINIRI} watches. Stop one with <code>/unwatch 0x…</code>.`;
  let j;
  try { j = await analiz(env, adres); } catch (e) { return /not a contract|returned no data|reverted/i.test(String(e.shortMessage || e.message)) ? "That address is not an ERC-20 token on Base." : "Could not read the chain right now. Please try again in a minute."; }
  const { izleme, ilkOlaylar } = await izlemeEkle(env.WATCH_KV, { token: getAddress(adres), hedef: { telegram: sohbet } }, j, Math.floor(Date.now() / 1000));
  let t = `👀 Watching <b>${esc(j.token.symbol)}</b> for ${IZLEME_GUN} days. I'll message here if an LP lock is about to unlock or unlocks, if the locked share or liquidity drops, or if the verdict changes.\n\nNow: ${esc(j.verdict.replace(/_/g, " "))} · rug risk ${esc(j.rugRisk.replace(/_/g, " "))} · $${sayi(izleme.son.liquidityUsd)} liquidity`;
  for (const o of ilkOlaylar) t += `\n⚠️ ${esc(o.detail)}`;
  return t;
}

async function tarama(env) {
  if (!env.WATCH_KV || !env.BOT_TOKEN) return;
  const r = await izlemeleriTara(env.WATCH_KV, (t) => analiz(env, t), async (w, o, s) => {
    if (w.hedef?.telegram === undefined) return;
    const link = `${SAYFA}?token=${w.token}`;
    await tg(env, "sendMessage", { chat_id: w.hedef.telegram, text: `⚠️ <b>${esc(o.type.replace(/_/g, " "))}</b> · <code>${esc(w.token)}</code>\n${esc(o.detail)}\n\nNow: ${esc(s.verdict.replace(/_/g, " "))} · rug risk ${esc(s.rugRisk.replace(/_/g, " "))} · $${sayi(s.liquidityUsd)} liquidity\n<a href="${link}">Report</a> · Not financial advice.`, parse_mode: "HTML", disable_web_page_preview: true });
  }, Math.floor(Date.now() / 1000));
  console.log("TG_WATCH_SCAN", JSON.stringify(r));
}

export default {
  async scheduled(_e, env, ctx) { ctx.waitUntil(tarama(env)); },

  async fetch(istek, env, ctx) {
    const url = new URL(istek.url);
    if (!env.BOT_TOKEN) return Response.json({ error: "BOT_TOKEN not configured" }, { status: 503 });
    const anahtar = await gizliAnahtar(env.BOT_TOKEN);

    if (url.pathname === "/tg" && istek.method === "POST") {
      if (istek.headers.get("x-telegram-bot-api-secret-token") !== anahtar) return new Response("forbidden", { status: 403 });
      const g = await istek.json().catch(() => null);
      if (g) ctx.waitUntil(isle(env, g).catch(() => {}));
      return new Response("ok");
    }

    // Webhook'u ve bot bilgilerini (yeniden) kaydeder. Tekrar çağrılması zararsızdır.
    if (url.pathname === "/setup") {
      const w = await tg(env, "setWebhook", { url: `${url.origin}/tg`, secret_token: anahtar, allowed_updates: ["message", "channel_post"], drop_pending_updates: true });
      await tg(env, "setMyCommands", { commands: [{ command: "lpcheck", description: "Is this Base token's liquidity locked? /lpcheck 0x…" }, { command: "watch", description: "Alert me if this token's LP unlocks or is pulled: /watch 0x…" }, { command: "watches", description: "List this chat's watches" }, { command: "unwatch", description: "Stop a watch: /unwatch 0x… or all" }, { command: "help", description: "How it works" }] });
      await tg(env, "setMyShortDescription", { short_description: "Free check: is a Base token's liquidity locked, burned or removable? Rug-risk verdict from live on-chain data." });
      await tg(env, "setMyDescription", { description: "Paste a Base token address or send /lpcheck 0x… to see whether its liquidity is burned, in a known locker (UNCX, Team Finance, AGIChainAI) or removable, plus a rug-risk verdict. Free, live on-chain reads. Add me to your group. Not financial advice." });
      const bilgi = await tg(env, "getWebhookInfo", {});
      return Response.json({ setWebhook: w.ok, description: w.description, webhook: bilgi.result && { url: bilgi.result.url, pending: bilgi.result.pending_update_count, lastError: bilgi.result.last_error_message || null } });
    }

    if (url.pathname === "/check") {
      const a = url.searchParams.get("token") || "";
      if (!isAddress(a)) return Response.json({ error: "token query parameter required" }, { status: 400 });
      try { return Response.json(await analiz(env, a)); }
      catch (e) { return Response.json({ error: String(e.shortMessage || e.message || e).split("\n").slice(0, 3).join(" | ") }, { status: 502 }); }
    }

    return Response.json({ ok: true, bot: "https://t.me/AGIChainAI_LPCheck_bot", usage: "Telegram: /lpcheck 0x…" });
  },
};
