// QA console — drives the contract's REAL decision logic from a browser.
//
// POST /api/decide spawns `gate_cli`, the host build of the same Rust
// `gate::decide()` the enclave runs. The rules are never reimplemented in JS,
// so a passing test here is evidence about the contract, not about a mock.
//
// This is the offline half of QA: mandate logic, every branch, no credits.
// The enclave-only properties (KV mandate, atomic dispatch, TEE attestation)
// are proven separately against testnet — see submission/VERIFICATION.md.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
// The agent's own implementations — not copies. If either drifts, the
// cross-language conformance test in agent/test catches it.
import { bindCredential } from "../agent/src/credential-binding.mjs";
import { decide } from "../agent/src/gate-cli.mjs";
import {
  paymentRequired, readPaymentHeader, verifyPayment, settlementHeader, fetchWithMandate,
  ephemeralWallet,
} from "../agent/src/x402.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The mandate the platform provisioned for this investor. In production the
// enclave reads this from KV; here it is the fixture the rules are applied to.
export const MANDATE = {
  max_amount_cents: 500_000,
  allowed_assets: ["USDC", "USD"],
  allowed_kinds: ["rwa.buy"],
  allowed_counterparties: ["did:t3n:meridian-fund"],
  expires_at_secs: 0,
  valid_after_secs: 0,
};

// The console evaluates at a fixed instant so a scenario means the same thing
// today as it did when the screenshots were taken.
const NOW = 1786000000;

// Base Sepolia USDC. A real deployment, so the EIP-712 domain a signature is
// made against is the real one — the signature would be valid on-chain if the
// wallet held anything.
export const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const requirementFor = (params) => ({
  scheme: "exact",
  network: "eip155:84532",
  amount: String(params.get("price") ?? "10000"),
  asset: USDC_BASE_SEPOLIA,
  payTo: params.get("payTo") ?? PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", decimals: 6 },
});

/** What the platform lets this agent spend on paid APIs. Its own kind, so a
 *  mandate written for buying RWA does not silently also fund API calls. */
export const X402_MANDATE = {
  max_amount_cents: 500,
  allowed_assets: ["USDC"],
  allowed_kinds: ["x402.pay"],
  allowed_counterparties: [PAY_TO],
  expires_at_secs: 0,
  valid_after_secs: 0,
};

const server = createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const body = async (r) => { let raw = ""; for await (const c of r) raw += c; return raw; };

  if (req.method === "POST" && req.url === "/api/decide") {
    try {
      const parsed = JSON.parse(await body(req));
      if (!parsed?.action?.kind) return send(400, { error: "action.kind is required" });
      return send(200, await decide(parsed));
    } catch (e) {
      return send(400, { error: String(e.message ?? e) });
    }
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return send(200, await readFile(path.join(HERE, "index.html"), "utf8"), "text/html");
  }
  // The console plays the agent's part here: it binds a credential to an action
  // using the agent's OWN module, so the page never reimplements the commitment.
  // That is the same rule as the decision logic — one implementation, exercised,
  // not a copy that agrees with itself.
  if (req.method === "POST" && req.url === "/api/bind") {
    try {
      const parsed = JSON.parse(await body(req));
      return send(200, bindCredential(
        {
          issuer: parsed.issuer ?? "did:key:kyc-provider",
          subject: parsed.subject ?? "did:t3n:investor",
          claims: parsed.claims ?? { accreditedInvestor: true },
          verified: true,
        },
        parsed.action,
      ));
    } catch (e) {
      return send(400, { error: String(e.message ?? e) });
    }
  }

  if (req.method === "GET" && req.url === "/api/mandate") return send(200, MANDATE);

  // ── a real paywall, on this server ────────────────────────────────────────
  //
  // Not a fixture: this path answers a spec-shaped HTTP 402, and when the retry
  // arrives it recovers the payer from the EIP-3009 signature before serving
  // anything. The console's x402 buttons make the agent fetch THIS url, so the
  // browser is watching a real 402 → sign → verify → 200 round trip.
  //
  // Nothing settles. The signing wallet is generated per request: a real key
  // producing real signatures, holding no money — which is the honest shape for
  // a QA console, and is stated in the response as `settled: false`.
  if (req.url?.startsWith("/api/paywall")) {
    const url = new URL(req.url, "http://localhost");
    const requirement = requirementFor(url.searchParams);
    const payment = readPaymentHeader(req.headers);
    if (!payment) {
      const { status, headers, body } = paymentRequired({
        accepts: [requirement],
        resource: { url: "/api/paywall", description: "one fund quote", mimeType: "application/json" },
      });
      res.writeHead(status, headers);
      return res.end(JSON.stringify(body));
    }
    const verdict = verifyPayment(payment, requirement);
    if (!verdict.isValid) return send(402, { error: verdict.invalidReason });
    res.writeHead(200, {
      "content-type": "application/json",
      ...settlementHeader({ success: true, payer: verdict.payer, network: requirement.network, settled: false }),
    });
    return res.end(JSON.stringify({ quote: "MERIDIAN-PC-2026", nav_cents: 10_250 }));
  }

  // Drive the whole x402 flow: fetch the paywall above, let the mandate decide,
  // sign only on approval, retry. Returns what actually happened.
  if (req.method === "POST" && req.url === "/api/x402") {
    try {
      const { mandate = X402_MANDATE, price = "10000", payTo = PAY_TO } = JSON.parse(await body(req));
      const wallet = ephemeralWallet();
      const target = `http://127.0.0.1:${server.address().port}/api/paywall` +
        `?price=${encodeURIComponent(price)}&payTo=${encodeURIComponent(payTo)}`;
      const r = await fetchWithMandate(target, {
        decide: (action) => decide({ action, mandate, now_secs: NOW }),
        wallet,
      });
      return send(200, {
        paid: r.paid,
        status: r.response.status,
        action: r.action ?? null,
        reasons: r.decision?.reasons ?? [],
        decision: r.decision?.decision ?? "not-required",
        payer: r.receipt?.payer ?? null,
        settled: r.receipt?.settled ?? false,
        signer: wallet.address,
      });
    } catch (e) {
      return send(400, { error: String(e.message ?? e) });
    }
  }

  send(404, { error: "not found" });
});

export function start(port = 0) {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// `node server.mjs` runs it; importing it (the tests) does not.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const s = await start(4173);
  console.log(`QA console on http://localhost:${s.address().port}`);
}
