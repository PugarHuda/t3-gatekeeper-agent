// Edge-case probes for the selective-disclosure layer. These assert the DESIRED
// (hardened) behaviour; failures here surface real robustness issues to fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueRecord, discloseOnly, verifyDisclosure } from "../src/selective-disclosure.mjs";

test("revealing an unknown claim key throws (not silently empty)", async () => {
  const cred = await issueRecord({ accreditedInvestor: true });
  await assert.rejects(
    () => discloseOnly(cred, ["doesNotExist"]),
    /unknown claim/i,
    "asking to reveal a non-existent claim must error, not silently reveal nothing",
  );
});

test("revealing zero claims throws", async () => {
  const cred = await issueRecord({ accreditedInvestor: true });
  await assert.rejects(() => discloseOnly(cred, []), /at least one/i);
});

test("revealing all claims verifies", async () => {
  const cred = await issueRecord({ a: "1", b: "2", c: "3" });
  const d = await discloseOnly(cred, ["a", "b", "c"]);
  assert.equal(d.disclosed.length, 3);
  assert.equal(await verifyDisclosure(d), true);
});

test("claim values containing '=' round-trip correctly", async () => {
  const cred = await issueRecord({ note: "a=b=c", accreditedInvestor: true });
  const d = await discloseOnly(cred, ["note", "accreditedInvestor"]);
  assert.equal(await verifyDisclosure(d), true);
  assert.equal(d.disclosed.find((x) => x.key === "note").value, "a=b=c");
});

test("boolean false predicate is disclosed and verifies", async () => {
  const cred = await issueRecord({ accreditedInvestor: false });
  const d = await discloseOnly(cred, ["accreditedInvestor"]);
  assert.equal(await verifyDisclosure(d), true);
  assert.equal(d.disclosed[0].value, false);
});

test("disclosure order independent of requested key order", async () => {
  const cred = await issueRecord({ a: "1", b: "2", c: "3" });
  const d = await discloseOnly(cred, ["c", "a"]); // request out of order
  assert.equal(await verifyDisclosure(d), true);
});
