import { isAddress } from "viem";
import { gasBilgisi, fiyatBilgisi, bakiyeBilgisi } from "./basedata.js";
import { tokenKontrol } from "./tokencheck.js";
import { holderDogrula, ipSiniri, HOLDER_MESAJ, gecisEtkinlestir, gecisDurumu, GECIS_GUN } from "./holder.js";
// AGIChainAI x402 Notary — ajanlar USDC ile öder, kayıt Base'deki AGI noterine yazılır ve ücretin bir kısmı AGI alıp yakar.
// Akış (ödeme ÖNCE tahsil edilir): istek → doğrulama → (ödeme yoksa 402) → ödeme doğrula → ödemeyi tahsil et → zincire yaz.
import { izlemeEkle, izlemeOku, izlemeleriTara, olayGovdesi, webhookGecerli, IZLEME_GUN } from "./watch.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { x402ResourceServer } from "@x402/core/server";
import {
  decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createPublicClient, createWalletClient, http, fallback, getAddress, isHex, parseAbi, formatUnits, formatEther, encodeAbiParameters, keccak256, toHex, pad } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lpKilitAnalizi } from "./lplock.js";
import { cuzdanOlc, tokenKesfet, tokenListesi, bekciEkle, bekciOku, bekcileriTara, olayGovdesi as bekciGovdesi, GUARD_GUN, MAX_TOKEN, OLAY_TURLERI } from "./exitguard.js";

export const SURUM = "1.4.0";

const NOTER_USDC_ABI = parseAbi([
  "function kaydet(bytes32 ozet, string etiket, uint256 asgariAgi) returns (uint256)",
  "function kayit(bytes32 ozet) view returns ((address kaydeden, uint64 zaman, uint64 blok, uint256 yakilanAgi, string etiket))",
  "function UCRET() view returns (uint256)",
  "function HAVUZ_UCRETI() view returns (uint24)",
  "function AZAMI_ETIKET() view returns (uint256)",
  "function kayitSayisi() view returns (uint256)",
  "function toplamYakilan() view returns (uint256)",
]);
const NOTER_AGI_ABI = parseAbi([
  "function kayit(bytes32 ozet) view returns ((address kaydeden, uint64 zaman, uint64 blok, string etiket))",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const ROUTER02_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);
const YAKMA_ADRESI = "0x000000000000000000000000000000000000dEaD";
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);

const SIFIR = "0x" + "0".repeat(64);
const ASGARI_ETH = 5_000_000_000_000n; // 0,000005 ETH: Base'de birkaç kaydın gazı
const ONAY_MIKTARI = 1_000_000n; // noterin bir kerede çekebileceği en fazla USDC: 1 USDC (100 kayıt)

const json = (c, body, status = 200, headers = {}) => {
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  c.header("Cache-Control", "no-store");
  return c.json(body, status);
};

function etiketHazirla(payer, etiket) {
  // Zincirdeki kaydı yapan hizmet cüzdanıdır; ödeyen ajan etikete yazılır ki herkes görebilsin.
  let e = `x402:${payer}`;
  if (etiket) e += " " + etiket;
  const enc = new TextEncoder();
  while (enc.encode(e).length > 100) e = e.slice(0, -1);
  return e;
}

/**
 * @param {object} ay
 *  rpcUrl, network ("eip155:8453"), privateKey, facilitator (FacilitatorClient), price (string|AssetAmount),
 *  adres: { noterUsdc, noterAgi, usdc, agi, quoter }, publicUrl, chain (viem chain)
 */
export function uygulamaKur(ay) {
  const hesap = privateKeyToAccount(ay.privateKey);
  // Fiyat USDC'nin en küçük biriminde (6 ondalık): "$0.02" → 20000
  ay.fiyatHam = typeof ay.price === "string" ? BigInt(Math.round(Number(ay.price.replace("$", "")) * 1e6)) : BigInt(ay.price.amount);
  // Genel RPC'ler hız sınırı koyabilir: birkaç adres arasında otomatik geçiş ve yeniden deneme.
  const rpcler = (Array.isArray(ay.rpcUrl) ? ay.rpcUrl : [ay.rpcUrl]).filter(Boolean);
  const tasima = rpcler.length > 1
    // Not: Cloudflare Workers'ta bir isteğin başlattığı G/Ç'yi başka istek bekleyemez; bu yüzden arka planda ölçüm yapan "rank" kullanılmaz
    // ve uygulama her istekte yeniden kurulur (bkz. index.js).
    ? fallback(rpcler.map((u) => http(u, { retryCount: 1, retryDelay: 300, timeout: 4_000, batch: { wait: 10 } })), { rank: false, retryCount: 2, retryDelay: 400 })
    : http(rpcler[0], { retryCount: 3, timeout: 10_000, batch: { wait: 10 } });
  // Aynı anda yapılan okumalar tek RPC isteğinde toplanır (multicall) — hız sınırına takılma azalır.
  const okur = createPublicClient({ chain: ay.chain, transport: tasima, batch: { multicall: { wait: 10 } } });
  const yazar = createWalletClient({ account: hesap, chain: ay.chain, transport: tasima });
  const A = Object.fromEntries(Object.entries(ay.adres).map(([k, v]) => [k, getAddress(v)]));
  const sunucu = new x402ResourceServer(ay.facilitator).register(ay.network, new ExactEvmScheme());
  sunucu.registerExtension(bazaarResourceServerExtension);
  const fiyatUsd = (Number(ay.fiyatHam) / 1e6).toFixed(2);
  let hazir = null;
  const hazirla = () => (hazir ??= sunucu.initialize().catch((e) => { hazir = null; throw e; }));

  const kayitBul = async (ozet) => {
    const [u, a] = await Promise.all([
      okur.readContract({ address: A.noterUsdc, abi: NOTER_USDC_ABI, functionName: "kayit", args: [ozet] }),
      A.noterAgi ? okur.readContract({ address: A.noterAgi, abi: NOTER_AGI_ABI, functionName: "kayit", args: [ozet] }) : null,
    ]);
    const bicim = (k, noter, yakilan) => ({
      recorded: true, notary: noter, recordedBy: k.kaydeden, timestamp: Number(k.zaman),
      time: new Date(Number(k.zaman) * 1000).toISOString(), block: Number(k.blok), label: k.etiket,
      ...(yakilan !== undefined ? { agiBurned: formatEther(yakilan) } : {}),
    });
    if (u && u.zaman > 0n) return bicim(u, A.noterUsdc, u.yakilanAgi);
    if (a && a.zaman > 0n) return bicim(a, A.noterAgi);
    return null;
  };

  // USDC sözleşmesinde hizmet cüzdanının bakiyesinin tutulduğu depolama slotunu bulur (mapping slotu 0–20 denenir).
  let slotOnbellek = null;
  const bakiyeSlotu = async () => {
    if (slotOnbellek) return slotOnbellek;
    const deneme = 123_456_789n;
    for (let i = 0n; i <= 20n; i++) {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [hesap.address, i]));
      try {
        const v = await okur.readContract({ address: A.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [hesap.address], stateOverride: [{ address: A.usdc, stateDiff: [{ slot, value: pad(toHex(deneme), { size: 32 }) }] }] });
        if (v === deneme) return (slotOnbellek = slot);
      } catch {}
    }
    throw new Error("could not locate USDC balance slot");
  };

  let sabitler = null;
  let sonTahsil = null; // tanı için: son tahsilatta Coinbase'in katalog (bazaar) yanıtı
  // İzin yoksa verir, fiyat teklifi alır ve kaydı simüle eder; kayma payı %5.
  const zincirHazirla = async (ozet, etiketHam) => {
    // UCRET ve HAVUZ_UCRETI değişmez (immutable): bir kez okunur.
    sabitler ??= await Promise.all([
      okur.readContract({ address: A.noterUsdc, abi: NOTER_USDC_ABI, functionName: "UCRET" }),
      okur.readContract({ address: A.noterUsdc, abi: NOTER_USDC_ABI, functionName: "HAVUZ_UCRETI" }),
    ]).catch((e) => { sabitler = null; throw e; });
    const [ucret, havuz] = sabitler;
    const [izin, bakiye] = await Promise.all([
      okur.readContract({ address: A.usdc, abi: ERC20_ABI, functionName: "allowance", args: [hesap.address, A.noterUsdc] }),
      okur.readContract({ address: A.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [hesap.address] }),
    ]);
    // Cüzdanda henüz USDC yoksa sorun değil: ödeme (fiyat ≥ noter ücreti) yazmadan önce tahsil edilir.
    // Simülasyonda bu gelecek bakiye, USDC'nin bakiye slotu geçersiz kılınarak (state override) gösterilir.
    let gecersizKil;
    if (bakiye < ucret) {
      if (ay.fiyatHam < ucret) throw new Error("price is below the notary fee");
      const slot = await bakiyeSlotu();
      gecersizKil = [{ address: A.usdc, stateDiff: [{ slot, value: pad(toHex(ucret), { size: 32 }) }] }];
    }
    if (izin < ucret) {
      const h = await yazar.writeContract({ address: A.usdc, abi: ERC20_ABI, functionName: "approve", args: [A.noterUsdc, ONAY_MIKTARI] });
      const m = await okur.waitForTransactionReceipt({ hash: h });
      if (m.status !== "success") throw new Error("approve failed");
    }
    const { result } = await okur.simulateContract({ address: A.quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: A.usdc, tokenOut: A.agi, amountIn: ucret, fee: havuz, sqrtPriceLimitX96: 0n }] });
    const asgari = (result[0] * 95n) / 100n;
    if (asgari === 0n) throw new Error("no AGI liquidity");
    const kayitArg = { account: hesap, address: A.noterUsdc, abi: NOTER_USDC_ABI, functionName: "kaydet", args: [ozet, etiketHazirla("0x" + "0".repeat(40), etiketHam), asgari], stateOverride: gecersizKil };
    await okur.simulateContract(kayitArg);
    // Gaz parası gerçekten yetiyor mu? (tahmin × en yüksek ücret × 1,5 güvenlik payı)
    // (bakiye geçersiz kılınıyorsa her düğüm gaz tahmininde bunu desteklemez; o durumda cömert sabit 400k gaz kullanılır)
    // Gaz tahmini (eth_estimateGas) genel RPC'lerde en sık reddedilen çağrı: kayıt ~250k gaz harcar, 400k sabit pay kullanılır.
    const gaz = 400_000n;
    const [ucretler, eth] = await Promise.all([okur.estimateFeesPerGas(), okur.getBalance({ address: hesap.address })]);
    const gerekli = (gaz * (ucretler.maxFeePerGas ?? ucretler.gasPrice) * 3n) / 2n;
    if (eth < gerekli) throw new Error(`low gas balance: need ${formatEther(gerekli)} ETH`);
    return { asgari };
  };

  const app = new Hono();
  // Tarayıcıdaki ödeme sayfaları ve ajanlar için CORS: ödeme başlıkları gönderilebilir ve okunabilir.
  app.use("*", cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", "PAYMENT-SIGNATURE", "X-PAYMENT", "Access-Control-Expose-Headers"],
    exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"],
    maxAge: 86400,
  }));

  const GIRDI_SEMA = {
    type: "object", required: ["hash"], additionalProperties: false,
    properties: {
      hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "SHA-256 fingerprint of your data, 0x-prefixed hex" },
      label: { type: "string", maxLength: 50, description: "Optional plain-ASCII note stored with the record" },
    },
  };
  const CIKTI_ORNEK = { ok: true, hash: "0x…", transaction: "0x…", record: { recorded: true, notary: "0x722C…26Cc", time: "2026-11-24T18:00:00.000Z", block: 1, label: "x402:0xPayer… my report", agiBurned: "2.9" }, payment: { payer: "0x…", transaction: "0x…", network: "eip155:8453" } };
  const bazaar = declareDiscoveryExtension({ method: "POST", bodyType: "json", input: { hash: "0x" + "ab".repeat(32), label: "quarterly report v1" }, inputSchema: GIRDI_SEMA, output: { example: CIKTI_ORNEK } });

  app.get("/openapi.json", (c) => json(c, {
    openapi: "3.1.0",
    info: { title: "AGIChainAI x402 Notary", version: SURUM, description: "Write the SHA-256 fingerprint of a file or text to the AGIChainAI notary contract on Base, paid per call in USDC over x402. Proves the data existed unchanged at that time. Part of the fee buys and burns AGI.", contact: { url: "https://agichainai.com" } },
    servers: [{ url: ay.publicUrl }],
    paths: {
      "/lp-lock": {
        get: {
          operationId: "lpLockCheck", summary: "Is this Base token's liquidity locked? (rug-pull check)",
          "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: LP_USD } },
          parameters: [{ name: "token", in: "query", required: true, schema: LP_GIRDI_SEMA.properties.token }],
          responses: { "200": { description: "Lock analysis", content: { "application/json": { example: LP_ORNEK } } }, "402": { description: "Payment required (x402 v2, exact, USDC on Base)" }, "400": { description: "Invalid token; nothing charged" } },
        },
      },
      "/token-check": {
        get: {
          operationId: "tokenCheck", summary: "Pre-trade token safety check (honeypot/tax simulation, owner powers, LP lock)",
          "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: TC_USD } },
          parameters: [{ name: "token", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }, { name: "AGI-HOLDER", in: "header", required: false, schema: { type: "string" }, description: "base64 JSON {address, issuedAt, signature}; free with an active AGI pass (POST /pass/activate after burning AGI)" }],
          responses: { "200": { description: "Report", content: { "application/json": { example: TC_ORNEK } } }, "402": { description: "Payment required (x402 v2, exact, USDC on Base)" }, "400": { description: "Invalid token; nothing charged" } },
        },
      },
      "/base/gas": { get: { operationId: "baseGas", summary: "Live Base gas and suggested EIP-1559 fees", "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: D_USD } }, responses: { "200": { description: "Gas" }, "402": { description: "Payment required" } } } },
      "/base/price": { get: { operationId: "basePrice", summary: "USD price of a Base ERC-20 from its deepest V2-style pool", "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: D_USD } }, parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Price" }, "402": { description: "Payment required" } } } },
      "/base/balance": { get: { operationId: "baseBalance", summary: "ETH and ERC-20 balances of a Base address", "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: D_USD } }, parameters: [{ name: "address", in: "query", required: true, schema: { type: "string" } }, { name: "tokens", in: "query", required: false, schema: { type: "string" } }], responses: { "200": { description: "Balances" }, "402": { description: "Payment required" } } } },
      "/exit-check": { get: { operationId: "exitCheck", summary: "Can this wallet still sell each of its positions? (full-balance sell simulated from the wallet)", "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: "0.02" } }, parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }, { name: "tokens", in: "query", required: false, schema: { type: "string" } }], responses: { "200": { description: "Exit report" }, "402": { description: "Payment required" } } } },
      "/exit-check/lite": { get: { operationId: "exitCheckLite", summary: "Free exit summary for a wallet", parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Summary" }, "429": { description: "Daily free limit reached" } } } },
      "/exit-guard": { post: { operationId: "exitGuard", summary: "30-day Exit Guard: webhook when a held position can no longer be sold cleanly", "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: "3" } }, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["wallet", "webhook"], properties: { wallet: { type: "string" }, webhook: { type: "string" }, tokens: { type: "array", items: { type: "string" } } } } } } }, responses: { "200": { description: "Guard created" }, "402": { description: "Payment required" }, "400": { description: "Invalid input; nothing charged" } } } },
      "/token-check/lite": {
        get: { operationId: "tokenCheckLite", summary: "Free verdict and risk codes", parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Lite verdict" }, "429": { description: "Daily free limit reached" } } },
      },
      "/lp-watch": {
        post: {
          operationId: "lpWatch", summary: "Watch a Base token's liquidity lock for 30 days (webhook alerts)",
          "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: W_USD } },
          requestBody: { required: true, content: { "application/json": { schema: W_SEMA } } },
          responses: { "200": { description: "Watch created", content: { "application/json": { example: W_ORNEK } } }, "402": { description: "Payment required (x402 v2, exact, USDC on Base)" }, "400": { description: "Invalid token or webhook; nothing charged" } },
        },
      },
      "/notarize": {
        post: {
          operationId: "notarize", summary: "Notarize a SHA-256 fingerprint on Base",
          "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: fiyatUsd } },
          requestBody: { required: true, content: { "application/json": { schema: GIRDI_SEMA } } },
          responses: {
            "200": { description: "Recorded on-chain", content: { "application/json": { example: CIKTI_ORNEK } } },
            "402": { description: "Payment required (x402 v2, exact, USDC on Base)" },
            "409": { description: "Already recorded; nothing charged" },
          },
        },
      },
    },
    "x-discovery": { ownershipProofs: [] },
  }));
  app.get("/.well-known/x402", (c) => json(c, { version: 1, resources: [ay.publicUrl + "/exit-check", ay.publicUrl + "/exit-guard", ay.publicUrl + "/token-check", ay.publicUrl + "/base/gas", ay.publicUrl + "/base/price", ay.publicUrl + "/base/balance", ay.publicUrl + "/notarize", ay.publicUrl + "/lp-lock", ay.publicUrl + "/lp-watch"], instructions: "POST JSON {hash, label?}. Free lookup: GET /record/{hash}." }));

  app.get("/", async (c) => {
    return json(c, {
      name: "AGIChainAI x402 Notary",
      version: SURUM,
      description: "Prove a file or text existed at a point in time: its SHA-256 fingerprint is written to the AGIChainAI notary contract on Base. Pay per record in USDC over x402; no account, no API key, no AGI needed.",
      endpoints: {
        "POST /notarize": { price: typeof ay.price === "string" ? ay.price + " USDC" : ay.price, body: { hash: "0x + 64 hex chars (SHA-256 of your data)", label: "optional, up to ~50 characters" }, paid: "x402 (exact, USDC on Base)" },
        "POST /pass/activate": { price: "free", body: { tx: "0x… hash of a transaction that burned at least 1,000,000 AGI (transfer to 0x…dEaD)" }, description: "Activates a 30-day AGI pass for the burning wallet (2x burn = 60 days, up to 12x). With a pass, send the signed AGI-HOLDER header for free paid-endpoint calls within daily limits. Status: GET /pass/{address}" },
        "GET /exit-check?wallet=0x…": { price: "$0.02 USDC", description: "For every token a wallet holds: can the FULL balance still be sold from that wallet, sell tax for that wallet, price impact, exit value, LP rug risk", paid: "x402 (exact, USDC on Base)" },
        "GET /exit-check/lite?wallet=0x…": { price: "free (10/day per IP)", description: "Summary only: positions, blocked, at risk" },
        "POST /exit-guard": { price: "$3 USDC for 30 days (or free with an AGI pass)", body: { wallet: "0x…", webhook: "https://…", tokens: "optional array" }, description: "Exit Guard: every position is sold in simulation from your wallet ~every 10 minutes; webhook on SELL_BLOCKED, SELL_TAX_UP, EXIT_VALUE_DROP, PROTECTION_DROP, UNLOCK_SOON, UNLOCKED. Status: GET /exit-guard/{id}" },
        "GET /token-check?token=0x…": { price: "$0.01 USDC (free with an AGI pass via the AGI-HOLDER header)", description: "Pre-trade check: buy/transfer/sell simulation (honeypot, taxes), owner powers, proxy, LP lock; verdict SAFE/CAUTION/DANGER", paid: "x402 (exact, USDC on Base)" },
        "GET /token-check/lite?token=0x…": { price: "free (daily limit per IP)", description: "Verdict, score and risk codes only" },
        "POST /lp-watch": { price: "$0.05 USDC", body: { token: "0x… (Base ERC-20)", webhook: "https://… (receives JSON events)" }, description: "30-day LP watch: webhook before an LP lock unlocks, when the locked share or liquidity drops, or the verdict changes. Status: GET /lp-watch/{id} (free)", paid: "x402 (exact, USDC on Base)" },
        "GET /lp-lock?token=0x…": { price: "$" + LP_USD + " USDC", description: "Liquidity-lock / rug-pull check for a Base token: burned, locked (with unlock dates) and removable LP share per pool", paid: "x402 (exact, USDC on Base)" },
        "GET /record/{hash}": { price: "free", description: "Check whether and when a fingerprint was recorded" },
        "GET /status": { price: "free" },
      },
      notary: A.noterUsdc,
      network: ay.network,
      howToHash: "sha256 of the raw bytes, hex, 0x-prefixed. Only the fingerprint goes on-chain, never the content.",
      what_happens_to_the_fee: "Part of each payment buys AGI on Uniswap and burns it (sends it to 0x…dEaD), through the notary contract.",
      docs: "https://agichainai.com/exchange/agents.html",
      source: "https://github.com/aslanklc04/agichainai-agent-tools",
    });
  });

  app.get("/status", async (c) => {
    const [eth, usdc, sayi, yak] = await Promise.all([
      okur.getBalance({ address: hesap.address }),
      okur.readContract({ address: A.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [hesap.address] }),
      okur.readContract({ address: A.noterUsdc, abi: NOTER_USDC_ABI, functionName: "kayitSayisi" }),
      okur.readContract({ address: A.noterUsdc, abi: NOTER_USDC_ABI, functionName: "toplamYakilan" }),
    ]);
    return json(c, {
      ok: eth >= ASGARI_ETH, serviceWallet: hesap.address, version: SURUM, facilitator: ay.facilitatorName || "custom",
      notaryRecords: Number(sayi), lastSettlement: sonTahsil, agiBurnedByNotary: formatEther(yak),
      serviceWalletEth: formatEther(eth), serviceWalletUsdc: formatUnits(usdc, 6),
    });
  });

  app.get("/record/:hash", async (c) => {
    const h = c.req.param("hash").toLowerCase();
    if (!isHex(h) || h.length !== 66 || h === SIFIR) return json(c, { error: "hash must be 0x followed by 64 hex characters" }, 400);
    const k = await kayitBul(h);
    return json(c, k || { recorded: false, hash: h });
  });

  app.post("/notarize", async (c) => {
    const baslik = c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT");
    await hazirla();
    const kaynak = {
      url: ay.publicUrl + "/notarize",
      description: "Notarize any file, report, dataset or AI agent output on Base: send only its SHA-256 hash (content never leaves you) and get an on-chain proof of existence and integrity with block, time and BaseScan tx, verifiable by anyone for free via GET /record/{hash}. $0.02 USDC, no account or API key. Nothing is charged for an already-recorded hash or if the write would fail. Part of the fee buys and burns AGI.",
      mimeType: "application/json",
      serviceName: "AGIChainAI Notary",
      tags: ["notary", "notarize", "timestamp", "proof-of-existence", "sha256", "audit-trail"],
      iconUrl: "https://agichainai.com/assets/agi-token-256.png",
    };
    const sartlar = await sunucu.buildPaymentRequirements({ scheme: "exact", payTo: hesap.address, price: ay.price, network: ay.network, maxTimeoutSeconds: 120 });
    const odemeIste = async (hata) => {
      const pr = await sunucu.createPaymentRequiredResponse(sartlar, kaynak, hata, bazaar);
      return json(c, pr, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) });
    };

    // 1) İstek doğrulama — ödeme alınmadan önce; hatalı istek ücretlendirilmez.
    //    Ödemesiz keşif yoklamaları (boş gövde) doğrudan ödeme şartlarını görür.
    let govde = null;
    try { govde = await c.req.json(); } catch {}
    const ozet = String((govde && govde.hash) || "").toLowerCase();
    const etiketHam = govde && govde.label !== undefined ? String(govde.label) : "";
    const ozetGecerli = isHex(ozet) && ozet.length === 66 && ozet !== SIFIR;
    const etiketGecerli = /^[\x20-\x7e]{0,50}$/.test(etiketHam);
    if (!ozetGecerli || !etiketGecerli) {
      if (!baslik) return odemeIste(govde ? "send JSON {\"hash\":\"0x + 64 hex\",\"label\":\"≤50 ASCII chars\"}" : undefined);
      return json(c, { error: !ozetGecerli ? "hash must be 0x followed by 64 hex characters (SHA-256)" : "label: up to 50 plain ASCII characters" }, 400);
    }

    const [onceki, eth] = await Promise.all([kayitBul(ozet), okur.getBalance({ address: hesap.address })]);
    if (onceki) return json(c, { error: "This hash is already recorded; nothing was charged.", record: onceki }, 409);

    if (eth < ASGARI_ETH) return json(c, { error: "Service temporarily unavailable (low gas balance); nothing was charged." }, 503);

    // 2) Zincir tarafı ÖN KONTROL — ödeme alınmadan önce: izin, fiyat teklifi, kayıt simülasyonu ve gaz.
    let yazHazir;
    try { yazHazir = await zincirHazirla(ozet, etiketHam); }
    catch (e) { console.error("PRECHECK_FAILED", String(e.shortMessage || e.message || e)); return json(c, { error: "Service cannot record right now; nothing was charged." }, 503); }

    if (!baslik) return odemeIste();

    let yuk;
    try { yuk = decodePaymentSignatureHeader(baslik); } catch { return odemeIste("invalid payment header"); }
    const sart = sartlar.find((s) => s.scheme === yuk.accepted?.scheme && s.network === yuk.accepted?.network) || sartlar[0];

    // 3) Doğrula, sonra TAHSİL ET; ancak tahsilattan sonra zincire yazılır.
    let dog;
    try { dog = await sunucu.verifyPayment(yuk, sart, bazaar); } catch (e) { return odemeIste("verification failed: " + (e.message || e)); }
    if (!dog.isValid) return odemeIste(dog.invalidReason || "payment invalid");
    // Bazaar kataloğu, tahsilat isteğinde katalog bilgisini (extensions.bazaar) ve kaynağı ister.
    // İstemci bunları göndermediyse sunucu ekler; imza yalnızca ödeme yetkisini kapsar, bu alanlar değil.
    try {
      const pr = await sunucu.createPaymentRequiredResponse(sartlar, kaynak, undefined, bazaar);
      yuk.extensions = { ...(pr.extensions || {}), ...(yuk.extensions || {}) };
      if (!yuk.resource) yuk.resource = pr.resource;
    } catch (e) { console.error("BAZAAR_ENRICH_FAILED", String(e.message || e)); }
    let tahsil;
    try { tahsil = await sunucu.settlePayment(yuk, sart, bazaar); } catch (e) { return odemeIste("settlement failed: " + (e.message || e)); }
    if (!tahsil.success) return odemeIste(tahsil.errorReason || "settlement failed");
    const odemeBasligi = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(tahsil) };
    sonTahsil = { zaman: new Date().toISOString(), extensionResponses: tahsil.extensionResponses || tahsil.extensions || null };
    console.log("SETTLED", JSON.stringify({ tx: tahsil.transaction, ext: sonTahsil.extensionResponses }));
    const odeyen = getAddress(tahsil.payer || dog.payer || yuk.payload?.authorization?.from);

    // 4) Zincire yaz (etikete ödeyen eklenir; ön kontrolde aynı uzunlukta yer tutucu ile simüle edildi)
    try {
      const { request } = await okur.simulateContract({ account: hesap, address: A.noterUsdc, abi: NOTER_USDC_ABI, functionName: "kaydet", args: [ozet, etiketHazirla(odeyen, etiketHam), yazHazir.asgari] });
      const tx = await yazar.writeContract(request);
      const mak = await okur.waitForTransactionReceipt({ hash: tx });
      if (mak.status !== "success") throw new Error("notary transaction reverted");
      const kayit = await kayitBul(ozet);
      return json(c, { ok: true, hash: ozet, transaction: tx, record: kayit, payment: { payer: odeyen, transaction: tahsil.transaction, network: tahsil.network } }, 200, odemeBasligi);
    } catch (e) {
      console.error("NOTARIZE_FAILED_AFTER_PAYMENT", JSON.stringify({ hash: ozet, payer: odeyen, payment: tahsil.transaction, error: String(e.shortMessage || e.message || e) }));
      return json(c, {
        error: "Payment was received but the record could not be written. It will be retried manually; contact via https://agichainai.com/#contact with this payment transaction.",
        hash: ozet, payment: { payer: odeyen, transaction: tahsil.transaction },
      }, 500, odemeBasligi);
    }
  });

  // ───────── Likidite kilidi kontrolü (GET /lp-lock?token=0x…) ─────────
  const LP_FIYAT = ay.lpPrice || "$0.01";
  const LP_USD = typeof LP_FIYAT === "string" ? LP_FIYAT.replace("$", "") : (Number(LP_FIYAT.amount) / 1e6).toFixed(2);
  const LP_GIRDI_SEMA = { type: "object", required: ["token"], properties: { token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "ERC-20 token address on Base" } } };
  const LP_ORNEK = { token: { symbol: "XYZ" }, verdict: "MOSTLY_LOCKED", protectedPctWeightedByLiquidity: 91.2, v2Pools: [{ dex: "uniswap-v2", quote: "WETH", liquidityUsd: 48210.5, lp: { burnedPct: 0.0, lockedPct: 91.2, lockers: [{ name: "UNCX (Uniswap V2)", pct: 91.2, earliestUnlock: "2027-03-01T00:00:00.000Z" }], removablePct: 8.8 } }], v3Pools: [], notes: [] };
  const lpBazaar = declareDiscoveryExtension({ method: "GET", input: { token: "0x4200000000000000000000000000000000000006" }, inputSchema: LP_GIRDI_SEMA, output: { example: LP_ORNEK } });
  const lpKaynak = () => ({
    url: ay.publicUrl + "/lp-lock",
    description: "Is this Base token's liquidity really locked? One call checks every V2-style pool (Uniswap V2, Aerodrome, AGIChainAI) against WETH and USDC. It returns the share of LP burned, the share in known lockers (UNCX, Team Finance and others) with unlock dates, the share still removable, Aerodrome gauge staking, pool liquidity in USD, a rug-pull verdict and any V3 pools. Live on-chain reads, $0.01 USDC, no API key. Nothing is charged for an invalid token.",
    mimeType: "application/json", serviceName: "AGIChainAI LP Lock Check",
    tags: ["rug-pull", "liquidity-lock", "token-safety", "base", "lp", "due-diligence"],
    iconUrl: "https://agichainai.com/assets/agi-token-256.png",
  });

  // Gelirin yarısıyla AGI yak: hizmet cüzdanında biriken USDC, yedek (0,05) üstü 0,15'i geçince yarısı Uniswap'ta AGI alıp 0x…dEaD'e gönderir.
  let yakiyor = false;
  const yakmaDene = async () => {
    if (yakiyor || !A.router02) return; yakiyor = true;
    try {
      const bakiye = await okur.readContract({ address: A.usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [hesap.address] });
      const YEDEK = 50_000n, ESIK = 150_000n;
      if (bakiye < ESIK) return;
      const miktar = (bakiye - YEDEK) / 2n;
      const izin = await okur.readContract({ address: A.usdc, abi: ERC20_ABI, functionName: "allowance", args: [hesap.address, A.router02] });
      if (izin < miktar) {
        const h = await yazar.writeContract({ address: A.usdc, abi: ERC20_ABI, functionName: "approve", args: [A.router02, 5_000_000n] });
        await okur.waitForTransactionReceipt({ hash: h });
      }
      const { result } = await okur.simulateContract({ address: A.quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: A.usdc, tokenOut: A.agi, amountIn: miktar, fee: 10000, sqrtPriceLimitX96: 0n }] });
      const { request } = await okur.simulateContract({ account: hesap, address: A.router02, abi: ROUTER02_ABI, functionName: "exactInputSingle", args: [{ tokenIn: A.usdc, tokenOut: A.agi, fee: 10000, recipient: YAKMA_ADRESI, amountIn: miktar, amountOutMinimum: (result[0] * 95n) / 100n, sqrtPriceLimitX96: 0n }] });
      const tx = await yazar.writeContract(request);
      await okur.waitForTransactionReceipt({ hash: tx });
      console.log("BURN", JSON.stringify({ usdc: formatUnits(miktar, 6), tx }));
    } catch (e) { console.error("BURN_FAILED", String(e.shortMessage || e.message || e)); }
    finally { yakiyor = false; }
  };

  const lpIsle = async (c, token) => {
    const baslik = c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT");
    await hazirla();
    const kaynak = lpKaynak();
    const sartlar = await sunucu.buildPaymentRequirements({ scheme: "exact", payTo: hesap.address, price: LP_FIYAT, network: ay.network, maxTimeoutSeconds: 120 });
    const odemeIste = async (hata) => {
      const pr = await sunucu.createPaymentRequiredResponse(sartlar, kaynak, hata, lpBazaar);
      return json(c, pr, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) });
    };
    const gecerli = /^0x[0-9a-fA-F]{40}$/.test(token);
    if (!baslik) return odemeIste(gecerli ? undefined : "add ?token=0x… (ERC-20 address on Base)");
    if (!gecerli) return json(c, { error: "token must be a 0x-prefixed 20-byte address" }, 400);

    // Analiz ÖDEMEDEN ÖNCE yapılır: geçersiz token ya da okuma hatası ücretlendirilmez.
    let analiz;
    try { analiz = await lpKilitAnalizi(okur, ay.lp, token); }
    catch (e) {
      if (e.kullanici) return json(c, { error: e.message + "; nothing was charged." }, 400);
      console.error("LPLOCK_FAILED", String(e.shortMessage || e.message || e));
      return json(c, { error: "Could not read the chain right now; nothing was charged." }, 503);
    }

    let yuk;
    try { yuk = decodePaymentSignatureHeader(baslik); } catch { return odemeIste("invalid payment header"); }
    const sart = sartlar.find((x) => x.scheme === yuk.accepted?.scheme && x.network === yuk.accepted?.network) || sartlar[0];
    let dog;
    try { dog = await sunucu.verifyPayment(yuk, sart, lpBazaar); } catch (e) { return odemeIste("verification failed: " + (e.message || e)); }
    if (!dog.isValid) return odemeIste(dog.invalidReason || "payment invalid");
    try {
      const pr = await sunucu.createPaymentRequiredResponse(sartlar, kaynak, undefined, lpBazaar);
      yuk.extensions = { ...(pr.extensions || {}), ...(yuk.extensions || {}) };
      if (!yuk.resource) yuk.resource = pr.resource;
    } catch {}
    let tahsil;
    try { tahsil = await sunucu.settlePayment(yuk, sart, lpBazaar); } catch (e) { return odemeIste("settlement failed: " + (e.message || e)); }
    if (!tahsil.success) return odemeIste(tahsil.errorReason || "settlement failed");
    console.log("SETTLED_LP", JSON.stringify({ tx: tahsil.transaction, token }));
    try { c.executionCtx.waitUntil(yakmaDene()); } catch { yakmaDene(); }
    return json(c, { ...analiz, payment: { payer: tahsil.payer || dog.payer, transaction: tahsil.transaction, network: tahsil.network }, feeUse: "Half of accumulated fees buy AGI on Uniswap and burn it." }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(tahsil) });
  };
  app.get("/lp-lock", (c) => lpIsle(c, String(c.req.query("token") || "")));
  // ERC-8257 araç çağrısı: POST, JSON gövde {token}.
  app.post("/lp-lock", async (c) => {
    let g = {};
    try { g = await c.req.json(); } catch {}
    return lpIsle(c, String((g && g.token) || c.req.query("token") || ""));
  });

  // ───────── ERC-8257 (OpenSea Agent Tool Registry) manifestoları ─────────
  for (const [slug, m] of Object.entries(ay.toolManifests || {})) {
    app.get(`/.well-known/ai-tool/${slug}.json`, (c) => json(c, m));
  }


  // ───────── Ön-alım token kontrolü (honeypot/vergi simülasyonu + yetkiler + LP) ─────────
  const TC_FIYAT = ay.tokenCheckPrice || "$0.01";
  const TC_USD = typeof TC_FIYAT === "string" ? TC_FIYAT.replace("$", "") : (Number(TC_FIYAT.amount) / 1e6).toFixed(2);
  const H_MIN = BigInt(ay.holderMinAgi || "1000000") * 10n ** 18n;
  const H_GUN = Number(ay.holderDaily || 200);
  const LITE_GUN = Number(ay.liteDaily || 20);
  const TC_ORNEK = { verdict: "CAUTION", score: 76, summary: "SELL_TAX_HIGH, OWNER_CAN_CHANGE_FEES", risks: [{ level: "caution", code: "SELL_TAX_HIGH", detail: "Sell tax 12%." }], simulation: { simulated: true, buyOk: true, sellOk: true, buyTaxPct: 0, sellTaxPct: 12, transferTaxPct: 0, roundTripLossPct: 13.1 }, owner: { renounced: false, powers: { feeChange: ["setSellFee(uint256)"] }, proxyImplementation: null }, liquidity: { verdict: "LOCKED_OR_BURNED", rugRisk: "LOW" } };
  const tcBazaar = declareDiscoveryExtension({ input: { token: "0x4200000000000000000000000000000000000006" }, inputSchema: { properties: { token: { type: "string", description: "ERC-20 token address on Base" } }, required: ["token"] }, output: { example: TC_ORNEK } });
  const tcKaynak = () => ({
    url: ay.publicUrl + "/token-check",
    description: `Pre-trade safety check for any Base ERC-20 before your agent buys: simulates buy → wallet transfer → sell against the real pool (honeypot, buy/sell/transfer tax), detects owner powers (mint, blacklist, pause, fee change, trading switch), upgradeable proxies, and whether LP is burned, locked (UNCX/Team Finance, with unlock dates) or removable. Verdict SAFE / CAUTION / DANGER / UNVERIFIED with a 0-100 score. $${TC_USD} USDC, or free (${H_GUN}/day) with a 30-day AGI pass (burn ${H_MIN / 10n ** 18n} AGI, then send the AGI-HOLDER header); free lite verdict at /token-check/lite. Nothing is charged for an invalid token.`,
    mimeType: "application/json", serviceName: "AGIChainAI Token Check",
    tags: ["token-safety", "honeypot", "rug-pull", "pre-trade", "sell-simulation", "base", "security"],
    iconUrl: "https://agichainai.com/assets/agi-token-256.png",
  });
  const tcIsle = async (c, token) => {
    const baslik = c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT");
    const holder = c.req.header("AGI-HOLDER");
    await hazirla();
    const sartlar = await sunucu.buildPaymentRequirements({ scheme: "exact", payTo: hesap.address, price: TC_FIYAT, network: ay.network, maxTimeoutSeconds: 120 });
    const odemeIste = async (hata) => { const pr = await sunucu.createPaymentRequiredResponse(sartlar, tcKaynak(), hata, tcBazaar); return json(c, { ...pr, holderAccess: { pass: `burn ${H_MIN / 10n ** 18n} AGI to 0x000000000000000000000000000000000000dEaD, then POST {"tx":"0x…"} to ${ay.publicUrl}/pass/activate for ${GECIS_GUN} days`, header: "AGI-HOLDER", burnAgi: String(H_MIN / 10n ** 18n), days: GECIS_GUN, dailyLimit: H_GUN, message: HOLDER_MESAJ("0x0000000000000000000000000000000000000000", "<ISO time>").replace("0x0000000000000000000000000000000000000000", "<your address>"), docs: "https://agichainai.com/pages/agi.html" }, freeLite: ay.publicUrl + "/token-check/lite?token=0x…" }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }); };
    const gecerli = /^0x[0-9a-fA-F]{40}$/.test(token);
    if (!baslik && !holder) return odemeIste(gecerli ? undefined : "add ?token=0x… (ERC-20 address on Base)");
    if (!gecerli) return json(c, { error: "token must be a 0x-prefixed 20-byte address" }, 400);
    let analiz;
    try { analiz = await tokenKontrol(okur, ay.lp, token); }
    catch (e) {
      if (e.kullanici) return json(c, { error: e.message + "; nothing was charged." }, 400);
      console.error("TOKENCHECK_FAILED", String(e.shortMessage || e.message || e));
      return json(c, { error: "Could not read the chain right now; nothing was charged." }, 503);
    }
    if (holder && !baslik) {
      const h = await holderDogrula({ okur, kv: c.env?.WATCH_KV, agi: ay.adres.agi, minimum: H_MIN, gunluk: H_GUN, baslik: holder });
      if (!h.ok) return odemeIste(h.reason);
      console.log("HOLDER_CHECK", JSON.stringify({ address: h.address, token }));
      return json(c, { ...analiz, access: { type: "agi-holder", address: h.address, remainingToday: h.remaining } });
    }
    let yuk;
    try { yuk = decodePaymentSignatureHeader(baslik); } catch { return odemeIste("invalid payment header"); }
    const sart = sartlar.find((x) => x.scheme === yuk.accepted?.scheme && x.network === yuk.accepted?.network) || sartlar[0];
    let dog;
    try { dog = await sunucu.verifyPayment(yuk, sart, tcBazaar); } catch (e) { return odemeIste("verification failed: " + (e.message || e)); }
    if (!dog.isValid) return odemeIste(dog.invalidReason || "payment invalid");
    try { const pr = await sunucu.createPaymentRequiredResponse(sartlar, tcKaynak(), undefined, tcBazaar); yuk.extensions = { ...(pr.extensions || {}), ...(yuk.extensions || {}) }; if (!yuk.resource) yuk.resource = pr.resource; } catch {}
    let tahsil;
    try { tahsil = await sunucu.settlePayment(yuk, sart, tcBazaar); } catch (e) { return odemeIste("settlement failed: " + (e.message || e)); }
    if (!tahsil.success) return odemeIste(tahsil.errorReason || "settlement failed");
    console.log("SETTLED_TC", JSON.stringify({ tx: tahsil.transaction, token, payer: tahsil.payer || dog.payer }));
    try { c.executionCtx.waitUntil(yakmaDene()); } catch { yakmaDene(); }
    return json(c, { ...analiz, payment: { payer: tahsil.payer || dog.payer, transaction: tahsil.transaction, network: tahsil.network }, feeUse: "Half of accumulated fees buy AGI on Uniswap and burn it." }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(tahsil) });
  };
  app.get("/token-check", (c) => tcIsle(c, String(c.req.query("token") || "")));
  app.post("/token-check", async (c) => { let g = {}; try { g = await c.req.json(); } catch {} return tcIsle(c, String((g && g.token) || c.req.query("token") || "")); });
  // Ücretsiz önizleme: hüküm, puan ve risk kodları (ayrıntısız), IP başına günlük sınır.
  app.get("/token-check/lite", async (c) => {
    const token = String(c.req.query("token") || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return json(c, { error: "add ?token=0x… (ERC-20 address on Base)" }, 400);
    const ip = c.req.header("CF-Connecting-IP") || "";
    const s = await ipSiniri(c.env?.WATCH_KV, ip, LITE_GUN);
    if (!s.ok) return json(c, { error: `free lite limit of ${LITE_GUN} per day reached; use /token-check ($${TC_USD}) or hold AGI for free access` }, 429);
    try {
      const a = await tokenKontrol(okur, ay.lp, token);
      return json(c, { token: a.token, verdict: a.verdict, score: a.score, risks: a.risks.map((r) => r.code), honeypot: a.simulation.simulated ? !a.simulation.sellOk : null, sellTaxPct: a.simulation.sellTaxPct ?? null, rugRisk: a.liquidity.rugRisk, full: ay.publicUrl + "/token-check?token=" + (a.token?.address || a.token), fullPrice: "$" + TC_USD, holderAccess: `free full checks (${H_GUN}/day) with a ${GECIS_GUN}-day AGI pass: burn ${H_MIN / 10n ** 18n} AGI and POST the tx to /pass/activate`, remainingToday: s.remaining });
    } catch (e) {
      if (e.kullanici) return json(c, { error: e.message }, 400);
      return json(c, { error: "Could not read the chain right now." }, 503);
    }
  });

  // ───────── Base veri paketi: gas, fiyat, bakiye ($0.001; AGI sahiplerine günde 2000 ücretsiz) ─────────
  const D_FIYAT = ay.dataPrice || "$0.001";
  const D_USD = typeof D_FIYAT === "string" ? D_FIYAT.replace("$", "") : "0.001";
  const D_GUN = Number(ay.holderDataDaily || 2000);
  const odemeli = async (c, { kaynak, bazaar, uret, etiket, fiyat = D_FIYAT, gunluk = D_GUN, onek = "d" }) => {
    const baslik = c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT");
    const holder = c.req.header("AGI-HOLDER");
    await hazirla();
    const sartlar = await sunucu.buildPaymentRequirements({ scheme: "exact", payTo: hesap.address, price: fiyat, network: ay.network, maxTimeoutSeconds: 120 });
    const odemeIste = async (hata) => { const pr = await sunucu.createPaymentRequiredResponse(sartlar, kaynak, hata, bazaar); return json(c, { ...pr, holderAccess: { pass: `burn ${H_MIN / 10n ** 18n} AGI to 0x000000000000000000000000000000000000dEaD, then POST {"tx":"0x…"} to ${ay.publicUrl}/pass/activate for ${GECIS_GUN} days`, header: "AGI-HOLDER", burnAgi: String(H_MIN / 10n ** 18n), days: GECIS_GUN, dailyLimit: gunluk, docs: "https://agichainai.com/pages/agi.html" } }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }); };
    if (!baslik && !holder) return odemeIste();
    let sonuc;
    try { sonuc = await uret(); }
    catch (e) {
      if (e.kullanici) return json(c, { error: e.message + "; nothing was charged." }, 400);
      console.error(etiket + "_FAILED", String(e.shortMessage || e.message || e));
      return json(c, { error: "Could not read the chain right now; nothing was charged." }, 503);
    }
    if (holder && !baslik) {
      const h = await holderDogrula({ okur, kv: c.env?.WATCH_KV, agi: ay.adres.agi, minimum: H_MIN, gunluk, baslik: holder, onek });
      if (!h.ok) return odemeIste(h.reason);
      console.log("HOLDER_" + etiket, h.address);
      return json(c, { ...sonuc, access: { type: "agi-holder", address: h.address, remainingToday: h.remaining } });
    }
    let yuk;
    try { yuk = decodePaymentSignatureHeader(baslik); } catch { return odemeIste("invalid payment header"); }
    const sart = sartlar.find((x) => x.scheme === yuk.accepted?.scheme && x.network === yuk.accepted?.network) || sartlar[0];
    let dog;
    try { dog = await sunucu.verifyPayment(yuk, sart, bazaar); } catch (e) { return odemeIste("verification failed: " + (e.message || e)); }
    if (!dog.isValid) return odemeIste(dog.invalidReason || "payment invalid");
    try { const pr = await sunucu.createPaymentRequiredResponse(sartlar, kaynak, undefined, bazaar); yuk.extensions = { ...(pr.extensions || {}), ...(yuk.extensions || {}) }; if (!yuk.resource) yuk.resource = pr.resource; } catch {}
    let tahsil;
    try { tahsil = await sunucu.settlePayment(yuk, sart, bazaar); } catch (e) { return odemeIste("settlement failed: " + (e.message || e)); }
    if (!tahsil.success) return odemeIste(tahsil.errorReason || "settlement failed");
    console.log("SETTLED_" + etiket, JSON.stringify({ tx: tahsil.transaction, payer: tahsil.payer || dog.payer }));
    try { c.executionCtx.waitUntil(yakmaDene()); } catch { yakmaDene(); }
    return json(c, { ...sonuc, payment: { payer: tahsil.payer || dog.payer, transaction: tahsil.transaction, network: tahsil.network } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(tahsil) });
  };
  const veriKaynak = (yol, aciklama, etiketler) => ({ url: ay.publicUrl + yol, description: aciklama + ` $${D_USD} USDC per call, or free (${D_GUN}/day) with a ${GECIS_GUN}-day AGI pass (burn ${H_MIN / 10n ** 18n} AGI).`, mimeType: "application/json", serviceName: "AGIChainAI Base Data", tags: ["base", "data", ...etiketler], iconUrl: "https://agichainai.com/assets/agi-token-256.png" });
  const gasB = declareDiscoveryExtension({ input: {}, output: { example: { block: 38500000, baseFeeGwei: "0.006", priorityFeeGwei: "0.001", suggested: { standard: { maxFeePerGasGwei: "0.01", maxPriorityFeePerGasGwei: "0.001" } } } } });
  const fiyatB = declareDiscoveryExtension({ input: { token: "0x532f27101965dd16442E59d40670FaF5eBB142E4" }, inputSchema: { properties: { token: { type: "string" } }, required: ["token"] }, output: { example: { priceUsd: 0.0123, source: { dex: "uniswap-v2", quote: "WETH", liquidityUsd: 152000 } } } });
  const bakiyeB = declareDiscoveryExtension({ input: { address: "0x4200000000000000000000000000000000000006", tokens: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, inputSchema: { properties: { address: { type: "string" }, tokens: { type: "string", description: "comma-separated ERC-20 addresses (max 20)" } }, required: ["address"] }, output: { example: { eth: "0.42", tokens: [{ symbol: "USDC", balance: "12.5" }] } } });
  app.get("/base/gas", (c) => odemeli(c, { etiket: "GAS", bazaar: gasB, kaynak: veriKaynak("/base/gas", "Live Base gas: base fee, priority fee and suggested slow/standard/fast EIP-1559 fees from the latest block.", ["gas", "fees"]), uret: () => gasBilgisi(okur) }));
  app.get("/base/price", (c) => {
    const t = String(c.req.query("token") || "");
    return odemeli(c, { etiket: "PRICE", bazaar: fiyatB, kaynak: veriKaynak("/base/price", "USD price of any Base ERC-20 from its deepest Uniswap V2 / Aerodrome / AGIChainAI pool and the Chainlink ETH/USD feed, with the pool used and its liquidity.", ["price", "token"]), uret: async () => { if (!isAddress(t)) { const e = new Error("add ?token=0x… (ERC-20 address on Base)"); e.kullanici = true; throw e; } return fiyatBilgisi(okur, ay.lp, t); } });
  });
  app.get("/base/balance", (c) => {
    const a = String(c.req.query("address") || ""), tk = String(c.req.query("tokens") || "").split(",").map((x) => x.trim()).filter(Boolean);
    return odemeli(c, { etiket: "BALANCE", bazaar: bakiyeB, kaynak: veriKaynak("/base/balance", "ETH and ERC-20 balances of any Base address (up to 20 tokens per call), plus whether it is a contract.", ["balance", "wallet"]), uret: () => bakiyeBilgisi(okur, a, tk) });
  });

  // ───────── AGI geçişi (30 gün; AGI yakılarak alınır) ─────────
  app.post("/pass/activate", async (c) => {
    let g = {}; try { g = await c.req.json(); } catch {}
    try {
      const r = await gecisEtkinlestir({ okur, kv: c.env?.WATCH_KV, agi: ay.adres.agi, minimum: H_MIN, tx: String(g.tx || c.req.query("tx") || "") });
      console.log("PASS_ACTIVATED", JSON.stringify(r));
      return json(c, { ok: true, ...r, days: GECIS_GUN, dailyLimits: { tokenCheck: H_GUN, baseData: D_GUN }, header: "AGI-HOLDER: base64(JSON {address, issuedAt, signature}) where signature = personal_sign(\"AGIChainAI holder access\\nAddress: <checksummed address>\\nIssued: <ISO time>\")" });
    } catch (e) {
      if (e.kullanici) return json(c, { error: e.message }, 400);
      return json(c, { error: "Could not verify the burn right now; try again." }, 503);
    }
  });
  app.get("/pass/:adres", async (c) => {
    const a = c.req.param("adres");
    if (!isAddress(a)) return json(c, { error: "address required" }, 400);
    return json(c, { ...(await gecisDurumu(c.env?.WATCH_KV, a)), burnAgiFor30Days: String(H_MIN / 10n ** 18n) });
  });

  // ───────── LP izleme (POST /lp-watch, 30 gün, webhook) ─────────
  const W_FIYAT = ay.watchPrice || "$0.05";
  const W_USD = typeof W_FIYAT === "string" ? W_FIYAT.replace("$", "") : (Number(W_FIYAT.amount) / 1e6).toFixed(2);
  const W_SEMA = { type: "object", required: ["token", "webhook"], properties: { token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "ERC-20 token address on Base" }, webhook: { type: "string", description: "https URL that receives a JSON POST for each event" } } };
  const W_ORNEK = { watchId: "3f2a…", token: "0x…", expiresAt: "2026-12-25T00:00:00.000Z", baseline: { verdict: "MOSTLY_LOCKED", rugRisk: "MEDIUM", protectedPct: 91.2, liquidityUsd: 48210.5 }, events: ["LIQUIDITY_DROP", "PROTECTION_DROP", "VERDICT_CHANGE", "UNLOCK_SOON", "UNLOCKED"] };
  const wBazaar = declareDiscoveryExtension({ method: "POST", input: { token: "0x4200000000000000000000000000000000000006", webhook: "https://example.com/hooks/lp" }, inputSchema: W_SEMA, bodyType: "json", output: { example: W_ORNEK } });
  const wKaynak = () => ({
    url: ay.publicUrl + "/lp-watch",
    description: `Watch a Base token's liquidity for ${IZLEME_GUN} days and get a webhook before it can be pulled: alerts when an LP lock (UNCX) is 7 days from unlocking or unlocks, when the burned/locked LP share drops, when liquidity falls 30%+, or when the rug-risk verdict changes. Checked hourly from live on-chain data. $${W_USD} USDC once, no API key. Nothing is charged for an invalid token or webhook.`,
    mimeType: "application/json", serviceName: "AGIChainAI LP Watch",
    tags: ["rug-pull", "liquidity-lock", "monitoring", "alerts", "webhook", "base", "token-safety"],
    iconUrl: "https://agichainai.com/assets/agi-token-256.png",
  });
  app.post("/lp-watch", async (c) => {
    const baslik = c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT");
    await hazirla();
    const sartlar = await sunucu.buildPaymentRequirements({ scheme: "exact", payTo: hesap.address, price: W_FIYAT, network: ay.network, maxTimeoutSeconds: 120 });
    const odemeIste = async (hata) => { const pr = await sunucu.createPaymentRequiredResponse(sartlar, wKaynak(), hata, wBazaar); return json(c, pr, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }); };
    let g = {}; try { g = await c.req.json(); } catch {}
    const token = String(g.token || ""), webhook = String(g.webhook || "");
    if (!baslik) return odemeIste();
    if (!c.env?.WATCH_KV) return json(c, { error: "Watching is not enabled yet; nothing was charged." }, 503);
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return json(c, { error: "token must be a 0x-prefixed 20-byte address; nothing was charged." }, 400);
    if (!webhookGecerli(webhook)) return json(c, { error: "webhook must be a public https URL (no IPs, no credentials); nothing was charged." }, 400);
    let ilk;
    try { ilk = await lpKilitAnalizi(okur, ay.lp, token); }
    catch (e) { if (e.kullanici) return json(c, { error: e.message + "; nothing was charged." }, 400); return json(c, { error: "Could not read the chain right now; nothing was charged." }, 503); }
    let yuk; try { yuk = decodePaymentSignatureHeader(baslik); } catch { return odemeIste("invalid payment header"); }
    const sart = sartlar.find((x) => x.scheme === yuk.accepted?.scheme && x.network === yuk.accepted?.network) || sartlar[0];
    let dog; try { dog = await sunucu.verifyPayment(yuk, sart, wBazaar); } catch (e) { return odemeIste("verification failed: " + (e.message || e)); }
    if (!dog.isValid) return odemeIste(dog.invalidReason || "payment invalid");
    try { const pr = await sunucu.createPaymentRequiredResponse(sartlar, wKaynak(), undefined, wBazaar); yuk.extensions = { ...(pr.extensions || {}), ...(yuk.extensions || {}) }; if (!yuk.resource) yuk.resource = pr.resource; } catch {}
    let tahsil; try { tahsil = await sunucu.settlePayment(yuk, sart, wBazaar); } catch (e) { return odemeIste("settlement failed: " + (e.message || e)); }
    if (!tahsil.success) return odemeIste(tahsil.errorReason || "settlement failed");
    const simdi = Math.floor(Date.now() / 1000);
    const { izleme, ilkOlaylar } = await izlemeEkle(c.env.WATCH_KV, { token, hedef: { webhook }, odeyen: tahsil.payer || dog.payer, odemeTx: tahsil.transaction }, ilk, simdi);
    console.log("SETTLED_WATCH", JSON.stringify({ tx: tahsil.transaction, token, id: izleme.id }));
    try { c.executionCtx.waitUntil(yakmaDene()); } catch { yakmaDene(); }
    return json(c, { watchId: izleme.id, token, webhook, expiresAt: new Date(izleme.bitis * 1000).toISOString(), status: ay.publicUrl + "/lp-watch/" + izleme.id, baseline: { verdict: izleme.son.verdict, rugRisk: izleme.son.rugRisk, protectedPct: izleme.son.protectedPct, liquidityUsd: izleme.son.liquidityUsd, locks: izleme.son.kilitler }, alreadyDue: ilkOlaylar, events: ["LIQUIDITY_DROP", "PROTECTION_DROP", "VERDICT_CHANGE", "UNLOCK_SOON", "UNLOCKED"], payment: { payer: tahsil.payer || dog.payer, transaction: tahsil.transaction, network: tahsil.network } }, 200, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(tahsil) });
  });
  app.get("/lp-watch/:id", async (c) => {
    if (!c.env?.WATCH_KV) return json(c, { error: "watching not enabled" }, 503);
    const w = await izlemeOku(c.env.WATCH_KV, c.req.param("id"));
    if (!w) return json(c, { error: "not found or expired" }, 404);
    return json(c, { watchId: w.id, token: w.token, expiresAt: new Date(w.bitis * 1000).toISOString(), lastCheck: new Date(w.son.t * 1000).toISOString(), current: { verdict: w.son.verdict, rugRisk: w.son.rugRisk, protectedPct: w.son.protectedPct, liquidityUsd: w.son.liquidityUsd, locks: w.son.kilitler }, eventsSent: w.olaySayisi });
  });
  // ───────── Exit Guard: elde tutulan pozisyonların çıkış ölçümü ve izlenmesi ─────────
  const X_FIYAT = ay.exitCheckPrice || "$0.02";
  const X_USD = X_FIYAT.replace("$", "");
  const G_FIYAT = ay.exitGuardPrice || "$3";
  const G_USD = G_FIYAT.replace("$", "");
  const xHata = (m) => { const e = new Error(m); e.kullanici = true; return e; };
  const cuzdanKontrol = async (cuzdan, tokenGirdi) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(cuzdan)) throw xHata("wallet must be a 0x-prefixed 20-byte address");
    let tl = tokenListesi(tokenGirdi || "");
    const k = await tokenKesfet(okur, getAddress(cuzdan));
    for (const t of k.tokens) if (!tl.includes(t)) tl.push(t);
    tl = tl.filter((t) => t.toLowerCase() !== ay.lp.weth.toLowerCase() && t.toLowerCase() !== ay.lp.usdc.toLowerCase()).slice(0, MAX_TOKEN);
    const o = await cuzdanOlc(okur, ay.lp, cuzdan, tl, Math.floor(Date.now() / 1000));
    if (o.positions.length && o.positions.every((p) => p.gecici)) throw new Error("chain read failed");
    return { tokenler: tl, sonBlok: k.sonBlok, olcum: o };
  };
  const xRapor = (cuzdan, r) => {
    const held = r.olcum.positions.filter((p) => p.held).map((p) => {
      // Token riski (dolandırıcılık işaretleri) ile pozisyon büyüklüğünden doğan sığ likidite ayrı tutulur.
      const flags = [];
      if (p.sellable === false) flags.push("SELL_BLOCKED");
      if ((p.sellTaxPct ?? 0) > 10) flags.push("HIGH_SELL_TAX");
      if (p.rugRisk === "HIGH" || p.rugRisk === "NO_LIQUIDITY") flags.push("LIQUIDITY_REMOVABLE");
      if (p.sellable && (p.exitLossPct ?? 0) > 20) flags.push("LOW_EXIT_LIQUIDITY");
      return { ...p, flags };
    });
    const tokenRiski = (p) => p.flags.some((f) => f !== "LOW_EXIT_LIQUIDITY");
    return {
      wallet: getAddress(cuzdan),
      summary: { positions: held.length, sellable: held.filter((p) => p.sellable).length, blocked: held.filter((p) => p.sellable === false).length, tokenRisk: held.filter(tokenRiski).length, lowExitLiquidity: held.filter((p) => p.flags.includes("LOW_EXIT_LIQUIDITY")).length, exitValueEth: Math.round(held.reduce((a, p) => a + (p.exitValueEth || 0), 0) * 1e8) / 1e8, exitValueUsd: r.olcum.ethUsd ? Math.round(held.reduce((a, p) => a + (p.exitValueEth || 0), 0) * r.olcum.ethUsd * 100) / 100 : null },
      positions: held.map(({ lp, gecici, measurable, held: _h, ...p }) => p),
      notHeldOrUnmeasurable: r.olcum.positions.filter((p) => !p.held).map((p) => ({ token: p.token, symbol: p.symbol, reason: p.reason || (p.measurable === false ? "unmeasurable" : p.error || "zero balance") })),
      tokensScanned: r.tokenler.length,
      method: "Each position is sold in an eth_call from your own wallet address (state override puts a sell routine at the wallet), against the deepest V2-style WETH pool, for your full balance: measures whether it can be sold, the sell tax applied to your wallet, price impact and what you would receive. No transaction is sent. Tokens: those you pass plus any received in roughly the last 11 hours.",
      checkedAt: new Date().toISOString(),
    };
  };
  const X_ORNEK = { wallet: "0x…", summary: { positions: 3, sellable: 2, blocked: 1, tokenRisk: 1, lowExitLiquidity: 0, exitValueEth: 0.41, exitValueUsd: 1230.5 }, positions: [{ token: "0x…", symbol: "MEME", balance: "1250000", sellable: true, sellTaxPct: 0, priceImpactPct: 2.1, exitLossPct: 2.4, exitValueEth: 0.4, exitValueUsd: 1200, rugRisk: "LOW" }, { token: "0x…", symbol: "TRAP", sellable: false, error: "transfer: BLOCKED", rugRisk: "HIGH" }] };
  const xBazaar = declareDiscoveryExtension({ input: { wallet: "0x0000000000000000000000000000000000000001", tokens: "0x532f27101965dd16442E59d40670FaF5eBB142E4" }, inputSchema: { properties: { wallet: { type: "string", description: "Base wallet that holds the tokens" }, tokens: { type: "string", description: "optional comma-separated token addresses (max 20); recent incoming tokens are found automatically" } }, required: ["wallet"] }, output: { example: X_ORNEK } });
  const xKaynak = () => ({ url: ay.publicUrl + "/exit-check", description: `Can your agent still get out? For every token a Base wallet holds, simulates selling the FULL balance from that wallet (catches blacklists, wallet-specific taxes and taxes raised after you bought) and returns sellable / sell tax / price impact / what you would receive, plus LP rug risk. $${X_USD} USDC per wallet check, no API key. Nothing is charged if the chain cannot be read.`, mimeType: "application/json", serviceName: "AGIChainAI Exit Guard", tags: ["exit", "honeypot", "rug-pull", "portfolio", "positions", "base", "trading-bot", "token-safety"], iconUrl: "https://agichainai.com/assets/agi-token-256.png" });
  app.get("/exit-check", (c) => odemeli(c, { etiket: "EXIT_CHECK", fiyat: X_FIYAT, gunluk: 100, onek: "x", bazaar: xBazaar, kaynak: xKaynak(), uret: async () => { const cz = String(c.req.query("wallet") || ""); return xRapor(cz, await cuzdanKontrol(cz, c.req.query("tokens"))); } }));

  // Ücretsiz özet: kaç pozisyon, kaçı satılamıyor/riskli (token ayrıntısı yok), IP başına günde 10.
  app.get("/exit-check/lite", async (c) => {
    const cz = String(c.req.query("wallet") || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(cz)) return json(c, { error: "add ?wallet=0x… (Base address)" }, 400);
    const s = await ipSiniri(c.env?.WATCH_KV, "x" + (c.req.header("CF-Connecting-IP") || ""), 10);
    if (!s.ok) return json(c, { error: `free lite limit reached; full report: ${ay.publicUrl}/exit-check ($${X_USD})` }, 429);
    try {
      const r = xRapor(cz, await cuzdanKontrol(cz, c.req.query("tokens")));
      return json(c, { wallet: r.wallet, summary: r.summary, tokenRisk: r.positions.filter((p) => p.flags.some((f) => f !== "LOW_EXIT_LIQUIDITY")).map((p) => ({ token: p.symbol || p.token, flags: p.flags })), lowExitLiquidity: r.positions.filter((p) => p.flags.includes("LOW_EXIT_LIQUIDITY")).map((p) => ({ token: p.symbol || p.token, exitLossPct: p.exitLossPct, note: "your position is large relative to the pool; selling it all at once loses value to price impact (not a scam signal)" })), full: `${ay.publicUrl}/exit-check?wallet=${r.wallet} ($${X_USD}: per-position tax, impact, exit value)`, guard: `POST ${ay.publicUrl}/exit-guard ($${G_USD} for ${GUARD_GUN} days of webhook alerts)`, remainingToday: s.remaining, checkedAt: r.checkedAt });
    } catch (e) {
      if (e.kullanici) return json(c, { error: e.message }, 400);
      return json(c, { error: "Could not read the chain right now." }, 503);
    }
  });

  const G_SEMA = { type: "object", required: ["wallet", "webhook"], properties: { wallet: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, webhook: { type: "string", description: "https URL that receives a JSON POST for each event" }, tokens: { type: "array", items: { type: "string" }, description: "optional; tokens received later are added automatically (max 20)" } } };
  const G_ORNEK = { guardId: "3f2a…", wallet: "0x…", expiresAt: "2026-12-27T00:00:00.000Z", watching: 4, events: OLAY_TURLERI, baseline: X_ORNEK.summary };
  const gBazaar = declareDiscoveryExtension({ method: "POST", input: { wallet: "0x0000000000000000000000000000000000000001", webhook: "https://example.com/hooks/exit" }, inputSchema: G_SEMA, bodyType: "json", output: { example: G_ORNEK } });
  const gKaynak = () => ({ url: ay.publicUrl + "/exit-guard", description: `${GUARD_GUN}-day Exit Guard for a trading agent's wallet: every position (up to ${MAX_TOKEN}, new ones added automatically) is sold in simulation from your wallet about every 10 minutes; your webhook gets an event when a sell starts failing (blacklist/honeypot switch), the sell tax for your wallet rises, what you would receive drops 30%+, the LP lock protection falls, or an LP lock is about to unlock. Changes are confirmed by a second independent read. $${G_USD} USDC once, or free with a 30-day AGI pass.`, mimeType: "application/json", serviceName: "AGIChainAI Exit Guard", tags: ["exit", "monitoring", "webhook", "honeypot", "rug-pull", "portfolio", "base", "trading-bot"], iconUrl: "https://agichainai.com/assets/agi-token-256.png" });
  app.post("/exit-guard", async (c) => {
    const baslik = c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT");
    const holder = c.req.header("AGI-HOLDER");
    await hazirla();
    const sartlar = await sunucu.buildPaymentRequirements({ scheme: "exact", payTo: hesap.address, price: G_FIYAT, network: ay.network, maxTimeoutSeconds: 120 });
    const odemeIste = async (hata) => { const pr = await sunucu.createPaymentRequiredResponse(sartlar, gKaynak(), hata, gBazaar); return json(c, { ...pr, holderAccess: { pass: `burn ${H_MIN / 10n ** 18n} AGI to 0x000000000000000000000000000000000000dEaD, then POST {"tx":"0x…"} to ${ay.publicUrl}/pass/activate`, header: "AGI-HOLDER", guardsPerDay: 3, note: "with a pass, the guard lasts until the pass expires (max 30 days)" } }, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }); };
    let g = {}; try { g = await c.req.json(); } catch {}
    const cuzdan = String(g.wallet || ""), webhook = String(g.webhook || "");
    if (!baslik && !holder) return odemeIste();
    if (!c.env?.WATCH_KV) return json(c, { error: "Exit Guard is not enabled yet; nothing was charged." }, 503);
    if (!webhookGecerli(webhook)) return json(c, { error: "webhook must be a public https URL (no IPs, no credentials); nothing was charged." }, 400);
    let r;
    try { r = await cuzdanKontrol(cuzdan, g.tokens); }
    catch (e) { if (e.kullanici) return json(c, { error: e.message + "; nothing was charged." }, 400); return json(c, { error: "Could not read the chain right now; nothing was charged." }, 503); }
    let odeme = null, erisim = "usdc", bitisUst = null, odeyen = null, odemeTx = null;
    if (holder && !baslik) {
      const h = await holderDogrula({ okur, kv: c.env.WATCH_KV, agi: ay.adres.agi, minimum: H_MIN, gunluk: 3, baslik: holder, onek: "gx" });
      if (!h.ok) return odemeIste(h.reason);
      erisim = "agi-pass"; odeyen = h.address; bitisUst = h.passExpiresAt ? Math.floor(Date.parse(h.passExpiresAt) / 1000) : null;
    } else {
      let yuk; try { yuk = decodePaymentSignatureHeader(baslik); } catch { return odemeIste("invalid payment header"); }
      const sart = sartlar.find((x) => x.scheme === yuk.accepted?.scheme && x.network === yuk.accepted?.network) || sartlar[0];
      let dog; try { dog = await sunucu.verifyPayment(yuk, sart, gBazaar); } catch (e) { return odemeIste("verification failed: " + (e.message || e)); }
      if (!dog.isValid) return odemeIste(dog.invalidReason || "payment invalid");
      try { const pr = await sunucu.createPaymentRequiredResponse(sartlar, gKaynak(), undefined, gBazaar); yuk.extensions = { ...(pr.extensions || {}), ...(yuk.extensions || {}) }; if (!yuk.resource) yuk.resource = pr.resource; } catch {}
      let tahsil; try { tahsil = await sunucu.settlePayment(yuk, sart, gBazaar); } catch (e) { return odemeIste("settlement failed: " + (e.message || e)); }
      if (!tahsil.success) return odemeIste(tahsil.errorReason || "settlement failed");
      odeyen = tahsil.payer || dog.payer; odemeTx = tahsil.transaction; odeme = tahsil;
      try { c.executionCtx.waitUntil(yakmaDene()); } catch { yakmaDene(); }
    }
    const simdi = Math.floor(Date.now() / 1000);
    const { bekci, ilkOlaylar } = await bekciEkle(c.env.WATCH_KV, { cuzdan, webhook, tokenler: r.tokenler, sonBlok: r.sonBlok, olcum: r.olcum, odeyen, odemeTx, erisim }, simdi);
    if (bitisUst && bitisUst < bekci.bitis) { bekci.bitis = bitisUst; await c.env.WATCH_KV.put("g:" + bekci.id, JSON.stringify(bekci), { expiration: bekci.bitis + 86400 }); }
    console.log("EXIT_GUARD_CREATED", JSON.stringify({ id: bekci.id, erisim, odeyen, tx: odemeTx, tokens: r.tokenler.length }));
    return json(c, { guardId: bekci.id, wallet: bekci.cuzdan, webhook, expiresAt: new Date(bekci.bitis * 1000).toISOString(), status: ay.publicUrl + "/exit-guard/" + bekci.id, watching: r.tokenler.length, events: OLAY_TURLERI, baseline: xRapor(cuzdan, r).summary, alreadyDue: ilkOlaylar, addTokens: `POST ${ay.publicUrl}/exit-guard/${bekci.id}/tokens {"tokens":["0x…"]}`, access: erisim, payment: odeme ? { payer: odeme.payer, transaction: odeme.transaction, network: odeme.network } : null }, 200, odeme ? { "PAYMENT-RESPONSE": encodePaymentResponseHeader(odeme) } : {});
  });
  app.get("/exit-guard/:id", async (c) => {
    if (!c.env?.WATCH_KV) return json(c, { error: "not enabled" }, 503);
    const g = await bekciOku(c.env.WATCH_KV, c.req.param("id"));
    if (!g) return json(c, { error: "not found or expired" }, 404);
    return json(c, { guardId: g.id, wallet: g.cuzdan, expiresAt: new Date(g.bitis * 1000).toISOString(), lastCheck: new Date(g.t * 1000).toISOString(), eventsSent: g.olaySayisi, positions: Object.entries(g.son).filter(([, v]) => v && v.held).map(([t, v]) => ({ token: t, symbol: v.sym, balance: v.bal, sellable: v.ok, sellTaxPct: v.tax, exitValueEth: v.eth })), watching: g.tokenler.length });
  });
  app.post("/exit-guard/:id/tokens", async (c) => {
    if (!c.env?.WATCH_KV) return json(c, { error: "not enabled" }, 503);
    const g = await bekciOku(c.env.WATCH_KV, c.req.param("id"));
    if (!g) return json(c, { error: "not found or expired" }, 404);
    let b = {}; try { b = await c.req.json(); } catch {}
    let tl; try { tl = tokenListesi(b.tokens || []); } catch (e) { return json(c, { error: e.message }, 400); }
    for (const t of tl) if (!g.tokenler.includes(t) && g.tokenler.length < MAX_TOKEN) g.tokenler.push(t);
    await c.env.WATCH_KV.put("g:" + g.id, JSON.stringify(g), { expiration: g.bitis + 86400 });
    return json(c, { guardId: g.id, watching: g.tokenler, max: MAX_TOKEN });
  });

  // Zamanlanmış tarama (index.js scheduled → tara)
  const lpTara = async (kv) => izlemeleriTara(kv, (t) => lpKilitAnalizi(okur, ay.lp, t), async (w, o, s) => {
    if (!w.hedef?.webhook) return;
    await fetch(w.hedef.webhook, { method: "POST", headers: { "content-type": "application/json", "user-agent": "AGIChainAI-LP-Watch/1" }, body: JSON.stringify(olayGovdesi(w, o, s)), signal: AbortSignal.timeout(8000) });
  }, Math.floor(Date.now() / 1000));
  const bekciTara = async (kv) => {
    let sonBlok = null; try { sonBlok = await okur.getBlockNumber({ cacheTime: 0 }); } catch {}
    return bekcileriTara(kv, {
      sonBlok,
      olc: (cz, tl) => cuzdanOlc(okur, ay.lp, cz, tl, Math.floor(Date.now() / 1000)),
      kesfet: (cz, o) => tokenKesfet(okur, cz, { ...o, parca: 5000 }),
      bildir: async (g, ol, olcum) => { await fetch(g.webhook, { method: "POST", headers: { "content-type": "application/json", "user-agent": "AGIChainAI-Exit-Guard/1" }, body: JSON.stringify(bekciGovdesi(g, ol, olcum)), signal: AbortSignal.timeout(8000) }); },
    }, Math.floor(Date.now() / 1000));
  };
  // LP izlemeleri ~30 dakikada bir, Exit Guard her çalışmada (cron 10 dakika).
  const tara = async (kv, { lp = true } = {}) => ({ guard: await bekciTara(kv), lp: lp ? await lpTara(kv) : null });

  app.notFound((c) => json(c, { error: "not found", see: ay.publicUrl + "/" }, 404));
  // Hata ayrıntısı herkese açık bilgiden ibarettir (anahtar asla mesajlarda yer almaz); ilk sürümde teşhis için döndürülür.
  app.onError((e, c) => { console.error("ERR", e && (e.stack || e.message)); return json(c, { error: "internal error", detail: String((e && (e.shortMessage || e.message)) || e).slice(0, 300) }, 500); });
  return { app, hesap, tara };
}
