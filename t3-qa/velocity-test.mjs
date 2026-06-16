// Stateful velocity limit: register gate@0.5.0, create the `spent` KV map, then
// spend 3x in one window — the running total is held in the TEE across calls.
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
const TAIL = "gate", VERSION = "0.5.0";

setEnvironment("testnet");
const key = process.env.T3N_API_KEY, tenantDid = process.env.DID;
const address = eth_get_address(key);
const client = new T3nClient({ wasmComponent: await loadWasmComponent(), handlers: { EthSign: metamask_sign(address, undefined, key) } });
await client.handshake();
await client.authenticate(createEthAuthInput(address));
const tenant = new TenantClient({ environment: "testnet", t3n: client, tenantDid, baseUrl: BASE_URL });

const wasm = new Uint8Array(readFileSync(WASM));
let contractId;
try {
  const reg = await tenant.contracts.register({ tail: TAIL, version: VERSION, wasm });
  contractId = reg.contract_id; console.log("registered:", JSON.stringify(reg));
} catch (e) { console.log("register note:", e.message?.slice(0, 120)); }

try {
  const map = await tenant.maps.create({ tail: "spent", visibility: "private", writers: contractId ? { only: [contractId] } : "all" });
  console.log("map created:", JSON.stringify(map));
} catch (e) { console.log("map note (may exist):", e.message?.slice(0, 140)); }

const window = "vtest-" + Date.now(); // fresh window each run
const spend = async (amount) => {
  const r = await tenant.contracts.execute(TAIL, {
    version: VERSION, functionName: "spend",
    input: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: amount }, daily_limit_cents: 500_000, window },
  });
  console.log(`  spend $${amount/100} → ${r.decision}  (before=${r.spent_before} after=${r.spent_after} remaining=${r.remaining})`);
  return r;
};

console.log(`\nwindow=${window} daily_limit=$5000`);
const a = await spend(200_000);
const b = await spend(200_000);
const c = await spend(200_000); // would be $6000 > $5000 → rejected

const ok = a.decision === "approved" && b.decision === "approved" && c.decision === "rejected" &&
  b.spent_after === 400_000 && c.spent_after === 400_000;
console.log(`\nRESULT: stateful velocity limit ${ok ? "WORKS ✅ (total held across calls in the TEE)" : "FAILED ❌"}`);
process.exit(ok ? 0 : 1);
