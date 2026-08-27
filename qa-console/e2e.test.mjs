// End-to-end QA: Playwright drives the console, the console runs the contract's
// real Rust gate. Happy path AND wrong paths — a gate that only proves it says
// yes is worthless; what matters is that it says no for the right reason.
//
//   node --test e2e.test.mjs
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { start } from "./server.mjs";

let server, browser, page, base;

before(async () => {
  server = await start(0);
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(base);
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** Click a scenario and wait for the verdict to settle. */
async function runScenario(id) {
  await page.evaluate(() => { delete document.body.dataset.decision; });
  await page.getByTestId(id).click();
  await page.waitForFunction(() => document.body.dataset.decision !== undefined);
  return {
    verdict: (await page.getByTestId("verdict").textContent()).trim(),
    reasons: await page.getByTestId("reasons").locator("li").allTextContents(),
  };
}

describe("happy path", () => {
  test("an in-mandate purchase is approved with no reasons", async () => {
    const { verdict, reasons } = await runScenario("s-happy");
    assert.equal(verdict, "APPROVED");
    assert.deepEqual(reasons, [], "an approval must carry no rejection reasons");
  });

  test("a credential from a trusted issuer is approved", async () => {
    const { verdict, reasons } = await runScenario("s-issuer-ok");
    assert.equal(verdict, "APPROVED");
    assert.deepEqual(reasons, []);
  });
});

describe("wrong paths", () => {
  test("over the cap is rejected, and says so", async () => {
    const { verdict, reasons } = await runScenario("s-over");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.some((r) => r.includes("exceeds mandate max")), reasons.join(" | "));
  });

  test("a disallowed asset and kind are both reported", async () => {
    const { verdict, reasons } = await runScenario("s-asset");
    assert.equal(verdict, "REJECTED");
    // Both failures must surface — reporting only the first hides the second.
    assert.ok(reasons.some((r) => r.includes("allowed_kinds")), reasons.join(" | "));
    assert.ok(reasons.some((r) => r.includes("allowed_assets")), reasons.join(" | "));
  });

  test("an unlisted counterparty is rejected by name", async () => {
    const { verdict, reasons } = await runScenario("s-payee");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.some((r) => r.includes("unknown-payee")), reasons.join(" | "));
  });

  test("an expired mandate is rejected", async () => {
    const { verdict, reasons } = await runScenario("s-expired");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.some((r) => r.includes("expired")), reasons.join(" | "));
  });

  test("a self-issued credential is rejected as untrusted", async () => {
    // The headline attack: a BBS+ signature proves the issuer signed the claim,
    // not that the issuer is anyone the fund trusts.
    const { verdict, reasons } = await runScenario("s-issuer-bad");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.some((r) => r.includes("not trusted")), reasons.join(" | "));
  });

  test("a per-counterparty sub-limit binds under the global cap", async () => {
    const { verdict, reasons } = await runScenario("s-sublimit");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.some((r) => r.includes("per-counterparty limit")), reasons.join(" | "));
  });

  test("an unconfigured mandate denies by default", async () => {
    // The one that matters most: a half-provisioned mandate must fail closed.
    const { verdict, reasons } = await runScenario("s-empty");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.length >= 2, `expected asset+kind denials, got ${reasons.join(" | ")}`);
  });
});

describe("credential binding — the eligibility check cannot be detached", () => {
  test("a credential bound to this exact action is approved", async () => {
    const { verdict, reasons } = await runScenario("s-bind-ok");
    assert.equal(verdict, "APPROVED", reasons.join(" | "));
  });

  test("a credential verified for a smaller amount cannot pay a bigger one", async () => {
    // The whole point: the agent really did verify a credential, just not for
    // this action. The enclave recomputes the commitment over the action it is
    // about to perform, so the substitution shows up as a mismatch.
    const { verdict, reasons } = await runScenario("s-bind-moved");
    assert.equal(verdict, "REJECTED");
    assert.ok(
      reasons.some((r) => /does not match this action/.test(r)),
      reasons.join(" | "),
    );
  });

  test("a mandate that requires a binding refuses when none is supplied", async () => {
    // Otherwise omitting the field is the way around the check.
    const { verdict, reasons } = await runScenario("s-bind-missing");
    assert.equal(verdict, "REJECTED");
    assert.ok(
      reasons.some((r) => /requires a credential binding/.test(r)),
      reasons.join(" | "),
    );
  });
});

describe("idempotency — a retry must not become a second order", () => {
  test("a mandate that requires a key refuses an action without one", async () => {
    // Without a key, a timed-out dispatch is ambiguous: retrying risks a second
    // order, not retrying risks none. The mandate refuses the ambiguity.
    const { verdict, reasons } = await runScenario("s-idem-missing");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.some((r) => /requires an idempotency key/.test(r)), reasons.join(" | "));
  });

  test("a key carrying path structure is refused", async () => {
    // The key becomes part of a KV key, so it must not be able to address
    // another map or escape its namespace.
    const { verdict, reasons } = await runScenario("s-idem-bad");
    assert.equal(verdict, "REJECTED");
    assert.ok(reasons.some((r) => /idempotency key may contain only/.test(r)), reasons.join(" | "));
  });
});

describe("api abuse", () => {
  const post = (body) => page.evaluate(async (b) => {
    const r = await fetch("/api/decide", {
      method: "POST", headers: { "content-type": "application/json" }, body: b,
    });
    return { status: r.status, json: await r.json() };
  }, typeof body === "string" ? body : JSON.stringify(body));

  test("malformed JSON is rejected, not crashed on", async () => {
    const { status, json } = await post("{not json");
    assert.equal(status, 400);
    assert.ok(json.error);
  });

  test("a missing action is rejected", async () => {
    const { status } = await post({ mandate: {} });
    assert.equal(status, 400);
  });

  test("a negative amount cannot sneak past the cap", async () => {
    // u64 in Rust — a negative must fail to parse rather than wrap around into
    // a huge or zero value that slips under the limit.
    const { json } = await post({
      action: { kind: "rwa.buy", asset: "USDC", amount_cents: -1, counterparty: "did:t3n:meridian-fund" },
      mandate: { max_amount_cents: 500000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"] },
    });
    assert.notEqual(json.decision, "approved", `negative amount must not approve: ${JSON.stringify(json)}`);
  });

  test("an unknown route 404s", async () => {
    const res = await page.request.get(`${base}/nope`);
    assert.equal(res.status(), 404);
  });
});

// ── paying for a resource, watched from the browser ─────────────────────────
//
// The console fetches a real HTTP 402 from this same server, and the server
// recovers the payer from the EIP-3009 signature before serving. So a green
// "PAID" here means a signature was produced, transmitted and verified — not
// that a boolean was set.
describe("x402 — the mandate decides whether to pay", () => {
  /** Click an x402 button and wait for the round trip to finish. */
  async function pay(id) {
    await page.evaluate(() => { delete document.body.dataset.paid; });
    await page.getByTestId(id).click();
    await page.waitForFunction(() => document.body.dataset.paid !== undefined);
    return {
      verdict: (await page.getByTestId("verdict").textContent()).trim(),
      reasons: await page.getByTestId("reasons").locator("li").allTextContents(),
      raw: JSON.parse(await page.getByTestId("raw").textContent()),
    };
  }

  test("an in-mandate price is paid, and the payee recovered the signer", async () => {
    const { verdict, reasons, raw } = await pay("x-pay-ok");
    assert.equal(verdict, "PAID");
    assert.deepEqual(reasons, []);
    assert.equal(raw.status, 200);
    assert.equal(raw.action.kind, "x402.pay");
    assert.equal(raw.action.amount_cents, 1);
    // The server did not take the client's word for who was paying.
    assert.equal(raw.payer, raw.signer, "the recovered payer must be the signing wallet");
    // And it does not claim money moved.
    assert.equal(raw.settled, false);
  });

  test("a payee the mandate never listed is refused before signing", async () => {
    const { verdict, reasons, raw } = await pay("x-pay-payee");
    assert.equal(verdict, "NOT PAID");
    assert.equal(raw.status, 402, "the resource must still be unpaid");
    assert.equal(raw.payer, null, "nothing was signed, so nothing was recovered");
    assert.ok(reasons.some((r) => /dEaD/i.test(r)), reasons.join(","));
  });

  test("a price over the API budget is refused", async () => {
    const { verdict, reasons } = await pay("x-pay-price");
    assert.equal(verdict, "NOT PAID");
    assert.ok(reasons.some((r) => /exceeds mandate max/.test(r)), reasons.join(","));
  });

  test("permission to trade is not permission to spend on APIs", async () => {
    const { verdict, reasons } = await pay("x-pay-kind");
    assert.equal(verdict, "NOT PAID");
    assert.ok(reasons.some((r) => r.includes("x402.pay")), reasons.join(","));
  });

  test("the paywall itself answers a spec-shaped 402", async () => {
    const res = await page.request.get(`${base}/api/paywall`);
    assert.equal(res.status(), 402);
    const header = res.headers()["payment-required"];
    assert.ok(header, "a 402 must carry the PAYMENT-REQUIRED header");
    const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.accepts[0].scheme, "exact");
    assert.equal(challenge.accepts[0].extra.assetTransferMethod, "eip3009");
  });

  test("a junk payment header does not open the paywall", async () => {
    const res = await page.request.get(`${base}/api/paywall`, {
      headers: { "payment-signature": Buffer.from('{"x402Version":2}').toString("base64") },
    });
    assert.equal(res.status(), 402);
    assert.match((await res.json()).error, /missing signature or authorization/);
  });
});

// ── A2A, on the wire ─────────────────────────────────────────────────────────
//
// agent/test/a2a-server.test.mjs drives the server with the official SDK
// client, which proves SDK talks to SDK. This block hand-writes the JSON-RPC
// envelopes from the v1.0 spec and sends them with Playwright's request API —
// no A2A library on the calling side at all. If the SDK ever wrapped a private
// dialect, this is where it would show.
describe("A2A v1.0 — hand-written JSON-RPC, no SDK on the client side", () => {
  let a2a;
  before(async () => { a2a = await (await import("../agent/src/a2a-server.mjs")).start(0); });
  after(() => a2a?.close());

  const MANDATE = { max_amount_cents: 500000, allowed_assets: ["USDC"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 };
  let nextId = 1;
  // v1.0 negotiates the protocol version in a header. Omit it and the server
  // assumes 0.3 — the dialect it does not speak — and refuses. The official
  // client sends it silently; a hand-rolled one has to know.
  const rpc = (method, params, headers = { "A2A-Version": "1.0" }) => page.request.post(a2a.listenUrl, {
    data: { jsonrpc: "2.0", method, params, id: nextId++ }, headers,
  });
  const sendMessage = (data) => rpc("SendMessage", {
    message: { messageId: `m-${nextId}`, role: "ROLE_USER", parts: [{ data, mediaType: "application/json" }] },
    configuration: {},
  });

  test("the card is served at the well-known path and names this endpoint", async () => {
    const res = await page.request.get(`${a2a.listenUrl}.well-known/agent-card.json`);
    assert.equal(res.status(), 200);
    const card = await res.json();
    assert.equal(card.name, "Gatekeeper Agent");
    assert.equal(card.supportedInterfaces[0].url, a2a.baseUrl);
    assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
    assert.ok(card.skills.some((s) => s.id === "evaluate-gated-action"));
  });

  test("SendMessage with an in-mandate action completes the task, verdict in the artifact", async () => {
    const res = await sendMessage({ action: { kind: "rwa.buy", asset: "USDC", amount_cents: 100000 }, mandate: MANDATE });
    assert.equal(res.status(), 200);
    const { result, error } = await res.json();
    assert.equal(error, undefined);
    assert.equal(result.task.status.state, "TASK_STATE_COMPLETED");
    assert.equal(result.task.artifacts[0].parts[0].data.decision, "approved");
    assert.deepEqual(result.task.artifacts[0].parts[0].data.reasons, []);
  });

  test("an over-cap action completes with decision rejected and the rule that refused", async () => {
    const res = await sendMessage({ action: { kind: "rwa.buy", asset: "USDC", amount_cents: 900000 }, mandate: MANDATE });
    const { result } = await res.json();
    assert.equal(result.task.status.state, "TASK_STATE_COMPLETED");
    const verdict = result.task.artifacts[0].parts[0].data;
    assert.equal(verdict.decision, "rejected");
    assert.ok(verdict.reasons.some((r) => /exceeds mandate max/.test(r)));
    assert.match(result.task.status.message.parts[0].text, /^REJECTED/);
  });

  test("a mandate with no ceiling fails the task rather than approving by default", async () => {
    const res = await sendMessage({ action: { kind: "rwa.buy", amount_cents: 1 }, mandate: {} });
    const { result } = await res.json();
    assert.equal(result.task.status.state, "TASK_STATE_FAILED");
    assert.equal(result.task.artifacts?.length ?? 0, 0, "a failed task must carry no verdict");
    assert.match(result.task.status.message.parts[0].text, /max_amount_cents/);
  });

  test("GetTask reads a completed task back by id", async () => {
    const sent = (await (await sendMessage({ action: { kind: "rwa.buy", asset: "USDC", amount_cents: 1 }, mandate: MANDATE })).json()).result.task;
    const res = await rpc("GetTask", { id: sent.id });
    const { result } = await res.json();
    assert.equal(result.id, sent.id);
    assert.equal(result.status.state, "TASK_STATE_COMPLETED");
  });

  test("a request without the A2A-Version header is refused BY VERSION, not with a mystery", async () => {
    const res = await rpc("GetTask", { id: "nope" }, {});
    const body = await res.json();
    assert.equal(body.error?.code, -32009, JSON.stringify(body).slice(0, 160));
    assert.match(body.error.message, /'0.3' is not supported.*1\.0/);
  });

  test("an unknown method is a JSON-RPC method-not-found, not a crash", async () => {
    const res = await rpc("DropAllLimits", {});
    const body = await res.json();
    assert.ok(body.error, "expected a JSON-RPC error object");
    assert.equal(body.error.code, -32601);
  });

  test("a body that is not JSON-RPC is refused with a parse/invalid-request error", async () => {
    const res = await page.request.post(a2a.listenUrl, { data: "{not json", headers: { "content-type": "application/json" } });
    const body = await res.json().catch(() => null);
    assert.ok(body?.error, `expected a JSON-RPC error, got HTTP ${res.status()} ${JSON.stringify(body).slice(0, 120)}`);
    assert.ok([-32700, -32600].includes(body.error.code), `code ${body.error.code}`);
  });
});
