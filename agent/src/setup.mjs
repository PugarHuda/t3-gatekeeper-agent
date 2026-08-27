// One-time setup: register the compiled gate-contract WASM to your tenant and
// provision the four KV maps it uses. Safe to re-run — it re-points each
// map's ACL at the newly registered contract id.
//
// Build the WASM first (see ../../gate-contract/README.md):
//   cargo +stable-x86_64-pc-windows-gnu build --lib --target wasm32-wasip2 --release
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, seedEntry, CONTRACT_TAIL, CONTRACT_VERSION, MANDATE, CREDENTIAL_KEY } from "./lib.mjs";

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

// A map's ACL names contract ids, and the id changes on every re-register — so
// setup must always (re)point them, not just create them the first time.
// Create-then-update rather than update-then-create: the first run has nothing
// to update, and every later run has nothing to create.
async function ensureMap(tail, readers, writers) {
  try {
    const map = await tenant.maps.create({ tail, visibility: "private", readers, writers });
    console.log(`Map ${tail} created ✅`, JSON.stringify(map));
    return;
  } catch (createErr) {
    if (!contractId) {
      console.log(`Map ${tail} note (exists; re-register the contract to re-point its ACL):`, createErr.message);
      return;
    }
    try {
      await tenant.maps.update(tail, { readers, writers });
      console.log(`Map ${tail} ACL re-pointed to contract ${contractId} ✅`);
    } catch (updateErr) {
      console.log(`Map ${tail} ACL update note:`, updateErr.message);
    }
  }
}

/** Seed one entry, reporting rather than throwing — setup should finish its list. */
async function seed(tail, key, value, label) {
  try {
    await seedEntry(tenant, tail, key, value);
    console.log(`${label} ✅`);
  } catch (e) {
    console.log(`${label} note:`, e.message);
  }
}

const contractOnly = contractId ? { only: [contractId] } : "all";
const nobody = { only: [] };

// The MANDATE the enclave enforces. This is the whole trust story: the tenant
// admin (the user's platform) provisions it once here, the contract reads it
// from KV at decision time, and `execute_action` has no inline-mandate escape
// hatch — so the agent cannot widen its own limits. Readable by the contract,
// writable by nobody at runtime (the control plane wrote it).
await ensureMap("mandate", contractOnly, nobody);
await seed("mandate", "default", MANDATE, `Mandate seeded ${JSON.stringify(MANDATE)}`);

// The stateful velocity gate (`spend`) keeps its running total here. Restrict
// BOTH read and write to the contract: spend() read-modify-writes the counter,
// so a write-only ACL fails with "read denied", and any wider ACL would let the
// agent reset its own limit.
await ensureMap("spent", contractOnly, contractOnly);

// Idempotency records: which keys the enclave has already dispatched under, and
// what happened. Contract-only for BOTH read and write — it read-modify-writes,
// and an agent that could edit it could make a duplicate order look like a
// replay, or a replay look new.
await ensureMap("dispatched", contractOnly, contractOnly);

// The broker credential. Nothing outside the enclave can read this map back —
// not the agent, not this script after it writes. The contract fetches the
// value only after it has approved an action, and only to build the outbound
// Authorization header. That is the point: a compromised agent can be made to
// propose a bad order, but it cannot walk off with the key that pays for it.
await ensureMap("secrets", contractOnly, nobody);
if (process.env.BROKER_API_KEY) {
  await seed("secrets", CREDENTIAL_KEY, process.env.BROKER_API_KEY, `Broker credential sealed into z:<tid>:secrets[${CREDENTIAL_KEY}]`);
} else {
  console.log(
    `No BROKER_API_KEY in agent/.env — secrets map left empty, and the mandate's\n` +
    `credential_key stays "" so the enclave sends an unauthenticated request.\n` +
    `Set BROKER_API_KEY and re-run to seal a real credential in.`,
  );
}
