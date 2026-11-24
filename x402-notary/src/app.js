// AGIChainAI x402 Notary — ajanlar USDC ile öder, kayıt Base'deki AGI noterine yazılır ve ücretin bir kısmı AGI alıp yakar.
// Akış (ödeme ÖNCE tahsil edilir): istek → doğrulama → (ödeme yoksa 402) → ödeme doğrula → ödemeyi tahsil et → zincire yaz.
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

export const SURUM = "1.3.0";

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
    ? fallback(rpcler.map((u) => http(u, { retryCount: 1, retryDelay: 300, timeout: 4_000, batch: { wait: 10 } })), { rank: { interval: 60_000, sampleCount: 5, timeout: 2_000 }, retryCount: 2, retryDelay: 400 })
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
    const [gaz, ucretler, eth] = await Promise.all([
      gecersizKil ? 400_000n : okur.estimateContractGas(kayitArg),
      okur.estimateFeesPerGas(), okur.getBalance({ address: hesap.address }),
    ]);
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
  app.get("/.well-known/x402", (c) => json(c, { version: 1, resources: [ay.publicUrl + "/notarize", ay.publicUrl + "/lp-lock"], instructions: "POST JSON {hash, label?}. Free lookup: GET /record/{hash}." }));

  app.get("/", async (c) => {
    return json(c, {
      name: "AGIChainAI x402 Notary",
      version: SURUM,
      description: "Prove a file or text existed at a point in time: its SHA-256 fingerprint is written to the AGIChainAI notary contract on Base. Pay per record in USDC over x402; no account, no API key, no AGI needed.",
      endpoints: {
        "POST /notarize": { price: typeof ay.price === "string" ? ay.price + " USDC" : ay.price, body: { hash: "0x + 64 hex chars (SHA-256 of your data)", label: "optional, up to ~50 characters" }, paid: "x402 (exact, USDC on Base)" },
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

  app.get("/lp-lock", async (c) => {
    const baslik = c.req.header("PAYMENT-SIGNATURE") || c.req.header("X-PAYMENT");
    await hazirla();
    const kaynak = lpKaynak();
    const sartlar = await sunucu.buildPaymentRequirements({ scheme: "exact", payTo: hesap.address, price: LP_FIYAT, network: ay.network, maxTimeoutSeconds: 120 });
    const odemeIste = async (hata) => {
      const pr = await sunucu.createPaymentRequiredResponse(sartlar, kaynak, hata, lpBazaar);
      return json(c, pr, 402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) });
    };
    const token = String(c.req.query("token") || "");
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
  });

  app.notFound((c) => json(c, { error: "not found", see: ay.publicUrl + "/" }, 404));
  // Hata ayrıntısı herkese açık bilgiden ibarettir (anahtar asla mesajlarda yer almaz); ilk sürümde teşhis için döndürülür.
  app.onError((e, c) => { console.error("ERR", e && (e.stack || e.message)); return json(c, { error: "internal error", detail: String((e && (e.shortMessage || e.message)) || e).slice(0, 300) }, 500); });
  return { app, hesap };
}
