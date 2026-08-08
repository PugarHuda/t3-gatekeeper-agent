// Web Bot Auth — RFC 9421 HTTP Message Signatures for the agent's outbound
// action requests. This is the "front door" standard for agentic commerce
// (Cloudflare/IETF; adopted by Visa TAP and Mastercard Agent Pay): a destination
// can cryptographically verify the request came from this agent before acting.
//
// Minimal, dependency-free (Ed25519 via node:crypto) implementation of the
// derived-component signing in RFC 9421 §2.2 + the `web-bot-auth` tag profile.
// When the request carries a body, its SHA-256 `Content-Digest` (RFC 9530) is
// covered by the signature too, so the body cannot be tampered in flight.
import {
  generateKeyPairSync, sign as edSign, verify as edVerify,
  createPublicKey, createPrivateKey, createHash,
} from "node:crypto";

const BASE_COMPONENTS = ["@method", "@authority", "@path"];

export function generateAgentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

/**
 * Load the agent's signing key from `WBA_PRIVATE_KEY` (PKCS#8 base64), or mint
 * an ephemeral one.
 *
 * A per-run key cannot be verified by anyone: the destination resolves `keyid`
 * against a published directory, and a key that changes every process start can
 * never appear there. `ephemeral` is returned so callers can say which mode
 * they are in rather than implying a verifiable identity they do not have.
 */
export function loadAgentKey(env = process.env) {
  const b64 = env.WBA_PRIVATE_KEY;
  if (!b64) return { ...generateAgentKey(), ephemeral: true };
  const privateKey = createPrivateKey({
    key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8",
  });
  return { privateKey, publicKey: createPublicKey(privateKey), ephemeral: false };
}

/** Export a private key as base64 PKCS#8 — what `WBA_PRIVATE_KEY` expects. */
export function exportPrivateKey(privateKey) {
  return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
}

/** base64url of the raw 32-byte Ed25519 public key (the JWK `x` parameter). */
function rawPublicKey(publicKey) {
  // SPKI for Ed25519 is a fixed 12-byte header followed by the raw key.
  const spki = publicKey.export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("base64url");
}

/**
 * Build the Web Bot Auth key directory (a JWKS) that a destination fetches to
 * resolve `keyid` → public key. Served at
 * `/.well-known/http-message-signatures-directory`.
 */
export function keyDirectory(publicKey, keyid) {
  return {
    keys: [{
      kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig",
      kid: keyid, x: rawPublicKey(publicKey),
    }],
  };
}

/** Resolve a `keyid` against a fetched directory → a verifying public key. */
export function keyFromDirectory(directory, keyid) {
  const jwk = (directory?.keys ?? []).find((k) => k.kid === keyid);
  if (!jwk) return null;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new Error(`unsupported key type ${jwk.kty}/${jwk.crv}`);
  }
  // Rebuild SPKI from the raw key: fixed Ed25519 header + 32 raw bytes.
  const header = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([header, Buffer.from(jwk.x, "base64url")]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** RFC 9530 Content-Digest of a body: `sha-256=:<base64(sha256)>:`. */
function contentDigest(body) {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

function componentValue(component, ctx) {
  const u = new URL(ctx.url);
  switch (component) {
    case "@method": return ctx.method.toUpperCase();
    case "@authority": return u.host;
    case "@path": return u.pathname || "/";
    case "content-digest": return ctx.contentDigestValue;
    default: throw new Error(`unsupported component ${component}`);
  }
}

// RFC 9421 §2.5 signature base: one line per covered component, then the
// "@signature-params" line whose value is the inner list + signature params.
function buildBase(components, ctx, params) {
  const inner = components.map((c) => `"${c}"`).join(" ");
  const sigParamsValue =
    `(${inner});created=${params.created};keyid="${params.keyid}";alg="ed25519";tag="web-bot-auth"`;
  const lines = components.map((c) => `"${c}": ${componentValue(c, ctx)}`);
  lines.push(`"@signature-params": ${sigParamsValue}`);
  return { base: lines.join("\n"), sigParamsValue };
}

/**
 * Sign a request → returns the `Signature-Input`, `Signature`, and (when the
 * request has a body) `Content-Digest` header values.
 * `req` = { method, url, body? }.
 */
export function signRequest(req, { privateKey, keyid, created = Math.floor(Date.now() / 1000) }) {
  const hasBody = req.body != null && req.body !== "";
  const components = hasBody ? [...BASE_COMPONENTS, "content-digest"] : [...BASE_COMPONENTS];
  const cdValue = hasBody ? contentDigest(req.body) : undefined;
  const ctx = { method: req.method, url: req.url, contentDigestValue: cdValue };
  const { base, sigParamsValue } = buildBase(components, ctx, { keyid, created });
  const sig = edSign(null, Buffer.from(base, "utf8"), privateKey).toString("base64");
  const headers = {
    "Signature-Input": `sig1=${sigParamsValue}`,
    "Signature": `sig1=:${sig}:`,
  };
  if (hasBody) headers["Content-Digest"] = cdValue;
  return headers;
}

/**
 * Verify a signed request against a public key. Returns true/false.
 *
 * `maxAgeSeconds` bounds how old a signature may be (default 5 minutes). Without
 * it a signature verifies forever: anyone who captures one request can replay it
 * unchanged for as long as the key lives, which for a payment instruction is the
 * whole attack. `created` is signed, so it cannot be moved without breaking the
 * signature — but it has to actually be *checked*. `skewSeconds` allows for a
 * destination clock that runs a little ahead of the signer's.
 *
 * `expectedKeyid` binds the signature to a specific agent. Verification against
 * a key alone answers "was this signed by that key", not "is this the agent I
 * think it is" — which differ the moment keys are resolved from a directory.
 */
export function verifyRequest(req, headers, publicKey, {
  maxAgeSeconds = 300, skewSeconds = 30, expectedKeyid, now = Math.floor(Date.now() / 1000),
} = {}) {
  const sigInput = headers["Signature-Input"] || "";
  const sigHeader = headers["Signature"] || "";
  const m = sigInput.match(/^sig1=(.+)$/);
  const s = sigHeader.match(/^sig1=:(.+):$/);
  if (!m || !s) return false;
  const sigParamsValue = m[1];
  if (!sigParamsValue.includes('tag="web-bot-auth"')) return false;
  const keyid = (sigParamsValue.match(/keyid="([^"]+)"/) || [])[1];
  const created = Number((sigParamsValue.match(/created=(\d+)/) || [])[1]);

  if (expectedKeyid != null && keyid !== expectedKeyid) return false;
  if (!Number.isFinite(created)) return false;
  if (maxAgeSeconds != null) {
    if (created > now + skewSeconds) return false;      // signed in the future
    if (now - created > maxAgeSeconds) return false;    // stale — replayed
  }
  // Recover the exact covered-component set from the signature input.
  const inner = sigParamsValue.match(/^\(([^)]*)\)/);
  if (!inner) return false;
  const components = inner[1].split(" ").filter(Boolean).map((x) => x.replace(/"/g, ""));

  // If the body digest is covered, the Content-Digest header must be present and
  // actually match the body bytes — otherwise the body could be swapped freely.
  let cdValue;
  if (components.includes("content-digest")) {
    if (req.body == null) return false;
    cdValue = contentDigest(req.body);
    if ((headers["Content-Digest"] || "") !== cdValue) return false;
  }

  const ctx = { method: req.method, url: req.url, contentDigestValue: cdValue };
  const { base, sigParamsValue: expected } = buildBase(components, ctx, { keyid, created });
  if (sigParamsValue !== expected) return false; // covered set / params must match
  const pub = publicKey instanceof Object ? publicKey : createPublicKey(publicKey);
  return edVerify(null, Buffer.from(base, "utf8"), pub, Buffer.from(s[1], "base64"));
}
