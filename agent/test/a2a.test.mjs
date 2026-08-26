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

// ── discovery ───────────────────────────────────────────────────────────────
// A2A's other half: finding a peer from nothing but a domain. Served over real
// HTTP from the same directory the evidence site publishes, so this exercises
// the fetch path rather than a function call.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { discoverPeer, validateAgentCard, skillIds, AGENT_CARD_PATH } from "../src/a2a.mjs";

const CARD_SRC = new URL("../agent-card.json", import.meta.url);
const CARD_PUBLISHED = new URL("../../site/.well-known/agent-card.json", import.meta.url);

async function servingTheCard(fn, { body, status = 200, type = "application/json" } = {}) {
  const payload = body ?? (await readFile(CARD_PUBLISHED, "utf8"));
  const srv = createServer((req, res) => {
    if (req.url !== AGENT_CARD_PATH) return res.writeHead(404).end("not here");
    res.writeHead(status, { "content-type": type });
    res.end(payload);
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    return await fn(`http://localhost:${srv.address().port}`);
  } finally {
    srv.close();
  }
}

test("the published card is discoverable from just an origin", async () => {
  const d = await servingTheCard((origin) => discoverPeer(origin));
  assert.equal(d.valid, true, JSON.stringify(d.problems));
  assert.deepEqual(d.problems, []);
  assert.ok(d.url.endsWith(AGENT_CARD_PATH));
  assert.ok(skillIds(d.card).includes("evaluate-gated-action"));
});

test("the published card has not drifted from the source card", async () => {
  // site/.well-known/agent-card.json is a copy. A copy that silently diverges
  // means peers discover capabilities the agent no longer has.
  const [src, published] = await Promise.all([
    readFile(CARD_SRC, "utf8").then(JSON.parse),
    readFile(CARD_PUBLISHED, "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(published, src, "re-copy agent/agent-card.json to site/.well-known/");
});

test("a full card URL is accepted as well as an origin", async () => {
  const d = await servingTheCard((origin) => discoverPeer(origin + AGENT_CARD_PATH));
  assert.equal(d.valid, true);
});

test("a missing card is an error, not an empty peer", async () => {
  await assert.rejects(
    () => servingTheCard((origin) => discoverPeer(origin), { status: 404, body: "nope" }),
    /HTTP 404/,
  );
});

test("a card that is not JSON is an error", async () => {
  await assert.rejects(
    () => servingTheCard((origin) => discoverPeer(origin), { body: "<html>oops</html>" }),
    /not JSON/,
  );
});

test("validation names every missing field a client would dereference", () => {
  const r = validateAgentCard({ name: "x" });
  assert.equal(r.valid, false);
  for (const f of ["description", "version", "skills"]) {
    assert.ok(r.problems.some((p) => p.includes(f)), `${f} should be reported: ${r.problems}`);
  }
  assert.ok(r.problems.some((p) => /neither url nor did/.test(p)), "unaddressable card must fail");
});

test("a skill without an id is a problem, without a name only a warning", () => {
  const r = validateAgentCard({
    name: "a", description: "b", version: "1", did: "did:t3n:x",
    skills: [{ name: "no id" }, { id: "no-name" }],
  });
  assert.ok(r.problems.some((p) => /skills\[0\] has no id/.test(p)));
  assert.ok(r.warnings.some((w) => /skills\[1\] has no name/.test(w)));
});

test("an empty skills list is valid but warned about", () => {
  const r = validateAgentCard({ name: "a", description: "b", version: "1", did: "did:t3n:x", skills: [] });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => /advertises no skills/.test(w)));
});
