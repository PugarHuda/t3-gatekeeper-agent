// `npm run x402:settle` — move real (testnet) money through the mandate.
//
// Everything before this was verification: a signature the token would accept,
// a facilitator that agreed. This is the transfer. It is wired the way x402 is
// meant to be wired — the RESOURCE SERVER verifies and settles through the
// facilitator, and the agent only ever signs — so what runs here is the same
// sequence a real paywall runs, not a shortcut through our own code.
//
//   agent  ── GET ──▶ paywall ── 402 + requirement ──▶ agent
//   agent: mandate decides · signs EIP-3009 · retries with PAYMENT-SIGNATURE
//   paywall: facilitator /verify · facilitator /settle (broadcasts) · 200 + receipt
//
// The payer is X402_PRIVATE_KEY. The payee is the ERC-8004 owner wallet — a
// second wallet this repo controls — so the balances on both sides can be
// read before and after, and the transaction the facilitator returns can be
// checked on chain rather than taken on faith.
//
// Amount: 0.01 USDC. The mandate here allows exactly that much and only to
// that payee; a bigger price or a different payee is refused before a
// signature exists, the same as everywhere else in this repo.
import { createServer } from "node:http";
import { ethers } from "ethers";
import {
  paymentRequired, readPaymentHeader, settlementHeader, fetchWithMandate,
  loadPaymentWallet, decodeHeader, PAYMENT_KIND, X402_VERSION,
} from "./x402.mjs";
import { decide, gateCliPath, BUILD_HINT } from "./gate-cli.mjs";
import { loadEnv } from "./lib.mjs";

try { loadEnv(new URL("../.env", import.meta.url)); } catch { /* .env optional */ }

if (!gateCliPath()) { console.error(`gate_cli is not built.\n  ${BUILD_HINT}`); process.exit(1); }

const FACILITATOR = (process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator").replace(/\/$/, "");
const RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
const PRICE = "10000"; // 0.01 USDC

// `--tx 0x…` re-checks a settlement that already happened, without paying again.
const argTx = process.argv.indexOf("--tx");
const ONLY_VERIFY = argTx > -1 ? process.argv[argTx + 1] : null;

const payer = loadPaymentWallet();
if (!payer) { console.error("X402_PRIVATE_KEY is not set — nothing to pay with. `npm run x402:verify` prints the address to fund."); process.exit(1); }
const payee = process.env.ERC8004_PRIVATE_KEY ? new ethers.Wallet(process.env.ERC8004_PRIVATE_KEY).address : null;
if (!payee) { console.error("ERC8004_PRIVATE_KEY is not set — it is the payee here, so both sides are ours."); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC);
const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], provider);
const fmt = (v) => ethers.formatUnits(v, 6);

const requirement = {
  scheme: "exact", network: NETWORK, amount: PRICE, asset: USDC, payTo: payee, maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", decimals: 6 },
};

// ── the resource server: verifies and settles through the facilitator ──────
let settlement = null;
const paywall = createServer(async (req, res) => {
  const payment = readPaymentHeader(req.headers);
  if (!payment) {
    const { status, headers, body } = paymentRequired({
      accepts: [requirement],
      resource: { url: "/quote", description: "one Meridian fund quote", mimeType: "application/json" },
    });
    res.writeHead(status, headers);
    return res.end(JSON.stringify(body));
  }
  const post = (path) => fetch(`${FACILITATOR}${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: requirement }),
    signal: AbortSignal.timeout(60_000),
  }).then((r) => r.json());

  const verdict = await post("/verify");
  if (!verdict.isValid) {
    res.writeHead(402, { "content-type": "application/json" });
    return res.end(JSON.stringify({ x402Version: X402_VERSION, error: verdict.invalidReason }));
  }
  settlement = await post("/settle");
  if (!settlement.success) {
    res.writeHead(402, { "content-type": "application/json" });
    return res.end(JSON.stringify({ x402Version: X402_VERSION, error: settlement.errorReason }));
  }
  res.writeHead(200, { "content-type": "application/json", ...settlementHeader(settlement) });
  res.end(JSON.stringify({ quote: "MERIDIAN-PC-2026", nav_cents: 10_250 }));
});
await new Promise((r) => paywall.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${paywall.address().port}/quote`;

// ── before ──────────────────────────────────────────────────────────────────
let receipt;
if (ONLY_VERIFY) {
  receipt = { transaction: ONLY_VERIFY, payer: payer.address };
  console.log(`x402 settlement — re-checking ${ONLY_VERIFY} on chain (no payment made)`);
} else {
  const before = { payer: await usdc.balanceOf(payer.address), payee: await usdc.balanceOf(payee) };
  console.log(`x402 settlement — 0.01 USDC through the mandate, on Base Sepolia`);
  console.log(`  facilitator  ${FACILITATOR}`);
  console.log(`  payer        ${payer.address}   ${fmt(before.payer)} USDC`);
  console.log(`  payee        ${payee}   ${fmt(before.payee)} USDC   (our ERC-8004 owner wallet)`);
  if (before.payer < BigInt(PRICE)) { console.error("\nThe payer holds less than the price. Nothing sent."); process.exit(1); }

  // The mandate: this payee, this category, a ceiling just above the price.
  const MANDATE = {
    max_amount_cents: 5, allowed_assets: ["USDC"], allowed_kinds: [PAYMENT_KIND],
    allowed_counterparties: [payee], expires_at_secs: 0,
  };

  // ── the agent ─────────────────────────────────────────────────────────────
  console.log(`\nagent fetches ${url}`);
  const r = await fetchWithMandate(url, { decide: (action) => decide({ action, mandate: MANDATE }), wallet: payer });
  console.log(`  mandate saw   ${r.action.amount_cents}¢ ${r.action.asset} → ${r.action.counterparty}`);
  if (!r.paid) {
    console.log(`  NOT PAID — ${r.decision?.reasons?.join("; ") ?? `HTTP ${r.response.status}`}`);
    paywall.close(); process.exit(1);
  }
  receipt = decodeHeader(r.response.headers.get("payment-response"));
  console.log(`  PAID → HTTP ${r.response.status}  ${JSON.stringify(await r.response.json())}`);
  console.log(`  receipt       success=${receipt?.success} network=${receipt?.network} payer=${receipt?.payer}`);
  console.log(`  transaction   ${receipt?.transaction}`);
}

// ── after: the chain, not the receipt ───────────────────────────────────────
//
// Balances are read at EXPLICIT blocks. A public RPC behind a load balancer
// will happily answer "latest" from a node a few blocks behind the one that
// mined the transfer, and the first run of this script read 20.0 → 20.0 for
// exactly that reason while the Transfer event sat in the receipt. The log is
// the primary evidence; the balances at (block-1, block) are the second.
let failed = 0;
const check = (label, pass, detail = "") => { if (!pass) failed++; console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`); };

console.log(`\nchecking the chain`);
let tx = null;
for (let i = 0; i < 20 && !tx; i++) {
  tx = await provider.getTransactionReceipt(receipt?.transaction).catch(() => null);
  if (!tx) await new Promise((s) => setTimeout(s, 3000));
}
check("the facilitator's transaction is mined", tx?.status === 1, tx ? `block ${tx.blockNumber}` : "not found after 60s");
check("it was sent to the USDC contract", tx?.to?.toLowerCase() === USDC.toLowerCase(), tx?.to);
check("and the payer paid no gas — the facilitator broadcast it", tx && tx.from.toLowerCase() !== payer.address.toLowerCase(), `from ${tx?.from}`);

const transfers = (tx?.logs ?? []).flatMap((l) => {
  try { const e = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]).parseLog(l); return e ? [e.args] : []; } catch { return []; }
});
const ours = transfers.find((t) => t.from.toLowerCase() === payer.address.toLowerCase() && t.to.toLowerCase() === payee.toLowerCase());
check("the receipt carries a USDC Transfer from the payer to the payee for exactly 0.01",
  ours && ours.value === BigInt(PRICE), ours ? `${ours.from} → ${ours.to}  ${fmt(ours.value)} USDC` : `${transfers.length} transfer(s), none from payer to payee`);

if (tx) {
  const at = (addr, block) => usdc.balanceOf(addr, { blockTag: block });
  const [p0, p1, q0, q1] = await Promise.all([
    at(payer.address, tx.blockNumber - 1), at(payer.address, tx.blockNumber),
    at(payee, tx.blockNumber - 1), at(payee, tx.blockNumber),
  ]);
  check("the payer is exactly 0.01 USDC lighter across that block", p0 - p1 === BigInt(PRICE), `${fmt(p0)} → ${fmt(p1)}`);
  check("the payee is exactly 0.01 USDC heavier across that block", q1 - q0 === BigInt(PRICE), `${fmt(q0)} → ${fmt(q1)}`);
}
console.log(`  https://sepolia.basescan.org/tx/${receipt?.transaction}`);

paywall.close();
console.log(failed === 0
  ? `\nMoney moved, through the mandate, settled by a third party, confirmed on chain.`
  : `\n${failed} check(s) failed — the receipt and the chain disagree. Do not describe this as settled.`);
process.exit(failed === 0 ? 0 : 1);
