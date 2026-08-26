import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRevocation, buildOptionsFromEnv } from "../src/revocation.mjs";

const VC = "urn:vc:eligibility:demo";
const ISSUER = "did:key:zIssuer";
const OPTS = { revocationRegistryAddress: "0xRegistry", provider: {} }; // present => check runs

test("not configured -> skipped, fail-open (revoked=false)", async () => {
  const r = await checkRevocation(VC, ISSUER, { options: null, failClosed: false });
  assert.equal(r.checked, false);
  assert.equal(r.revoked, false);
});

test("not configured + failClosed -> blocked (revoked=true)", async () => {
  const r = await checkRevocation(VC, ISSUER, { options: null, failClosed: true });
  assert.equal(r.checked, false);
  assert.equal(r.revoked, true);
});

test("registry says revoked -> revoked=true, checked", async () => {
  const r = await checkRevocation(VC, ISSUER, { options: OPTS, isRevokedFn: async () => true });
  assert.equal(r.checked, true);
  assert.equal(r.revoked, true);
});

test("registry says not revoked -> revoked=false, checked", async () => {
  const r = await checkRevocation(VC, ISSUER, { options: OPTS, isRevokedFn: async () => false });
  assert.equal(r.checked, true);
  assert.equal(r.revoked, false);
});

test("registry/RPC error is treated as couldn't-check (honors failClosed)", async () => {
  const boom = async () => { throw new Error("RPC down"); };
  const open = await checkRevocation(VC, ISSUER, { options: OPTS, isRevokedFn: boom, failClosed: false });
  assert.equal(open.checked, false);
  assert.equal(open.revoked, false);
  const closed = await checkRevocation(VC, ISSUER, { options: OPTS, isRevokedFn: boom, failClosed: true });
  assert.equal(closed.revoked, true);
});

test("buildOptionsFromEnv returns null when unset", async () => {
  assert.equal(await buildOptionsFromEnv({}), null);
  assert.equal(await buildOptionsFromEnv({ REVOCATION_REGISTRY_ADDRESS: "0x1" }), null); // missing RPC
});

// ── unified status check (registry OR status list) ──────────────────────────
import { createServer } from "node:http";
import { checkCredentialStatus } from "../src/revocation.mjs";
import { buildStatusList, statusEntry } from "../src/status-list.mjs";

const LIST = buildStatusList({ id: "https://x.test/l", issuer: "did:key:i", revoked: [7] });

async function withList(fn, { status = 200 } = {}) {
  const srv = createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(LIST));
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    return await fn(`http://localhost:${srv.address().port}/l`);
  } finally {
    srv.close();
  }
}

const credWithStatus = (url, index) => ({
  id: "urn:vc:1",
  issuer: "did:key:i",
  credentialStatus: statusEntry({ statusListCredential: url, statusListIndex: index }),
});

test("a status list revocation blocks, without any chain configured", async () => {
  const r = await withList((url) => checkCredentialStatus(credWithStatus(url, 7)));
  assert.equal(r.checked, true);
  assert.equal(r.revoked, true);
  assert.equal(r.method, "bitstring-status-list");
});

test("a clear index passes, without any chain configured", async () => {
  const r = await withList((url) => checkCredentialStatus(credWithStatus(url, 8)));
  assert.equal(r.checked, true);
  assert.equal(r.revoked, false);
});

test("the status list is preferred over the registry when the credential names one", async () => {
  // The registry would say revoked; the credential's own issuer says otherwise.
  // The credential names where its status lives, so that is the answer.
  const r = await withList((url) =>
    checkCredentialStatus(credWithStatus(url, 8), {
      options: { revocationRegistryAddress: "0x", provider: {} },
      isRevokedFn: async () => true,
    }));
  assert.equal(r.method, "bitstring-status-list");
  assert.equal(r.revoked, false);
});

test("an unreachable status list falls back to the registry rather than giving up", async () => {
  const cred = credWithStatus("http://127.0.0.1:1/l", 7);
  const r = await checkCredentialStatus(cred, {
    options: { revocationRegistryAddress: "0x", provider: {} },
    isRevokedFn: async () => true,
  });
  assert.equal(r.checked, true);
  assert.equal(r.revoked, true);
  assert.equal(r.method, "on-chain-registry");
});

test("both mechanisms unavailable is 'not checked', and failClosed decides", async () => {
  const cred = credWithStatus("http://127.0.0.1:1/l", 7);
  const open = await checkCredentialStatus(cred);
  assert.equal(open.checked, false);
  assert.equal(open.revoked, false);
  assert.equal(open.method, "none");

  const closed = await checkCredentialStatus(cred, { failClosed: true });
  assert.equal(closed.checked, false);
  assert.equal(closed.revoked, true, "failClosed must block when nothing could answer");
});

test("a credential with no status entry still uses the registry", async () => {
  const r = await checkCredentialStatus(
    { id: "urn:vc:2", issuer: "did:key:i" },
    { options: { revocationRegistryAddress: "0x", provider: {} }, isRevokedFn: async () => false },
  );
  assert.equal(r.method, "on-chain-registry");
  assert.equal(r.revoked, false);
});
