// The A2A server, driven by the official client over real HTTP.
//
// Nothing here calls the executor. A test that did would prove the executor
// works and say nothing about whether a peer — which only has our URL and the
// A2A SDK — can discover the card, pick a transport, send a message, and read
// a task back. That is the whole claim, so that is what is exercised.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

import { start, buildAgentCard, requestFromMessage } from "../src/a2a-server.mjs";
import { decide, gateCliPath } from "../src/gate-cli.mjs";
import { validateAgentCard } from "../src/a2a.mjs";

let srv, client;

before(async () => {
  srv = await start(0);
  // A peer's view: a URL, the SDK, nothing shared in advance.
  const factory = new ClientFactory({ ...ClientFactoryOptions.default, transports: [new JsonRpcTransportFactory()] });
  client = await factory.createFromUrl(srv.baseUrl);
});
after(() => srv?.close());

const need = () => (gateCliPath() ? false : "gate_cli is not built");

const MANDATE = {
  max_amount_cents: 500_000, allowed_assets: ["USDC", "USD"], allowed_kinds: ["rwa.buy"],
  allowed_counterparties: ["did:t3n:meridian-fund"], expires_at_secs: 0,
};

/** Send one request as a data part, the way an agent-to-agent caller would. */
async function ask(request) {
  const res = await client.sendMessage({
    tenant: "",
    message: {
      messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER,
      parts: [{ content: { $case: "data", value: request }, metadata: undefined, filename: "", mediaType: "application/json" }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  });
  // v1.0 returns the Task (or Message) itself, unwrapped. A Task has a
  // status; a Message does not.
  assert.ok(res?.id && res?.status, `expected a task, got ${JSON.stringify(res).slice(0, 120)}`);
  const task = res;
  const artifact = task.artifacts?.[0];
  const verdict = artifact?.parts?.find((p) => p.content?.$case === "data")?.content?.value ?? null;
  const note = task.status?.message?.parts?.find((p) => p.content?.$case === "text")?.content?.value ?? "";
  return { task, verdict, note };
}

describe("discovery, through the SDK", () => {
  test("the card the server serves is the card the SDK resolved", async () => {
    const card = await client.getAgentCard();
    assert.equal(card.name, "Gatekeeper Agent");
    assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
    assert.equal(card.supportedInterfaces[0].url, srv.baseUrl);
  });

  test("it advertises the same skills as the published static card", async () => {
    const served = (await client.getAgentCard()).skills.map((s) => s.id).sort();
    const published = buildAgentCard("http://x/").skills.map((s) => s.id).sort();
    assert.deepEqual(served, published);
    assert.ok(served.includes("evaluate-gated-action"));
  });

  test("and it passes the same validation we apply to other agents' cards", async () => {
    const report = validateAgentCard(await client.getAgentCard());
    assert.deepEqual(report.problems, []);
  });
});

describe("evaluate-gated-action, over A2A", () => {
  test("an in-mandate action completes the task with decision approved", { skip: need() }, async () => {
    const { task, verdict, note } = await ask({
      action: { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, counterparty: "did:t3n:meridian-fund" },
      mandate: MANDATE,
    });
    assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(verdict.decision, "approved");
    assert.deepEqual(verdict.reasons, []);
    assert.match(note, /APPROVED/);
  });

  test("an over-cap action COMPLETES with decision rejected — no is an answer, not an error", { skip: need() }, async () => {
    const { task, verdict, note } = await ask({
      action: { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000, counterparty: "did:t3n:meridian-fund" },
      mandate: MANDATE,
    });
    assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(verdict.decision, "rejected");
    assert.ok(verdict.reasons.some((r) => /exceeds mandate max/.test(r)));
    assert.match(note, /REJECTED/);
  });

  test("the verdict is the compiled contract's, not a reimplementation", { skip: need() }, async () => {
    const args = {
      action: { kind: "rwa.buy", asset: "USDC", amount_cents: 250_000, counterparty: "did:t3n:acme" },
      mandate: { ...MANDATE, allowed_counterparties: ["did:t3n:acme"], counterparty_limits: { "did:t3n:acme": 10_000 } },
      now_secs: 1_786_000_000,
    };
    const direct = await decide(args);
    const { verdict } = await ask(args);
    assert.deepEqual(verdict, direct);
    assert.equal(direct.decision, "rejected");
  });

  test("a request with no mandate ceiling FAILS the task and says why", async () => {
    const { task, verdict, note } = await ask({ action: { kind: "rwa.buy", amount_cents: 1 }, mandate: {} });
    assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    assert.equal(verdict, null, "no verdict may be produced from a mandate with no ceiling");
    assert.match(note, /max_amount_cents/);
  });

  test("a message carrying no request at all fails with instructions", async () => {
    const res = await client.sendMessage({
      tenant: "",
      message: {
        messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER,
        parts: [{ content: { $case: "text", value: "hello?" }, metadata: undefined, filename: "", mediaType: "text/plain" }],
        metadata: undefined, extensions: [], referenceTaskIds: [],
      },
      configuration: undefined, metadata: undefined,
    });
    const task = res;
    assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    const note = task.status.message.parts[0].content.value;
    assert.match(note, /action, mandate/);
  });

  test("a completed task can be read back by id", { skip: need() }, async () => {
    const { task } = await ask({ action: { kind: "rwa.buy", asset: "USDC", amount_cents: 1, counterparty: "did:t3n:meridian-fund" }, mandate: MANDATE });
    const again = await client.getTask({ tenant: "", id: task.id, historyLength: undefined });
    assert.equal(again.id, task.id);
    assert.equal(again.status.state, TaskState.TASK_STATE_COMPLETED);
  });
});

describe("bind-credential, over A2A", () => {
  test("produces the commitment the enclave recomputes, and the gate accepts it", { skip: need() }, async () => {
    const action = { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, counterparty: "did:t3n:meridian-fund" };
    const { verdict: binding } = await ask({
      skill: "bind-credential", issuer: "did:key:kyc", subject: "did:t3n:investor",
      claims: { accreditedInvestor: true }, verified: true, action,
    });
    assert.ok(binding.commitment);
    const { verdict } = await ask({ action, mandate: { ...MANDATE, require_credential: true }, credential: binding });
    assert.equal(verdict.decision, "approved");
    assert.equal(verdict.expected_commitment, binding.commitment);
  });

  test("refuses to bind a credential the caller did not verify", async () => {
    const { task, note } = await ask({
      skill: "bind-credential", issuer: "did:key:kyc", subject: "did:t3n:investor",
      claims: {}, verified: false, action: { kind: "rwa.buy" },
    });
    assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    assert.match(note, /not verified/);
  });
});

describe("request parsing", () => {
  test("reads a data part, JSON in a text part, or wire-shaped parts", () => {
    const req = { action: { kind: "x" }, mandate: { max_amount_cents: 1 } };
    assert.deepEqual(requestFromMessage({ parts: [{ content: { $case: "data", value: req } }] }), req);
    assert.deepEqual(requestFromMessage({ parts: [{ content: { $case: "text", value: JSON.stringify(req) } }] }), req);
    assert.deepEqual(requestFromMessage({ parts: [{ data: req }] }), req);
    assert.equal(requestFromMessage({ parts: [{ content: { $case: "text", value: "not json" } }] }), null);
    assert.equal(requestFromMessage(null), null);
  });
});
