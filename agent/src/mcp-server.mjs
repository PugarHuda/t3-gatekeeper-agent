#!/usr/bin/env node
// The Gatekeeper as an MCP server — this is how the agent gets distributed.
//
// The bounty asks for an agent "we can distribute / host". A repo you clone is
// not distribution. An MCP server is: any host that speaks Model Context
// Protocol — Claude Code, Claude Desktop, an agent framework — adds one line of
// config and gets a mandate gate it did not have to build, understand, or trust
// blindly, because the answers come from the compiled contract rather than from
// this file.
//
//   claude mcp add gatekeeper -- node /path/to/agent/src/mcp-server.mjs
//
// Two properties are worth being explicit about:
//
//   * `gate_evaluate` runs the REAL Rust `decide()` (via gate_cli, the host
//     build of the same source the enclave runs). It costs nothing, needs no
//     key, and works offline — so a host can ask "would this be allowed?" on
//     every action without a network round trip or a funded account.
//   * `gate_execute` is the enclave path. It needs credentials and credits, and
//     it says so rather than degrading into a local approximation. A gate that
//     silently falls back to a local guess is not a gate.
//
// STDIO FOOTGUN: stdout is the protocol channel. A stray console.log corrupts
// the JSON-RPC stream and the client disconnects with a parse error that names
// nothing. Everything human-readable goes to stderr — which the 2026-07-28 spec
// now names as the recommended logging path for stdio servers.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { decide, gateCliPath, BUILD_HINT, CONTRACT_VERSION } from "./gate-cli.mjs";
import { decideWith } from "./engine.mjs";
import { discoverPeer } from "./a2a.mjs";
import { checkStatus, statusEntry, STATUS_LIST_URL } from "./status-list.mjs";
import { resolveAgent, preflight, DEFAULT_NETWORK } from "./erc8004.mjs";

const CARD = JSON.parse(readFileSync(new URL("../agent-card.json", import.meta.url), "utf8"));

// ── shapes ──────────────────────────────────────────────────────────────────
// These mirror `gate::Action` and `gate::Mandate` exactly. They are the schema
// the host's model reads to decide how to call the tool, so the descriptions
// matter as much as the types.
const actionShape = {
  kind: z.string().describe('What is being done, e.g. "rwa.buy". Matched against the mandate\'s allowed_kinds.'),
  asset: z.string().optional().describe('Asset symbol, e.g. "USDC".'),
  amount_cents: z.number().int().optional().describe("Amount in cents. Integer — there are no fractional cents in a mandate."),
  counterparty: z.string().optional().describe("Who is being paid. Checked against allowed_counterparties and counterparty_limits."),
  issuer: z.string().optional().describe("DID of the credential issuer the caller verified against. Checked against allowed_issuers."),
};

// `max_amount_cents` is the one field the Rust struct has no default for, so a
// mandate without it is not a permissive mandate — it is not a mandate. Requiring
// it here turns that into a schema error the host can read instead of a
// deserialisation error from a subprocess.
const mandateShape = {
  max_amount_cents: z.number().int().nonnegative().describe("Ceiling in cents. Required. 0 means nothing is approvable."),
  allowed_assets: z.array(z.string()).optional(),
  allowed_kinds: z.array(z.string()).optional(),
  allowed_counterparties: z.array(z.string()).optional().describe("Empty = not enforced. Non-empty = deny-by-default."),
  counterparty_limits: z.record(z.string(), z.number().int()).optional().describe("Per-payee sub-limit, applied in addition to max_amount_cents. It can only tighten the global cap, never widen it."),
  allowed_issuers: z.array(z.string()).optional().describe("Which KYC issuers this mandate trusts. Empty = not enforced, which means the caller may mint its own eligibility."),
  expires_at_secs: z.number().int().optional(),
  valid_after_secs: z.number().int().optional(),
  require_credential: z.boolean().optional(),
  require_idempotency_key: z.boolean().optional(),
};

/**
 * Build a fresh server with every tool and resource registered.
 *
 * A factory rather than a singleton because the Streamable HTTP transport in
 * its stateless form pairs one server with one transport per request; stdio
 * builds one and keeps it. Both call this.
 */
export function createMcpServer() {
const server = new McpServer(
  { name: "gatekeeper", version: CONTRACT_VERSION },
  {
    instructions:
      "Gatekeeper enforces a spending mandate on an agent's actions. Call gate_evaluate " +
      "BEFORE taking any financial action to find out whether it is within mandate — it is " +
      "free, offline, and runs the same compiled logic as the hardware enclave. Call " +
      "gate_execute only when the action should actually happen; it requires Terminal 3 " +
      "credentials and spends credits.",
  },
);

// ── gate_evaluate ───────────────────────────────────────────────────────────
// Which engine decides is engine.mjs's business; see there for the two.
server.registerTool(
  "gate_evaluate",
  {
    title: "Evaluate an action against a mandate",
    description:
      "Decide whether an action is inside a spending mandate, using the contract's own compiled " +
      "logic: gate_cli (the Rust host build of the enclave's decide()) or the registered wasm " +
      "component itself, hosted in JavaScript. Offline, free, and no credentials needed. Returns " +
      "the decision, a machine-readable reason for every rule that refused, and which engine " +
      "answered. An empty mandate approves nothing.",
    inputSchema: {
      action: z.object(actionShape),
      mandate: z.object(mandateShape),
      now_secs: z.number().int().optional().describe("Unix seconds to evaluate at. Defaults to now; pass one to test a time window deterministically."),
      credential: z.record(z.string(), z.unknown()).optional().describe("Credential binding from bind_credential. Required when the mandate sets require_credential."),
      idempotency_key: z.string().optional(),
      engine: z.enum(["auto", "gate_cli", "component"]).optional()
        .describe("auto (default) uses gate_cli when built, else the wasm component. gate_cli is required for credential/idempotency checks."),
    },
    outputSchema: {
      decision: z.enum(["approved", "rejected"]),
      reasons: z.array(z.string()),
      action_digest: z.string().optional(),
      expected_commitment: z.string().nullable().optional(),
      now_secs: z.number().int(),
      engine: z.enum(["gate_cli", "component"]),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    const out = await decideWith(args);
    const verdict = out.decision === "approved"
      ? "APPROVED — inside mandate."
      : `REJECTED — ${out.reasons.join("; ")}`;
    return { content: [{ type: "text", text: verdict }], structuredContent: out };
  },
);

// ── bind_credential ─────────────────────────────────────────────────────────
// Exposed because gate_evaluate's `require_credential` is unusable without it,
// and because the commitment is the one part a caller must not guess at.
server.registerTool(
  "bind_credential",
  {
    title: "Bind a verified credential to one action",
    description:
      "Commit to which credential was verified AND which action it was verified for. The enclave " +
      "recomputes this from the action it is about to perform and refuses if they differ, so a " +
      "credential checked for a $500 purchase cannot authorise a $500,000 one. Only call this " +
      "after the credential's proof actually verified — it is an assertion, not a check.",
    inputSchema: {
      issuer: z.string().describe("DID of the issuer that signed the credential."),
      subject: z.string().describe("DID of the credential's holder."),
      claims: z.record(z.string(), z.unknown()).describe("The claims that were verified. Digested, never sent to the enclave in the clear."),
      action: z.object(actionShape),
      verified: z.literal(true).describe("You are asserting the proof verified. Passing anything else is refused."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ issuer, subject, claims, action, verified }) => {
    const { bindCredential } = await import("./credential-binding.mjs");
    const binding = bindCredential({ issuer, subject, claims, verified }, action);
    return {
      content: [{ type: "text", text: `commitment ${binding.commitment}` }],
      structuredContent: binding,
    };
  },
);

// ── check_credential_status ─────────────────────────────────────────────────
server.registerTool(
  "check_credential_status",
  {
    title: "Check a credential's revocation status",
    description:
      "Look up one entry in a W3C Bitstring Status List v1.0 over HTTPS. Answers three ways — " +
      "revoked, not revoked, or could not check — and never turns the third into the second. " +
      "The list holds 131,072 entries, so fetching it reveals nothing about which holder is asking.",
    inputSchema: {
      statusListIndex: z.number().int().nonnegative().describe("The holder's index in the list."),
      statusListCredential: z.string().url().optional().describe(`URL of the status list. Defaults to this agent's published list (${STATUS_LIST_URL}).`),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ statusListIndex, statusListCredential }) => {
    const entry = statusEntry({
      statusListCredential: statusListCredential ?? STATUS_LIST_URL,
      statusListIndex,
    });
    const res = await checkStatus(entry);
    const text = res.checked
      ? res.revoked ? `REVOKED (index ${statusListIndex})` : `not revoked (index ${statusListIndex})`
      : `COULD NOT CHECK — ${res.reason}. Treat this as unknown, not as valid.`;
    return { content: [{ type: "text", text }], structuredContent: res };
  },
);

// ── discover_agent ──────────────────────────────────────────────────────────
server.registerTool(
  "discover_agent",
  {
    title: "Discover an A2A peer from its domain",
    description:
      "Fetch and validate a peer agent's card at /.well-known/agent-card.json. Needs only the " +
      "origin — nothing shared in advance. Reports which required fields are missing rather than " +
      "failing later on an undefined.",
    inputSchema: { origin: z.string().url().describe("Origin, e.g. https://example.com, or a full card URL.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ origin }) => {
    const { url, card, valid, problems, warnings } = await discoverPeer(origin);
    const text = valid
      ? `${card.name} v${card.version} — ${(card.skills ?? []).length} skill(s)${warnings.length ? `; warnings: ${warnings.join(", ")}` : ""}`
      : `card at ${url} is not usable: ${problems.join(", ")}`;
    return { content: [{ type: "text", text }], structuredContent: { url, valid, problems, warnings, card } };
  },
);

// ── resolve_erc8004_agent ───────────────────────────────────────────────────
server.registerTool(
  "resolve_erc8004_agent",
  {
    title: "Resolve an ERC-8004 agent on-chain",
    description:
      "Read an agent's owner and agentURI from an ERC-8004 Trustless Agents identity registry. " +
      "A live chain read — no gas, no wallet. Defaults to the reference registry on Sepolia.",
    inputSchema: {
      agentId: z.union([z.number().int().nonnegative(), z.string()]).describe("The agent's ERC-721 token id."),
      network: z.string().optional().describe(`Registry key. Default ${DEFAULT_NETWORK}.`),
      rpc: z.string().url().optional().describe("Override the RPC endpoint."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ agentId, network, rpc }) => {
    const info = await resolveAgent(agentId, { network, rpc });
    if (info === null) {
      return {
        content: [{ type: "text", text: `agent ${agentId} is not minted in this registry.` }],
        structuredContent: { agentId: String(agentId), minted: false },
      };
    }
    return {
      content: [{ type: "text", text: `agent ${agentId}: owner ${info.owner}, uri ${info.uri || "(none)"}` }],
      structuredContent: { ...info, minted: true },
    };
  },
);

// ── check_erc8004_registry ──────────────────────────────────────────────────
server.registerTool(
  "check_erc8004_registry",
  {
    title: "Preflight an ERC-8004 registry before spending gas",
    description:
      "Verify that an address actually holds a Trustless Agents registry — code deployed, name " +
      "readable, and register(string) present in the bytecode — BEFORE a mint sends a transaction " +
      "to it. This is the check that stops gas being burned registering into a token contract.",
    inputSchema: {
      network: z.string().optional(),
      rpc: z.string().url().optional(),
      address: z.string().optional().describe("Registry address to check. Defaults to the network's reference registry."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ network, rpc, address }) => {
    const report = await preflight({ network, rpc, address });
    const failed = report.checks.filter((c) => !c.pass);
    const text = report.ok
      ? `OK — ${JSON.stringify(report.name)} at ${report.address} implements register(string).`
      : `NOT a usable registry (${report.address}): ${failed.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
    return { content: [{ type: "text", text }], structuredContent: report };
  },
);

// ── fetch_paid_resource ─────────────────────────────────────────────────────
// The reason this tool is interesting: an MCP host that can pay for things is a
// host that can be talked into paying for the wrong things. Here the price, the
// payee and the asset go through the mandate before a signature exists.
server.registerTool(
  "fetch_paid_resource",
  {
    title: "Fetch a resource that costs money (x402), with the mandate deciding",
    description:
      "GET a URL. If it answers HTTP 402, read the x402 payment requirement, turn it into an " +
      "action (kind x402.pay, the payee as counterparty), and ask the mandate. Only on approval " +
      "is an EIP-3009 authorisation signed and the request retried. A mandate that does not list " +
      "x402.pay refuses every paywall, and a payee it does not list is refused before anything " +
      "is signed. Signing needs X402_PRIVATE_KEY; settlement additionally needs " +
      "X402_FACILITATOR_URL and a funded wallet, and is never faked.",
    inputSchema: {
      url: z.string().url(),
      mandate: z.object(mandateShape).describe("Must list \"x402.pay\" in allowed_kinds, or every paywall is refused."),
      network: z.string().optional().describe("Restrict to one CAIP-2 network, e.g. eip155:84532."),
      decimals: z.number().int().optional().describe("Token decimals, when the requirement does not declare them. Without either, the price is refused rather than guessed."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ url, mandate, network, decimals }) => {
    const { fetchWithMandate, loadPaymentWallet } = await import("./x402.mjs");
    const r = await fetchWithMandate(url, {
      decide: (action) => decide({ action, mandate }),
      wallet: loadPaymentWallet(),
      network,
      decimals,
    });

    if (!r.paid && r.decision) {
      return {
        content: [{ type: "text", text: `NOT PAID — the mandate refused: ${r.decision.reasons.join("; ")}` }],
        structuredContent: { paid: false, action: r.action, reasons: r.decision.reasons, status: r.response.status },
      };
    }
    const body = await r.response.text();
    return {
      content: [{
        type: "text",
        text: r.paid
          ? `PAID ${r.action.amount_cents}¢ in ${r.action.asset} to ${r.action.counterparty} → HTTP ${r.response.status}\n${body.slice(0, 2000)}`
          : `HTTP ${r.response.status} — nothing was charged.\n${body.slice(0, 2000)}`,
      }],
      structuredContent: {
        paid: r.paid,
        status: r.response.status,
        action: r.action ?? null,
        receipt: r.receipt ?? null,
        settlement: r.settlement ?? null,
      },
    };
  },
);

// ── gate_execute ────────────────────────────────────────────────────────────
// The live path. Kept last because everything above it works with no account.
server.registerTool(
  "gate_execute",
  {
    title: "Execute an action inside the enclave",
    description:
      "Run the action for real: the Terminal 3 enclave reads the mandate from its own KV (the " +
      "caller CANNOT supply one), decides, and — only on approval — performs the outbound HTTP " +
      "call itself, in the same invocation. A rejected action never reaches the network. Needs " +
      "T3N_API_KEY and DID in agent/.env and a funded account; refuses clearly when either is " +
      "missing rather than pretending.",
    inputSchema: {
      action: z.object(actionShape),
      url: z.string().url().describe("Destination of the approved action. Must be covered by an egress grant."),
      method: z.string().optional().describe("HTTP method. Default POST."),
      body: z.string().optional().describe("Request body. A body containing {{profile.*}} markers is routed through http-with-placeholders so the host substitutes the data and this process never sees it."),
      credential: z.record(z.string(), z.unknown()).describe("Binding from bind_credential."),
      idempotency_key: z.string().describe("Caller-chosen key. Retrying with the same key replays the recorded outcome instead of placing a second order — so it belongs to the ORDER, not to the request."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ action, url, method = "POST", body, credential, idempotency_key }) => {
    let tenant, CONTRACT_TAIL, executeContract;
    try {
      const lib = await import("./lib.mjs");
      ({ CONTRACT_TAIL, executeContract } = lib);
      ({ tenant } = await lib.connect(new URL("../.env", import.meta.url)));
    } catch (e) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            `Cannot reach the enclave: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 200)}\n` +
            "This tool needs T3N_API_KEY and DID in agent/.env (see .env.example). " +
            "Use gate_evaluate for a decision that needs neither.",
        }],
      };
    }

    const r = await executeContract(
      tenant,
      CONTRACT_TAIL,
      {
        version: CONTRACT_VERSION,
        functionName: "execute_action",
        input: { action, url, method, body: body ?? JSON.stringify(action), credential, idempotency_key },
      },
      // stdout is the JSON-RPC channel — the quota notice must not land there.
      { log: (m) => process.stderr.write(`${m}\n`) },
    );
    const resp = r.response ?? {};
    const text = r.decision === "approved"
      ? `APPROVED (mandate_source=${r.mandate_source}) dispatched=${r.dispatched} → ${resp.ok ? `HTTP ${resp.code}` : `egress gated: ${resp.error}`}`
      : `REJECTED (mandate_source=${r.mandate_source}) — ${r.reasons.join("; ")}. The enclave never made the call.`;
    return { content: [{ type: "text", text }], structuredContent: r };
  },
);

// ── resources ───────────────────────────────────────────────────────────────
server.registerResource(
  "agent-card",
  "gatekeeper://agent-card",
  {
    title: "A2A agent card",
    description: "This agent's A2A / ERC-8004 card: identity, skills, trust model, registrations.",
    mimeType: "application/json",
  },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(CARD, null, 2) }] }),
);

server.registerResource(
  "gate-status",
  "gatekeeper://status",
  {
    title: "Gate status",
    description: "Whether the offline decision path is usable right now, and which contract version it speaks.",
    mimeType: "application/json",
  },
  async (uri) => {
    const exe = gateCliPath();
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          contractVersion: CONTRACT_VERSION,
          offlineDecisions: exe ? "ready" : "unavailable",
          gateCli: exe ?? null,
          buildHint: exe ? null : BUILD_HINT,
          liveDispatch: "needs T3N_API_KEY + DID in agent/.env and a funded account",
        }, null, 2),
      }],
    };
  },
);

return server;
}

// ── transport ───────────────────────────────────────────────────────────────
// Only when run as a program. Importing this module gives you the factory
// without hijacking the process's stdio.

if (process.argv[1]?.endsWith("mcp-server.mjs")) {
  if (!gateCliPath()) {
    process.stderr.write(`gatekeeper mcp: gate_cli is not built — gate_evaluate will fail.\n  ${BUILD_HINT}\n`);
  }
  await createMcpServer().connect(new StdioServerTransport());
  process.stderr.write(`gatekeeper mcp: ready on stdio (contract ${CONTRACT_VERSION})\n`);
}
