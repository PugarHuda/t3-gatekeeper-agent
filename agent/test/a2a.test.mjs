import { test, describe } from "node:test";
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

test("the published card is the v1.0 card the hosted endpoint serves", async () => {
  // site/.well-known/agent-card.json is generated from the source card by the
  // same buildAgentCard() the server uses, pointing at the hosted endpoint. A
  // published card that diverges means peers discover an agent that is not
  // the one answering at that URL.
  const { buildAgentCard } = await import("../src/a2a-server.mjs");
  const { PUBLIC_A2A_URL } = await import("../src/hosted.mjs");
  const { signatures, ...published } = JSON.parse(await readFile(CARD_PUBLISHED, "utf8"));
  assert.deepEqual({ ...published, signatures: [] }, buildAgentCard(PUBLIC_A2A_URL), "run `npm run status-list` to regenerate site/.well-known/");
  assert.equal(signatures?.length, 1, "the published card must be signed");
  assert.equal(published.supportedInterfaces[0].url, "https://gatekeeper-evidence.vercel.app/api/a2a");
  assert.equal(published.supportedInterfaces[0].protocolVersion, "1.0");
  assert.ok(published.securitySchemes["web-bot-auth"], "the lock on the door must be declared");
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
  assert.ok(r.problems.some((p) => /neither url, did nor a supportedInterfaces url/.test(p)), "unaddressable card must fail");
});

test("a v1.0 card is addressable through supportedInterfaces alone", () => {
  // No top-level url or did — exactly what the official SDK serves. This used
  // to be reported as "nothing to talk to".
  const r = validateAgentCard({
    name: "a", description: "b", version: "1",
    supportedInterfaces: [{ url: "https://agent.example/", protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    capabilities: {}, skills: [{ id: "s", name: "s" }],
  });
  assert.equal(r.valid, true, r.problems.join(","));
  assert.deepEqual(r.warnings, []);
});

test("a v1.0 interface without a url is a problem, without a binding a warning", () => {
  const r = validateAgentCard({
    name: "a", description: "b", version: "1",
    supportedInterfaces: [{ protocolVersion: "1.0" }],
    capabilities: {}, skills: [{ id: "s", name: "s" }],
  });
  assert.equal(r.valid, false);
  assert.ok(r.problems.some((p) => /supportedInterfaces\[0\] has no url/.test(p)));
  assert.ok(r.warnings.some((w) => /names no protocolBinding/.test(w)));
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

// ── the card must not go stale, and its two copies must not drift ───────────
//
// The card is the thing peers, registries and Web Bot Auth verifiers read, and
// it is the easiest file in the repo to forget: it is not imported by anything,
// so nothing breaks when it lies. Two copies exist because Vercel deploys only
// `site/`, which is exactly the shape that drifts.
describe("the published agent card", () => {
  const read = async (rel) => JSON.parse(
    await (await import("node:fs/promises")).readFile(new URL(rel, import.meta.url), "utf8"),
  );

  test("it is valid by the same rules we apply to other agents' cards", async () => {
    const { validateAgentCard } = await import("../src/a2a.mjs");
    const report = validateAgentCard(await read("../agent-card.json"));
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.warnings, []);
  });

  test("its version is the contract version, not a number someone typed", async () => {
    const { CONTRACT_VERSION } = await import("../src/gate-cli.mjs");
    assert.equal((await read("../agent-card.json")).version, CONTRACT_VERSION);
  });

  test("the card the site serves offers exactly the skills the source card describes", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = JSON.parse(await readFile(new URL("../agent-card.json", import.meta.url), "utf8"));
    const served = JSON.parse(await readFile(new URL("../../site/.well-known/agent-card.json", import.meta.url), "utf8"));
    assert.deepEqual(served.skills.map((s) => s.id), source.skills.map((s) => s.id), "run `npm run status-list` to re-publish");
    assert.equal(served.name, source.name);
    assert.equal(served.version, source.version);
  });

  test("every skill a peer might select is addressable and described", async () => {
    const card = await read("../agent-card.json");
    const ids = card.skills.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, "skill ids must be unique — a peer selects by id");
    for (const s of card.skills) {
      assert.ok(s.name && s.description?.length > 40, `skill ${s.id} is not described`);
      assert.ok(Array.isArray(s.tags) && s.tags.length, `skill ${s.id} has no tags`);
    }
    // The adoptions we claim on the card must be the ones that ship.
    assert.ok(ids.includes("mcp-mandate-gate"));
    assert.ok(ids.includes("x402-mandated-payment"));
  });
});
