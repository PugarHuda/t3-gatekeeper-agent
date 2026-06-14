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
try {
  const reg = await tenant.contracts.register({ tail: CONTRACT_TAIL, version: CONTRACT_VERSION, wasm });
  console.log("Registered ✅", JSON.stringify(reg));
} catch (e) {
  console.log("Note (bump CONTRACT_VERSION if already registered):", e.message);
}
