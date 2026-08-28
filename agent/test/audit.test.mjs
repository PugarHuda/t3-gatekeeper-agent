// The audit reconciliation, on ledger shapes copied from real responses.
//
// `readActivity` / `readAudit` are network reads and are not faked here. What
// is worth pinning is how the summaries treat the awkward rows: an errored
// call, an uncommitted batch, an empty page — because those are the rows an
// operator is actually looking for, and the easy thing is to fold them away.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summariseActivity, summariseAudit, reconcile } from "../src/audit.mjs";

const GATE = "z:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f:gate";
// Shape taken verbatim from a live `activity.log` entry, 2026-08-28.
const entry = (seq, contract, fn, outcome) => ({
  seq_no: seq, hash: "abf83e9f".padEnd(64, "0"), timestamp_ms: 1787883129261,
  caller_type: "agent", actor: "did:t3n:x", on_behalf_of: "did:t3n:x", org: "did:t3n:org",
  contract, function: fn, outcome,
});
const batch = (committed, ...outcomes) => ({ key: "b", committed, events: outcomes.map((o) => ({ outcome: o })) });

describe("activity ledger", () => {
  test("tallies per contract and function, keeping errors beside successes", () => {
    const s = summariseActivity([
      entry(3, GATE, "execute_action", "success"),
      entry(2, GATE, "execute_action", "error"),
      entry(1, GATE, "evaluate", "success"),
      entry(0, "tee:tenant/contracts", "map-entry-set", "success"),
    ]);
    assert.equal(s.entries, 4);
    assert.equal(s.errors, 1);
    assert.deepEqual(s.byContract[GATE].execute_action, { success: 1, error: 1, other: 0 });
    assert.deepEqual(s.byContract[GATE].evaluate, { success: 1, error: 0, other: 0 });
    assert.equal(s.first_seq, 0);
    assert.equal(s.last_seq, 3);
  });

  test("an unknown outcome is counted as other, never as success", () => {
    const s = summariseActivity([entry(1, GATE, "execute_action", "timeout")]);
    assert.deepEqual(s.byContract[GATE].execute_action, { success: 0, error: 0, other: 1 });
  });

  test("an empty ledger summarises to zeroes rather than throwing", () => {
    const s = summariseActivity([]);
    assert.equal(s.entries, 0);
    assert.equal(s.first_seq, null);
    assert.deepEqual(s.byContract, {});
  });
});

describe("audit.get-mine", () => {
  test("committed and uncommitted events are kept apart", () => {
    const s = summariseAudit([batch(true, "success", "success"), batch(false, "success")]);
    assert.equal(s.events, 3);
    assert.equal(s.committed, 2);
    assert.equal(s.uncommitted, 1);
  });

  test("a batch with no events array is tolerated", () => {
    assert.equal(summariseAudit([{ key: "x", committed: true }]).events, 0);
  });
});

describe("reconciling the agent's rows against the ledger", () => {
  const rows = [
    { decision: "approved", dispatched: true },
    { decision: "rejected", dispatched: false },
    { decision: "approved", dispatched: true },
  ];

  test("every claimed dispatch has a successful call behind it", () => {
    const r = reconcile(rows, [
      entry(3, GATE, "execute_action", "success"),
      entry(2, GATE, "execute_action", "success"),
      entry(1, GATE, "execute_action", "success"), // the rejection is a successful call too
    ], { contract: GATE });
    assert.equal(r.agentClaimedDispatched, 2);
    assert.equal(r.ledgerCalls, 3);
    assert.equal(r.ledgerSuccessful, 3);
    assert.equal(r.consistent, true);
  });

  test("more claimed dispatches than successful calls is reported, not smoothed", () => {
    const r = reconcile(rows, [
      entry(2, GATE, "execute_action", "success"),
      entry(1, GATE, "execute_action", "error"),
    ], { contract: GATE });
    assert.equal(r.ledgerErrored, 1);
    assert.equal(r.consistent, false);
  });

  test("calls on other contracts do not count toward this one", () => {
    const r = reconcile(rows, [
      entry(2, "z:other:gate", "execute_action", "success"),
      entry(1, "z:other:gate", "execute_action", "success"),
    ], { contract: GATE });
    assert.equal(r.ledgerCalls, 0);
    assert.equal(r.consistent, false);
  });

  test("an agent that dispatched nothing is consistent with an empty ledger", () => {
    const r = reconcile([{ decision: "rejected", dispatched: false }], [], { contract: GATE });
    assert.equal(r.consistent, true);
  });
});
