// Register the built wasm under a THROWAWAY tail and invoke it, before letting
// it anywhere near the tail the agent actually uses.
//
// This exists because of a footgun we hit and filed as bug #8: the host executes
// the LATEST version registered under a tail. Register a version that traps and
// every pinned caller of that tail starts failing too — the bad deploy takes the
// good one down with it. There is no rollback and no "get contract id" call.
//
// The specific thing that goes wrong: a component that imports a host interface
// the node does not serve registers *successfully* and then 500s on every
// invoke. Registration is not validation. So: probe first, promote second.
//
//   node src/probe-contract.mjs            # register + invoke under tail "probe"
//   node src/probe-contract.mjs --tail x   # some other throwaway tail
//
// Costs one registration. Measured 2026-08-27 on testnet: 1,370,147,045 credits
// for a 255,706-byte component — about 5,358 per byte, or 45 contract calls.
// That is the price of not bricking production, and it is cheaper than the
// alternative, which has no rollback.
//
// Registering the same version under a second tail is safe: verified 2026-08-27
// that tails do not shadow each other, so the production tail keeps answering
// while the probe runs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect, executeContract, CONTRACT_VERSION } from "./lib.mjs";

const WASM_PATH = fileURLToPath(
  new URL("../../gate-contract/target/wasm32-wasip2/release/gate_contract.wasm", import.meta.url),
);

const argTail = process.argv.indexOf("--tail");
const TAIL = argTail > -1 ? process.argv[argTail + 1] : "probe";

const { tenant } = await connect(new URL("../.env", import.meta.url));
const wasm = new Uint8Array(readFileSync(WASM_PATH));

console.log(`Probing ${TAIL}@${CONTRACT_VERSION} (${wasm.length} bytes) — NOT the production tail.`);
try {
  const reg = await tenant.contracts.register({ tail: TAIL, version: CONTRACT_VERSION, wasm });
  console.log("  registered:", JSON.stringify(reg));
} catch (e) {
  console.log("  register note (already at this version?):", String(e.message).slice(0, 200));
}

// An inline mandate, so this needs no KV map and cannot touch production ACLs.
// It is enough to prove the component loads and every imported host interface
// resolves — which is the failure this probe is looking for.
const probes = [
  {
    label: "evaluate — in mandate",
    fn: "evaluate",
    input: {
      action: { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 },
      mandate: { max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 },
    },
    ok: (r) => r.decision === "approved",
  },
  {
    label: "evaluate — over cap is refused",
    fn: "evaluate",
    input: {
      action: { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 },
      mandate: { max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 },
    },
    ok: (r) => r.decision === "rejected" && r.reasons.length > 0,
  },
  {
    // The load-bearing one. `dispatch_action` is the only entry point that
    // touches host `http` / `http-with-placeholders`; if the node does not serve
    // an imported interface, THIS is where it 500s rather than at registration.
    // An `egress_denied` here is a PASS: the interface resolved and answered.
    label: "dispatch_action — host http resolves",
    fn: "dispatch_action",
    input: { url: "https://example.invalid/probe", method: "POST", body: "{}" },
    ok: (r) => typeof r.ok === "boolean",
  },
  {
    label: "dispatch_action — placeholder routing resolves",
    fn: "dispatch_action",
    // The `{{profile.` marker is what makes the contract route through
    // http-with-placeholders instead of plain http. Same pass condition: a typed
    // answer means the import is served.
    input: { url: "https://example.invalid/probe", method: "POST", body: '{"name":"{{profile.full_name}}"}' },
    ok: (r) => typeof r.ok === "boolean",
  },
];

let failed = 0;
for (const p of probes) {
  try {
    const r = await executeContract(tenant, TAIL, { version: CONTRACT_VERSION, functionName: p.fn, input: p.input },
      { log: (m) => console.log(m) });
    const pass = p.ok(r);
    if (!pass) failed++;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${p.label}\n        ${JSON.stringify(r).slice(0, 220)}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${p.label}\n        ${String(e.message).replace(/\s+/g, " ").slice(0, 220)}`);
  }
}

console.log(
  failed === 0
    ? `\n${CONTRACT_VERSION} is safe to promote: run \`npm run setup\` to register it under the production tail.`
    : `\n${failed} probe(s) failed — do NOT register this build under the production tail.`,
);
process.exit(failed === 0 ? 0 : 1);
