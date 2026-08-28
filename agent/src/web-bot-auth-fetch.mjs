// A `fetch` that signs every request it sends — web-bot-auth on the way out.
//
// Both the A2A client (`JsonRpcTransportFactory({ fetchImpl })`) and the MCP
// Streamable HTTP client (`{ fetch }`) take a fetch function. Handing them this
// one makes every call they make a signed call, with no change to how they are
// used. The signature covers method, authority, path, and — when there is a
// body — its Content-Digest, and names the origin that serves this agent's key
// directory in `Signature-Agent`, so the destination can resolve the key with
// nothing shared in advance.
import { signRequest } from "./web-bot-auth.mjs";

/**
 * @param privateKey      Ed25519 private key (node KeyObject)
 * @param keyid           the `kid` published in the directory
 * @param directoryOrigin origin serving /.well-known/http-message-signatures-directory
 */
export function signingFetch({ privateKey, keyid, directoryOrigin, fetchImpl = fetch }) {
  if (!privateKey || !keyid || !directoryOrigin) {
    throw new Error("signingFetch: privateKey, keyid and directoryOrigin are all required");
  }
  const agent = `"${new URL(directoryOrigin).origin}"`;

  return async function signedFetch(input, init = {}) {
    // Normalise to (method, url, body, headers) whatever shape we were handed.
    const req = input instanceof Request ? input : new Request(input, init);
    const method = (init.method ?? req.method ?? "GET").toUpperCase();
    const url = req.url;
    // Read the body once, as text: the digest is over exactly these bytes,
    // and they are what goes on the wire.
    let body = init.body;
    if (body == null && input instanceof Request && !["GET", "HEAD"].includes(method)) {
      body = await input.clone().text();
    }
    if (body != null && typeof body !== "string") body = String(body);

    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const signed = signRequest({ method, url, body: body ?? "" }, { privateKey, keyid });
    for (const [k, v] of Object.entries(signed)) headers.set(k, v);
    headers.set("Signature-Agent", agent);

    return fetchImpl(url, { ...init, method, headers, body: body ?? undefined });
  };
}
