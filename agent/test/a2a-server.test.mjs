// The A2A server, driven by the official client over real HTTP — signed.
//
// Nothing here calls the executor. A test that did would prove the executor
// works and say nothing about whether a peer — which only has our URL, the A2A
// SDK, and a key it publishes — can discover the card, learn it must sign,
// send a signed message, and read a task back. That is the whole claim.
//
// The caller's key lives in a directory served by a real HTTP server; the A2A
// server resolves it from `Signature-Agent` the way it would for a stranger.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client";

import { start, buildAgentCard, requestFromMessage } from "../src/a2a-server.mjs";
import { decide, gateCliPath } from "../src/gate-cli.mjs";
import { validateAgentCard } from "../src/a2a.mjs";
import { signRequest } from "../src/web-bot-auth.mjs";
import { testCaller } from "./helpers/directory-server.mjs";

let srv, client, caller;

before(async () => {
  srv = await start(0);
  caller = await testCaller();
  // A peer's view: a URL, the SDK, and its own signing key. The card is
  // fetched unsigned (it is how one learns to sign); every JSON-RPC call after
  // that goes through the signing fetch.
  const factory = new ClientFactory({
    ...ClientFactoryOptions.default,
    transports: [new JsonRpcTransportFactory({ fetchImpl: caller.fetch })],
  });
  client = await factory.createFromUrl(srv.baseUrl);
});
after(async () => { await srv?.close(); await caller?.close(); });

const need = () => (gateCliPath() ? false : "gate_cli is not built");

const MANDATE = {
  max_amount_cents: 500_000, allowed_assets: ["USDC", "USD"], allowed_kinds: ["rwa.buy"],
  allowed_counterparties: ["did:t3n:meridian-fund"], expires_at_secs: 0,
};

const message = (parts) => ({
  messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER,
  parts, metadata: undefined, extensions: [], referenceTaskIds: [],
});
const dataPart = (value) => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });

/** Send one request as a data part, the way an agent-to-agent caller would. */
async function ask(request) {
  const res = await client.sendMessage({ tenant: "", message: message([dataPart(request)]), configuration: undefined, metadata: undefined });
  // v1.0 returns the Task (or Message) itself, unwrapped. A Task has a status.
  assert.ok(res?.id && res?.status, `expected a task, got ${JSON.stringify(res).slice(0, 120)}`);
  const task = res;
  const verdict = task.artifacts?.[0]?.parts?.find((p) => p.content?.$case === "data")?.content?.value ?? null;
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

  test("the card says a signature is required, before the first call is refused", async () => {
    const card = await client.getAgentCard();
    assert.ok(card.securitySchemes["web-bot-auth"], "no web-bot-auth security scheme on the card");
    assert.equal(card.securitySchemes["web-bot-auth"].scheme.$case, "httpAuthSecurityScheme");
    assert.equal(card.securitySchemes["web-bot-auth"].scheme.value.scheme, "HTTPSig");
    assert.ok(card.securityRequirements.some((r) => r.schemes["web-bot-auth"]));
  });

  test("it advertises the same skills as the published static card", async () => {
    const served = (await client.getAgentCard()).skills.map((s) => s.id).sort();
    const published = buildAgentCard("http://x/").skills.map((s) => s.id).sort();
    assert.deepEqual(served, published);
  });

  test("and it passes the same validation we apply to other agents' cards", async () => {
    assert.deepEqual(validateAgentCard(await client.getAgentCard()).problems, []);
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
    assert.deepEqual(verdict, { ...direct, engine: "gate_cli" });
    assert.equal(direct.decision, "rejected");
  });

  test("a request with no mandate ceiling FAILS the task and says why", async () => {
    const { task, verdict, note } = await ask({ action: { kind: "rwa.buy", amount_cents: 1 }, mandate: {} });
    assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    assert.equal(verdict, null);
    assert.match(note, /max_amount_cents/);
  });

  test("a message carrying no request at all fails with instructions", async () => {
    const task = await client.sendMessage({
      tenant: "",
      message: message([{ content: { $case: "text", value: "hello?" }, metadata: undefined, filename: "", mediaType: "text/plain" }]),
      configuration: undefined, metadata: undefined,
    });
    assert.equal(task.status.state, TaskState.TASK_STATE_FAILED);
    assert.match(task.status.message.parts[0].content.value, /action, mandate/);
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

describe("who may call — web-bot-auth at the door", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "nope" },
  });
  const post = (headers) => fetch(srv.baseUrl, {
    method: "POST", body,
    headers: { "content-type": "application/json", "A2A-Version": "1.0", ...headers },
  });

  test("an unsigned call is refused with 401 and told what is required", async () => {
    const res = await post({});
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /HTTPSig.*web-bot-auth/);
    assert.match((await res.json()).reason, /not signed/);
  });

  test("a signed call from a key that is NOT in the named directory is refused", async () => {
    const { generateAgentKey } = await import("../src/web-bot-auth.mjs");
    const stranger = generateAgentKey();
    const headers = signRequest({ method: "POST", url: srv.baseUrl, body }, { privateKey: stranger.privateKey, keyid: caller.keyid });
    const res = await post({ ...headers, "Signature-Agent": `"${caller.origin}"` });
    assert.equal(res.status, 401);
    assert.match((await res.json()).reason, /does not verify/);
  });

  test("a signature naming an origin with no directory is refused", async () => {
    const headers = signRequest({ method: "POST", url: srv.baseUrl, body }, { privateKey: caller.privateKey, keyid: caller.keyid });
    const res = await post({ ...headers, "Signature-Agent": '"https://127.0.0.1:1"' });
    assert.equal(res.status, 401);
    assert.match((await res.json()).reason, /could not resolve/);
  });

  test("the same signed request sent twice is refused the second time — replay", async () => {
    const headers = { ...signRequest({ method: "POST", url: srv.baseUrl, body }, { privateKey: caller.privateKey, keyid: caller.keyid }), "Signature-Agent": `"${caller.origin}"` };
    const first = await post(headers);
    assert.notEqual(first.status, 401, `first send should pass auth: ${await first.text()}`);
    const second = await post(headers);
    assert.equal(second.status, 401);
    assert.match((await second.json()).reason, /replay/);
  });

  test("a signed request whose body was swapped in flight is refused", async () => {
    const headers = { ...signRequest({ method: "POST", url: srv.baseUrl, body }, { privateKey: caller.privateKey, keyid: caller.keyid }), "Signature-Agent": `"${caller.origin}"` };
    const res = await fetch(srv.baseUrl, {
      method: "POST", headers: { "content-type": "application/json", "A2A-Version": "1.0", ...headers },
      body: body.replace('"nope"', '"other"'),
    });
    assert.equal(res.status, 401);
  });

  test("the card stays public — it is how a caller learns to sign", async () => {
    const res = await fetch(`${srv.baseUrl}.well-known/agent-card.json`);
    assert.equal(res.status, 200);
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

describe("streaming — SendMessageStream over SSE, official client", () => {
  const stream = async (request) => {
    const events = [];
    for await (const ev of client.sendMessageStream({
      tenant: "", message: message([dataPart(request)]), configuration: undefined, metadata: undefined,
    })) events.push(ev);
    return events;
  };
  const kinds = (events) => events.map((e) => e.payload?.$case);
  const states = (events) => events
    .filter((e) => e.payload?.$case === "statusUpdate" || e.payload?.$case === "task")
    .map((e) => e.payload.value.status?.state);

  test("the served card says streaming", async () => {
    const card = await (await fetch(`${srv.listenUrl}.well-known/agent-card.json`)).json();
    assert.equal(card.capabilities.streaming, true);
  });

  test("the events arrive in order — task, working, artifact, completed — and the stream then ends", { skip: need() }, async () => {
    const events = await stream({ action: { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, counterparty: "did:t3n:meridian-fund" }, mandate: MANDATE });
    assert.deepEqual(kinds(events), ["task", "statusUpdate", "artifactUpdate", "statusUpdate"], JSON.stringify(kinds(events)));
    assert.deepEqual(states(events), [TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_COMPLETED]);
    const artifact = events[2].payload.value.artifact;
    const verdict = artifact.parts.find((p) => p.content?.$case === "data")?.content?.value;
    assert.equal(verdict.decision, "approved");
    // v1.0 has no `final` flag; the terminal state is last, and the generator
    // returned (we are past the for-await), so the stream really closed.
    assert.equal(events.at(-1).payload.$case, "statusUpdate");
  });

  test("a rejected action streams to completed with the reason, not to failed", { skip: need() }, async () => {
    const events = await stream({ action: { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000, counterparty: "did:t3n:meridian-fund" }, mandate: MANDATE });
    assert.equal(states(events).at(-1), TaskState.TASK_STATE_COMPLETED);
    assert.ok(!states(events).includes(TaskState.TASK_STATE_FAILED));
    const verdict = events.find((e) => e.payload?.$case === "artifactUpdate").payload.value.artifact.parts[0].content.value;
    assert.equal(verdict.decision, "rejected");
    assert.match(verdict.reasons[0], /exceeds mandate max 500000/);
  });
});

describe("signature age — the server bounds the window too", () => {
  test("a signature created 150 s ago is refused by a server that accepts 120 s, and accepted by the default", async () => {
    const { createApp } = await import("../src/a2a-server.mjs");
    const express = (await import("express")).default;
    const tight = express().use(createApp("http://tight.local", { auth: { maxAgeSeconds: 120 } }));
    const loose = express().use(createApp("http://loose.local"));
    const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const [ts, ls] = await Promise.all([listen(tight), listen(loose)]);
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "none" } });
      const created = Math.floor(Date.now() / 1000) - 150;
      const call = async (server) => {
        const url = `http://127.0.0.1:${server.address().port}/`;
        const headers = { "content-type": "application/json", "A2A-Version": "1.0",
          ...signRequest({ method: "POST", url, body }, { privateKey: caller.privateKey, keyid: caller.keyid, created, ttlSeconds: 300 }),
          "Signature-Agent": `"${caller.origin}"` };
        return fetch(url, { method: "POST", headers, body });
      };
      const refused = await call(ts);
      assert.equal(refused.status, 401);
      assert.match((await refused.json()).reason, /older than this server accepts \(120s/);
      const accepted = await call(ls);
      assert.equal(accepted.status, 200, "still inside the signer's own 300 s");
      assert.match(JSON.stringify(await accepted.json()), /TASK_NOT_FOUND|Task not found/);
    } finally { ts.close(); ls.close(); }
  });
});
