// MCP over Streamable HTTP, on the same origin as A2A, driven by the official
// MCP client — signed, because the same door guards both.
//
// The stdio server is how a local host adopts the gate. This is how a REMOTE
// one does: an HTTP endpoint any MCP client can point at, stateless (one
// server per request, as the SDK documents), and refusing anyone who cannot
// produce a web-bot-auth signature from a published key.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { start, MCP_PATH } from "../src/a2a-server.mjs";
import { gateCliPath, CONTRACT_VERSION } from "../src/gate-cli.mjs";
import { testCaller } from "./helpers/directory-server.mjs";

let srv, caller, client;
const need = () => (gateCliPath() ? false : "gate_cli is not built");

before(async () => {
  srv = await start(0);
  caller = await testCaller("did:t3n:mcp-host#wba");
  client = new Client({ name: "remote-host", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_PATH, srv.listenUrl), { fetch: caller.fetch }));
});
after(async () => { await client?.close(); await srv?.close(); await caller?.close(); });

describe("MCP over HTTP, signed", () => {
  test("the server identifies itself and lists the same tools as stdio", async () => {
    assert.equal(client.getServerVersion().name, "gatekeeper");
    assert.equal(client.getServerVersion().version, CONTRACT_VERSION);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const n of ["gate_evaluate", "bind_credential", "fetch_paid_resource", "gate_execute"]) assert.ok(names.includes(n), n);
  });

  test("gate_evaluate answers over HTTP from the compiled contract", { skip: need() }, async () => {
    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: {
        action: { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 },
        mandate: { max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 },
      },
    });
    assert.equal(r.structuredContent.decision, "rejected");
    assert.ok(r.structuredContent.reasons.some((x) => /exceeds mandate max/.test(x)));
  });

  test("each request stands alone — a second client with no shared state gets the same answers", { skip: need() }, async () => {
    const other = new Client({ name: "another-host", version: "1.0.0" });
    await other.connect(new StreamableHTTPClientTransport(new URL(MCP_PATH, srv.listenUrl), { fetch: caller.fetch }));
    const r = await other.callTool({
      name: "gate_evaluate",
      arguments: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: 1 }, mandate: { max_amount_cents: 5, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"] } },
    });
    assert.equal(r.structuredContent.decision, "approved");
    await other.close();
  });

  test("an unsigned MCP client is refused at the door", async () => {
    const unsigned = new Client({ name: "stranger", version: "1.0.0" });
    await assert.rejects(
      () => unsigned.connect(new StreamableHTTPClientTransport(new URL(MCP_PATH, srv.listenUrl))),
      /unauthorized.*not signed/,
    );
  });

  test("a signed GET on the stateless endpoint is 405, not a hang", async () => {
    const res = await caller.fetch(new URL(MCP_PATH, srv.listenUrl), { method: "GET", headers: { accept: "text/event-stream" } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});
