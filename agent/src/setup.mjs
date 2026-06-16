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
// Restrict BOTH read and write to THIS contract so the agent can neither read
// nor tamper with the counter (spend() reads the running total, then writes it).
// The contract id changes on every re-register, so we always (re)point the map's
// ACL at the current contract — create it the first time, update it after.
const acl = contractId ? { only: [contractId] } : "all";
try {
  const map = await tenant.maps.create({ tail: "spent", visibility: "private", readers: acl, writers: acl });
  console.log("Spend map ✅", JSON.stringify(map));
} catch (e) {
  // Map already exists — re-sync its reader/writer ACL to the current contract id.
  if (contractId) {
    try {
      await tenant.maps.update("spent", { readers: acl, writers: acl });
      console.log(`Spend map ACL re-pointed to contract ${contractId} ✅`);
    } catch (e2) {
      console.log("Spend map ACL update note:", e2.message);
    }
  } else {
    console.log("Spend map note (exists; re-register the contract to re-point its ACL):", e.message);
  }
}
