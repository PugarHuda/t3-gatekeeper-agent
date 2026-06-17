// Gatekeeper Agent (selective-disclosure variant).
//
// Same core flow as agent.mjs, but the eligibility gate now uses TRUE BBS+
// selective disclosure: the issuer signs the user's FULL KYC record once, the
// holder derives a proof revealing ONLY `accreditedInvestor`, and the agent
// verifies it without ever seeing the name / DOB / net worth.
import { issueRecord, discloseOnly, verifyDisclosure } from "./selective-disclosure.mjs";
import { connect, CONTRACT_TAIL, CONTRACT_VERSION, MANDATE } from "./lib.mjs";

const { tenant, agentDid } = await connect(new URL("../.env", import.meta.url));
console.log(`[1] IDENTITY   ${agentDid}`);

// --- 2. VC GATE via selective disclosure ---
// Issuer (trusted KYC provider) signs the full record.
const fullRecord = {
  fullName: "Aisha Rahman",
  dateOfBirth: "1990-04-12",
  netWorthUSD: 5_000_000,
  accreditedInvestor: true,
};
const cred = await issueRecord(fullRecord);

// Holder derives a proof that reveals ONLY accreditedInvestor.
const disclosure = await discloseOnly(cred, ["accreditedInvestor"]);

// Agent verifies — it only ever sees the disclosed claim.
const verified = await verifyDisclosure(disclosure);
const disclosedObj = Object.fromEntries(disclosure.disclosed.map((d) => [d.key, d.value]));
const eligible = verified && disclosedObj.accreditedInvestor === true;

console.log(`[2] VC GATE    selective disclosure`);
console.log(`               issuer signed : ${Object.keys(fullRecord).join(", ")}`);
console.log(`               agent SEES     : ${JSON.stringify(disclosedObj)}`);
console.log(`               agent HIDDEN   : fullName, dateOfBirth, netWorthUSD (never revealed)`);
console.log(`               proof verified : ${verified}  -> eligible=${eligible}`);
if (!eligible) { console.log("ABORT: eligibility gate failed."); process.exit(0); }

// --- 3 + 4. MANDATE (TEE) + AUDIT ---
async function act(label, action) {
  const d = await tenant.contracts.execute(CONTRACT_TAIL, {
    version: CONTRACT_VERSION, functionName: "evaluate", input: { action, mandate: MANDATE },
  });
  console.log(`\n[3] MANDATE    ${label}\n               TEE decision = ${d.decision.toUpperCase()}` +
    (d.reasons.length ? `  reasons=${JSON.stringify(d.reasons)}` : ""));
  console.log(`[4] AUDIT      ${JSON.stringify({ ts: d.evaluated_at_secs, agentDid, eligibility: "bbs+ selective-disclosure", disclosed: disclosedObj, action, decision: d.decision, reasons: d.reasons })}`);
}

await act("buy $1,000 of USDC RWA", { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 });
await act("buy $9,000 of USDC RWA (over mandate)", { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 });

console.log("\n✅ Gatekeeper Agent (SD): identity + selective-disclosure gate + hardware mandate + audit.");
