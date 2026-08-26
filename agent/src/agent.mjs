// Gatekeeper Agent runtime — chains every Terminal 3 SDK layer for one action:
//   1. IDENTITY : authenticate the agent (did:t3n) over an encrypted TEE session
//   2. VC GATE  : verify a BBS+ predicate credential -> eligibility without PII
//   3. MANDATE  : invoke the gate-contract inside the TEE to enforce the mandate
//   4. AUDIT    : emit one structured audit row (approved AND rejected)
//   5. DISPATCH : on approval, sign the outbound action request (Web Bot Auth /
//                 RFC 9421) so the destination can verify it came from this agent
import * as vcCore from "@terminal3/vc_core";
import * as bbs from "@terminal3/bbs_vc";
import { connect, CONTRACT_TAIL, CONTRACT_VERSION, MANDATE, actionEndpoint } from "./lib.mjs";
import { loadAgentKey, signRequest, verifyRequest } from "./web-bot-auth.mjs";
import { buildOptionsFromEnv, checkCredentialStatus } from "./revocation.mjs";
import { statusEntry, STATUS_LIST_URL, DEMO_REVOKED_INDEX } from "./status-list.mjs";
import { bindCredential } from "./credential-binding.mjs";
import { randomUUID } from "node:crypto";

// A trusted KYC issuer attests ONLY the predicate the action needs — never the
// underlying net worth, name, or DOB. (Predicate-credential model: see README.)
async function issueEligibilityCredential(subjectDid, statusListIndex = 0) {
  const issuer = new bbs.BbsDID(vcCore.randomKeyBls());
  const vc = await bbs.createBbsCredential(
    issuer,
    new vcCore.DID(...vcCore.getMethodIdentifier(subjectDid)),
    { accreditedInvestor: true, jurisdiction: "SG" },
    ["VerifiableCredential", "AccreditationCredential"],
    undefined, undefined, undefined, undefined, true,
  );
  // Where this credential's revocation state is published. The holder is one
  // bit in a list of 131,072, so checking it tells the issuer nothing about who
  // is transacting — see src/status-list.mjs.
  vc.id ??= `urn:vc:eligibility:${statusListIndex}`;
  vc.credentialStatus = statusEntry({
    statusListCredential: STATUS_LIST_URL,
    statusListIndex,
  });
  return { vc, issuerDid: issuer.did };
}

const { client, tenant, agentDid } = await connect(new URL("../.env", import.meta.url));
console.log(`[1] IDENTITY   ${agentDid}`);

// The agent's Web Bot Auth signing key (RFC 9421). Persisted via WBA_PRIVATE_KEY
// so it matches the published directory a destination resolves `keyid` against:
//   https://gatekeeper-evidence.vercel.app/.well-known/http-message-signatures-directory
// Without it the key is ephemeral and no stranger can verify our signatures.
const wba = loadAgentKey();
const WBA_KEYID = `${agentDid}#wba`;
if (wba.ephemeral) {
  console.log("[!] WBA_PRIVATE_KEY unset — signing with an ephemeral key, not the published one");
}
const ACTION_ENDPOINT = actionEndpoint(); // the approved action's destination

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
// BBS+ proof still verifies.
//
// Two mechanisms answer this. The credential names a W3C Bitstring Status List,
// which needs only a published document, so it runs with no chain configured;
// the on-chain registry (REVOCATION_REGISTRY_ADDRESS + REVOCATION_RPC_URL) is
// the fallback. "Could not check" is reported as itself, never as "not revoked".
const revOptions = await buildOptionsFromEnv();
const rev = await checkCredentialStatus(vc, { options: revOptions, failClosed: false });
console.log(`[2b] REVOCATION ${rev.checked ? (rev.revoked ? "REVOKED" : "valid (not revoked)") : "not checked"}  via=${rev.method}  (${rev.reason})`);
if (rev.revoked) { console.log("ABORT: credential revoked — no action attempted."); process.exit(0); }

// Show the gate doing its job: the same issuer, a credential whose index IS
// marked revoked in the published list. If the list is reachable this is
// REVOKED; if it is not, it reports "not checked" rather than waving it through.
{
  const { vc: revokedVc } = await issueEligibilityCredential(subject.did, DEMO_REVOKED_INDEX);
  const r = await checkCredentialStatus(revokedVc, { options: revOptions, failClosed: false });
  console.log(`[2b] CONTROL    a holder revoked at index ${DEMO_REVOKED_INDEX} -> ${r.checked ? (r.revoked ? "REVOKED ✅ blocked" : "NOT revoked ❌ unexpected") : "not checked"}  (${r.reason})`);
}

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
  console.log(`[5] DISPATCH   dry run — no action sent (see the LIVE section below)`);
  return d.decision;
}

// The LIVE path. Everything above is a what-if: the agent supplied the mandate
// it was judged against, so the gate only holds while the agent cooperates.
// Bind the credential this run actually verified to the action being requested.
// `verified: true` is the BBS+ verdict from step [2] — not an assumption; if
// that check had failed the run would not have reached here.
// One key per order attempt. A retry of the SAME order must reuse its key —
// that is what makes the retry safe — so the key belongs to the order, not to
// the request. Here each demo action is its own order.
const newIdempotencyKey = () => `order-${randomUUID()}`;

const binding = (action) => bindCredential({
  issuer: issuerDid,
  subject: subject.did,
  claims: vc.credentialSubject,
  verified: verdict.isValid,
}, action);

// `execute_action` is the real one — the enclave reads the mandate from KV
// (the agent CANNOT supply one) and performs the outbound call itself, in the
// same invocation, only on approval. A rejected action never reaches the network
// because the network call and the decision are the same host call.
async function executeForReal(label, action, credential = binding(action), idempotencyKey = newIdempotencyKey()) {
  await pace();
  const body = JSON.stringify(action);
  const req = { method: "POST", url: ACTION_ENDPOINT, body };
  const headers = signRequest(req, { privateKey: wba.privateKey, keyid: WBA_KEYID });
  const verifiable = verifyRequest(req, headers, wba.publicKey); // method+authority+path+body
  console.log(`\n[LIVE] ${label}`);
  console.log(`       signed (web-bot-auth, body digest)  destination-verifiable=${verifiable}`);
  try {
    const r = await tenant.contracts.execute(CONTRACT_TAIL, {
      version: CONTRACT_VERSION, functionName: "execute_action",
      input: { action, url: ACTION_ENDPOINT, method: "POST", body, credential, idempotency_key: idempotencyKey },
    });
    const src = `mandate_source=${r.mandate_source}`;
    if (r.decision !== "approved") {
      console.log(`       TEE decision = REJECTED (${src})  reasons=${JSON.stringify(r.reasons)}`);
      console.log(`       dispatched=${r.dispatched} — the enclave never made the call`);
      return r;
    }
    const resp = r.response ?? {};
    const out = resp.ok ? `HTTP ${resp.code}` : `egress gated: ${resp.error}`;
    console.log(`       TEE decision = APPROVED (${src})  dispatched=${r.dispatched}  -> ${out}`);
    return r;
  } catch (e) {
    console.log(`       execute_action failed: ${briefErr(e)}`);
    return null;
  }
}

console.log("\n─── DRY RUN — inline mandate, nothing is sent ───────────────────");

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

// Trusted-issuer gate. A BBS+ signature proves the ISSUER signed the claim — not
// that the issuer is anyone this fund trusts. Without this dimension the agent
// can mint its own "accredited investor" credential and pass the gate.
const ISSUER_MANDATE = { ...MANDATE, allowed_issuers: [issuerDid] };
await act("credential from the TRUSTED KYC issuer",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, issuer: issuerDid }, ISSUER_MANDATE);
await act("SELF-ISSUED credential (agent minted its own accreditation)",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, issuer: "did:key:the-agent-itself" },
  ISSUER_MANDATE);

// Per-counterparty sub-limit — tighter than the global cap, for one payee.
const SUBLIMIT_MANDATE = {
  ...MANDATE,
  allowed_counterparties: ["did:t3n:acme-treasury"],
  counterparty_limits: { "did:t3n:acme-treasury": 10_000 }, // $100
};
await act("pay $1,000 to a payee capped at $100 (sub-limit)",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, counterparty: "did:t3n:acme-treasury" },
  SUBLIMIT_MANDATE);

// Valid-after window (a future-dated authorization not yet active)
const FUTURE_MANDATE = { ...MANDATE, valid_after_secs: 4_102_444_800 }; // year 2100
await act("future-dated mandate (not yet active)",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 }, FUTURE_MANDATE);

console.log("\n─── LIVE — mandate read from KV inside the enclave, action really sent ───");

// In-mandate: the enclave approves AND makes the outbound call itself.
await executeForReal("buy $1,000 of USDC RWA",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 });

// Over-mandate: same entry point, same code path — the call is never made.
await executeForReal("buy $9,000 of USDC RWA (over mandate)",
  { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 });

console.log("\n✅ Gatekeeper Agent: identity + BBS+ VC gate + hardware mandate + audit — complete.");
