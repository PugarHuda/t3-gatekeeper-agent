// End-to-end deploy test: auth -> tenant.claim -> contracts.register(wasm)
import { readFileSync } from "node:fs";
import {
  T3nClient, TenantClient, loadWasmComponent, setEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign,
} from "@terminal3/t3n-sdk";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const WASM_PATH =
  "C:/Hackathons/Terminal 3 Agent Dev Kit Bounty Challenge (Launch Ed)/z-tenant-flight/target/wasm32-wasip2/release/z_tenant_flight.wasm";

(async () => {
  try {
    setEnvironment("testnet");
    const key = process.env.T3N_API_KEY;
    const tenantDid = process.env.DID;
    const address = eth_get_address(key);

    const wasmComponent = await loadWasmComponent();
    const client = new T3nClient({
      wasmComponent,
      handlers: { EthSign: metamask_sign(address, undefined, key) },
    });
    await client.handshake();
    await client.authenticate(createEthAuthInput(address));
    console.log("authenticated as", tenantDid);

    const tenant = new TenantClient({
      environment: "testnet",
      t3n: client,
      tenantDid,
      baseUrl: "https://cn-api.sg.testnet.t3n.terminal3.io",
    });

    console.log("\n-- tenant.claim() --");
    try {
      const claimed = await tenant.tenant.claim();
      console.log("claim ✅:", JSON.stringify(claimed)?.slice(0, 200));
    } catch (e) {
      console.log("claim note:", e.message?.slice(0, 200));
    }

    const wasm = new Uint8Array(readFileSync(WASM_PATH));
    console.log(`\n-- contracts.register (wasm ${wasm.length} bytes) --`);
    const reg = await tenant.contracts.register({
      tail: "qa-flight",
      version: "0.4.1",
      wasm,
    });
    console.log("register ✅:", JSON.stringify(reg)?.slice(0, 400));

    console.log("\nRESULT: contract DEPLOY (register) WORKS ✅");
  } catch (e) {
    console.error("RESULT: register FAILED ❌\n", e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
