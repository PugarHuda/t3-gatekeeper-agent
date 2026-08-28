// Who is calling the A2A endpoint? Web Bot Auth answers that — and nothing
// else in A2A does.
//
// The A2A server shipped with `UserBuilder.noAuthentication`: any process that
// could reach the port could ask the gate for decisions. For a decision that
// costs nothing that is merely impolite; for anything that reaches the enclave
// it is the hole. The fix is the standard this agent already speaks on the way
// OUT: RFC 9421 signatures with the web-bot-auth profile, now required on the
// way IN.
//
// How a caller is identified, with nothing shared in advance:
//
//   1. It signs the request (Signature-Input / Signature, Content-Digest over
//      the body) and names where its key lives in `Signature-Agent` — an origin
//      that serves /.well-known/http-message-signatures-directory.
//   2. This middleware fetches that directory, resolves `keyid` to a JWK, and
//      verifies. The caller's identity IS its origin plus keyid: two agents
//      that publish different directories are different agents, whatever they
//      claim in the body.
//   3. The nonce is remembered until the signature's own expiry. A captured
//      request replayed inside the window is refused; after the window the
//      signature has expired anyway.
//
// A2A's own security model is "whatever the securitySchemes say", and the
// v1.0 card can advertise this one (`httpsig`). The reference verifier for the
// profile is Cloudflare's, and our verifier is tested against it both ways.
import { verifyRequest, keyFromDirectory } from "./web-bot-auth.mjs";

export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

/** Parse `Signature-Agent`: an RFC 8941 sf-string, i.e. a quoted origin. */
export function signatureAgentOrigin(header) {
  const m = String(header ?? "").trim().match(/^"([^"]+)"$/);
  if (!m) return null;
  try {
    const u = new URL(m[1]);
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Fetch and cache a caller's key directory. */
export function directoryResolver({ fetchImpl = fetch, ttlMs = 300_000 } = {}) {
  const cache = new Map(); // origin → { at, directory }
  return async (origin) => {
    const hit = cache.get(origin);
    if (hit && Date.now() - hit.at < ttlMs) return hit.directory;
    const res = await fetchImpl(origin + DIRECTORY_PATH, {
      headers: { accept: "application/http-message-signatures-directory+json, application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`key directory ${origin}: HTTP ${res.status}`);
    const directory = await res.json();
    cache.set(origin, { at: Date.now(), directory });
    return directory;
  };
}

/** Remember nonces until the signature that carried them has expired. */
export function nonceLedger() {
  const seen = new Map(); // nonce → expires (unix secs)
  return {
    /** true if this nonce is new; false if it was already used. */
    admit(nonce, expires) {
      const now = Math.floor(Date.now() / 1000);
      for (const [n, exp] of seen) if (exp < now) seen.delete(n);
      if (!nonce) return false;
      if (seen.has(nonce)) return false;
      seen.set(nonce, Number.isFinite(expires) ? expires : now + 300);
      return true;
    },
    get size() { return seen.size; },
  };
}

/** The `Signature-Input` parameters we need to make a decision. */
function sigParams(input) {
  const m = String(input ?? "").match(/^[A-Za-z0-9_-]+=(.+)$/);
  if (!m) return null;
  return {
    keyid: (m[1].match(/keyid="([^"]+)"/) || [])[1],
    nonce: (m[1].match(/nonce="([^"]+)"/) || [])[1],
    expires: Number((m[1].match(/expires=(\d+)/) || [])[1]),
  };
}

/**
 * Express middleware: refuse any request that is not a valid, fresh, unreplayed
 * web-bot-auth signature from an agent with a published key.
 *
 * Mount it AFTER a body parser that kept the raw bytes (`express.json({ verify })`),
 * because Content-Digest is over the bytes, not the parsed object. On success
 * `req.agent = { origin, keyid }` for whatever runs next.
 */
export function requireWebBotAuth({ resolve = directoryResolver(), nonces = nonceLedger(), skip = () => false } = {}) {
  return async function webBotAuth(req, res, next) {
    if (skip(req)) return next();
    const refuse = (status, reason) => {
      res.status(status)
        .set("WWW-Authenticate", 'HTTPSig realm="gatekeeper", tag="web-bot-auth"')
        .json({ error: "unauthorized", reason });
    };

    const input = req.get("signature-input");
    const signature = req.get("signature");
    if (!input || !signature) return refuse(401, "request is not signed (web-bot-auth required)");

    const origin = signatureAgentOrigin(req.get("signature-agent"));
    if (!origin) return refuse(401, "Signature-Agent must name the https origin that serves your key directory");

    const params = sigParams(input);
    if (!params?.keyid) return refuse(401, "signature names no keyid");

    let key;
    try {
      key = keyFromDirectory(await resolve(origin), params.keyid);
    } catch (e) {
      return refuse(401, `could not resolve keyid at ${origin}: ${String(e.message).slice(0, 80)}`);
    }
    if (!key) return refuse(401, `keyid ${params.keyid} is not in ${origin}${DIRECTORY_PATH}`);

    // The URL the signer saw: authority from the Host header, path from the
    // request. A proxy that rewrites either will (correctly) fail this.
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const headers = {
      "Signature-Input": input,
      "Signature": signature,
      "Content-Digest": req.get("content-digest") ?? "",
    };
    const ok = verifyRequest(
      { method: req.method, url, body: req.rawBody ?? "", headers: { "signature-agent": req.get("signature-agent") } },
      headers,
      key,
      { expectedKeyid: params.keyid },
    );
    if (!ok) return refuse(401, "signature does not verify (method, authority, path, body digest, or expiry)");
    if (!nonces.admit(params.nonce, params.expires)) return refuse(401, "nonce already used — replay refused");

    req.agent = { origin, keyid: params.keyid };
    next();
  };
}
