// Base veri paketi: ajanların döngü içinde tekrar tekrar satın aldığı basit veriler.
// gas, token fiyatı (USD), cüzdan bakiyesi. Hepsi canlı zincir okuması.
import { getAddress, parseAbi, formatUnits, formatGwei, isAddress } from "viem";
import { lpKilitAnalizi } from "./lplock.js";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

export async function gasBilgisi(okur) {
  const [blok, gasPrice, oncelik] = await Promise.all([
    okur.getBlock(),
    okur.getGasPrice(),
    okur.estimateMaxPriorityFeePerGas().catch(() => 0n),
  ]);
  const taban = blok.baseFeePerGas ?? 0n;
  const oneri = (carpan) => taban * BigInt(carpan) / 100n + oncelik;
  const transferUsd = null;
  return {
    chainId: 8453,
    block: Number(blok.number),
    timestamp: new Date(Number(blok.timestamp) * 1000).toISOString(),
    baseFeeGwei: formatGwei(taban),
    priorityFeeGwei: formatGwei(oncelik),
    gasPriceGwei: formatGwei(gasPrice),
    suggested: {
      slow: { maxFeePerGasGwei: formatGwei(oneri(110)), maxPriorityFeePerGasGwei: formatGwei(oncelik) },
      standard: { maxFeePerGasGwei: formatGwei(oneri(150)), maxPriorityFeePerGasGwei: formatGwei(oncelik) },
      fast: { maxFeePerGasGwei: formatGwei(oneri(200) + oncelik), maxPriorityFeePerGasGwei: formatGwei(oncelik * 2n) },
    },
    blockGasUsedPct: blok.gasLimit > 0n ? Math.round(Number((blok.gasUsed * 10000n) / blok.gasLimit)) / 100 : null,
    transferUsd,
  };
}

// Fiyat: en derin V2 tipi havuz (Uniswap V2 / Aerodrome / AGIChainAI) ve Chainlink ETH/USD.
export async function fiyatBilgisi(okur, ay, token, simdi) {
  const j = await lpKilitAnalizi(okur, ay, getAddress(token), simdi);
  const havuzlar = (j.v2Pools || []).filter((p) => p.liquidityUsd !== null && p.liquidityUsd !== undefined).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const v3 = (j.v3Pools || []).filter((p) => p.liquidityUsd).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const en = havuzlar[0];
  let priceUsd = null, kaynak = null;
  if (en && Number(en.reserves.token) > 0) {
    const qUsd = en.liquidityUsd / 2; // havuzun karşı tarafının USD değeri
    priceUsd = qUsd / Number(en.reserves.token);
    kaynak = { dex: en.dex, pool: en.pair, quote: en.quote, liquidityUsd: en.liquidityUsd };
  }
  return {
    token: j.token,
    priceUsd,
    source: kaynak,
    note: !en ? (v3.length ? "Only Uniswap V3 liquidity found; V3 pricing is not included in this endpoint." : "No V2-style pool with USD-priced liquidity found.") : (en.liquidityUsd < 1000 ? "Thin liquidity: the price can move a lot on small trades." : null),
    totalLiquidityUsd: j.liquidityUsd,
    checkedAt: j.checkedAt,
  };
}

export async function bakiyeBilgisi(okur, adres, tokenlar = []) {
  if (!isAddress(adres)) { const e = new Error("address must be a 0x-prefixed 20-byte address"); e.kullanici = true; throw e; }
  const a = getAddress(adres);
  const liste = [...new Set(tokenlar.filter(isAddress).map((t) => getAddress(t)))].slice(0, 20);
  const [eth, ...tok] = await Promise.all([
    okur.getBalance({ address: a }),
    ...liste.map(async (t) => {
      try {
        const [b, d, s] = await Promise.all([
          okur.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [a] }),
          okur.readContract({ address: t, abi: ERC20, functionName: "decimals" }),
          okur.readContract({ address: t, abi: ERC20, functionName: "symbol" }).catch(() => null),
        ]);
        return { token: t, symbol: s, balance: formatUnits(b, d), raw: b.toString(), decimals: Number(d) };
      } catch { return { token: t, error: "not an ERC-20 on Base" }; }
    }),
  ]);
  const kod = await okur.getCode({ address: a });
  return { address: a, isContract: !!kod && kod !== "0x", eth: formatUnits(eth, 18), tokens: tok };
}
