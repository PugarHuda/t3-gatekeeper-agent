// Does importing host:interfaces/http@2.1.0 work on this testnet host?
// The official z-tenant-flight example imports it, so it SHOULD — unlike vp /
// agent-registry. Deploy under a separate tail "httptest"; check evaluate still
// runs (import is provided, not a brick), then probe an outbound GET.
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
const TAIL = "httptest", VERSION = "0.1.0";

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

console.log("\n[1] sanity — evaluate on the http-enabled contract:");
try {
  const d = await tenant.contracts.execute(TAIL, { version: VERSION, functionName: "evaluate",
    input: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: 100000 },
             mandate: { max_amount_cents: 500000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 } } });
  console.log("    evaluate OK ->", d.decision, "(http import is provided, not a brick ✅)");
} catch (e) { console.log("    evaluate ERROR:", e.message?.slice(0, 200)); }

console.log("\n[2] http_probe — outbound GET from inside the TEE:");
for (const url of ["https://api.github.com/zen", "https://cn-api.sg.testnet.t3n.terminal3.io/"]) {
  try {
    const r = await tenant.contracts.execute(TAIL, { version: VERSION, functionName: "http_probe", input: { url } });
    console.log(`    GET ${url} ->`, JSON.stringify(r));
  } catch (e) { console.log(`    GET ${url} -> execute error:`, e.message?.slice(0, 160)); }
}
