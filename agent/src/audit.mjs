// Read the tenant's audit trail back from T3, and reconcile it against what the
// agent believes happened.
//
// The agent prints a structured row per action. That row is the AGENT's account
// of events, which is exactly the thing this project argues you should not have
// to take on faith. `audit.get-mine` returns the host's record of the same
// dispatches, with one field the agent cannot forge:
//
//   committed — did the contract transaction actually commit?
//
// An event carrying `outcome: "success"` in an uncommitted batch is the
// contract's *claim*, not a durable fact: the call rolled back or trapped after
// saying so. Reconciling on that field is the difference between "the agent says
// the order went out" and "the network agrees the order went out".
import { connect } from "./lib.mjs";

/** Fetch audit batches, following the cursor. `limit` caps total events read. */
export async function readAudit(client, { limit = 100, piiDid } = {}) {
  const batches = [];
  let cursor;
  let seen = 0;
  do {
    const page = await client.getAuditEvents({
      limit: Math.min(50, limit - seen) || 1,
      ...(cursor ? { cursor } : {}),
      ...(piiDid ? { pii_did: piiDid } : {}),
    });
    for (const b of page.batches ?? []) {
      batches.push(b);
      seen += b.events?.length ?? 0;
    }
    cursor = page.next_cursor ?? null;
  } while (cursor && seen < limit);
  return batches;
}

/**
 * Split the host's record into what durably happened and what was only claimed.
 *
 * Uncommitted is not a rounding error to fold into the total — it is the
 * interesting case, because it is where the agent's story and the ledger differ.
 */
export function summarise(batches) {
  const out = { batches: batches.length, events: 0, committed: 0, uncommitted: 0, byOutcome: {} };
  for (const b of batches) {
    for (const e of b.events ?? []) {
      out.events++;
      if (b.committed) out.committed++;
      else out.uncommitted++;
      const key = `${e.outcome ?? "unknown"}${b.committed ? "" : " (uncommitted)"}`;
      out.byOutcome[key] = (out.byOutcome[key] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Compare the agent's own rows against the host's ledger.
 *
 * `agentRows` is what the agent printed. A row the ledger does not corroborate
 * is not automatically a lie — the event may not have been emitted, or the batch
 * may still be settling — but it is the thing an operator should look at, so it
 * is reported rather than smoothed over.
 */
export function reconcile(agentRows, batches) {
  const ledgerEvents = batches.flatMap((b) => (b.events ?? []).map((e) => ({ ...e, committed: b.committed })));
  const dispatched = agentRows.filter((r) => r.dispatched);
  return {
    agentRows: agentRows.length,
    agentDispatched: dispatched.length,
    ledgerEvents: ledgerEvents.length,
    ledgerCommitted: ledgerEvents.filter((e) => e.committed).length,
    // Stated as a question, not a verdict: this is a report, not a proof.
    corroborated: ledgerEvents.filter((e) => e.committed).length >= dispatched.length,
  };
}

// `npm run audit`
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`
  || process.argv[1]?.endsWith("audit.mjs")) {
  const { client } = await connect(new URL("../.env", import.meta.url));
  const batches = await readAudit(client, { limit: 100 });
  const s = summarise(batches);

  console.log("T3 audit ledger (audit.get-mine)");
  console.log(`  batches ${s.batches}  events ${s.events}  committed ${s.committed}  uncommitted ${s.uncommitted}`);
  for (const [outcome, n] of Object.entries(s.byOutcome)) console.log(`    ${outcome}: ${n}`);

  if (!s.events) {
    console.log("\n  The trail is empty. Audit events are emitted by contract dispatches,");
    console.log("  and no contract call has run since the account hit zero credits —");
    console.log("  so an empty page here is the honest state, not a failure.");
  }
  for (const b of batches.slice(0, 3)) {
    console.log(`\n  batch ${String(b.key).slice(0, 32)}  committed=${b.committed}`);
    for (const e of (b.events ?? []).slice(0, 5)) console.log(`    ${JSON.stringify(e).slice(0, 200)}`);
  }
}
