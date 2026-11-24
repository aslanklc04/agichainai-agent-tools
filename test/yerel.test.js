// Integration test against a local hardhat chain prepared by scripts/_ajan-eklenti-hazirla.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { defineChain, sha256, toBytes } from "viem";
import { createViemAgiTools } from "../src/viem.js";
import { buildServer } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agiActionProvider } from "../src/agentkit.js";
import { ViemWalletProvider } from "@coinbase/agentkit";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// AgentKit sends its own analytics to coinbase.com; the sandbox has no route there.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).includes("cca-lite.coinbase.com") ? Promise.resolve(new Response("{}")) : realFetch(url, init));

const CFG = process.env.AGI_TEST_CONFIG || "/tmp/ajan-eklenti.json";
if (!fs.existsSync(CFG)) { test("local chain not prepared; skipping integration tests", { skip: true }, () => {}); }
const A = !fs.existsSync(CFG) ? null : JSON.parse(fs.readFileSync(process.env.AGI_TEST_CONFIG || "/tmp/ajan-eklenti.json", "utf8"));
const KEY = (process.env.AGI_TEST_KEY || fs.readFileSync("/tmp/ajan-key", "utf8")).trim();
const RPC = "http://127.0.0.1:8545";
const chain = defineChain({ id: 31337, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

const tools = createViemAgiTools({ rpcUrl: RPC, privateKey: KEY, addresses: A, chain });
const ro = createViemAgiTools({ rpcUrl: RPC, addresses: A, chain });
const T = (set, name) => set.find((t) => t.name === name);
const run = (name, args) => T(tools, name).run(args);

test("market info reads price", async () => {
  const m = await run("agi_market_info", {});
  assert.equal(m.poolAgi, "1000000");
  assert.equal(m.poolEth, "2");
  assert.ok(Math.abs(m.priceEth - 2e-6) < 1e-12);
  assert.equal(m.priceUsd, null);
});

test("balance of agent", async () => {
  const b = await run("agi_balance", {});
  assert.equal(b.agi, "50000");
  assert.ok(Number(b.eth) > 1000);
});

test("quote and price impact guard", async () => {
  const q = await run("agi_quote", { side: "buy", amount: "0.01" });
  assert.equal(q.outUnit, "AGI");
  assert.ok(Number(q.expectedOut) > 4900 && Number(q.expectedOut) < 5000);
  assert.equal(q._in, undefined);
  await assert.rejects(run("agi_quote", { side: "buy", amount: "0.5" }), /Price impact/);
});

test("buy respects per-trade limit", async () => {
  const small = createViemAgiTools({ rpcUrl: RPC, privateKey: KEY, addresses: A, chain, limits: { maxEthPerSwap: "0.001" } });
  await assert.rejects(T(small, "agi_buy").run({ ethAmount: "0.01" }), /per-trade limit/);
});

test("buy then sell", async () => {
  const r = await run("agi_buy", { ethAmount: "0.01" });
  assert.ok(r.tx.includes("/tx/0x"));
  const b = await run("agi_balance", {});
  assert.ok(Number(b.agi) > 54900);
  const s = await run("agi_sell", { agiAmount: "1000" });
  assert.ok(s.approveTx);
  assert.ok(Number(s.expectedEth) > 0.0019);
});

test("read-only instance refuses writes", async () => {
  await assert.rejects(T(ro, "agi_buy").run({ ethAmount: "0.001" }), /needs a wallet/);
  const m = await T(ro, "agi_market_info").run({});
  assert.ok(m.priceEth > 0);
});

test("tasks: list, guards, submit", async () => {
  const l = await run("agi_list_tasks", {});
  assert.equal(l.tasks.length, 1);
  assert.equal(l.tasks[0].rewardAgi, "1000");
  assert.ok(l.tasks[0].description_untrusted.startsWith("Write"));
  await assert.rejects(run("agi_submit_task", { taskId: 0, link: "javascript:alert(1)" }), /https/);
  await assert.rejects(run("agi_submit_task", { taskId: 5, link: "https://x.org" }));
  const s = await run("agi_submit_task", { taskId: 0, link: "https://github.com/me/work" });
  assert.equal(s.done, true);
  const l2 = await run("agi_list_tasks", {});
  assert.equal(l2.tasks[0].submissions, 1);
});

test("notary: record text, verify, refuse duplicate", async () => {
  const before = (await run("agi_balance", {})).agi;
  const r = await run("agi_notarize", { text: "hello agents", label: "test" });
  assert.equal(r.hash, sha256(toBytes("hello agents")));
  assert.equal(r.burnedAgi, "100");
  const after = (await run("agi_balance", {})).agi;
  assert.equal(Number(before) - Number(after), 100);
  const v = await run("agi_verify_notary", { text: "hello agents" });
  assert.equal(v.recorded, true);
  assert.equal(v.label_untrusted, "test");
  await assert.rejects(run("agi_notarize", { text: "hello agents" }), /Already recorded/);
  await assert.rejects(run("agi_notarize", { hash: "0x1234" }), /64 hex/);
  const no = await run("agi_verify_notary", { text: "never" });
  assert.equal(no.recorded, false);
});

test("directory: guards and register", async () => {
  await assert.rejects(run("agi_register_agent", { name: "Bot", profileUrl: "https://bot.example", stakeAgi: "5000" }), /Minimum stake/);
  await assert.rejects(run("agi_register_agent", { name: "Bot", profileUrl: "http://bot.example", stakeAgi: "10000" }), /https/);
  await assert.rejects(run("agi_register_agent", { name: "Bot", profileUrl: "https://bot.example", stakeAgi: "2000000" }), /limit/);
  const r = await run("agi_register_agent", { name: "Bot", profileUrl: "https://bot.example", stakeAgi: "10000" });
  assert.equal(r.stakeAgi, "10000");
  const l = await run("agi_list_agents", {});
  assert.equal(l.total, 1);
  assert.equal(l.agents[0].name_untrusted, "Bot");
  await assert.rejects(run("agi_register_agent", { name: "Bot", profileUrl: "https://bot.example", stakeAgi: "10000" }), /already registered/);
});

test("USDC notary: pay 0.01 USDC, AGI bought and burned, verify, cross-notary duplicate refused", async () => {
  const agiBefore = (await run("agi_balance", {})).agi;
  const r = await run("agi_notarize_usdc", { text: "paid in usdc", label: "usdc" });
  assert.equal(r.done, true);
  assert.equal(r.paidUsdc, "0.01");
  assert.ok(Number(r.expectedBurnedAgi) > 2.5 && Number(r.expectedBurnedAgi) < 3, r.expectedBurnedAgi);
  assert.ok(r.approveTx);
  assert.equal((await run("agi_balance", {})).agi, agiBefore); // no AGI needed
  const v = await run("agi_verify_notary", { text: "paid in usdc" });
  assert.equal(v.recorded, true);
  assert.equal(v.paidWith, "USDC");
  assert.equal(v.label_untrusted, "usdc");
  await assert.rejects(run("agi_notarize", { text: "paid in usdc" }), /Already recorded/);
  await assert.rejects(run("agi_notarize_usdc", { text: "hello agents" }), /Already recorded/);
  const v2 = await run("agi_verify_notary", { text: "hello agents" });
  assert.equal(v2.paidWith, "AGI");
});

test("USDC notary refuses when the wallet has no USDC", async () => {
  const poorKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // hardhat account #2
  const poor = createViemAgiTools({ rpcUrl: RPC, privateKey: poorKey, addresses: A, chain });
  await assert.rejects(T(poor, "agi_notarize_usdc").run({ text: "no usdc here" }), /Needs 0.01 USDC/);
});

test("wrong chain is refused", async () => {
  const bad = createViemAgiTools({ rpcUrl: RPC, addresses: { ...A, chainId: 8453 }, chain });
  await assert.rejects(T(bad, "agi_market_info").run({}), /expected 8453/);
});

test("MCP server lists and calls tools", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer(ro);
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const list = await client.listTools();
  assert.equal(list.tools.length, 12);
  const r = await client.callTool({ name: "agi_market_info", arguments: {} });
  assert.ok(JSON.parse(r.content[0].text).priceEth > 0);
  const e = await client.callTool({ name: "agi_buy", arguments: { ethAmount: "0.001" } });
  assert.equal(e.isError, true);
  await client.close();
});

test("AgentKit action provider works with a viem wallet provider", async () => {
  const wc = createWalletClient({ account: privateKeyToAccount(KEY), chain, transport: http(RPC) });
  const wp = new ViemWalletProvider(wc);
  const p = agiActionProvider({ addresses: A });
  const actions = p.getActions(wp);
  assert.equal(actions.length, 12);
  const info = actions.find((x) => x.name.endsWith("agi_market_info"));
  const out = JSON.parse(await info.invoke({}));
  assert.ok(out.priceEth > 0);
  const n = actions.find((x) => x.name.endsWith("agi_notarize"));
  const r = JSON.parse(await n.invoke({ text: "via agentkit" }));
  assert.equal(r.done, true);
  const bad = actions.find((x) => x.name.endsWith("agi_buy"));
  assert.match(await bad.invoke({ ethAmount: "5" }), /^Error: Price impact/);
});
