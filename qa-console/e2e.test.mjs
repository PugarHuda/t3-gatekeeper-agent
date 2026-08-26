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
