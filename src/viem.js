// Standalone signer: a viem client on Base. The private key belongs to the AGENT's own hot wallet,
// funded with small amounts only. Never use a personal or treasury wallet key here.
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createAgiTools, BASE_MAINNET } from "./core.js";

export function createViemAgiTools({ rpcUrl, privateKey, addresses, limits, chain } = {}) {
  const ch = chain || base;
  const transport = http(rpcUrl || ch.rpcUrls.default.http[0]);
  const pub = createPublicClient({ chain: ch, transport });
  const acct = privateKey ? privateKeyToAccount(privateKey) : null;
  const wallet = acct ? createWalletClient({ chain: ch, transport, account: acct }) : null;
  let checked = false;
  async function checkChain() {
    if (checked) return;
    const id = await pub.getChainId();
    const want = addresses?.chainId ?? BASE_MAINNET.chainId;
    if (id !== want) throw new Error(`RPC is on chain ${id}, expected ${want}`);
    checked = true;
  }
  return createAgiTools({
    addresses, limits,
    read: async (p) => { await checkChain(); return pub.readContract(p); },
    getEthBalance: (a) => pub.getBalance({ address: a }),
    account: acct ? async () => acct.address : undefined,
    signTypedData: wallet ? (td) => wallet.signTypedData({ account: acct, ...td }) : undefined,
    signMessage: wallet ? (message) => wallet.signMessage({ account: acct, message }) : undefined,
    send: wallet ? async (tx) => {
      await checkChain();
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n });
      const r = await pub.waitForTransactionReceipt({ hash });
      return { hash, status: r.status };
    } : undefined,
  });
}

export { defineChain };
