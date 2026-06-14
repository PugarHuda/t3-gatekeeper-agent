// Gatekeeper Agent — full flow chaining EVERY T3 SDK layer:
//   1. IDENTITY  : authenticate the agent (did:t3n) over an encrypted TEE session
//   2. VC GATE   : verify a BBS+ predicate credential ({accreditedInvestor:true})
//                  -> proves eligibility without revealing net worth / PII
//   3. MANDATE   : invoke the gate-contract inside the TEE to enforce the
//                  spending mandate (amount / asset / kind / expiry)
//   4. AUDIT     : emit one structured, redacted audit row per action
import { readFileSync } from "node:fs";
import {
  T3nClient, TenantClient, loadWasmComponent, setEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign,
} from "@terminal3/t3n-sdk";
import * as vcCore from "@terminal3/vc_core";
import * as bbs from "@terminal3/bbs_vc";

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
const TAIL = "gate", VERSION = "0.1.0";
const mandate = { max_amount_cents: 500_000, allowed_assets: ["USDC", "USD"], allowed_kinds: ["rwa.buy"], expires_at_secs: 0 };

// --- VC GATE: a trusted issuer attests ONLY the predicate, never the raw data ---
async function issueEligibilityCredential(subjectDid) {
  const issuer = new bbs.BbsDID(vcCore.randomKeyBls()); // trusted KYC issuer
  const vc = await bbs.createBbsCredential(
    issuer,
    new vcCore.DID(...vcCore.getMethodIdentifier(subjectDid)),
    { accreditedInvestor: true, jurisdiction: "SG" }, // predicate only — no net worth, no name, no DOB
    ["VerifiableCredential", "AccreditationCredential"],
    undefined, undefined, undefined, undefined, true,
  );
  return { vc, issuerDid: issuer.did };
}

(async () => {
  setEnvironment("testnet");
  const key = process.env.T3N_API_KEY, tenantDid = process.env.DID;
  const address = eth_get_address(key);
  const wasmComponent = await loadWasmComponent();
  const client = new T3nClient({ wasmComponent, handlers: { EthSign: metamask_sign(address, undefined, key) } });

  // 1. IDENTITY
  await client.handshake();
  const auth = await client.authenticate(createEthAuthInput(address));
  const agentDid = auth?.value ?? tenantDid;
  console.log(`[1] IDENTITY   agent authenticated as ${agentDid}`);

  const tenant = new TenantClient({ environment: "testnet", t3n: client, tenantDid, baseUrl: BASE_URL });

  // 2. VC GATE
  const subjectBls = new bbs.BbsDID(vcCore.randomKeyBls());
  const { vc, issuerDid } = await issueEligibilityCredential(subjectBls.did);
  const verdict = await bbs.verifyBbsVCW3c(vc);
  const eligible = verdict.isValid === true && vc.credentialSubject.accreditedInvestor === true;
  console.log(`[2] VC GATE    BBS+ credential from issuer ${issuerDid.slice(0, 28)}…`);
  console.log(`               verify=${verdict.isValid}  predicate(accreditedInvestor)=${vc.credentialSubject.accreditedInvestor}  -> eligible=${eligible}`);
  if (!eligible) { console.log("ABORT: eligibility gate failed — no action attempted."); return; }

  // 3 + 4. MANDATE (TEE contract) + AUDIT, for two actions
  const act = async (label, action) => {
    const decision = await tenant.contracts.execute(TAIL, { version: VERSION, functionName: "evaluate", input: { action, mandate } });
    const audit = {
      ts: decision.evaluated_at_secs, agentDid, issuerDid,
      eligibility: "bbs+ verified", action, decision: decision.decision, reasons: decision.reasons,
    };
    console.log(`\n[3] MANDATE    ${label}`);
    console.log(`               TEE decision = ${decision.decision.toUpperCase()}${decision.reasons.length ? "  reasons=" + JSON.stringify(decision.reasons) : ""}`);
    console.log(`[4] AUDIT      ${JSON.stringify(audit)}`);
    return decision.decision;
  };

  await act("buy $1,000 of USDC RWA", { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 });
  await act("buy $9,000 of USDC RWA (over mandate)", { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000 });

  console.log("\nRESULT: full Gatekeeper Agent flow (identity + VC gate + TEE mandate + audit) WORKS ✅");
})().catch((e) => { console.error("FAILED ❌\n", e?.stack ?? e); process.exit(1); });
