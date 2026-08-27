// The Gatekeeper as an A2A agent — v1.0 of the protocol, on the official SDK.
//
//   npm run a2a                     # serve on A2A_PORT (default 41241)
//   A2A_BASE_URL=https://… npm run a2a
//
// Our agent card has advertised "A2A" since June. Until now that meant the
// card was the right SHAPE: a peer could discover us and read our skills, and
// then had nothing to send a message to. This is the other half — a JSON-RPC
// endpoint that any A2A client can talk to, serving the same decision the MCP
// server and the QA console serve: the contract's own compiled `decide()`.
//
// Two things a peer gets from this that a shape does not:
//
//   * A task it can watch. A2A wraps every request in a Task with a lifecycle
//     (submitted → working → completed | failed), so a caller that fires off
//     "may I buy this?" gets an id, a state, and an artifact carrying the
//     verdict — not a bare JSON blob it has to interpret.
//   * The same refusals as everywhere else. A malformed request fails the task
//     with a reason. A rejected action COMPLETES the task with decision
//     "rejected" — being told no is a successful answer, not an error.
//
// The v1.0 card is generated from agent/agent-card.json rather than kept as a
// second hand-edited file: the card the site serves and the card this server
// serves must describe the same agent, and a test asserts the skills match.
import express from "express";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, Role, TaskState } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";

import { decide, gateCliPath, BUILD_HINT, CONTRACT_VERSION } from "./gate-cli.mjs";
import { bindCredential } from "./credential-binding.mjs";

const SOURCE_CARD = JSON.parse(readFileSync(new URL("../agent-card.json", import.meta.url), "utf8"));

/**
 * The v1.0 AgentCard, derived from the published card.
 *
 * `baseUrl` is where THIS process is reachable — the one thing the static card
 * cannot know, and the one field an A2A client actually dereferences.
 */
export function buildAgentCard(baseUrl) {
  return {
    name: SOURCE_CARD.name,
    description: SOURCE_CARD.description,
    version: SOURCE_CARD.version,
    documentationUrl: SOURCE_CARD.url,
    provider: SOURCE_CARD.provider
      ? { organization: SOURCE_CARD.provider.organization, url: SOURCE_CARD.provider.url }
      : undefined,
    supportedInterfaces: [{
      url: baseUrl,
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
      tenant: "",
    }],
    capabilities: { streaming: false, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    // Same skill ids, names and tags as the published card — a peer that
    // discovered us through the static card must find the same agent here.
    skills: SOURCE_CARD.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags ?? [],
      examples: s.examples ?? [],
      inputModes: s.inputModes ?? ["application/json"],
      outputModes: s.outputModes ?? ["application/json"],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

// ── reading a request ────────────────────────────────────────────────────────

/** Pull the structured request out of a Message, whichever part carries it. */
export function requestFromMessage(message) {
  for (const part of message?.parts ?? []) {
    const c = part?.content;
    if (c?.$case === "data" && c.value && typeof c.value === "object") return c.value;
    if (c?.$case === "text" && typeof c.value === "string") {
      try { return JSON.parse(c.value); } catch { /* not JSON — keep looking */ }
    }
    // Wire-shaped parts, in case a client hands us proto-JSON directly.
    if (part?.data && typeof part.data === "object") return part.data;
    if (typeof part?.text === "string") {
      try { return JSON.parse(part.text); } catch { /* same */ }
    }
  }
  return null;
}

const dataPart = (value) => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });
const textPart = (value) => ({ content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" });

const agentMessage = (contextId, taskId, parts) => ({
  messageId: randomUUID(), contextId, taskId, role: Role.ROLE_AGENT,
  parts, metadata: undefined, extensions: [], referenceTaskIds: [],
});

// ── the executor ─────────────────────────────────────────────────────────────

/**
 * One skill in, one verdict out.
 *
 * Request shape (as a data part, or JSON in a text part):
 *   { skill?: "evaluate-gated-action" | "bind-credential",
 *     action, mandate, now_secs?, credential?, idempotency_key? }
 */
export class GatekeeperExecutor {
  async execute(ctx, bus) {
    const { taskId, contextId } = ctx;
    const status = (state, parts) => ({
      taskId, contextId, metadata: undefined,
      status: { state, message: parts ? agentMessage(contextId, taskId, parts) : undefined, timestamp: new Date().toISOString() },
    });

    bus.publish(AgentEvent.task({
      id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [], history: [ctx.userMessage], metadata: undefined,
    }));

    const req = requestFromMessage(ctx.userMessage);
    if (!req) {
      bus.publish(AgentEvent.statusUpdate(status(TaskState.TASK_STATE_FAILED,
        [textPart("no request found: send a data part (or JSON text) with { action, mandate }")])));
      return bus.finished();
    }

    bus.publish(AgentEvent.statusUpdate(status(TaskState.TASK_STATE_WORKING)));

    try {
      const skill = req.skill ?? "evaluate-gated-action";
      let result;
      if (skill === "bind-credential") {
        // The caller is asserting it verified a credential. Same rule as the
        // MCP tool: `verified` must be literally true, and it is their claim.
        result = bindCredential(
          { issuer: req.issuer, subject: req.subject, claims: req.claims ?? {}, verified: req.verified },
          req.action,
        );
      } else if (skill === "evaluate-gated-action") {
        if (!req.action?.kind) throw new Error("action.kind is required");
        if (!req.mandate || typeof req.mandate.max_amount_cents !== "number") {
          throw new Error("mandate.max_amount_cents is required — a mandate with no ceiling is not a mandate");
        }
        result = await decide({
          action: req.action, mandate: req.mandate, now_secs: req.now_secs,
          credential: req.credential ?? null, idempotency_key: req.idempotency_key ?? null,
        });
        if (result?.error) throw new Error(result.error);
      } else {
        throw new Error(`unknown skill '${skill}'`);
      }

      const summary = result.decision
        ? (result.decision === "approved" ? "APPROVED — inside mandate." : `REJECTED — ${result.reasons.join("; ")}`)
        : `commitment ${result.commitment}`;

      bus.publish(AgentEvent.artifactUpdate({
        taskId, contextId, append: false, lastChunk: true, metadata: undefined,
        artifact: {
          artifactId: randomUUID(), name: skill, description: summary,
          parts: [dataPart(result)], metadata: undefined, extensions: [],
        },
      }));
      // A refusal is a complete, correct answer. Only a request we could not
      // evaluate at all is a failure.
      bus.publish(AgentEvent.statusUpdate(status(TaskState.TASK_STATE_COMPLETED, [textPart(summary)])));
    } catch (e) {
      bus.publish(AgentEvent.statusUpdate(status(TaskState.TASK_STATE_FAILED,
        [textPart(String(e?.message ?? e).slice(0, 300))])));
    }
    bus.finished();
  }

  async cancelTask(taskId, bus) {
    // Decisions are synchronous and finish in milliseconds; there is nothing
    // in flight to cancel. Say so rather than pretend.
    bus.publish(AgentEvent.statusUpdate({
      taskId, contextId: "", metadata: undefined,
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
    }));
    bus.finished();
  }
}

// ── the app ──────────────────────────────────────────────────────────────────

/** Build the express app. `baseUrl` is what the card advertises. */
export function createApp(baseUrl) {
  const requestHandler = new DefaultRequestHandler(
    buildAgentCard(baseUrl), new InMemoryTaskStore(), new GatekeeperExecutor(),
  );
  const app = express();
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  return app;
}

/**
 * Listen on `port` (0 = any free).
 *
 * Resolves with `{ server, listenUrl, baseUrl, close }`. `listenUrl` is where
 * the socket actually is; `baseUrl` is what the card ADVERTISES — the same
 * thing unless `advertise` is set, which is what a deployment behind a proxy
 * or a tunnel needs. Keep the two apart: a caller that forwards traffic to
 * "the server's URL" and is handed the advertised one forwards to itself.
 */
export function start(port = 0, { host = "127.0.0.1", advertise } = {}) {
  return new Promise((resolve, reject) => {
    // The card must advertise a URL, so the app is built AFTER the port is known.
    const server = express().listen(port, host, () => {
      const listenUrl = `http://${host}:${server.address().port}/`;
      const baseUrl = advertise ?? listenUrl;
      const app = createApp(baseUrl);
      server.removeAllListeners("request");
      server.on("request", app);
      resolve({ server, listenUrl, baseUrl, close: () => new Promise((r) => server.close(r)) });
    });
    server.on("error", reject);
  });
}

if (process.argv[1]?.endsWith("a2a-server.mjs")) {
  if (!gateCliPath()) {
    console.error(`gate_cli is not built — evaluate-gated-action will fail every task.\n  ${BUILD_HINT}`);
  }
  const port = Number(process.env.A2A_PORT || 41241);
  const { baseUrl } = await start(port, { host: "0.0.0.0", advertise: process.env.A2A_BASE_URL });
  console.log(`gatekeeper a2a: contract ${CONTRACT_VERSION}, protocol ${A2A_PROTOCOL_VERSION}`);
  console.log(`  card      ${baseUrl}${AGENT_CARD_PATH}`);
  console.log(`  json-rpc  ${baseUrl}`);
}
