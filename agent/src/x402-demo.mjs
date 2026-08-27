// `npm run demo:x402` — watch the mandate decide whether to pay for something.
//
// A real HTTP server on localhost charges for one resource. The agent fetches
// it, gets a 402, turns the payment requirement into an Action, and asks the
// compiled contract logic. Only on approval does a signature exist; the server
// then recovers the payer from that signature before serving anything.
//
// Nothing here is a fixture. The 402, the headers, the EIP-712 signature and the
// ecrecover are the same code the agent uses against a real paywall. What does
// NOT happen is settlement — no tokens move, and the receipt says so.
import { createServer } from "node:http";
import {
  paymentRequired, readPaymentHeader, verifyPayment, settlementHeader,
  fetchWithMandate, ephemeralWallet, PAYMENT_KIND,
} from "./x402.mjs";
import { decide, gateCliPath, BUILD_HINT } from "./gate-cli.mjs";

if (!gateCliPath()) {
  console.error(`gate_cli is not built, so there is nothing to decide with.\n  ${BUILD_HINT}`);
  process.exit(1);
}

// Base Sepolia USDC — a real deployment, so the EIP-712 domain is the real one.
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const STRANGER = "0x000000000000000000000000000000000000dEaD";
const requirement = (amount, payTo = PAY_TO) => ({
  scheme: "exact", network: "eip155:84532", amount: String(amount),
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo, maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", decimals: 6 },
});

// What the platform lets this agent spend on paid APIs. Its own kind, and its
// own much smaller ceiling than the trading mandate.
const MANDATE = {
  max_amount_cents: 500, // $5.00 for the whole category
  allowed_assets: ["USDC"],
  allowed_kinds: [PAYMENT_KIND],
  allowed_counterparties: [PAY_TO],
  expires_at_secs: 0,
};

let served = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const req_ = requirement(url.searchParams.get("price") ?? "10000", url.searchParams.get("payTo") ?? PAY_TO);
  const payment = readPaymentHeader(req.headers);
  if (!payment) {
    const { status, headers, body } = paymentRequired({
      accepts: [req_],
      resource: { url: "/quote", description: "one Meridian fund quote", mimeType: "application/json" },
    });
    res.writeHead(status, headers);
    return res.end(JSON.stringify(body));
  }
  const v = verifyPayment(payment, req_);
  if (!v.isValid) {
    res.writeHead(402, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: v.invalidReason }));
  }
  served++;
  res.writeHead(200, {
    "content-type": "application/json",
    ...settlementHeader({ success: true, payer: v.payer, network: req_.network, settled: false }),
  });
  res.end(JSON.stringify({ quote: "MERIDIAN-PC-2026", nav_cents: 10_250 }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const wallet = ephemeralWallet(); // real key, no money — see the note above
console.log(`x402 — the mandate decides whether to pay`);
console.log(`  paywall  ${origin}/quote   (a real HTTP 402 from this process)`);
console.log(`  wallet   ${wallet.address}   (ephemeral, unfunded: signatures are real, settlement is not)`);
console.log(`  mandate  max $${(MANDATE.max_amount_cents / 100).toFixed(2)} · ${PAYMENT_KIND} only · payee ${PAY_TO}\n`);

const scenarios = [
  { label: "a $0.01 quote from an approved provider", query: "" },
  { label: "the same price, from a payee the mandate never listed", query: `?payTo=${STRANGER}` },
  { label: "a $10.00 quote — over the whole API budget", query: "?price=10000000" },
  {
    label: "a mandate that only allows trading, not paying for APIs",
    query: "",
    mandate: { ...MANDATE, allowed_kinds: ["rwa.buy"] },
  },
];

for (const s of scenarios) {
  const r = await fetchWithMandate(`${origin}/quote${s.query}`, {
    decide: (action) => decide({ action, mandate: s.mandate ?? MANDATE }),
    wallet,
  });
  console.log(`▸ ${s.label}`);
  console.log(`    price seen by the mandate  ${r.action.amount_cents}¢ of ${r.action.asset} to ${r.action.counterparty}`);
  if (r.paid) {
    console.log(`    PAID  → HTTP ${r.response.status}  ${JSON.stringify(await r.response.json())}`);
    console.log(`    the server recovered the payer from the signature: ${r.receipt.payer}`);
    console.log(`    settled=${r.receipt.settled} — the authorisation is real, nothing was broadcast\n`);
  } else {
    console.log(`    NOT PAID — ${r.decision.reasons.join("; ")}`);
    console.log(`    nothing was signed, and the resource is still ${r.response.status}\n`);
  }
}

console.log(`The paywall served ${served} of ${scenarios.length} requests. The other ${scenarios.length - served} never`);
console.log(`reached a signature, because a gate that only says yes is not a gate.`);
server.close();
