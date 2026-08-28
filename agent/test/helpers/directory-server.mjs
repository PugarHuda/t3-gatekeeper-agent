// A caller's key directory, served over HTTP for tests.
//
// A web-bot-auth verifier resolves the signer's key from the origin named in
// `Signature-Agent`. In production that origin is the caller's own site; in a
// test it is this — a real HTTP server, so the resolver's fetch, content-type
// handling and caching are exercised rather than bypassed.
import { createServer } from "node:http";
import { generateAgentKey, keyDirectory } from "../../src/web-bot-auth.mjs";
import { signingFetch } from "../../src/web-bot-auth-fetch.mjs";

/** Start serving `directory` (a JWKS). Resolves to { origin, close }. */
export function serveDirectory(directory) {
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/http-message-signatures-directory") {
      res.writeHead(200, { "content-type": "application/http-message-signatures-directory+json" });
      return res.end(JSON.stringify(directory));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

/**
 * A complete signing identity for a test caller: a fresh key, its directory
 * served over HTTP, and a fetch that signs with it. `close()` when done.
 */
export async function testCaller(keyid = "did:t3n:test-caller#wba") {
  const { publicKey, privateKey } = generateAgentKey();
  const dir = await serveDirectory(keyDirectory(publicKey, keyid));
  return {
    keyid, publicKey, privateKey, origin: dir.origin,
    fetch: signingFetch({ privateKey, keyid, directoryOrigin: dir.origin }),
    close: dir.close,
  };
}
