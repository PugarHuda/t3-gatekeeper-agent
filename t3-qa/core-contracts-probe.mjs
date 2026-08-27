// Repro for bugs #27 and #28: two core contracts the node serves, which a
// tenant caller cannot reach.
//
//   node core-contracts-probe.mjs
//
// We found `tee:agent-connect@1.4.0` and `tee:vc@2.6.0` with `contracts.list`
// (bug #26 — neither is documented). This script is the attempt to actually use
// them, kept as evidence rather than described in prose, because "we could not
// make it work" is worth very little without the calls that failed.
//
// It is written to FAIL WHEN THE BUGS ARE FIXED. If a call that should be
// blocked succeeds, the script exits non-zero and says so — so the day Terminal
// 3 fixes either of these, we find out from a test run instead of from a guess.
import { readFileSync } from "node:fs";
import {
  T3nClient, TenantClient, loadWasmComponent, setEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign, fetchTrustedManifest,
  getContractVersion,
} from "@terminal3/t3n-sdk";

const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
for (const line of readFileSync(new URL("../agent/.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

setEnvironment("testnet");
const key = process.env.T3N_API_KEY;
const address = eth_get_address(key);
const client = new T3nClient({
  trustAnchor: await fetchTrustedManifest("testnet"),
  wasmComponent: await loadWasmComponent(),
  handlers: { EthSign: metamask_sign(address, undefined, key) },
});
await client.handshake();
await client.authenticate(createEthAuthInput(address));
new TenantClient({ environment: "testnet", t3n: client, tenantDid: process.env.DID, baseUrl: BASE_URL });

const brief = (e) => String(e?.message ?? e).replace(/\s+/g, " ");
let unexpected = 0;

const call = async (script, fn, input) => {
  const version = await getContractVersion(BASE_URL, script);
  try {
    return { ok: true, value: await client.execute({ script_name: script, script_version: version, function_name: fn, input }) };
  } catch (e) {
    return { ok: false, error: brief(e) };
  }
};

// ── bug #27 ────────────────────────────────────────────────────────────────
console.log("── tee:agent-connect@1.4.0 — every caller-facing function ──────────────\n");
console.log("The contract reads a user-profile envelope the HOST assembles. It requires a");
console.log("`kind` field. The profile writer, tee:user's user-upsert, refuses that exact");
console.log("field as an unrecognised key. Nothing a caller sends changes either side.\n");

const CALLER_FACING = [
  "commerce-quote", "commerce-intent-create", "commerce-intent-confirm",
  "commerce-intent-cancel", "commerce-history-get",
];
for (const fn of CALLER_FACING) {
  const r = await call("tee:agent-connect/contracts", fn, {});
  if (r.ok) {
    unexpected++;
    console.log(`  UNEXPECTED PASS  ${fn} -> ${JSON.stringify(r.value).slice(0, 160)}`);
    console.log(`                   bug #27 may be fixed — re-check ADOPTIONS.md.`);
  } else {
    const envelope = /malformed user-profile JSON envelope: missing field `kind`/.test(r.error);
    console.log(`  blocked  ${fn.padEnd(24)} ${envelope ? "host-assembled envelope, missing `kind`" : r.error.slice(0, 90)}`);
    if (!envelope) console.log(`           ${r.error.slice(0, 150)}`);
  }
}

// The other half of the contradiction: the writer will not accept the field.
console.log("\n  and the profile writer refuses to add it:");
for (const profile of [{ kind: "individual" }, { Kind: "individual" }, { profile_kind: "individual" }]) {
  try {
    await client.submitUserInput({ profile });
    unexpected++;
    console.log(`  UNEXPECTED PASS  user-upsert accepted ${JSON.stringify(profile)} — bug #27 may be fixed.`);
  } catch (e) {
    console.log(`  refused  user-upsert ${JSON.stringify(profile).padEnd(26)} ${/UnrecognizedKeys/.test(brief(e)) ? "UnrecognizedKeys" : brief(e).slice(0, 80)}`);
  }
}

// ── bug #28 ────────────────────────────────────────────────────────────────
console.log("\n── tee:vc@2.6.0 — issuing into the node's own wallet ───────────────────\n");
console.log("`issue-credential` demands `keys.generic_api` metadata. The one documented way");
console.log("to write keys is user-upsert's `keys` argument, which accepts every shape we");
console.log("tried WITHOUT complaint — and the consumer still reports it missing.\n");

for (const [label, keys] of [
  ["{}", { generic_api: {} }],
  ["issuer + alg", { generic_api: { issuer: process.env.DID, alg: "EdDSA" } }],
  ["a real Ed25519 JWK", { generic_api: { kty: "OKP", crv: "Ed25519", x: "0".repeat(43), alg: "EdDSA", kid: "vc-issuer" } }],
]) {
  let wrote = false;
  try {
    await client.submitUserInput({ profile: { role: "agent" }, keys });
    wrote = true;
  } catch (e) {
    console.log(`  user-upsert keys=${label} -> refused: ${brief(e).slice(0, 90)}`);
  }
  if (!wrote) continue;
  const r = await call("tee:vc/contracts", "issue-credential", {});
  if (r.ok) {
    unexpected++;
    console.log(`  UNEXPECTED PASS  issue-credential after keys=${label} — bug #28 may be fixed.`);
  } else {
    console.log(`  wrote keys=${label.padEnd(18)} accepted silently; issue-credential -> ${r.error.slice(0, 60)}`);
  }
}

// What DOES work there, so the report is not only negative.
console.log("\n  What the same contract does answer:");
const pres = await call("tee:vc/contracts", "my-presentations", {});
console.log(`    my-presentations -> ${pres.ok ? JSON.stringify(pres.value) : pres.error.slice(0, 80)}`);

const dcql = {
  credentials: [{
    id: "accred", format: "dc+sd-jwt",
    meta: { vct_values: ["AccreditationCredential"] },
    claims: [{ path: ["accreditedInvestor"] }],
  }],
};
const vp = await call("tee:vc/contracts", "submit-vp", {
  dcql_query_json: JSON.stringify(dcql),
  nonce: "gatekeeper-probe",
  client_id: process.env.DID,
  response_uri: "https://gatekeeper-evidence.vercel.app/oid4vp/response",
});
console.log(`    submit-vp        -> ${vp.ok ? JSON.stringify(vp.value).slice(0, 120) : vp.error.slice(0, 110)}`);
console.log("\n    That `unsatisfied` is the node acting as a HOLDER: it took the OpenID4VP");
console.log("    request, ran the DCQL query against the credentials it keeps, and found");
console.log("    none. The stack is real. We just cannot put a credential into it.");

console.log(
  unexpected === 0
    ? "\nBoth blockages reproduce. Nothing here is buildable against yet."
    : `\n${unexpected} call(s) behaved differently — a bug may be fixed. Update BUGS.md and ADOPTIONS.md.`,
);
process.exit(unexpected === 0 ? 0 : 1);
