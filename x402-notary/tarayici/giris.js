// Tarayıcı paketi: MetaMask ile x402 ödemesi (EIP-3009 imzası) yapan fetch sarmalayıcısı.
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
window.AgiX402 = {
  odeyenFetch(adres, ethereum, secenek = {}) {
    const imzalayici = {
      address: adres,
      async signTypedData({ domain, types, primaryType, message }) {
        const t = { ...types };
        if (!t.EIP712Domain) {
          t.EIP712Domain = [
            domain.name !== undefined && { name: "name", type: "string" },
            domain.version !== undefined && { name: "version", type: "string" },
            domain.chainId !== undefined && { name: "chainId", type: "uint256" },
            domain.verifyingContract !== undefined && { name: "verifyingContract", type: "address" },
          ].filter(Boolean);
        }
        const veri = JSON.stringify({ domain, types: t, primaryType, message }, (k, v) => (typeof v === "bigint" ? v.toString() : v));
        return ethereum.request({ method: "eth_signTypedData_v4", params: [adres, veri] });
      },
    };
    return wrapFetchWithPaymentFromConfig(fetch.bind(window), { schemes: [{ network: "eip155:*", client: new ExactEvmScheme(imzalayici) }], ...secenek });
  },
};
