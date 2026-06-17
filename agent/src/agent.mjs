// Gatekeeper Agent runtime — chains every Terminal 3 SDK layer for one action:
//   1. IDENTITY : authenticate the agent (did:t3n) over an encrypted TEE session
//   2. VC GATE  : verify a BBS+ predicate credential -> eligibility without PII
//   3. MANDATE  : invoke the gate-contract inside the TEE to enforce the mandate
//   4. AUDIT    : emit one structured audit row (approved AND rejected)
//   5. DISPATCH : on approval, sign the outbound action request (Web Bot Auth /
//                 RFC 9421) so the destination can verify it came from this agent
import * as vcCore from "@terminal3/vc_core";
import * as bbs from "@terminal3/bbs_vc";
import { connect, CONTRACT_TAIL, CONTRACT_VERSION, MANDATE } from "./lib.mjs";
import { generateAgentKey, signRequest, verifyRequest } from "./web-bot-auth.mjs";
import { buildOptionsFromEnv, checkRevocation } from "./revocation.mjs";

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

// The agent's Web Bot Auth signing key (RFC 9421). In production this key is
// published in a key directory the destination resolves via `keyid`.
const wba = generateAgentKey();
const WBA_KEYID = `${agentDid}#wba`;
const ACTION_ENDPOINT = "https://broker.example/v1/orders"; // the approved action's destination

// Optional pacing for demo recording: `DEMO_PAUSE_MS=2500 npm run demo` waits
// between scenarios so a live voice-over can land on each line. Default 0 (off).
const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS || 0);
const pace = () => (PAUSE_MS > 0 ? new Promise((r) => setTimeout(r, PAUSE_MS)) : Promise.resolve());

// 2. VC GATE — verify eligibility before any action is attempted.
const subject = new bbs.BbsDID(vcCore.randomKeyBls());
const { vc, issuerDid } = await issueEligibilityCredential(subject.did);
const verdict = await bbs.verifyBbsVCW3c(vc);
const eligible = verdict.isValid === true && vc.credentialSubject.accreditedInvestor === true;
console.log(`[2] VC GATE    issuer=${issuerDid.slice(0, 24)}…  verify=${verdict.isValid}  predicate=${vc.credentialSubject.accreditedInvestor}  -> eligible=${eligible}`);
if (!eligible) { console.log("ABORT: eligibility gate failed — no action attempted."); process.exit(0); }

// 2b. REVOCATION pre-gate — a revoked credential is a kill-switch even if the
// BBS+ proof still verifies. Config-gated: skipped (fail-open) when no registry
// is set; set REVOCATION_REGISTRY_ADDRESS + REVOCATION_RPC_URL in .env to enforce.
const revOptions = await buildOptionsFromEnv();
const rev = await checkRevocation("urn:vc:eligibility:demo", issuerDid, { options: revOptions, failClosed: false });
console.log(`[2b] REVOCATION ${rev.checked ? (rev.revoked ? "REVOKED" : "valid (not revoked)") : "skipped"}  (${rev.reason})`);
if (rev.revoked) { console.log("ABORT: credential revoked — no action attempted."); process.exit(0); }

// Trim a (sometimes huge / obfuscated) SDK error down to one readable line.
const briefErr = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160);

// 3 + 4. MANDATE (TEE) + AUDIT
async function act(label, action, mandate = MANDATE) {
  await pace(); // recording pacing (no-op unless DEMO_PAUSE_MS is set)
  let d;
  try {
    d = await tenant.contracts.execute(CONTRACT_TAIL, {
      version: CONTRACT_VERSION, functionName: "evaluate", input: { action, mandate },
    });
  } catch (e) {
    console.log(`\n[3] MANDATE    ${label}\n               TEE call failed: ${briefErr(e)}`);
    return "error";
  }
  console.log(`\n[3] MANDATE    ${label}\n               TEE decision = ${d.decision.toUpperCase()}` +
    (d.reasons.length ? `  reasons=${JSON.stringify(d.reasons)}` : ""));
  console.log(`[4] AUDIT      ${JSON.stringify({ ts: d.evaluated_at_secs, agentDid, issuerDid, eligibility: "bbs+ verified", action, decision: d.decision, reasons: d.reasons })}`);

  // 5. DISPATCH — only an APPROVED action is sent on. The request is signed
  // (web-bot-auth) so the destination can verify the caller, AND it is executed
  // FROM INSIDE THE TEE via the contract's `dispatch_action` (host `http`), so
  // the outbound call leaves the enclave — where credentials can be injected via
  // http-with-placeholders without the agent ever holding them. Real egress is
  // gated by the host's per-contract authorised_hosts allowlist.
  if (d.decision === "approved") {
    const body = JSON.stringify(action);
    const req = { method: "POST", url: ACTION_ENDPOINT, body };
    const headers = signRequest(req, { privateKey: wba.privateKey, keyid: WBA_KEYID });
    const verifiable = verifyRequest(req, headers, wba.publicKey); // covers method+authority+path+body
    console.log(`[5] DISPATCH   POST ${ACTION_ENDPOINT}  signed (web-bot-auth, body digest)  destination-verifiable=${verifiable}`);
    try {
      const teeResp = await tenant.contracts.execute(CONTRACT_TAIL, {
        version: CONTRACT_VERSION, functionName: "dispatch_action",
        input: { url: ACTION_ENDPOINT, method: "POST", body },
      });
      const out = teeResp.ok ? `executed in TEE (HTTP ${teeResp.code})` : `egress gated: ${teeResp.error}`;
      console.log(`               in-TEE call -> ${out}`);
    } catch (e) {
      console.log(`               in-TEE call -> failed: ${briefErr(e)}`);
    }
  } else {
    console.log(`[5] DISPATCH   skipped — action not approved, nothing sent`);
  }
  return d.decision;
}

// Core mandate (amount / asset / kind)
await act("buy $1,000 of USDC RWA", { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 });
await act("buy $9,000 of USDC RWA (over mandate)", { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 });
await act("swap into DOGE (asset + kind not allowed)", { kind: "swap", asset: "DOGE", amount_cents: 100 });

// Counterparty allow-list (pay only approved payees)
const CP_MANDATE = { ...MANDATE, allowed_counterparties: ["did:t3n:acme-treasury"] };
await act("pay APPROVED counterparty (acme-treasury)",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, counterparty: "did:t3n:acme-treasury" }, CP_MANDATE);
await act("pay UNKNOWN counterparty",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, counterparty: "did:t3n:unknown-payee" }, CP_MANDATE);

// Valid-after window (a future-dated authorization not yet active)
const FUTURE_MANDATE = { ...MANDATE, valid_after_secs: 4_102_444_800 }; // year 2100
await act("future-dated mandate (not yet active)",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 }, FUTURE_MANDATE);

console.log("\n✅ Gatekeeper Agent: identity + BBS+ VC gate + hardware mandate + audit — complete.");
