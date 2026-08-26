// The audit reconciliation matters most when the ledger is NOT empty, which is
// exactly the state the live account cannot reach right now. So the logic is
// tested against constructed pages — real shapes from the SDK's own typings,
// with no network — and the live read is a separate command.
//
// The case that must not be got wrong: an event can say `outcome: "success"`
// inside a batch that never committed. Counting that as a success would make the
// reconciliation agree with the agent precisely when it should not.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarise, reconcile, readAudit } from "../src/audit.mjs";

const batch = (committed, ...outcomes) => ({
  key: "ab".repeat(8),
  committed,
  events: outcomes.map((outcome, i) => ({ outcome, seq: i })),
});

describe("audit summary", () => {
  test("counts events, not batches", () => {
    const s = summarise([batch(true, "success", "success"), batch(true, "success")]);
    assert.equal(s.batches, 2);
    assert.equal(s.events, 3);
    assert.equal(s.committed, 3);
  });

  test("a successful event in an uncommitted batch is not counted as committed", () => {
    // The contract said it worked; the transaction rolled back. These are
    // different facts and the summary must keep them apart.
    const s = summarise([batch(false, "success")]);
    assert.equal(s.committed, 0);
    assert.equal(s.uncommitted, 1);
    assert.deepEqual(Object.keys(s.byOutcome), ["success (uncommitted)"]);
  });

  test("an empty ledger summarises to zeroes rather than throwing", () => {
    const s = summarise([]);
    assert.equal(s.events, 0);
    assert.deepEqual(s.byOutcome, {});
  });

  test("batches with no events array are tolerated", () => {
    assert.equal(summarise([{ key: "x", committed: true }]).events, 0);
  });
});

describe("reconciling the agent's rows against the ledger", () => {
  const rows = [
    { action: "buy", dispatched: true },
    { action: "buy-too-big", dispatched: false },
    { action: "buy", dispatched: true },
  ];

  test("only dispatched rows need corroborating", () => {
    const r = reconcile(rows, [batch(true, "success", "success")]);
    assert.equal(r.agentRows, 3);
    assert.equal(r.agentDispatched, 2);
    assert.equal(r.corroborated, true);
  });

  test("a dispatch the ledger does not corroborate is reported", () => {
    const r = reconcile(rows, [batch(true, "success")]);
    assert.equal(r.ledgerCommitted, 1);
    assert.equal(r.corroborated, false, "2 dispatches, 1 committed event");
  });

  test("uncommitted ledger events do not corroborate a dispatch", () => {
    const r = reconcile(rows, [batch(false, "success", "success")]);
    assert.equal(r.ledgerEvents, 2);
    assert.equal(r.ledgerCommitted, 0);
    assert.equal(r.corroborated, false);
  });

  test("an agent that dispatched nothing is trivially corroborated", () => {
    const r = reconcile([{ action: "rejected", dispatched: false }], []);
    assert.equal(r.corroborated, true);
  });
});

describe("paging", () => {
  test("follows next_cursor until the ledger ends", async () => {
    const pages = [
      { batches: [batch(true, "success")], next_cursor: "c1" },
      { batches: [batch(true, "success")], next_cursor: null },
    ];
    let calls = 0;
    const client = {
      getAuditEvents: async (opts) => {
        // The cursor from the previous page must be passed back, or paging
        // silently re-reads page one forever.
        if (calls > 0) assert.equal(opts.cursor, "c1");
        return pages[calls++];
      },
    };
    const out = await readAudit(client, { limit: 100 });
    assert.equal(calls, 2);
    assert.equal(out.length, 2);
  });

  test("stops at the requested limit even if more pages exist", async () => {
    let calls = 0;
    const client = {
      getAuditEvents: async () => {
        calls++;
        return { batches: [batch(true, "a", "b", "c")], next_cursor: "more" };
      },
    };
    const out = await readAudit(client, { limit: 2 });
    assert.equal(calls, 1, "must not keep paging past the limit");
    assert.equal(out.length, 1);
  });
});
