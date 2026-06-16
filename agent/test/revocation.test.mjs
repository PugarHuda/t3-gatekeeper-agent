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
