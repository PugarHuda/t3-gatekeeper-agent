// x402, both halves, over real HTTP with real signatures.
//
// The resource server here is a real node:http server that answers 402, reads
// the PAYMENT-SIGNATURE header, and recovers the signer with ecrecover before
// serving anything. The client is the agent. Nothing is stubbed: if the
// signature were wrong, or the recipient swapped, or the price understated, the
// server would refuse — and several of these tests prove exactly that by doing
// it on purpose.
//
// The one thing that does not happen is settlement, because moving tokens needs
// a funded wallet. That boundary is tested too: settle() must refuse rather than
// invent a receipt.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ethers } from "ethers";

import {
  X402_VERSION, HEADER_REQUIRED, HEADER_SIGNATURE, HEADER_RESPONSE, PAYMENT_KIND,
  encodeHeader, decodeHeader, chainIdFor, amountToCents, actionForRequirement,
  selectRequirement, signPayment, verifyPayment, settle, paymentRequired,
  settlementHeader, fetchWithMandate, readPaymentHeader, loadPaymentWallet,
} from "../src/x402.mjs";
import { decide as gateDecide, gateCliPath } from "../src/gate-cli.mjs";

// Base Sepolia USDC — a real deployment, so the EIP-712 domain is the real one.
// No token moves in these tests; the signature is over that domain regardless.
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const REQUIREMENT = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000", // 0.01 USDC, 6 decimals
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", decimals: 6 },
};

/** A resource server that really charges for one path. */
function startPaywall({ requirement = REQUIREMENT, onVerified } = {}) {
  const server = createServer(async (req, res) => {
    const payment = readPaymentHeader(req.headers);
    if (!payment) {
      const { status, headers, body } = paymentRequired({
        accepts: [requirement],
        resource: { url: `http://localhost${req.url}`, description: "one quote", mimeType: "application/json" },
      });
      res.writeHead(status, headers);
      return res.end(JSON.stringify(body));
    }
    // The server checks against ITS OWN requirement, never the one echoed back.
    const verdict = verifyPayment(payment, requirement);
    if (!verdict.isValid) {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ x402Version: X402_VERSION, error: verdict.invalidReason }));
    }
    onVerified?.(verdict, payment);
    res.writeHead(200, {
      "content-type": "application/json",
      // In production this receipt names a settled transaction. Here it names
      // the payer the signature actually recovered to, and says plainly that
      // nothing was broadcast — which is true, and checkable.
      ...settlementHeader({ success: true, payer: verdict.payer, network: requirement.network, settled: false }),
    });
    res.end(JSON.stringify({ quote: "MERIDIAN-PC-2026", price_cents: 250 }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}/quote`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

const MANDATE = {
  max_amount_cents: 500_000,
  allowed_assets: ["USDC", "USD"],
  allowed_kinds: ["rwa.buy", PAYMENT_KIND],
  allowed_counterparties: [PAY_TO],
  expires_at_secs: 0,
};

/** The gate, as the agent would call it: the compiled Rust, not a JS copy. */
const throughTheGate = (mandate = MANDATE) => async (action) => gateDecide({ action, mandate });
const needGate = () => (gateCliPath() ? false : "gate_cli is not built");

describe("header codec", () => {
  test("headers are base64-encoded JSON, round trip", () => {
    const obj = { x402Version: X402_VERSION, accepts: [REQUIREMENT] };
    const encoded = encodeHeader(obj);
    assert.match(encoded, /^[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(decodeHeader(encoded), obj);
  });

  test("a corrupt header decodes to null rather than throwing", () => {
    assert.equal(decodeHeader("not-base64-!!!"), null);
    assert.equal(decodeHeader(encodeHeader("x").slice(0, 3)), null);
    assert.equal(decodeHeader(undefined), null);
  });

  test("the legacy X-PAYMENT header is still read", () => {
    const payload = { x402Version: X402_VERSION, payload: {} };
    assert.deepEqual(readPaymentHeader({ "x-payment": encodeHeader(payload) }), payload);
    assert.equal(readPaymentHeader({}), null);
  });
});

describe("pricing a requirement for the mandate", () => {
  test("atomic units become cents", () => {
    assert.equal(amountToCents("10000", 6), 1); // 0.01 USDC
    assert.equal(amountToCents("1000000", 6), 100); // 1 USDC
    assert.equal(amountToCents("2500000000000000000", 18), 250); // 2.5 of an 18-decimal token
  });

  test("a fraction of a cent rounds UP, so nothing slips under a cap", () => {
    assert.equal(amountToCents("10001", 6), 2);
    assert.equal(amountToCents("1", 6), 1);
  });

  test("an asset that does not declare its decimals is refused, not guessed", () => {
    assert.throws(() => amountToCents("10000", undefined), /unknown decimals/);
    assert.throws(() => actionForRequirement({ ...REQUIREMENT, extra: { name: "USDC", version: "2" } }), /unknown decimals/);
  });

  test("an unsupported network is refused by name", () => {
    assert.equal(chainIdFor("eip155:84532"), 84532);
    assert.throws(() => chainIdFor("solana:mainnet"), /unsupported network/);
  });

  test("a requirement becomes an action the mandate can judge", () => {
    assert.deepEqual(actionForRequirement(REQUIREMENT), {
      kind: PAYMENT_KIND, asset: "USDC", amount_cents: 1, counterparty: PAY_TO,
    });
  });

  test("a scheme this client cannot satisfy is refused, listing what was offered", () => {
    assert.throws(
      () => selectRequirement({ accepts: [{ scheme: "upto", network: "eip155:84532" }] }),
      /no requirement matches scheme=exact.*upto/s,
    );
  });
});

describe("signing and verifying an EIP-3009 authorization", () => {
  const wallet = ethers.Wallet.createRandom();

  test("a signature recovers to the signer", async () => {
    const payment = await signPayment({ requirement: REQUIREMENT, wallet });
    assert.equal(payment.x402Version, X402_VERSION);
    assert.equal(payment.payload.authorization.from, wallet.address);
    assert.equal(payment.payload.authorization.to, PAY_TO);
    assert.equal(payment.payload.authorization.value, "10000");
    assert.match(payment.payload.signature, /^0x[0-9a-f]{130}$/i);

    const v = verifyPayment(payment, REQUIREMENT);
    assert.equal(v.isValid, true, v.invalidReason);
    assert.equal(v.payer, wallet.address);
  });

  test("each authorization gets its own nonce", async () => {
    const a = await signPayment({ requirement: REQUIREMENT, wallet });
    const b = await signPayment({ requirement: REQUIREMENT, wallet });
    assert.notEqual(a.payload.authorization.nonce, b.payload.authorization.nonce);
  });

  test("a tampered amount breaks the signature", async () => {
    const payment = await signPayment({ requirement: REQUIREMENT, wallet });
    payment.payload.authorization.value = "1000000";
    const v = verifyPayment(payment, REQUIREMENT);
    assert.equal(v.isValid, false);
    assert.match(v.invalidReason, /not produced by authorization.from/);
  });

  test("an authorization for a different payee does not pay this resource", async () => {
    const elsewhere = { ...REQUIREMENT, payTo: ethers.Wallet.createRandom().address };
    const payment = await signPayment({ requirement: elsewhere, wallet });
    const v = verifyPayment(payment, REQUIREMENT); // server's own requirement
    assert.equal(v.isValid, false);
    assert.match(v.invalidReason, /this resource is paid at/);
  });

  test("a cheaper authorization relabelled as the expensive one is refused", async () => {
    // The client signs for 1 unit, then rewrites `accepted` to claim it paid the
    // full price. The server compares against its own requirement, so this is
    // caught — the check exists precisely because `accepted` is client-supplied.
    const cheap = { ...REQUIREMENT, amount: "1" };
    const payment = await signPayment({ requirement: cheap, wallet });
    payment.accepted = REQUIREMENT;
    const v = verifyPayment(payment, REQUIREMENT);
    assert.equal(v.isValid, false);
    assert.match(v.invalidReason, /less than the required 10000/);
  });

  test("an expired authorization is refused", async () => {
    const payment = await signPayment({ requirement: REQUIREMENT, wallet, nowSecs: 1_000_000 });
    const v = verifyPayment(payment, REQUIREMENT, { nowSecs: 2_000_000 });
    assert.equal(v.isValid, false);
    assert.match(v.invalidReason, /expired/);
  });

  test("a signature over a different token contract does not transfer this one", async () => {
    const other = { ...REQUIREMENT, asset: ethers.Wallet.createRandom().address };
    const payment = await signPayment({ requirement: other, wallet });
    const v = verifyPayment(payment, REQUIREMENT);
    assert.equal(v.isValid, false, "an EIP-712 domain is per-contract; this must not verify");
  });

  test("a requirement with no EIP-712 domain is refused rather than assumed", async () => {
    const noDomain = { ...REQUIREMENT, extra: { decimals: 6 } };
    await assert.rejects(() => signPayment({ requirement: noDomain, wallet }), /name.*version/);
    assert.equal(verifyPayment({ x402Version: 2, payload: { signature: "0x", authorization: {} } }, noDomain).isValid, false);
  });
});

describe("settlement is not invented", () => {
  test("with no facilitator configured, settle refuses and says why", async () => {
    const wallet = ethers.Wallet.createRandom();
    const payment = await signPayment({ requirement: REQUIREMENT, wallet });
    const r = await settle(payment, REQUIREMENT, { facilitatorUrl: undefined });
    assert.equal(r.success, false);
    assert.equal(r.settled, false);
    assert.match(r.errorReason, /no facilitator configured/);
    assert.equal(r.payer, wallet.address);
  });

  test("with one configured, it posts the spec's /settle body", async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ success: true, payer: "0x1", transaction: "0xdead", network: "eip155:84532" }),
        { headers: { "content-type": "application/json" } });
    };
    const wallet = ethers.Wallet.createRandom();
    const payment = await signPayment({ requirement: REQUIREMENT, wallet });
    const r = await settle(payment, REQUIREMENT, { facilitatorUrl: "https://facilitator.test", fetchImpl });
    assert.equal(r.settled, true);
    assert.equal(seen.url, "https://facilitator.test/settle");
    assert.equal(seen.body.x402Version, X402_VERSION);
    assert.deepEqual(seen.body.paymentRequirements, REQUIREMENT);
    assert.ok(seen.body.paymentPayload.payload.signature);
  });

  test("no wallet means no payment, not a pretend one", () => {
    assert.equal(loadPaymentWallet({}), null);
    assert.ok(loadPaymentWallet({ X402_PRIVATE_KEY: ethers.Wallet.createRandom().privateKey }));
  });
});

describe("the mandate decides whether to pay — over real HTTP", () => {
  test("an in-mandate price is paid and the server verifies the signature", { skip: needGate() }, async (t) => {
    let verifiedPayer = null;
    const paywall = await startPaywall({ onVerified: (v) => { verifiedPayer = v.payer; } });
    t.after(paywall.close);

    const wallet = ethers.Wallet.createRandom();
    const r = await fetchWithMandate(paywall.url, { decide: throughTheGate(), wallet });

    assert.equal(r.paid, true, JSON.stringify(r.decision));
    assert.equal(r.response.status, 200);
    assert.deepEqual(await r.response.json(), { quote: "MERIDIAN-PC-2026", price_cents: 250 });
    // The server recovered the payer from the signature — not from anything the
    // client asserted about itself.
    assert.equal(verifiedPayer, wallet.address);
    assert.equal(r.receipt.payer, wallet.address);
    assert.equal(r.receipt.settled, false);
  });

  test("a payee the mandate does not list is refused before anything is signed", { skip: needGate() }, async (t) => {
    const stranger = ethers.Wallet.createRandom().address;
    const paywall = await startPaywall({ requirement: { ...REQUIREMENT, payTo: stranger } });
    t.after(paywall.close);

    const r = await fetchWithMandate(paywall.url, { decide: throughTheGate(), wallet: ethers.Wallet.createRandom() });
    assert.equal(r.paid, false);
    assert.equal(r.decision.decision, "rejected");
    assert.ok(r.decision.reasons.some((x) => x.includes(stranger)), r.decision.reasons.join(","));
    assert.equal(r.response.status, 402); // still unpaid, as it should be
  });

  test("a price over the cap is refused", { skip: needGate() }, async (t) => {
    // 10 USDC against a $0.05 ceiling.
    const paywall = await startPaywall({ requirement: { ...REQUIREMENT, amount: "10000000" } });
    t.after(paywall.close);

    const r = await fetchWithMandate(paywall.url, {
      decide: throughTheGate({ ...MANDATE, max_amount_cents: 5 }),
      wallet: ethers.Wallet.createRandom(),
    });
    assert.equal(r.paid, false);
    assert.ok(r.decision.reasons.some((x) => /exceeds mandate max/.test(x)));
  });

  test("a mandate that never mentions x402 refuses it — deny by default", { skip: needGate() }, async (t) => {
    const paywall = await startPaywall();
    t.after(paywall.close);

    const rwaOnly = { ...MANDATE, allowed_kinds: ["rwa.buy"] };
    const r = await fetchWithMandate(paywall.url, { decide: throughTheGate(rwaOnly), wallet: ethers.Wallet.createRandom() });
    assert.equal(r.paid, false);
    assert.ok(r.decision.reasons.some((x) => x.includes(PAYMENT_KIND)), r.decision.reasons.join(","));
  });

  test("an approved payment with no wallet is an error, never a skipped payment", { skip: needGate() }, async (t) => {
    const paywall = await startPaywall();
    t.after(paywall.close);
    await assert.rejects(
      () => fetchWithMandate(paywall.url, { decide: throughTheGate(), wallet: null }),
      /no wallet is configured/,
    );
  });

  test("a resource that costs nothing is fetched without a payment path at all", async (t) => {
    const server = createServer((req, res) => { res.writeHead(200); res.end("free"); });
    await new Promise((r) => server.listen(0, r));
    t.after(() => new Promise((r) => server.close(r)));

    const r = await fetchWithMandate(`http://127.0.0.1:${server.address().port}/`, {
      decide: () => { throw new Error("the gate must not be consulted when nothing is charged"); },
    });
    assert.equal(r.paid, false);
    assert.equal(r.response.status, 200);
  });

  test("the server's 402 carries the challenge in the spec header", async (t) => {
    const paywall = await startPaywall();
    t.after(paywall.close);
    const res = await fetch(paywall.url);
    assert.equal(res.status, 402);
    const challenge = decodeHeader(res.headers.get(HEADER_REQUIRED));
    assert.equal(challenge.x402Version, X402_VERSION);
    assert.deepEqual(challenge.accepts[0], REQUIREMENT);
  });

  test("a forged payment header does not open the paywall", async (t) => {
    const paywall = await startPaywall();
    t.after(paywall.close);

    const wallet = ethers.Wallet.createRandom();
    const payment = await signPayment({ requirement: REQUIREMENT, wallet });
    payment.payload.authorization.to = ethers.Wallet.createRandom().address; // redirect the money

    const res = await fetch(paywall.url, { headers: { [HEADER_SIGNATURE]: encodeHeader(payment) } });
    assert.equal(res.status, 402);
    assert.equal(res.headers.get(HEADER_RESPONSE), null);
    assert.match((await res.json()).error, /not produced by authorization.from/);
  });
});
