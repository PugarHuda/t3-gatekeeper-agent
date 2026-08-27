// The MCP server, exercised the way a host actually reaches it: a real client
// from the official SDK, spawning the server as a subprocess, speaking JSON-RPC
// over stdio. Nothing here calls the tool functions directly — a test that did
// would prove the functions work and say nothing about whether the server does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gateCliPath, CONTRACT_VERSION } from "../src/gate-cli.mjs";

const SERVER = fileURLToPath(new URL("../src/mcp-server.mjs", import.meta.url));

/** Connect a client to a freshly spawned server; hand it back with its cleanup. */
async function connectClient(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, ...env },
    // The server writes its readiness line to stderr. Inherit so a crash during
    // startup shows up in the test output instead of as a silent timeout.
    stderr: "inherit",
  });
  const client = new Client({ name: "gatekeeper-test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

const need = () => (gateCliPath() ? false : "gate_cli is not built");

test("MCP server", async (t) => {
  const { client, close } = await connectClient();
  t.after(close);

  await t.test("it handshakes and names itself after the contract it speaks for", () => {
    const info = client.getServerVersion();
    assert.equal(info.name, "gatekeeper");
    assert.equal(info.version, CONTRACT_VERSION);
  });

  await t.test("it advertises the tools a host needs, with schemas", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const name of [
      "gate_evaluate", "bind_credential", "check_credential_status",
      "discover_agent", "resolve_erc8004_agent", "check_erc8004_registry",
      "fetch_paid_resource", "gate_execute",
    ]) {
      assert.ok(byName[name], `missing tool ${name}`);
      assert.equal(byName[name].inputSchema?.type, "object", `${name} has no object input schema`);
      assert.ok(byName[name].description?.length > 40, `${name} has no usable description`);
    }
    // The one that moves money must not be advertised as safe to call freely.
    assert.equal(byName.gate_execute.annotations?.readOnlyHint, false);
    assert.equal(byName.gate_evaluate.annotations?.readOnlyHint, true);
  });

  await t.test("it exposes its card and its own readiness as resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    assert.ok(uris.includes("gatekeeper://agent-card"));
    assert.ok(uris.includes("gatekeeper://status"));

    const status = JSON.parse((await client.readResource({ uri: "gatekeeper://status" })).contents[0].text);
    assert.equal(status.contractVersion, CONTRACT_VERSION);
    assert.equal(status.offlineDecisions, gateCliPath() ? "ready" : "unavailable");

    const card = JSON.parse((await client.readResource({ uri: "gatekeeper://agent-card" })).contents[0].text);
    assert.equal(card.name, "Gatekeeper Agent");
  });

  await t.test("gate_evaluate approves an in-mandate action", { skip: need() }, async () => {
    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: {
        action: { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 },
        mandate: { max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 },
      },
    });
    assert.equal(r.structuredContent.decision, "approved");
    assert.deepEqual(r.structuredContent.reasons, []);
    assert.match(r.content[0].text, /APPROVED/);
  });

  await t.test("gate_evaluate refuses over the cap and says which rule refused", { skip: need() }, async () => {
    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: {
        action: { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 },
        mandate: { max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 },
      },
    });
    assert.equal(r.structuredContent.decision, "rejected");
    assert.ok(r.structuredContent.reasons.some((x) => /amount/i.test(x)), r.structuredContent.reasons.join(","));
  });

  await t.test("a mandate that allows nothing approves nothing", { skip: need() }, async () => {
    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: 1 }, mandate: { max_amount_cents: 0 } },
    });
    assert.equal(r.structuredContent.decision, "rejected");
  });

  await t.test("a mandate with no ceiling at all is a schema error, not a permit", async () => {
    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: { action: { kind: "rwa.buy", asset: "USDC", amount_cents: 1 }, mandate: {} },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /max_amount_cents/);
  });

  await t.test("the decision comes from the compiled Rust, not from this process", { skip: need() }, async () => {
    // Same input, both paths. If someone ever reimplements the rules in JS to
    // make the server faster, these stop agreeing.
    const { decide } = await import("../src/gate-cli.mjs");
    const args = {
      action: { kind: "rwa.buy", asset: "USDC", amount_cents: 250_000, counterparty: "did:t3n:acme" },
      mandate: {
        max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"],
        allowed_counterparties: ["did:t3n:acme"], counterparty_limits: { "did:t3n:acme": 10_000 },
        expires_at_secs: 0,
      },
      now_secs: 1_786_000_000,
    };
    const direct = await decide(args);
    const viaMcp = (await client.callTool({ name: "gate_evaluate", arguments: args })).structuredContent;
    assert.deepEqual(viaMcp, direct);
    assert.equal(direct.decision, "rejected"); // the sub-limit binds under the global cap
  });

  await t.test("bind_credential produces the commitment the enclave will recompute", { skip: need() }, async () => {
    const action = { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 };
    const bound = (await client.callTool({
      name: "bind_credential",
      arguments: {
        issuer: "did:key:kyc-provider", subject: "did:t3n:investor",
        claims: { accreditedInvestor: true }, action, verified: true,
      },
    })).structuredContent;

    // Feed it back through the gate with a mandate that demands one.
    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: {
        action,
        mandate: {
          max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"],
          expires_at_secs: 0, require_credential: true,
        },
        credential: bound,
      },
    });
    assert.equal(r.structuredContent.decision, "approved");
    assert.equal(r.structuredContent.expected_commitment, bound.commitment);
  });

  await t.test("a credential bound to a smaller action cannot pay a bigger one", { skip: need() }, async () => {
    const bound = (await client.callTool({
      name: "bind_credential",
      arguments: {
        issuer: "did:key:kyc-provider", subject: "did:t3n:investor",
        claims: { accreditedInvestor: true },
        action: { kind: "rwa.buy", asset: "USDC", amount_cents: 50_000 },
        verified: true,
      },
    })).structuredContent;

    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: {
        action: { kind: "rwa.buy", asset: "USDC", amount_cents: 400_000 }, // the bigger one
        mandate: {
          max_amount_cents: 500_000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"],
          expires_at_secs: 0, require_credential: true,
        },
        credential: bound,
      },
    });
    assert.equal(r.structuredContent.decision, "rejected");
    assert.ok(r.structuredContent.reasons.some((x) => /binding|commitment/i.test(x)), r.structuredContent.reasons.join(","));
  });

  await t.test("bind_credential refuses to bind an unverified credential", async () => {
    // `verified` is z.literal(true) — the schema itself is the refusal, so this
    // fails before any code runs, and the host is told which field was wrong.
    const r = await client.callTool({
      name: "bind_credential",
      arguments: {
        issuer: "did:key:x", subject: "did:t3n:y", claims: {},
        action: { kind: "rwa.buy" }, verified: false,
      },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /verified/);
  });

  await t.test("an action with no kind is refused by the schema, not decided on", async () => {
    const r = await client.callTool({
      name: "gate_evaluate",
      arguments: { action: {}, mandate: { max_amount_cents: 1 } },
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /kind/i);
    assert.equal(r.structuredContent, undefined); // no decision was produced
  });

  await t.test("an unknown tool is refused by name", async () => {
    const r = await client.callTool({ name: "gate_drop_all_limits", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /gate_drop_all_limits|not found|unknown/i);
  });

  await t.test("gate_execute reports the missing account instead of degrading", async () => {
    // Without T3N_API_KEY/DID this must say so. The failure mode it exists to
    // avoid is answering "approved" from a local approximation when the enclave
    // was never reached.
    const r = await client.callTool({
      name: "gate_execute",
      arguments: {
        action: { kind: "rwa.buy", asset: "USDC", amount_cents: 1 },
        url: "https://broker.example/v1/orders",
        credential: { commitment: "00" }, idempotency_key: "order-test",
      },
    });
    if (r.isError) {
      // Either the account is not configured (the tool says so and points at
      // gate_evaluate), or it IS configured and the enclave refused this call —
      // a real error from the network. Both are honest; a local "approved" is
      // the thing that must never happen.
      assert.match(r.content[0].text, /gate_evaluate|T3N_API_KEY|enclave|RPC Error|contract error/i);
      assert.doesNotMatch(r.content[0].text, /^APPROVED/);
    } else {
      // An account IS configured here — then it must have really reached the
      // enclave, which means a decision, not a local guess.
      assert.ok(["approved", "rejected"].includes(r.structuredContent.decision));
    }
  });
});

// ── paying for a resource, through MCP ──────────────────────────────────────
//
// A separate server process, because this one needs a payment key in its
// environment. The paywall is a real HTTP server in THIS process, so the
// subprocess really has to fetch it, really gets a 402, and really signs.
test("MCP server — x402", async (t) => {
  const { createServer } = await import("node:http");
  const { ethers } = await import("ethers");
  const x402 = await import("../src/x402.mjs");

  const wallet = ethers.Wallet.createRandom();
  const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
  const REQUIREMENT = {
    scheme: "exact", network: "eip155:84532", amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: PAY_TO, maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", decimals: 6 },
  };

  let payerSeen = null;
  const server = createServer((req, res) => {
    const payment = x402.readPaymentHeader(req.headers);
    if (!payment) {
      const { status, headers, body } = x402.paymentRequired({ accepts: [REQUIREMENT] });
      res.writeHead(status, headers);
      return res.end(JSON.stringify(body));
    }
    const v = x402.verifyPayment(payment, REQUIREMENT);
    if (!v.isValid) { res.writeHead(402); return res.end(JSON.stringify({ error: v.invalidReason })); }
    payerSeen = v.payer;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ quote: "MERIDIAN-PC-2026" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/quote`;
  t.after(() => new Promise((r) => server.close(r)));

  const { client, close } = await connectClient({ X402_PRIVATE_KEY: wallet.privateKey });
  t.after(close);

  const mandate = {
    max_amount_cents: 500, allowed_assets: ["USDC"], allowed_kinds: ["x402.pay"],
    allowed_counterparties: [PAY_TO], expires_at_secs: 0,
  };

  await t.test("an in-mandate paywall is paid and the payer is the signing wallet", { skip: need() }, async () => {
    const r = await client.callTool({ name: "fetch_paid_resource", arguments: { url, mandate } });
    assert.equal(r.structuredContent.paid, true, r.content[0].text);
    assert.equal(r.structuredContent.status, 200);
    assert.equal(r.structuredContent.action.kind, "x402.pay");
    assert.equal(r.structuredContent.action.amount_cents, 1);
    assert.equal(payerSeen, wallet.address);
    // Nothing was settled, and the tool does not claim otherwise.
    assert.equal(r.structuredContent.settlement, null);
  });

  await t.test("a mandate that does not allow x402.pay refuses the paywall", { skip: need() }, async () => {
    payerSeen = null;
    const r = await client.callTool({
      name: "fetch_paid_resource",
      arguments: { url, mandate: { ...mandate, allowed_kinds: ["rwa.buy"] } },
    });
    assert.equal(r.structuredContent.paid, false);
    assert.equal(r.structuredContent.status, 402);
    assert.ok(r.structuredContent.reasons.some((x) => x.includes("x402.pay")));
    assert.equal(payerSeen, null, "nothing should have been signed or sent");
  });

  await t.test("a payee outside the mandate is refused", { skip: need() }, async () => {
    payerSeen = null;
    const r = await client.callTool({
      name: "fetch_paid_resource",
      arguments: { url, mandate: { ...mandate, allowed_counterparties: ["0x0000000000000000000000000000000000000001"] } },
    });
    assert.equal(r.structuredContent.paid, false);
    assert.equal(payerSeen, null);
  });
});
