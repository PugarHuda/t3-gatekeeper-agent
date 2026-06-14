// Gatekeeper Agent runtime — chains every Terminal 3 SDK layer for one action:
//   1. IDENTITY : authenticate the agent (did:t3n) over an encrypted TEE session
//   2. VC GATE  : verify a BBS+ predicate credential -> eligibility without PII
//   3. MANDATE  : invoke the gate-contract inside the TEE to enforce the mandate
//   4. AUDIT    : emit one structured audit row (approved AND rejected)
import * as vcCore from "@terminal3/vc_core";
import * as bbs from "@terminal3/bbs_vc";
import { connect, CONTRACT_TAIL, CONTRACT_VERSION, MANDATE } from "./lib.mjs";

// A trusted KYC issuer attests ONLY the predicate the action needs — never the
// underlying net worth, name, or DOB. (Predicate-credential model: see README.)
async function issueEligibilityCredential(subjectDid) {
  const issuer = new bbs.BbsDID(vcCore.randomKeyBls());
  const vc = await bbs.createBbsCredential(
    issuer,
    new vcCore.DID(...vcCore.getMethodIdentifier(subjectDid)),
    { accreditedInvestor: true, jurisdiction: "SG" },
    ["VerifiableCredential", "AccreditationCredential"],
    undefined, undefined, undefined, undefined, true,
  );
  return { vc, issuerDid: issuer.did };
}

const { client, tenant, agentDid } = await connect(new URL("../.env", import.meta.url));
console.log(`[1] IDENTITY   ${agentDid}`);

// 2. VC GATE — verify eligibility before any action is attempted.
const subject = new bbs.BbsDID(vcCore.randomKeyBls());
const { vc, issuerDid } = await issueEligibilityCredential(subject.did);
const verdict = await bbs.verifyBbsVCW3c(vc);
const eligible = verdict.isValid === true && vc.credentialSubject.accreditedInvestor === true;
console.log(`[2] VC GATE    issuer=${issuerDid.slice(0, 24)}…  verify=${verdict.isValid}  predicate=${vc.credentialSubject.accreditedInvestor}  -> eligible=${eligible}`);
if (!eligible) { console.log("ABORT: eligibility gate failed — no action attempted."); process.exit(0); }

// 3 + 4. MANDATE (TEE) + AUDIT
async function act(label, action) {
  const d = await tenant.contracts.execute(CONTRACT_TAIL, {
    version: CONTRACT_VERSION, functionName: "evaluate", input: { action, mandate: MANDATE },
  });
  console.log(`\n[3] MANDATE    ${label}\n               TEE decision = ${d.decision.toUpperCase()}` +
    (d.reasons.length ? `  reasons=${JSON.stringify(d.reasons)}` : ""));
  console.log(`[4] AUDIT      ${JSON.stringify({ ts: d.evaluated_at_secs, agentDid, issuerDid, eligibility: "bbs+ verified", action, decision: d.decision, reasons: d.reasons })}`);
  return d.decision;
}

await act("buy $1,000 of USDC RWA", { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 });
await act("buy $9,000 of USDC RWA (over mandate)", { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 });
await act("swap into DOGE (asset + kind not allowed)", { kind: "swap", asset: "DOGE", amount_cents: 100 });

console.log("\n✅ Gatekeeper Agent: identity + BBS+ VC gate + hardware mandate + audit — complete.");
