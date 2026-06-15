// Deploy gate-contract + invoke evaluate() with approved & rejected scenarios.
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
  "C:/Hackathons/Terminal 3 Agent Dev Kit Bounty Challenge (Launch Ed)/gate-contract/target/wasm32-wasip2/release/gate_contract.wasm";
const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
const TAIL = "gate";
const VERSION = "0.2.0";

const mandate = {
  max_amount_cents: 500_000,           // $5,000 cap
  allowed_assets: ["USDC", "USD"],
  allowed_kinds: ["rwa.buy"],
  expires_at_secs: 0,
};

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
    const tenant = new TenantClient({ environment: "testnet", t3n: client, tenantDid, baseUrl: BASE_URL });

    const wasm = new Uint8Array(readFileSync(WASM_PATH));
    console.log(`-- register ${TAIL}@${VERSION} (${wasm.length} bytes) --`);
    try {
      const reg = await tenant.contracts.register({ tail: TAIL, version: VERSION, wasm });
      console.log("register ✅:", JSON.stringify(reg));
    } catch (e) {
      console.log("register note (may already exist):", e.message?.slice(0, 160));
    }

    const run = async (label, action) => {
      console.log(`\n-- invoke evaluate() : ${label} --`);
      console.log("  action:", JSON.stringify(action));
      const out = await tenant.contracts.execute(TAIL, {
        version: VERSION,
        functionName: "evaluate",
        input: { action, mandate },
      });
      console.log("  result:", JSON.stringify(out));
    };

    await run("APPROVED ($1,000 USDC rwa.buy under $5k cap)",
      { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 });
    await run("REJECTED ($9,000 — over cap)",
      { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 });
    await run("REJECTED (DOGE swap — asset + kind not allowed)",
      { kind: "swap", asset: "DOGE", amount_cents: 100 });

    // security: an EMPTY mandate must deny everything (deny-by-default), live in the TEE
    console.log("\n-- deny-by-default check (empty mandate) --");
    const denyOut = await tenant.contracts.execute(TAIL, {
      version: VERSION, functionName: "evaluate",
      input: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: 1 },
               mandate: { max_amount_cents: 1_000_000_000, allowed_assets: [], allowed_kinds: [], expires_at_secs: 0 } },
    });
    console.log("  empty-mandate result:", JSON.stringify(denyOut));
    if (denyOut.decision !== "rejected") throw new Error("SECURITY: empty mandate did not deny!");
    console.log("  ✅ empty mandate correctly DENIED in the TEE");

    console.log("\nRESULT: gate-contract deploy + invoke WORKS ✅");
  } catch (e) {
    console.error("RESULT: FAILED ❌\n", e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
