// Authorise the gate-contract's in-TEE outbound HTTP (step [5] DISPATCH).
//
// Outbound calls from a contract are authorised by the CALLER, not the contract:
// the host resolves the caller's `agent-auth` grant and only then lets the
// enclave reach the destination host. Without a matching grant the contract runs
// fine but `http.call` returns `host/http.egress_denied`.
//
// The agent here calls its own tenant's contract, so this is a SELF-grant:
// grantee DID == caller DID. Delegated use is the same call with the agent's DID.
import { getScriptVersion } from "@terminal3/t3n-sdk";
import { connect, CONTRACT_TAIL, CONTRACT_VERSION, actionEndpoint, BASE_URL } from "./lib.mjs";

// `tee:user/contracts` is a system contract; its version moves, so resolve the
// current one instead of pinning (the server rejects a literal "latest").
const USER_CONTRACT = "tee:user/contracts";

const { client, tenant, agentDid } = await connect(new URL("../.env", import.meta.url));

// Hosts the enclave may reach on our behalf. Defaults to the action endpoint's host.
const hosts = (process.env.EGRESS_HOSTS || new URL(actionEndpoint()).host)
  .split(",").map((h) => h.trim()).filter(Boolean);

const scriptName = tenant.canonicalName(CONTRACT_TAIL);

console.log(`granting  ${agentDid}\n      on  ${scriptName}@${CONTRACT_VERSION}\n   hosts  ${hosts.join(", ")}`);

const grant = {
  agents: [{
    agentDid,
    scripts: [{
      scriptName,
      versionReq: CONTRACT_VERSION,
      functions: ["evaluate", "spend", "dispatch_action"],
      allowedHosts: hosts,
    }],
  }],
};

let res;
try {
  res = await client.execute({
    script_name: USER_CONTRACT,
    script_version: await getScriptVersion(BASE_URL, USER_CONTRACT),
    function_name: "agent-auth-update",
    input: grant,
  });
} catch (e) {
  // The SDK bundle is minified — an uncaught throw dumps ~1MB of source.
  console.error("FAILED:", String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 500));
  process.exit(1);
}

console.log("agent-auth-update ✅", typeof res === "string" ? res : JSON.stringify(res));
console.log("\nRe-run `npm run demo` — [5] DISPATCH should now leave the enclave.");
