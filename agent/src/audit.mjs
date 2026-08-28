// Read the host's own record of what this agent did, and reconcile it against
// what the agent believes happened.
//
// The agent prints a structured row per action. That row is the AGENT's account
// of events, which is exactly the thing this project argues you should not have
// to take on faith. The node keeps its own ledger, and it has two doors:
//
//   activity.log  — every call this DID made: contract, function, outcome, a
//                   sequence number and a hash, whether the call succeeded or
//                   not. THIS is where the record is. 200 entries deep it
//                   already shows the fuel-quota errors, the probes against the
//                   undocumented core contracts, and every dispatch.
//   audit.get-mine — the documented "audit events" read. It has returned an
//                   empty page through 40+ dispatches (bug #29). We read it
//                   anyway and say what it returned, because an operator
//                   following the docs will look there first.
//
// Reconciling on the ledger's `outcome` is the difference between "the agent
// says the order went out" and "the node agrees a call was made". It is not the
// same as "the order was placed" — the ledger records the CALL, and only the
// contract's response says whether the enclave dispatched — so the two are kept
// apart in the output rather than blended into one reassuring number.
import { connect } from "./lib.mjs";

/** Fetch activity entries newest-first, following `next_seq`. */
export async function readActivity(client, { limit = 200, pageSize = 100 } = {}) {
  const entries = [];
  let before;
  while (entries.length < limit) {
    const page = await client.getActivityLog({
      limit: Math.min(pageSize, limit - entries.length),
      ...(before ? { before_seq: before } : {}),
    });
    const got = page.entries ?? [];
    entries.push(...got);
    if (!got.length || page.next_seq == null) break;
    before = page.next_seq;
  }
  return entries;
}

/** Fetch audit batches (the documented read), following the cursor. */
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
 * Tally the activity ledger by contract, function and outcome.
 *
 * Errors are not folded into a total. An `execute_action` that errored is the
 * interesting row — it is a call the agent may have counted as "sent" — so it
 * is reported beside the successes, not under them.
 */
export function summariseActivity(entries) {
  const out = { entries: entries.length, first_seq: null, last_seq: null, byContract: {}, errors: 0 };
  for (const e of entries) {
    out.first_seq = out.first_seq == null ? e.seq_no : Math.min(out.first_seq, e.seq_no);
    out.last_seq = out.last_seq == null ? e.seq_no : Math.max(out.last_seq, e.seq_no);
    const c = (out.byContract[e.contract] ??= {});
    const f = (c[e.function] ??= { success: 0, error: 0, other: 0 });
    const k = e.outcome === "success" ? "success" : e.outcome === "error" ? "error" : "other";
    f[k]++;
    if (k === "error") out.errors++;
  }
  return out;
}

/** The documented audit read, summarised the same way — usually empty. */
export function summariseAudit(batches) {
  const out = { batches: batches.length, events: 0, committed: 0, uncommitted: 0 };
  for (const b of batches) {
    for (const e of b.events ?? []) {
      out.events++;
      if (b.committed) out.committed++;
      else out.uncommitted++;
    }
  }
  return out;
}

/**
 * Compare the agent's own rows against the ledger, for one contract.
 *
 * `agentRows` is what the agent printed: `{ dispatched, decision }` per action.
 * The ledger knows calls and outcomes, not dispatches, so the comparison is
 * stated as two separate facts plus one question — never as a verdict.
 */
export function reconcile(agentRows, entries, { contract, fn = "execute_action" } = {}) {
  const calls = entries.filter((e) => (!contract || e.contract === contract) && e.function === fn);
  const ok = calls.filter((e) => e.outcome === "success").length;
  const claimedDispatched = agentRows.filter((r) => r.dispatched).length;
  return {
    agentRows: agentRows.length,
    agentClaimedDispatched: claimedDispatched,
    ledgerCalls: calls.length,
    ledgerSuccessful: ok,
    ledgerErrored: calls.length - ok,
    // Every dispatch the agent claims should sit on a successful call. The
    // reverse is not true — a successful call can be a rejection — so this is
    // a necessary condition, and it is named as one.
    consistent: ok >= claimedDispatched,
  };
}

// `npm run audit`
if (process.argv[1]?.replace(/\\/g, "/").endsWith("audit.mjs")) {
  const { client, tenant } = await connect(new URL("../.env", import.meta.url));
  const gate = tenant.canonicalName("gate");

  const entries = await readActivity(client, { limit: 200 });
  const s = summariseActivity(entries);
  console.log(`activity.log — the node's record of this DID's calls (last ${s.entries}, seq ${s.first_seq}…${s.last_seq})`);
  for (const [contract, fns] of Object.entries(s.byContract).sort()) {
    console.log(`  ${contract}`);
    for (const [fn, n] of Object.entries(fns).sort()) {
      console.log(`    ${fn.padEnd(24)} success ${String(n.success).padStart(3)}   error ${String(n.error).padStart(3)}${n.other ? `   other ${n.other}` : ""}`);
    }
  }
  const gateCalls = entries.filter((e) => e.contract === gate);
  const dispatches = gateCalls.filter((e) => e.function === "execute_action");
  console.log(`\n  ${gate}: ${gateCalls.length} calls, of which execute_action ${dispatches.length} ` +
    `(${dispatches.filter((e) => e.outcome === "success").length} succeeded, ${dispatches.filter((e) => e.outcome === "error").length} errored)`);
  console.log(`  Every entry carries a hash and a sequence number; the node, not the agent, assigned both.`);

  const batches = await readAudit(client, { limit: 100 });
  const a = summariseAudit(batches);
  console.log(`\naudit.get-mine — the documented audit read`);
  console.log(`  batches ${a.batches}  events ${a.events}  committed ${a.committed}  uncommitted ${a.uncommitted}`);
  if (!a.events && dispatches.length) {
    console.log(`  Empty, while activity.log shows ${dispatches.length} execute_action calls on the same DID.`);
    console.log(`  That is bug #29: the documented read does not surface tenant-contract dispatches.`);
  }
}
