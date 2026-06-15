// Web Bot Auth — RFC 9421 HTTP Message Signatures for the agent's outbound
// action requests. This is the "front door" standard for agentic commerce
// (Cloudflare/IETF; adopted by Visa TAP and Mastercard Agent Pay): a destination
// can cryptographically verify the request came from this agent before acting.
//
// Minimal, dependency-free (Ed25519 via node:crypto) implementation of the
// derived-component signing in RFC 9421 §2.2 + the `web-bot-auth` tag profile.
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey } from "node:crypto";

const COMPONENTS = ["@method", "@authority", "@path"];

export function generateAgentKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey };
}

function derived(component, url, method) {
  const u = new URL(url);
  switch (component) {
    case "@method": return method.toUpperCase();
    case "@authority": return u.host;
    case "@path": return u.pathname || "/";
    default: throw new Error(`unsupported component ${component}`);
  }
}

// RFC 9421 §2.5 signature base: one line per covered component, then the
// "@signature-params" line whose value is the inner list + signature params.
function signatureBase({ method, url }, params) {
  const inner = COMPONENTS.map((c) => `"${c}"`).join(" ");
  const sigParamsValue =
    `(${inner});created=${params.created};keyid="${params.keyid}";alg="ed25519";tag="web-bot-auth"`;
  const lines = COMPONENTS.map((c) => `"${c}": ${derived(c, url, method)}`);
  lines.push(`"@signature-params": ${sigParamsValue}`);
  return { base: lines.join("\n"), sigParamsValue };
}

/** Sign a request → returns the `Signature-Input` and `Signature` header values. */
export function signRequest(req, { privateKey, keyid, created = 1_700_000_000 }) {
  const { base, sigParamsValue } = signatureBase(req, { keyid, created });
  const sig = edSign(null, Buffer.from(base, "utf8"), privateKey).toString("base64");
  return {
    "Signature-Input": `sig1=${sigParamsValue}`,
    "Signature": `sig1=:${sig}:`,
  };
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
  // rebuild the base exactly and verify
  const { base } = signatureBase(req, { keyid, created });
  const expected = `(${COMPONENTS.map((c) => `"${c}"`).join(" ")});created=${created};keyid="${keyid}";alg="ed25519";tag="web-bot-auth"`;
  if (sigParamsValue !== expected) return false; // covered set / params must match
  const pub = publicKey instanceof Object ? publicKey : createPublicKey(publicKey);
  return edVerify(null, Buffer.from(base, "utf8"), pub, Buffer.from(s[1], "base64"));
}
