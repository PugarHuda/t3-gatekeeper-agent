// The A2A + MCP app, mounted for a host that puts it under a path prefix
// (Vercel functions live at /api/<name>). The mount is what keeps the
// web-bot-auth check honest: a caller signs the public path, express keeps it
// in req.originalUrl, and the verifier compares against exactly that.
import express from "express";
import { createApp } from "./a2a-server.mjs";

export const PUBLIC_A2A_URL = "https://gatekeeper-evidence.vercel.app/api/a2a";

/** `mounted("/api/a2a")` → the JSON-RPC endpoint; `mounted("/api")` → /api/mcp. */
/**
 * Replay protection on a serverless host is honest about its shape: the nonce
 * ledger lives in one function instance, so a captured request could be
 * replayed against a *different* instance until the signature ages out. The
 * hosted door therefore accepts a signature for 120 s from `created` instead
 * of the signer's 300 s: the window a replay has is that, not "never".
 */
export const HOSTED_MAX_AGE_SECONDS = 120;

export function mounted(prefix, publicUrl = PUBLIC_A2A_URL) {
  const outer = express();
  outer.use(prefix, createApp(publicUrl, { auth: { maxAgeSeconds: HOSTED_MAX_AGE_SECONDS } }));
  return outer;
}
