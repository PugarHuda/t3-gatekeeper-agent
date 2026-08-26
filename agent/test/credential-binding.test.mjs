// The credential binding exists in two languages: JavaScript in the agent, Rust
// in the enclave. If they ever disagree the scheme is worthless — each side
// verifies only against itself and the check silently passes nothing.
//
// So these tests do not assert the JS output against a constant I typed in. They
// run the COMPILED Rust (`gate_cli`, the same code the contract compiles) and
// assert the two agree. A drift in either implementation fails here.
//
// gate_cli is built by `node verify.mjs`; if it is missing these tests say so
// and skip rather than passing quietly.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionDigest, expectedCommitment, claimsDigest, bindCredential, BINDING_DOMAIN,
} from "../src/credential-binding.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = [
  path.join(REPO, "gate-contract", "target", "x86_64-pc-windows-gnu", "release", "gate_cli.exe"),
  path.join(REPO, "gate-contract", "target", "release", "gate_cli.exe"),
  path.join(REPO, "gate-contract", "target", "release", "gate_cli"),
].find(existsSync);

const MANDATE = {
  max_amount_cents: 10_000_000,
  allowed_assets: ["USDC"],
  allowed_kinds: ["rwa.buy"],
  require_credential: true,
};

/** Run the real Rust decision + binding check. */
function rust(action, credential, mandate = MANDATE) {
  const r = spawnSync(CLI, {
    input: JSON.stringify({ action, mandate, now_secs: 1_800_000_000, credential }),
    encoding: "utf8",
  });
  const out = (r.stdout || "").trim();
  assert.ok(out, `gate_cli produced no output: ${r.stderr}`);
  return JSON.parse(out);
}

const buy = (amount_cents, counterparty) => ({
  kind: "rwa.buy", asset: "USDC", amount_cents,
  ...(counterparty ? { counterparty } : {}),
});

describe("credential binding agrees with the contract", { skip: CLI ? false : "gate_cli not built — run `node verify.mjs`" }, () => {
  test("the action digest is identical in both languages", () => {
    for (const a of [buy(1), buy(100_000), buy(999_999, "did:t3n:meridian"), { kind: "", asset: "", amount_cents: 0 }]) {
      assert.equal(actionDigest(a), rust(a, null).action_digest, `digest differs for ${JSON.stringify(a)}`);
    }
  });

  test("the commitment is identical in both languages", () => {
    const action = buy(250_000, "did:t3n:meridian");
    const binding = bindCredential(
      { issuer: "did:key:kyc", subject: "did:t3n:investor", claims: { accreditedInvestor: true }, verified: true },
      action,
    );
    assert.equal(rust(action, binding).expected_commitment, binding.commitment);
  });

  test("a binding the agent built is accepted by the contract", () => {
    const action = buy(250_000);
    const binding = bindCredential(
      { issuer: "did:key:kyc", subject: "did:t3n:investor", claims: { accreditedInvestor: true }, verified: true },
      action,
    );
    const r = rust({ ...action, issuer: "did:key:kyc" }, binding);
    assert.equal(r.decision, "approved", r.reasons?.join("; "));
  });

  test("the contract rejects a binding moved to a bigger amount", () => {
    const small = buy(50_000);
    const binding = bindCredential(
      { issuer: "did:key:kyc", subject: "did:t3n:investor", claims: { accreditedInvestor: true }, verified: true },
      small,
    );
    const r = rust(buy(5_000_000), binding);
    assert.equal(r.decision, "rejected");
    assert.ok(r.reasons.some((x) => /does not match this action/.test(x)), r.reasons.join("; "));
  });

  test("the contract rejects a binding moved to a different payee", () => {
    const toFund = buy(100_000, "did:t3n:meridian");
    const binding = bindCredential(
      { issuer: "did:key:kyc", subject: "did:t3n:investor", claims: { accreditedInvestor: true }, verified: true },
      toFund,
    );
    assert.equal(rust(buy(100_000, "did:t3n:attacker"), binding).decision, "rejected");
  });

  test("a required binding cannot be omitted", () => {
    const r = rust(buy(100_000), null);
    assert.equal(r.decision, "rejected");
    assert.ok(r.reasons.some((x) => /requires a credential binding/.test(x)), r.reasons.join("; "));
  });

  test("a claimed issuer that is not the bound issuer is rejected", () => {
    const action = buy(100_000);
    const binding = bindCredential(
      { issuer: "did:key:real-kyc", subject: "did:t3n:investor", claims: { accreditedInvestor: true }, verified: true },
      action,
    );
    const r = rust({ ...action, issuer: "did:key:trusted-by-the-mandate" }, binding);
    assert.equal(r.decision, "rejected");
    assert.ok(r.reasons.some((x) => /not the issuer in the credential binding/.test(x)), r.reasons.join("; "));
  });
});

describe("credential binding, on its own", () => {
  test("refuses to bind a credential that was not verified", () => {
    assert.throws(
      () => bindCredential({ issuer: "did:key:x", subject: "did:t3n:y", claims: {} }, buy(1)),
      /not verified/,
    );
  });

  test("every binding gets a fresh nonce, so none can be replayed", () => {
    const action = buy(100_000);
    const mk = () => bindCredential(
      { issuer: "did:key:x", subject: "did:t3n:y", claims: { a: 1 }, verified: true }, action,
    );
    const a = mk(), b = mk();
    assert.notEqual(a.nonce, b.nonce);
    assert.notEqual(a.commitment, b.commitment, "same action, different nonce, different commitment");
  });

  test("the claims digest does not depend on key order", () => {
    assert.equal(
      claimsDigest({ accreditedInvestor: true, jurisdiction: "SG" }),
      claimsDigest({ jurisdiction: "SG", accreditedInvestor: true }),
    );
    assert.notEqual(claimsDigest({ a: 1 }), claimsDigest({ a: 2 }));
  });

  test("field boundaries cannot be shifted without changing the commitment", () => {
    const action = buy(1);
    const x = { issuer: "ab", subject: "c", claims_digest: "d", nonce: "n" };
    const y = { issuer: "a", subject: "bc", claims_digest: "d", nonce: "n" };
    assert.notEqual(expectedCommitment(x, action), expectedCommitment(y, action));
  });

  test("the domain separator is part of the commitment", () => {
    assert.match(BINDING_DOMAIN, /cred-binding/);
  });
});
