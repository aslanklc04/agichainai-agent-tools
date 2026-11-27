// Ön-alım (pre-trade) token kontrolü: honeypot/vergi simülasyonu + sahip yetkileri + proxy + LP kilidi.
// Simülasyon, AlimSatimSim bayt kodunu eth_call içinde state override ile rastgele bir adrese koyarak yapılır;
// zincirde hiçbir şey dağıtılmaz ve para harcanmaz.
import { encodeFunctionData, decodeFunctionResult, toFunctionSelector, getAddress, zeroAddress, parseEther, formatEther } from "viem";
import { SIM_CODE, SIM_ABI } from "./sim-bytecode.js";
import { lpKilitAnalizi } from "./lplock.js";

const SIM_ADRES = "0x5100000000000000000000000000000000005e11";
const SIM_GONDEREN = "0x5100000000000000000000000000000000c0ffee";
const WETH = "0x4200000000000000000000000000000000000006";
const DEAD = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// Riskli yetki imzaları: bayt kodunda seçici (PUSH4) olarak aranır.
const YETKILER = {
  mint: ["mint(address,uint256)", "mint(uint256)", "_mint(address,uint256)", "mintTo(address,uint256)"],
  blacklist: ["blacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "blacklistAddress(address,bool)", "setBots(address[],bool)", "addBots(address[])", "setBot(address,bool)", "blockBots(address[])", "setIsBlacklisted(address,bool)"],
  pause: ["pause()", "setPaused(bool)", "pauseTrading()"],
  feeChange: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxFeePercent(uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "setTaxes(uint256,uint256)", "updateFees(uint256,uint256)", "setBuyTax(uint256)", "setSellTax(uint256)", "updateBuyFees(uint256,uint256,uint256)", "updateSellFees(uint256,uint256,uint256)"],
  maxTx: ["setMaxTxAmount(uint256)", "setMaxWalletSize(uint256)", "setMaxTxPercent(uint256)", "updateMaxTxnAmount(uint256)", "updateMaxWalletAmount(uint256)"],
  tradingToggle: ["enableTrading()", "openTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "startTrading()"],
};
const SECICI = Object.fromEntries(Object.entries(YETKILER).map(([k, l]) => [k, l.map((s) => ({ s, h: toFunctionSelector(s).slice(2) }))]));
const OWNER_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

function yetkiTara(kod) {
  const k = kod.toLowerCase();
  const out = {};
  for (const [ad, l] of Object.entries(SECICI)) {
    const bulunan = l.filter(({ h }) => k.includes("63" + h)).map(({ s }) => s);
    if (bulunan.length) out[ad] = bulunan;
  }
  return out;
}

async function sahipBul(okur, token) {
  for (const fn of ["owner", "getOwner"]) {
    try { return await okur.readContract({ address: token, abi: OWNER_ABI, functionName: fn }); } catch {}
  }
  return null;
}

const yuzde = (pay, payda) => (payda > 0n ? Math.round(Number(10000n - (pay * 10000n) / payda)) / 100 : null);

async function simule(okur, havuz, token, weth) {
  const rW = parseEther(String(havuz.reserves.WETH));
  if (rW === 0n) return { simulated: false, reason: "pool has no WETH" };
  let girdi = rW / 200n; // havuzun %0,5'i: fiyat etkisi düşük kalsın
  const ust = parseEther("0.005");
  if (girdi > ust) girdi = ust;
  if (girdi === 0n) return { simulated: false, reason: "pool too small" };
  const data = encodeFunctionData({ abi: SIM_ABI, functionName: "calistir", args: [havuz.pair, token, weth, havuz.dex.startsWith("aerodrome")] });
  let r;
  try {
    r = await okur.call({ account: SIM_GONDEREN, to: SIM_ADRES, data, value: girdi, gas: 8_000_000n, stateOverride: [{ address: SIM_ADRES, code: SIM_CODE }, { address: SIM_GONDEREN, balance: parseEther("10") }] });
  } catch (e) {
    return { simulated: true, pool: havuz.pair, dex: havuz.dex, buyOk: false, sellOk: false, error: "simulation reverted: " + String(e.shortMessage || e.message).split("\n")[0].slice(0, 160) };
  }
  const s = decodeFunctionResult({ abi: SIM_ABI, functionName: "calistir", data: r.data });
  return {
    simulated: true, pool: havuz.pair, dex: havuz.dex, tradeSizeEth: formatEther(girdi),
    buyOk: s.alimOk, transferOk: s.transferGiden > 0n ? s.transferOk : null, sellOk: s.satimOk,
    buyTaxPct: s.alimOk ? Math.max(0, yuzde(s.alinan, s.beklenenAlim)) : null,
    transferTaxPct: s.transferGiden > 0n && s.transferOk ? Math.max(0, yuzde(s.transferUlasan, s.transferGiden)) : null,
    sellTaxPct: s.satimGiden > 0n && s.havuzaUlasan > 0n ? Math.max(0, yuzde(s.havuzaUlasan, s.satimGiden)) : null,
    roundTripLossPct: s.satimOk ? Math.max(0, yuzde(s.gelenWeth, girdi)) : null,
    error: s.hata || null,
  };
}

export async function tokenKontrol(okur, ay, token, simdi) {
  token = getAddress(token);
  const [lp, kod, impl, sahip] = await Promise.all([
    lpKilitAnalizi(okur, ay, token, simdi),
    okur.getCode({ address: token }),
    okur.getStorageAt({ address: token, slot: IMPL_SLOT }).catch(() => null),
    sahipBul(okur, token),
  ]);
  const proxy = impl && BigInt(impl) !== 0n ? getAddress("0x" + impl.slice(-40)) : null;
  let yetki = yetkiTara(kod || "0x");
  if (proxy) { try { yetki = { ...yetki, ...yetkiTara(await okur.getCode({ address: proxy })) }; } catch {} }
  const renounced = sahip ? DEAD.includes(sahip.toLowerCase()) : null;

  const wethHavuz = (lp.v2Pools || []).filter((p) => p.quote === "WETH" && p.dex !== "aerodrome-stable").sort((a, b) => Number(b.reserves.WETH) - Number(a.reserves.WETH))[0];
  const sim = wethHavuz ? await simule(okur, wethHavuz, token, getAddress(ay.weth || WETH)) : { simulated: false, reason: "no V2-style WETH pool to simulate (V3-only or USDC-only liquidity)" };

  // Hüküm
  const riskler = [];
  const ekle = (seviye, kod_, metin) => riskler.push({ level: seviye, code: kod_, detail: metin });
  if (sim.simulated) {
    if (!sim.buyOk) ekle("danger", "BUY_FAILS", "A simulated buy failed: " + (sim.error || "reverted"));
    else if (!sim.sellOk) ekle("danger", "HONEYPOT", "A simulated sell failed after a successful buy: " + (sim.error || "reverted"));
    if (sim.sellTaxPct !== null && sim.sellTaxPct >= 30) ekle("danger", "SELL_TAX_EXTREME", `Sell tax ${sim.sellTaxPct}%.`);
    else if (sim.sellTaxPct !== null && sim.sellTaxPct > 10) ekle("caution", "SELL_TAX_HIGH", `Sell tax ${sim.sellTaxPct}%.`);
    if (sim.buyTaxPct !== null && sim.buyTaxPct >= 30) ekle("danger", "BUY_TAX_EXTREME", `Buy tax ${sim.buyTaxPct}%.`);
    else if (sim.buyTaxPct !== null && sim.buyTaxPct > 10) ekle("caution", "BUY_TAX_HIGH", `Buy tax ${sim.buyTaxPct}%.`);
    if (sim.transferOk === false) ekle("caution", "TRANSFER_BLOCKED", "Wallet-to-wallet transfer failed in the simulation.");
  } else ekle("info", "NOT_SIMULATED", sim.reason);
  if (lp.rugRisk === "HIGH") ekle("danger", "LIQUIDITY_REMOVABLE", lp.interpretation);
  else if (lp.rugRisk === "MEDIUM") ekle("caution", "LIQUIDITY_PARTLY_LOCKED", lp.interpretation);
  else if (lp.rugRisk === "NO_LIQUIDITY") ekle("danger", "NO_LIQUIDITY", lp.interpretation);
  if (!renounced) {
    if (yetki.mint) ekle("caution", "OWNER_CAN_MINT", "Owner-callable mint function present: " + yetki.mint.join(", "));
    if (yetki.blacklist) ekle("caution", "OWNER_CAN_BLACKLIST", "Blacklist function present: " + yetki.blacklist.join(", "));
    if (yetki.pause) ekle("caution", "OWNER_CAN_PAUSE", "Pause function present: " + yetki.pause.join(", "));
    if (yetki.feeChange) ekle("caution", "OWNER_CAN_CHANGE_FEES", "Fee-change function present: " + yetki.feeChange.join(", "));
    if (yetki.tradingToggle) ekle("info", "TRADING_TOGGLE", "Owner-controlled trading switch present: " + yetki.tradingToggle.join(", "));
    if (yetki.maxTx) ekle("info", "MAX_TX_LIMITS", "Max transaction/wallet limits can be set: " + yetki.maxTx.join(", "));
  }
  if (proxy) ekle("caution", "UPGRADEABLE_PROXY", `EIP-1967 proxy: the logic (${proxy}) can be replaced by its admin.`);

  const danger = riskler.filter((r) => r.level === "danger").length;
  const caution = riskler.filter((r) => r.level === "caution").length;
  const verdict = danger ? "DANGER" : caution ? "CAUTION" : sim.simulated ? "SAFE" : "UNVERIFIED";
  const score = Math.max(0, 100 - danger * 45 - caution * 12);

  return {
    token: lp.token,
    verdict, score,
    summary: verdict === "DANGER" ? riskler.filter((r) => r.level === "danger").map((r) => r.detail).join(" ") : verdict === "CAUTION" ? riskler.filter((r) => r.level === "caution").map((r) => r.code).join(", ") : verdict === "SAFE" ? "Buy, transfer and sell simulate cleanly; no major owner powers or removable liquidity found." : "No V2-style WETH pool to simulate; see liquidity details.",
    risks: riskler,
    simulation: sim,
    owner: { address: sahip, renounced, powers: yetki, proxyImplementation: proxy },
    liquidity: { verdict: lp.verdict, rugRisk: lp.rugRisk, protectedPctWeightedByLiquidity: lp.protectedPctWeightedByLiquidity, liquidityUsd: lp.liquidityUsd, v2Pools: lp.v2Pools, v3Pools: lp.v3Pools, notes: lp.notes },
    checkedAt: lp.checkedAt,
    method: "Buy → wallet transfer → sell simulated in an eth_call against the deepest V2-style WETH pool (no transaction is sent); owner powers from function selectors in the bytecode (and proxy implementation); LP lock from on-chain LP balances of burn addresses and known lockers. Heuristics, not an audit.",
  };
}
