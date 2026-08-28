// The A2A + MCP app, mounted for a host that puts it under a path prefix
// (Vercel functions live at /api/<name>). The mount is what keeps the
// web-bot-auth check honest: a caller signs the public path, express keeps it
// in req.originalUrl, and the verifier compares against exactly that.
import express from "express";
import { createApp } from "./a2a-server.mjs";

export const PUBLIC_A2A_URL = "https://gatekeeper-evidence.vercel.app/api/a2a";

/** `mounted("/api/a2a")` → the JSON-RPC endpoint; `mounted("/api")` → /api/mcp. */
export function mounted(prefix, publicUrl = PUBLIC_A2A_URL) {
  const outer = express();
  outer.use(prefix, createApp(publicUrl));
  return outer;
}
