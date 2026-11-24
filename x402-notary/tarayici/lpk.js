import { createPublicClient, http, fallback } from "viem";
import { base } from "viem/chains";
import { lpKilitAnalizi, BASE_LP } from "../src/lplock.js";
window.LPK = async (token) => {
  const okur = createPublicClient({ chain: base, transport: fallback([http("https://mainnet.base.org"), http("https://base-rpc.publicnode.com")]), batch: { multicall: true } });
  return lpKilitAnalizi(okur, BASE_LP, token);
};
