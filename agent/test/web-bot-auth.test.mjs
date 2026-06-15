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
