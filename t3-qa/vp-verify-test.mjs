// In-TEE VP verification: register gate@0.4.0 (imports host vp.verify) and call
// verify_vp inside the enclave. We don't hold a trusted-issuer VP token, so the
// expected outcome is a TYPED host verdict (e.g. "issuer-untrusted" / "malformed")
// — which still proves the in-enclave vp.verify call path executes end to end.
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
const TAIL = "gate", VERSION = "0.4.0";

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

console.log(`\ninvoking verify_vp inside the enclave (gate@${VERSION})…`);
try {
  const r = await tenant.contracts.execute(TAIL, {
    version: VERSION, functionName: "verify_vp",
    input: {
      vp_token: "eyJhbGciOiJFZERTQSJ9.test-vp-token.sig", // not a real trusted-issuer VP
      audience: "did:t3n:gatekeeper-verifier",
      nonce: "qa-nonce-123",
      issuer: "did:t3n:some-kyc-issuer",
    },
  });
  console.log("verify_vp result:", JSON.stringify(r));
  if (r && typeof r.verified === "boolean") {
    console.log(`\nRESULT: in-TEE vp.verify call path WORKS ✅ (host returned a typed verdict: ${r.verified ? "verified" : r.error})`);
    process.exit(0);
  }
  console.log("\nRESULT: unexpected response shape ❓");
  process.exit(1);
} catch (e) {
  console.log("execute error:", e.message);
  console.log("\nRESULT: host rejected the call — see error above (likely vp.verify not exposed at this host version, or capability not granted).");
  process.exit(2);
}
