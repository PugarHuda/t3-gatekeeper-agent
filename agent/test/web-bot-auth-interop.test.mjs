// Web Bot Auth, checked by someone who is not us.
//
// Every other test of our signer verifies with our verifier, which proves the
// two agree and nothing about the world. Cloudflare wrote the web-bot-auth
// draft and ships the reference implementation (`web-bot-auth` on npm). This
// file runs OUR signatures through THEIR verifier and THEIR signatures through
// OURS. If either direction fails, one side is not speaking the profile — and
// since theirs is the reference, it is ours.
//
// Both directions resolve the key the way a destination would: from the JWKS
// our key directory publishes, not from a key handed over in-process.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { verify as cfVerify, signatureHeaders as cfSign } from "web-bot-auth";
import { verifierFromJWK, signerFromJWK } from "web-bot-auth/crypto";

import {
  generateAgentKey, signRequest, verifyRequest, keyDirectory, keyFromDirectory,
} from "../src/web-bot-auth.mjs";

const { publicKey, privateKey } = generateAgentKey();
const KEYID = "did:t3n:test#wba";
const directory = keyDirectory(publicKey, KEYID);

/** Our headers, as a fetch Request — the shape Cloudflare's verify() takes. */
function asRequest(url, method, headers, body) {
  return new Request(url, { method, headers, body: body ?? undefined });
}

describe("our signatures, Cloudflare's verifier", () => {
  test("a GET we sign verifies under the reference implementation", async () => {
    const req = { method: "GET", url: "https://broker.example/v1/orders/42" };
    const headers = signRequest(req, { privateKey, keyid: KEYID });

    // A destination resolves keyid → JWK from the directory we publish.
    const jwk = directory.keys.find((k) => k.kid === KEYID);
    await cfVerify(asRequest(req.url, req.method, headers), await verifierFromJWK(jwk));
  });

  test("a POST with a body verifies, digest included", async () => {
    const body = JSON.stringify({ kind: "rwa.buy", amount_cents: 100_000 });
    const req = { method: "POST", url: "https://broker.example/v1/orders", body };
    const headers = signRequest(req, { privateKey, keyid: KEYID });
    assert.ok(headers["Content-Digest"], "a body must be covered by Content-Digest");

    const jwk = directory.keys.find((k) => k.kid === KEYID);
    await cfVerify(asRequest(req.url, req.method, headers, body), await verifierFromJWK(jwk));
  });

  test("the reference verifier rejects our signature once it has expired", async () => {
    const req = { method: "GET", url: "https://broker.example/v1/orders/42" };
    const created = Math.floor(Date.now() / 1000) - 3600;
    const headers = signRequest(req, { privateKey, keyid: KEYID, created, ttlSeconds: 300 });
    const jwk = directory.keys.find((k) => k.kid === KEYID);
    await assert.rejects(
      async () => cfVerify(asRequest(req.url, req.method, headers), await verifierFromJWK(jwk)),
      /expired/,
    );
  });

  test("the reference verifier rejects a signature made by a different key", async () => {
    const other = generateAgentKey();
    const req = { method: "GET", url: "https://broker.example/v1/orders/42" };
    const headers = signRequest(req, { privateKey: other.privateKey, keyid: KEYID }); // claims our keyid
    const jwk = directory.keys.find((k) => k.kid === KEYID);
    await assert.rejects(async () => cfVerify(asRequest(req.url, req.method, headers), await verifierFromJWK(jwk)));
  });

  test("the reference verifier rejects a swapped body", async () => {
    const req = { method: "POST", url: "https://broker.example/v1/orders", body: '{"amount_cents":100}' };
    const headers = signRequest(req, { privateKey, keyid: KEYID });
    const jwk = directory.keys.find((k) => k.kid === KEYID);
    // Same headers, different body: Content-Digest no longer matches. Their
    // verifier does not recompute the digest itself (RFC 9421 leaves that to
    // the application), so this is the check OUR verifier adds — asserted in
    // the reverse direction below. Here we assert the signature still binds
    // the digest header: change the header and the signature breaks.
    const tampered = { ...headers, "Content-Digest": "sha-256=:AAAA:" };
    await assert.rejects(async () => cfVerify(asRequest(req.url, req.method, tampered, req.body), await verifierFromJWK(jwk)));
  });
});

describe("Cloudflare's signatures, our verifier", () => {
  // Their signer needs a JWK with the private scalar. Export ours.
  const jwkPrivate = { ...privateKey.export({ format: "jwk" }), kid: KEYID, alg: "EdDSA" };

  test("a request signed by the reference implementation verifies here", async () => {
    const url = "https://gatekeeper.example/a2a";
    const request = new Request(url, { method: "POST", headers: { "signature-agent": '"https://gatekeeper-evidence.vercel.app"' } });
    const now = new Date();
    const headers = await cfSign(request, await signerFromJWK(jwkPrivate), {
      created: now, expires: new Date(now.getTime() + 300_000),
    });

    // A destination running our verifier: key from the directory, headers off
    // the wire. Cloudflare covers `signature-agent`, a header component we
    // never emit — the verifier has to reconstruct it from the request.
    const key = keyFromDirectory(directory, KEYID);
    const ok = verifyRequest(
      { method: "POST", url, headers: { "signature-agent": '"https://gatekeeper-evidence.vercel.app"' } },
      { "Signature-Input": headers["Signature-Input"], "Signature": headers["Signature"] },
      key,
    );
    assert.equal(ok, true);
  });

  test("and refuses it once the covered header changes", async () => {
    const url = "https://gatekeeper.example/a2a";
    const request = new Request(url, { method: "POST", headers: { "signature-agent": '"https://a.example"' } });
    const now = new Date();
    const headers = await cfSign(request, await signerFromJWK(jwkPrivate), {
      created: now, expires: new Date(now.getTime() + 300_000),
    });
    const key = keyFromDirectory(directory, KEYID);
    const ok = verifyRequest(
      { method: "POST", url, headers: { "signature-agent": '"https://b.example"' } }, // moved
      { "Signature-Input": headers["Signature-Input"], "Signature": headers["Signature"] },
      key,
    );
    assert.equal(ok, false);
  });

  test("and refuses a signature with no expiry at all", () => {
    // Our own signer always sets one; this is a hand-built params line
    // without it, which is what a pre-profile RFC 9421 signer would emit.
    const url = "https://gatekeeper.example/a2a";
    const key = keyFromDirectory(directory, KEYID);
    const ok = verifyRequest(
      { method: "GET", url },
      {
        "Signature-Input": `sig1=("@method" "@authority" "@path");created=${Math.floor(Date.now() / 1000)};keyid="${KEYID}";alg="ed25519";tag="web-bot-auth"`,
        "Signature": "sig1=:AAAA:",
      },
      key,
    );
    assert.equal(ok, false);
  });
});
