import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateAgentKey, signRequest, verifyRequest,
  loadAgentKey, exportPrivateKey, keyDirectory, keyFromDirectory,
} from "../src/web-bot-auth.mjs";

const { publicKey, privateKey } = generateAgentKey();
const keyid = "did:t3n:3d7dd668…#wba";
const req = { method: "POST", url: "https://bank.example/api/transfer" };

test("a signed request verifies", () => {
  const headers = signRequest(req, { privateKey, keyid });
  assert.equal(verifyRequest(req, headers, publicKey), true);
});

test("tampering the method breaks verification", () => {
  const headers = signRequest(req, { privateKey, keyid });
  assert.equal(verifyRequest({ ...req, method: "GET" }, headers, publicKey), false);
});

test("tampering the path breaks verification", () => {
  const headers = signRequest(req, { privateKey, keyid });
  assert.equal(verifyRequest({ ...req, url: "https://bank.example/api/drain" }, headers, publicKey), false);
});

test("a different host key does not verify", () => {
  const headers = signRequest(req, { privateKey, keyid });
  const other = generateAgentKey();
  assert.equal(verifyRequest(req, headers, other.publicKey), false);
});

test("headers carry the web-bot-auth tag (RFC 9421 profile)", () => {
  const headers = signRequest(req, { privateKey, keyid });
  assert.match(headers["Signature-Input"], /tag="web-bot-auth"/);
  assert.match(headers["Signature-Input"], /alg="ed25519"/);
  assert.match(headers["Signature"], /^sig1=:.+:$/);
});

const bodyReq = { method: "POST", url: "https://bank.example/api/transfer", body: '{"amount":1000}' };

test("a request with a body verifies and covers content-digest", () => {
  const headers = signRequest(bodyReq, { privateKey, keyid });
  assert.match(headers["Content-Digest"], /^sha-256=:.+:$/);
  assert.match(headers["Signature-Input"], /"content-digest"/);
  assert.equal(verifyRequest(bodyReq, headers, publicKey), true);
});

test("tampering the body breaks verification (digest is signed)", () => {
  const headers = signRequest(bodyReq, { privateKey, keyid });
  const tampered = { ...bodyReq, body: '{"amount":9999}' };
  assert.equal(verifyRequest(tampered, headers, publicKey), false);
});

test("swapping the Content-Digest header to match a forged body still fails", () => {
  const headers = signRequest(bodyReq, { privateKey, keyid });
  // attacker forges body AND recomputes the digest header — signature must still reject
  const forged = { ...bodyReq, body: '{"amount":9999}' };
  const forgedHeaders = { ...headers, "Content-Digest": signRequest(forged, { privateKey, keyid })["Content-Digest"] };
  assert.equal(verifyRequest(forged, forgedHeaders, publicKey), false);
});

test("uses a real (non-fixed) created timestamp", () => {
  const headers = signRequest(req, { privateKey, keyid });
  const created = Number(headers["Signature-Input"].match(/created=(\d+)/)[1]);
  assert.ok(created > 1_700_000_000, "created should be a recent unix time, not the old fixed default");
});

// --- replay: a signature that verifies forever is a reusable payment order ---

test("a stale signature is rejected", () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  const headers = signRequest(req, { privateKey, keyid, created: old });
  assert.equal(verifyRequest(req, headers, publicKey), false,
    "an hour-old signature must not still verify");
});

test("a signature just inside the window still verifies", () => {
  const recent = Math.floor(Date.now() / 1000) - 60;
  const headers = signRequest(req, { privateKey, keyid, created: recent });
  assert.equal(verifyRequest(req, headers, publicKey), true);
});

test("a signature dated in the future is rejected", () => {
  const ahead = Math.floor(Date.now() / 1000) + 3600;
  const headers = signRequest(req, { privateKey, keyid, created: ahead });
  assert.equal(verifyRequest(req, headers, publicKey), false);
});

test("small clock skew is tolerated", () => {
  // A destination whose clock runs slightly ahead must not reject good traffic.
  const slightlyAhead = Math.floor(Date.now() / 1000) + 10;
  const headers = signRequest(req, { privateKey, keyid, created: slightlyAhead });
  assert.equal(verifyRequest(req, headers, publicKey), true);
});

test("the freshness window can be widened deliberately — within the signer's own expiry", () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  // The signer states its own deadline (`expires`). A verifier may be stricter
  // than that, never looser: widening maxAge past a signature that has already
  // expired must still refuse it.
  const longLived = signRequest(req, { privateKey, keyid, created: old, ttlSeconds: 7200 });
  assert.equal(verifyRequest(req, longLived, publicKey, { maxAgeSeconds: 7200 }), true);
  const expired = signRequest(req, { privateKey, keyid, created: old }); // default 300s TTL
  assert.equal(verifyRequest(req, expired, publicKey, { maxAgeSeconds: 7200 }), false);
});

test("created cannot be back-dated without breaking the signature", () => {
  // The defence only works because `created` is inside the signature base.
  const headers = signRequest(req, { privateKey, keyid });
  const fresh = Math.floor(Date.now() / 1000);
  headers["Signature-Input"] = headers["Signature-Input"].replace(/created=\d+/, `created=${fresh}`);
  assert.equal(verifyRequest(req, headers, publicKey), true); // unchanged value, still valid
  headers["Signature-Input"] = headers["Signature-Input"].replace(/created=\d+/, `created=${fresh - 9999}`);
  assert.equal(verifyRequest(req, headers, publicKey, { maxAgeSeconds: 1e9 }), false,
    "editing created must invalidate the signature, not just age it");
});

test("a signature from an unexpected keyid is rejected", () => {
  const headers = signRequest(req, { privateKey, keyid });
  assert.equal(verifyRequest(req, headers, publicKey, { expectedKeyid: "did:t3n:someone-else#wba" }),
    false, "verifying against a key is not the same as identifying the agent");
  assert.equal(verifyRequest(req, headers, publicKey, { expectedKeyid: keyid }), true);
});

// --- key directory: the part that makes a signature verifiable by a stranger ---

test("a persisted key round-trips through WBA_PRIVATE_KEY", () => {
  const fresh = generateAgentKey();
  const loaded = loadAgentKey({ WBA_PRIVATE_KEY: exportPrivateKey(fresh.privateKey) });
  assert.equal(loaded.ephemeral, false);
  // Same key => a signature made by one verifies under the other.
  const headers = signRequest(req, { privateKey: fresh.privateKey, keyid });
  assert.equal(verifyRequest(req, headers, loaded.publicKey), true);
});

test("an unset WBA_PRIVATE_KEY is reported as ephemeral, not silently accepted", () => {
  assert.equal(loadAgentKey({}).ephemeral, true);
});

test("the directory is a well-formed Ed25519 JWKS", () => {
  const [jwk] = keyDirectory(publicKey, keyid).keys;
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.equal(jwk.kid, keyid);
  assert.equal(Buffer.from(jwk.x, "base64url").length, 32, "x must be the raw 32-byte key");
});

test("a destination can verify using ONLY the published directory", () => {
  // The end-to-end property: fetch the JWKS, resolve keyid, verify. No shared
  // secret, no out-of-band key exchange — which is what made the old ephemeral
  // key worthless in practice.
  const headers = signRequest({ ...req, body: '{"amount":100}' }, { privateKey, keyid });
  const published = JSON.parse(JSON.stringify(keyDirectory(publicKey, keyid))); // over the wire
  const resolved = keyFromDirectory(published, keyid);
  assert.ok(resolved, "keyid must resolve in the directory");
  assert.equal(verifyRequest({ ...req, body: '{"amount":100}' }, headers, resolved), true);
});

test("a keyid missing from the directory does not resolve", () => {
  assert.equal(keyFromDirectory(keyDirectory(publicKey, keyid), "did:t3n:someone-else#wba"), null);
});

test("a directory key cannot verify a different agent's signature", () => {
  const other = generateAgentKey();
  const headers = signRequest(req, { privateKey: other.privateKey, keyid });
  const resolved = keyFromDirectory(keyDirectory(publicKey, keyid), keyid);
  assert.equal(verifyRequest(req, headers, resolved), false);
});
