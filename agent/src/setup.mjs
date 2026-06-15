// One-time setup: register the compiled gate-contract WASM to your tenant.
// Build the WASM first (see ../../gate-contract/README.md):
//   cargo +stable-x86_64-pc-windows-gnu build --target wasm32-wasip2 --release
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, CONTRACT_TAIL, CONTRACT_VERSION } from "./lib.mjs";

const WASM_PATH = fileURLToPath(
  new URL("../../gate-contract/target/wasm32-wasip2/release/gate_contract.wasm", import.meta.url),
);

const { tenant } = await connect(new URL("../.env", import.meta.url));

const wasm = new Uint8Array(readFileSync(WASM_PATH));
console.log(`Registering ${CONTRACT_TAIL}@${CONTRACT_VERSION} (${wasm.length} bytes)…`);
let contractId;
try {
  const reg = await tenant.contracts.register({ tail: CONTRACT_TAIL, version: CONTRACT_VERSION, wasm });
  contractId = reg.contract_id;
  console.log("Registered ✅", JSON.stringify(reg));
} catch (e) {
  console.log("Note (bump CONTRACT_VERSION if already registered):", e.message);
}

// The stateful velocity gate (`spend`) keeps its running total in this KV map.
// Restrict writers to the contract so the agent can't tamper with the counter.
try {
  const map = await tenant.maps.create({
    tail: "spent", visibility: "private",
    writers: contractId ? { only: [contractId] } : "all",
  });
  console.log("Spend map ✅", JSON.stringify(map));
} catch (e) {
  console.log("Spend map note (ok if it already exists):", e.message);
}
