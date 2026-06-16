// On-chain agent registration via the T3 host `agent-registry` interface.
// Deploys the registry-enabled wasm under a SEPARATE tail ("idreg") so the
// production "gate" tail (id 165) is never at risk. First sanity-checks that the
// new host import didn't break execution (evaluate), then calls register_agent.
import { readFileSync } from "node:fs";
import {
  T3nClient, TenantClient, loadWasmComponent, setEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign,
} from "@terminal3/t3n-sdk";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2];
}
const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
const WASM = "C:/Hackathons/Terminal 3 Agent Dev Kit Bounty Challenge (Launch Ed)/gate-contract/target/wasm32-wasip2/release/gate_contract.wasm";
const TAIL = "idreg", VERSION = "0.1.0";
const AGENT_URI = "https://raw.githubusercontent.com/PugarHuda/t3-gatekeeper-agent/master/agent/agent-card.json";

setEnvironment("testnet");
const key = process.env.T3N_API_KEY, tenantDid = process.env.DID;
const address = eth_get_address(key);
const client = new T3nClient({ wasmComponent: await loadWasmComponent(), handlers: { EthSign: metamask_sign(address, undefined, key) } });
await client.handshake();
await client.authenticate(createEthAuthInput(address));
const tenant = new TenantClient({ environment: "testnet", t3n: client, tenantDid, baseUrl: BASE_URL });

const wasm = new Uint8Array(readFileSync(WASM));
try {
  const reg = await tenant.contracts.register({ tail: TAIL, version: VERSION, wasm });
  console.log("registered:", JSON.stringify(reg));
} catch (e) { console.log("register note:", e.message?.slice(0, 160)); }

// 1) sanity: does the agent-registry import leave normal execution intact?
console.log("\n[1] sanity — evaluate on the registry-enabled contract:");
try {
  const d = await tenant.contracts.execute(TAIL, { version: VERSION, functionName: "evaluate",
    input: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: 100000 },
             mandate: { max_amount_cents: 500000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 } } });
  console.log("    evaluate OK ->", d.decision, "(import is harmless ✅)");
} catch (e) { console.log("    evaluate ERROR:", e.message?.slice(0, 200)); }

// 2) the real thing: register the agent on-chain via the host interface.
console.log("\n[2] register_agent (on-chain via host agent-registry):");
try {
  const r = await tenant.contracts.execute(TAIL, { version: VERSION, functionName: "register_agent",
    input: { agent_uri: AGENT_URI, owner_eth_hex: address } });
  console.log("    result:", JSON.stringify(r));
  if (r && r.registered) console.log(`\nRESULT: on-chain agent registration WORKS ✅ (registry result: ${r.result})`);
  else console.log(`\nRESULT: host returned a typed failure: ${r?.error ?? JSON.stringify(r)}`);
} catch (e) {
  console.log("    execute error:", e.message);
  console.log("\nRESULT: host rejected register_agent — see error (capability not granted / not exposed at this host).");
}
