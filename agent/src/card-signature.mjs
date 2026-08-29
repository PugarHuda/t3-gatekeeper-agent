// A signed agent card, and a did:web document to verify it against.
//
// A2A v1.0 cards carry `signatures`: detached JWS over the card. Without one a
// peer that fetched the card over TLS knows only that *some* server at that
// origin said so; with one it can check that the agent's own key — the same
// Ed25519 key every outbound request is signed with — vouches for exactly
// these skills, this endpoint and this security scheme.
//
// The key is resolvable two ways, both standard: the Web Bot Auth directory
// (`/.well-known/http-message-signatures-directory`) and a did:web document
// (`/.well-known/did.json`), whose verificationMethod carries the same JWK.
// The JWS `kid` is the did:web verification method id.
//
// Node's crypto only. No Terminal 3 packages: this must stay importable by the
// hosted functions and by any peer that wants to verify without our stack.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

// ── RFC 8785 JSON Canonicalization Scheme ──────────────────────────────────
// Enough of JCS for JSON that came from JSON.parse: object keys sorted by
// UTF-16 code units, arrays in order, numbers as ES ToString (which
// JSON.stringify already does), strings escaped as JSON.stringify does.
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** JWK → Node public key (Ed25519 only). */
export function publicKeyFromJwk(jwk) {
  if (jwk?.kty !== "OKP" || jwk?.crv !== "Ed25519" || !jwk?.x) throw new Error("expected an Ed25519 OKP JWK");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
}

/** Node public key → the public JWK (what did.json and the directory publish). */
export function jwkFromPublicKey(publicKey) {
  const { x } = publicKey.export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", x };
}

/** What gets signed: the card without its own signatures, canonicalized. */
export function cardPayload(card) {
  const { signatures: _omit, ...rest } = card;
  return b64u(canonicalize(rest));
}

/**
 * Sign a card. Returns a copy whose `signatures` holds one detached JWS
 * (`protected` + `signature`, both base64url, payload omitted — a peer rebuilds
 * it from the card it received, which is the point).
 */
export function signCard(card, { privateKey, kid }) {
  const protectedHeader = b64u(JSON.stringify({ alg: "EdDSA", kid, typ: "a2a-agent-card+jws" }));
  const input = `${protectedHeader}.${cardPayload(card)}`;
  const signature = b64u(sign(null, Buffer.from(input), privateKey));
  return { ...card, signatures: [{ protected: protectedHeader, signature }] };
}

/**
 * Verify every signature on a card. `resolveJwk(kid)` returns the JWK for a
 * key id (sync or async). Returns { verified, problems }: verified is the
 * count of signatures that checked out; problems names each that did not.
 */
export async function verifyCard(card, resolveJwk) {
  const problems = [];
  let verified = 0;
  const sigs = Array.isArray(card?.signatures) ? card.signatures : [];
  if (sigs.length === 0) return { verified: 0, problems: ["card carries no signatures"] };
  const payload = cardPayload(card);
  for (const [i, s] of sigs.entries()) {
    let header;
    try { header = JSON.parse(Buffer.from(s.protected, "base64url").toString("utf8")); }
    catch { problems.push(`signatures[${i}]: protected header is not base64url JSON`); continue; }
    if (header.alg !== "EdDSA") { problems.push(`signatures[${i}]: alg ${header.alg} is not EdDSA`); continue; }
    if (!header.kid) { problems.push(`signatures[${i}]: no kid`); continue; }
    let jwk;
    try { jwk = await resolveJwk(header.kid); } catch (e) { problems.push(`signatures[${i}]: ${e.message}`); continue; }
    if (!jwk) { problems.push(`signatures[${i}]: kid ${header.kid} did not resolve`); continue; }
    const ok = verify(null, Buffer.from(`${s.protected}.${payload}`), publicKeyFromJwk(jwk), Buffer.from(s.signature, "base64url"));
    if (ok) verified++; else problems.push(`signatures[${i}]: signature does not verify for ${header.kid}`);
  }
  return { verified, problems };
}

// ── did:web ────────────────────────────────────────────────────────────────

/** `https://host[/path]` → `did:web:host[:path]` (method spec §3.2). */
export function didWebFromOrigin(origin) {
  const u = new URL(origin);
  const host = u.port ? `${u.hostname}%3A${u.port}` : u.hostname;
  const path = u.pathname.replace(/^\/|\/$/g, "");
  return `did:web:${host}${path ? ":" + path.split("/").join(":") : ""}`;
}

/** Where a did:web DID's document is fetched from (method spec §3.2). */
export function didWebDocumentUrl(did) {
  const m = /^did:web:(.+)$/.exec(did);
  if (!m) throw new Error(`not a did:web: ${did}`);
  const parts = m[1].split(":").map(decodeURIComponent);
  const host = parts.shift();
  return parts.length ? `https://${host}/${parts.join("/")}/did.json` : `https://${host}/.well-known/did.json`;
}

/**
 * The DID document published at /.well-known/did.json: the agent's key as a
 * JsonWebKey2020 verification method, usable for authentication and
 * assertion (the card signature), plus the services a resolver can jump to.
 */
export function buildDidDocument({ origin, publicKey, keyFragment = "wba", services = [] }) {
  const did = didWebFromOrigin(origin);
  const vmId = `${did}#${keyFragment}`;
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: did,
    verificationMethod: [{ id: vmId, type: "JsonWebKey2020", controller: did, publicKeyJwk: jwkFromPublicKey(publicKey) }],
    authentication: [vmId],
    assertionMethod: [vmId],
    service: services,
  };
}

/** Resolve a `did:web:…#fragment` kid to its JWK by fetching the document. */
export function didWebResolver({ fetchImpl = fetch } = {}) {
  const cache = new Map();
  return async function resolveJwk(kid) {
    const [did, fragment] = kid.split("#");
    if (!did.startsWith("did:web:")) return null;
    if (!cache.has(did)) {
      const res = await fetchImpl(didWebDocumentUrl(did), { headers: { accept: "application/did+json, application/json" } });
      if (!res.ok) throw new Error(`did:web document fetch failed: HTTP ${res.status}`);
      cache.set(did, await res.json());
    }
    const doc = cache.get(did);
    const vm = (doc.verificationMethod ?? []).find((m) => m.id === kid || m.id === `#${fragment}`);
    return vm?.publicKeyJwk ?? null;
  };
}

/** Load the signing key the way the rest of the agent does (PKCS#8 base64). */
export function privateKeyFromEnv(b64) {
  return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}
