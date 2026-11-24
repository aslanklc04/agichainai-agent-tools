// Likidite kilidi analizi: bir Base token'ının V2 tarzı havuzlarında LP paylarının ne kadarı yakılmış, ne kadarı
// bilinen kilit kontratlarında, ne kadarı çekilebilir durumda? V3 havuzları listelenir (kilit durumu NFT bazlı, ölçülmez).
import { parseAbi, getAddress, formatUnits, zeroAddress } from "viem";

const ERC20 = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)",
  "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const V2_FAB = parseAbi(["function getPair(address,address) view returns (address)"]);
const AERO_FAB = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const AERO_VOTER = parseAbi(["function gauges(address) view returns (address)"]);
const PAIR = parseAbi(["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)", "function totalSupply() view returns (uint256)"]);
const V3_FAB = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const UNCX = parseAbi([
  "function getNumLocksForToken(address) view returns (uint256)",
  "function tokenLocks(address,uint256) view returns (uint256 lockDate, uint256 amount, uint256 initialAmount, uint256 unlockDate, uint256 lockID, address owner)",
]);
const BIZIM_KILIT = parseAbi(["function aktifMiktar(address,uint256,uint256) view returns (uint256,uint256)"]);
const CHAINLINK = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);

const YAKMA = ["0x000000000000000000000000000000000000dEaD", zeroAddress];

/** Base ana ağı adresleri. */
export const BASE_LP = {
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  v2: [
    { dex: "uniswap-v2", factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6" },
    { dex: "agichainai", factory: "0xCD7B0C7EA761565CA5A2444bf1cCcd29A126F824" },
  ],
  aerodrome: { factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5" },
  v3: { factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", fees: [100, 500, 3000, 10000] },
  lockers: [
    { name: "UNCX (Uniswap V2)", address: "0xc4E637D37113192F4F1F060DaEbD7758De7F4131", type: "uncx" },
    { name: "UNCX (Uniswap V2, legacy)", address: "0xED9180976c2a4742C7A57354FD39d8BEc6cbd8AB", type: "uncx" },
    { name: "UNCX (Sushiswap)", address: "0xBeddF48499788607B4c2e704e9099561ab38Aae8", type: "uncx" },
    { name: "UNCX (Aerodrome)", address: "0x30e522deDfFE3e3d11Cd53E27d18Cd4F016eD870", type: "uncx" },
    { name: "Team Finance", address: "0xE2fE530C047f2d85298b07D9333C05737f1435fB", type: "plain" },
    { name: "AGIChainAI lock", address: "0x3F6b4d102aFb926cb19Db347D8fE6E6a79eC0E7D", type: "agichainai" },
  ],
};

const yuzde = (pay, payda) => (payda === 0n ? 0 : Number((pay * 1_000_000n) / payda) / 10_000);

/**
 * @param okur viem public client
 * @param ay BASE_LP biçiminde adresler
 * @param token incelenecek token
 * @param simdi saniye cinsinden zaman (test için)
 */
export async function lpKilitAnalizi(okur, ay, token, simdi) {
  token = getAddress(token);
  // "Şimdi" zincirin son bloğunun zamanıdır: kilidin açılıp açılmadığına sözleşme de böyle karar verir.
  if (simdi === undefined) simdi = Number((await okur.getBlock()).timestamp);
  const kod = await okur.getCode({ address: token });
  if (!kod || kod === "0x") { const e = new Error("not a contract on Base"); e.kullanici = true; throw e; }
  const oku = (address, abi, functionName, args = []) => okur.readContract({ address, abi, functionName, args });
  const guvenli = (p) => p.catch(() => null);

  const [ad, sembol, ondalik, arz] = await Promise.all([
    guvenli(oku(token, ERC20, "name")), guvenli(oku(token, ERC20, "symbol")),
    guvenli(oku(token, ERC20, "decimals")), guvenli(oku(token, ERC20, "totalSupply")),
  ]);
  if (ondalik === null || arz === null) { const e = new Error("not an ERC-20 token"); e.kullanici = true; throw e; }

  const quotes = [{ sym: "WETH", address: getAddress(ay.weth), dec: 18 }, { sym: "USDC", address: getAddress(ay.usdc), dec: 6 }]
    .filter((q) => q.address !== token);
  let ethUsd = null;
  try { const r = await oku(ay.ethUsd, CHAINLINK, "latestRoundData"); ethUsd = Number(r[1]) / 1e8; } catch {}
  const usd = (q, ham) => (q.sym === "USDC" ? Number(formatUnits(ham, 6)) : ethUsd ? Number(formatUnits(ham, 18)) * ethUsd : null);

  // 1) V2 tarzı havuzları bul
  const adaylar = [];
  for (const q of quotes) {
    for (const f of ay.v2) adaylar.push({ dex: f.dex, q, p: guvenli(oku(f.factory, V2_FAB, "getPair", [token, q.address])) });
    if (ay.aerodrome) for (const st of [false, true]) adaylar.push({ dex: st ? "aerodrome-stable" : "aerodrome-volatile", q, p: guvenli(oku(ay.aerodrome.factory, AERO_FAB, "getPool", [token, q.address, st])), aero: true });
  }
  const havuzlar = [];
  for (const a of adaylar) { const adr = await a.p; if (adr && adr !== zeroAddress) havuzlar.push({ dex: a.dex, q: a.q, pair: getAddress(adr), aero: a.aero }); }

  // 2) Her havuz için LP dağılımı
  const sonuc = [];
  for (const h of havuzlar) {
    const [rez, t0, lpArz] = await Promise.all([oku(h.pair, PAIR, "getReserves"), oku(h.pair, PAIR, "token0"), oku(h.pair, PAIR, "totalSupply")]);
    const tokenIlk = getAddress(t0) === token;
    const rToken = tokenIlk ? rez[0] : rez[1], rQuote = tokenIlk ? rez[1] : rez[0];
    const qUsd = usd(h.q, rQuote);
    const yakilan = (await Promise.all(YAKMA.map((a) => oku(h.pair, ERC20, "balanceOf", [a])))).reduce((s, x) => s + x, 0n);
    const kilitler = [];
    for (const L of ay.lockers) {
      const bak = await oku(h.pair, ERC20, "balanceOf", [L.address]).catch(() => 0n);
      if (bak === 0n) continue;
      const k = { name: L.name, locker: L.address, pct: yuzde(bak, lpArz) };
      if (L.type === "uncx") {
        try {
          const n = await oku(L.address, UNCX, "getNumLocksForToken", [h.pair]);
          let enYakin = null, enUzak = null;
          for (let i = 0n; i < n && i < 20n; i++) {
            const t = await oku(L.address, UNCX, "tokenLocks", [h.pair, i]);
            if (t[1] === 0n) continue;
            const u = Number(t[3]);
            enYakin = enYakin === null ? u : Math.min(enYakin, u); enUzak = enUzak === null ? u : Math.max(enUzak, u);
          }
          if (enYakin !== null) { k.earliestUnlock = new Date(enYakin * 1000).toISOString(); k.latestUnlock = new Date(enUzak * 1000).toISOString(); k.expired = enYakin <= simdi; }
        } catch {}
      } else if (L.type === "agichainai") {
        try { const [aktif] = await oku(L.address, BIZIM_KILIT, "aktifMiktar", [h.pair, 0n, 200n]); k.activePct = yuzde(aktif, lpArz); } catch {}
      }
      kilitler.push(k);
    }
    let gauge = null;
    if (h.aero && ay.aerodrome.voter) {
      try {
        const g = await oku(ay.aerodrome.voter, AERO_VOTER, "gauges", [h.pair]);
        if (g && g !== zeroAddress) { const b = await oku(h.pair, ERC20, "balanceOf", [g]); if (b > 0n) gauge = { address: g, pct: yuzde(b, lpArz) }; }
      } catch {}
    }
    const burnedPct = yuzde(yakilan, lpArz);
    // Süresi dolmuş UNCX kilidi ve bizim kilitteki süresi dolmuş kısım "kilitli" sayılmaz.
    const lockedPct = kilitler.reduce((s, k) => s + (k.expired ? 0 : k.activePct !== undefined ? k.activePct : k.pct), 0);
    const korunan = Math.min(100, burnedPct + lockedPct);
    sonuc.push({
      dex: h.dex, pair: h.pair, quote: h.q.sym,
      reserves: { token: formatUnits(rToken, ondalik), [h.q.sym]: formatUnits(rQuote, h.q.dec) },
      liquidityUsd: qUsd === null ? null : Math.round(qUsd * 2 * 100) / 100,
      lp: {
        burnedPct, lockedPct: Math.round(lockedPct * 10_000) / 10_000, lockers: kilitler,
        ...(gauge ? { stakedInGaugePct: gauge.pct, stakedNote: "staked in the Aerodrome gauge: earns rewards but can be withdrawn at any time (not locked)" } : {}),
        removablePct: Math.round((100 - korunan) * 10_000) / 10_000,
      },
    });
  }

  // 3) V3 havuzları (yalnız varlık ve likidite büyüklüğü)
  const v3 = [];
  if (ay.v3) {
    for (const q of quotes) for (const fee of ay.v3.fees) {
      const p = await guvenli(oku(ay.v3.factory, V3_FAB, "getPool", [token, q.address, fee]));
      if (!p || p === zeroAddress) continue;
      const qBak = await oku(q.address, ERC20, "balanceOf", [p]).catch(() => 0n);
      const tBak = await oku(token, ERC20, "balanceOf", [p]).catch(() => 0n);
      v3.push({ dex: "uniswap-v3", pool: getAddress(p), fee, quote: q.sym, reserves: { token: formatUnits(tBak, ondalik), [q.sym]: formatUnits(qBak, q.dec) }, liquidityUsd: (() => { const u = usd(q, qBak); return u === null ? null : Math.round(u * 2 * 100) / 100; })() });
    }
  }

  // 4) Hüküm: likiditesi en büyük V2 havuzuna ve likiditeye göre ağırlıklı ortalamaya göre
  const agirlikli = (() => {
    const L = sonuc.filter((s) => s.liquidityUsd);
    const top = L.reduce((t, s) => t + s.liquidityUsd, 0);
    if (!top) return null;
    return Math.round(L.reduce((t, s) => t + (100 - s.lp.removablePct) * s.liquidityUsd, 0) / top * 100) / 100;
  })();
  const v2Usd = sonuc.reduce((t, s) => t + (s.liquidityUsd || 0), 0), v3Usd = v3.reduce((t, s) => t + (s.liquidityUsd || 0), 0);
  let verdict;
  if (!sonuc.length && !v3.length) verdict = "NO_POOL";
  else if (!sonuc.length) verdict = "V3_ONLY_NOT_ASSESSED";
  else {
    const p = agirlikli ?? (100 - sonuc[0].lp.removablePct);
    verdict = p >= 95 ? "LOCKED_OR_BURNED" : p >= 80 ? "MOSTLY_LOCKED" : p >= 20 ? "PARTIAL" : "UNLOCKED";
  }
  const notlar = [];
  if (v3.length) notlar.push(`Uniswap V3 pools hold about $${Math.round(v3Usd)} of liquidity; V3 positions are NFTs and their lock status is not assessed here.`);
  if (sonuc.some((s) => s.lp.lockers.some((k) => k.expired))) notlar.push("At least one UNCX lock has expired: those LP tokens can be withdrawn by the lock owner.");
  if (verdict === "UNLOCKED" || verdict === "PARTIAL") notlar.push("Removable LP is held by ordinary wallets or unknown contracts; the holder could pull that liquidity.");

  return {
    token: { address: token, name: ad, symbol: sembol, decimals: Number(ondalik), totalSupply: formatUnits(arz, ondalik) },
    verdict,
    protectedPctWeightedByLiquidity: agirlikli,
    v2Pools: sonuc.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)),
    v3Pools: v3.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)),
    liquidityUsd: { v2Style: Math.round(v2Usd * 100) / 100, v3: Math.round(v3Usd * 100) / 100 },
    knownLockersChecked: ay.lockers.map((l) => l.name),
    notes: notlar,
    method: "On-chain reads on Base at the time of the call: LP balances of burn addresses (0x…dEaD, 0x0) and known locker contracts divided by LP total supply. Prices from the pools and Chainlink ETH/USD.",
    checkedAt: new Date(simdi * 1000).toISOString(),
  };
}
