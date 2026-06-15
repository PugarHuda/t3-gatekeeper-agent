// Stateful velocity-limit demo — the hardware mandate as a per-window spend cap.
// Runs the gate-contract `spend()` function 3x in one window: the running total
// is kept in the contract's KV map inside the TEE, so the 3rd spend is rejected
// once it would exceed the cap — and the agent cannot reset the counter.
// Requires `npm run setup` first (registers the contract + creates the `spent` map).
import { connect, CONTRACT_TAIL, CONTRACT_VERSION } from "./lib.mjs";

const { tenant } = await connect(new URL("../.env", import.meta.url));

const DAILY_LIMIT = 500_000; // $5,000
const window = "demo-" + Math.floor(Date.now() / 1000); // fresh window per run
const spend = async (amount) => {
  const r = await tenant.contracts.execute(CONTRACT_TAIL, {
    version: CONTRACT_VERSION, functionName: "spend",
    input: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: amount }, daily_limit_cents: DAILY_LIMIT, window },
  });
  console.log(`  spend $${amount / 100} -> ${r.decision.toUpperCase()}  (before=${r.spent_before} after=${r.spent_after} remaining=${r.remaining})`);
  return r;
};

console.log(`window=${window}  daily_limit=$${DAILY_LIMIT / 100}`);
const a = await spend(200_000);
const b = await spend(200_000);
const c = await spend(200_000); // would push total to $6,000 > $5,000 -> rejected

const ok = a.decision === "approved" && b.decision === "approved" && c.decision === "rejected" &&
  b.spent_after === 400_000 && c.spent_after === 400_000;
console.log(`\nRESULT: hardware velocity limit ${ok ? "WORKS ✅ (running total held in the TEE across calls)" : "FAILED ❌"}`);
process.exit(ok ? 0 : 1);
