// Web Bot Auth — RFC 9421 HTTP Message Signatures for the agent's outbound
// action requests. This is the "front door" standard for agentic commerce
// (Cloudflare/IETF; adopted by Visa TAP and Mastercard Agent Pay): a destination
// can cryptographically verify the request came from this agent before acting.
//
// Minimal, dependency-free (Ed25519 via node:crypto) implementation of the
// derived-component signing in RFC 9421 §2.2 + the `web-bot-auth` tag profile.
// When the request carries a body, its SHA-256 `Content-Digest` (RFC 9530) is
// covered by the signature too, so the body cannot be tampered in flight.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createHash } from "node:crypto";

const BASE_COMPONENTS = ["@method", "@authority", "@path"];

export function generateAgentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
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

/** Verify a signed request against a public key. Returns true/false. */
export function verifyRequest(req, headers, publicKey) {
  const sigInput = headers["Signature-Input"] || "";
  const sigHeader = headers["Signature"] || "";
  const m = sigInput.match(/^sig1=(.+)$/);
  const s = sigHeader.match(/^sig1=:(.+):$/);
  if (!m || !s) return false;
  const sigParamsValue = m[1];
  if (!sigParamsValue.includes('tag="web-bot-auth"')) return false;
  const keyid = (sigParamsValue.match(/keyid="([^"]+)"/) || [])[1];
  const created = Number((sigParamsValue.match(/created=(\d+)/) || [])[1]);
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
