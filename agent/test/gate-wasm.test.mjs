// The registered component, hosted in JavaScript — and held to the Rust host
// build. Two hosts of the same source can still disagree if one of them is
// stale, so the first thing checked is that the glue was made from the
// component on disk, and the second is that its verdicts match gate_cli's.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadGate, SOURCE, tenantIdBytes, GateError, LOCAL_TENANT } from "../src/gate-wasm.mjs";
import { decide, gateCliPath, CONTRACT_VERSION } from "../src/gate-cli.mjs";

const PAYEE = "did:t3n:meridian-fund";
const BASE = {
  max_amount_cents: 500000, allowed_assets: ["USDC", "USD"], allowed_kinds: ["rwa.buy"],
  allowed_counterparties: [PAYEE], expires_at_secs: 0, valid_after_secs: 0,
};
const NOW = 1_786_000_000;
const buy = (amount_cents, extra = {}) => ({ kind: "rwa.buy", asset: "USDC", amount_cents, counterparty: PAYEE, ...extra });

describe("gate-wasm — provenance", () => {
  test("source.json names the contract version this agent expects", () => {
    assert.equal(SOURCE.version, CONTRACT_VERSION);
    assert.match(SOURCE.sha256, /^[0-9a-f]{64}$/);
  });

  test("the glue was transpiled from the release component on disk", (t) => {
    const path = fileURLToPath(new URL(`../../${SOURCE.component}`, import.meta.url));
    if (!existsSync(path)) return t.skip("no release component built locally — cannot compare");
    const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(sha, SOURCE.sha256, "gate-wasm/ is stale: run `npm run gate:transpile` after rebuilding the contract");
  });

  test("a tenant DID becomes the 20 raw bytes the node hands a contract", () => {
    assert.deepEqual(Array.from(tenantIdBytes("did:t3n:" + "ab".repeat(20))), Array(20).fill(0xab));
    assert.throws(() => tenantIdBytes("did:t3n:short"), /not a tenant DID/);
    assert.throws(() => tenantIdBytes("did:key:z6Mk"), /not a tenant DID/);
  });
});

describe("gate-wasm — the component decides", () => {
  let gate;
  before(async () => { gate = await loadGate({ tenantDid: "did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f", now: () => NOW }); });

  test("an in-mandate purchase is approved, and the output is the enclave's shape", () => {
    const out = gate.evaluate(buy(100000), BASE);
    assert.equal(out.decision, "approved");
    assert.deepEqual(out.reasons, []);
    assert.equal(out.mandate_source, "inline");
    assert.equal(out.evaluated_at_secs, NOW);
    assert.equal(out.tenant_did, "did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f");
    assert.equal(out.audit.max_amount_cents, 500000);
  });

  test("the verdict and every reason match gate_cli's, case by case", async (t) => {
    if (!gateCliPath()) return t.skip("gate_cli not built");
    const cases = [
      ["happy", buy(100000), BASE],
      ["over cap", buy(900000), BASE],
      ["wrong asset and kind", { kind: "swap", asset: "DOGE", amount_cents: 100, counterparty: PAYEE }, BASE],
      ["unknown payee", buy(100000, { counterparty: "did:t3n:unknown" }), BASE],
      ["expired", buy(100000), { ...BASE, expires_at_secs: NOW - 3600 }],
      ["not yet valid", buy(100000), { ...BASE, valid_after_secs: NOW + 3600 }],
      ["empty mandate denies", buy(1), { max_amount_cents: 999999999, allowed_assets: [], allowed_kinds: [], allowed_counterparties: [], expires_at_secs: 0, valid_after_secs: 0 }],
      ["per-payee sub-limit", buy(100000), { ...BASE, counterparty_limits: { [PAYEE]: 10000 } }],
      ["untrusted issuer", buy(100000, { issuer: "did:key:the-agent-itself" }), { ...BASE, allowed_issuers: ["did:key:kyc"] }],
      ["trusted issuer", buy(100000, { issuer: "did:key:kyc" }), { ...BASE, allowed_issuers: ["did:key:kyc"] }],
      ["wildcard asset", { kind: "rwa.buy", asset: "EURC", amount_cents: 5, counterparty: PAYEE }, { ...BASE, allowed_assets: ["*"] }],
    ];
    for (const [name, action, mandate] of cases) {
      const component = gate.evaluate(action, mandate, { now_secs: NOW });
      const rust = await decide({ action, mandate, now_secs: NOW });
      assert.equal(component.decision, rust.decision, `${name}: decision`);
      assert.deepEqual(component.reasons, rust.reasons, `${name}: reasons`);
    }
  });

  test("with no inline mandate the contract reads the tenant-provisioned one from KV", () => {
    assert.throws(() => gate.evaluate(buy(100000)), GateError, "nothing provisioned must not approve");
    gate.provisionMandate({ ...BASE, max_amount_cents: 50000 });
    const out = gate.evaluate(buy(100000));
    assert.equal(out.mandate_source, "kv");
    assert.equal(out.decision, "rejected");
    assert.match(out.reasons[0], /exceeds mandate max 50000/);
    assert.ok(gate.kv.has("z:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f:mandate"), "map name derives from the tenant id");
  });

  test("the clock is the host's, and a per-call override is scoped to that call", () => {
    const m = { ...BASE, expires_at_secs: NOW + 10 };
    assert.equal(gate.evaluate(buy(1), m).decision, "approved");
    assert.equal(gate.evaluate(buy(1), m, { now_secs: NOW + 11 }).decision, "rejected");
    assert.equal(gate.evaluate(buy(1), m).decision, "approved", "override must not stick");
  });

  test("evaluate never asks the host for outbound HTTP", () => {
    assert.equal(gate.calls.http, 0);
    assert.equal(gate.calls.httpWithPlaceholders, 0);
  });

  test("spend accumulates in the host KV across calls, bucketed by the clock — not the caller", () => {
    const g = gate; // fresh map name per tenant; use a distinct day for isolation
    const day = NOW + 5 * 86400;
    const a = g.spend(buy(60000), 100000, { now_secs: day });
    assert.equal(a.decision, "approved");
    assert.equal(a.spent_after, 60000);
    assert.equal(a.window, `d${Math.floor(day / 86400)}`);
    assert.equal(a.window_requested, "ignored-by-contract");
    const b = g.spend(buy(60000), 100000, { now_secs: day });
    assert.equal(b.decision, "rejected", "second spend crosses the daily limit");
    assert.equal(b.spent_before, 60000);
    assert.ok(g.calls.kvPut >= 1, "the running total was written through the kv import");
  });

  test("bad input is the component's error, not a JavaScript one", () => {
    assert.throws(() => gate.evaluate({ kind: "rwa.buy" }, BASE), GateError);
  });

  test("a host with no tenant runs as the all-zero local tenant", async () => {
    const g = await loadGate();
    assert.equal(g.tenantDid, LOCAL_TENANT);
    assert.equal(g.evaluate(buy(1), BASE).tenant_did, LOCAL_TENANT);
  });
});
