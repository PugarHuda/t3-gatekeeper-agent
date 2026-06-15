import { test } from "node:test";
import assert from "node:assert/strict";
import { issueCapabilityCredential, presentCapability, acceptIfCapable } from "../src/a2a.mjs";

const AGENT_A = "did:t3n:agentA";

test("peer accepts a selectively-disclosed capability, manifest stays hidden", async () => {
  const cred = await issueCapabilityCredential(AGENT_A, {
    capability: "payments.execute",
    tier: "institutional",
    maxUsd: "1000000",
    region: "SG",
  });
  const presentation = await presentCapability(cred, "capability");

  // only agent + capability are disclosed
  const keys = presentation.disclosed.map((d) => d.key).sort();
  assert.deepEqual(keys, ["agent", "capability"]);
  for (const hidden of ["tier", "maxUsd", "region"]) {
    assert.ok(!keys.includes(hidden), `${hidden} must stay hidden`);
  }

  // peer accepts because the disclosed capability matches what it requires
  assert.equal(await acceptIfCapable(presentation, "capability", "payments.execute"), true);
});

test("peer rejects when the required capability does not match", async () => {
  const cred = await issueCapabilityCredential(AGENT_A, { capability: "data.read" });
  const presentation = await presentCapability(cred, "capability");
  assert.equal(await acceptIfCapable(presentation, "capability", "payments.execute"), false);
});
