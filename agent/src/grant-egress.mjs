// Authorise the gate-contract's in-TEE outbound HTTP (step [5] DISPATCH).
//
//   npm run grant:egress                       # host of ACTION_ENDPOINT
//   EGRESS_HOSTS=a.com,b.com npm run grant:egress
//
// The agent here calls its own tenant's contract, so this is a SELF-grant:
// grantee DID == caller DID. Delegated use is the same call with the agent's
// DID. The mechanics live in lib.mjs (`grantEgress`) so the live proofs can
// grant for themselves instead of telling you to run this first.
import { connect, grantEgress, CONTRACT_TAIL, CONTRACT_VERSION, actionEndpoint } from "./lib.mjs";

const { client, tenant, agentDid } = await connect(new URL("../.env", import.meta.url));

const hosts = (process.env.EGRESS_HOSTS || new URL(actionEndpoint()).host)
  .split(",").map((h) => h.trim()).filter(Boolean);

console.log(`granting  ${agentDid}`);
console.log(`      on  ${tenant.canonicalName(CONTRACT_TAIL)}@${CONTRACT_VERSION}`);
console.log(`   hosts  ${hosts.join(", ")}`);

let res;
try {
  res = await grantEgress(client, tenant, agentDid, hosts);
} catch (e) {
  // The SDK bundle is minified — an uncaught throw dumps ~1MB of source.
  console.error("FAILED:", String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 500));
  process.exit(1);
}

console.log("agent-auth-update ✅", typeof res === "string" ? res : JSON.stringify(res));
console.log("\nRe-run `npm run demo` — [5] DISPATCH should now leave the enclave.");
