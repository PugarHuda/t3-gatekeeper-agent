import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAgentKey, signRequest, verifyRequest } from "../src/web-bot-auth.mjs";

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
