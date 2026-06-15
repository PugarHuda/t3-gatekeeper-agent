// A2A capability-exchange demo (offline — pure crypto, no network needed).
// Agent A holds a full capability manifest issued by a trusted authority. A peer
// (Agent B) needs proof of ONE capability before collaborating. Agent A presents
// only that capability via BBS+ selective disclosure; the rest stays hidden.
import { issueCapabilityCredential, presentCapability, acceptIfCapable } from "./a2a.mjs";

const AGENT_A = "did:t3n:agentA";

console.log("[A2A] capability authority issues Agent A its full manifest");
const cred = await issueCapabilityCredential(AGENT_A, {
  capability: "payments.execute",
  tier: "institutional",
  maxUsd: "1000000",
  region: "SG",
});
console.log(`      signed claims: ${cred.keys.join(", ")}`);

console.log('\n[A2A] peer (Agent B) requires capability="payments.execute"');
const presentation = await presentCapability(cred, "capability");
const shown = presentation.disclosed.map((d) => `${d.key}=${d.value}`).join(", ");
const hidden = cred.keys.filter((k) => !presentation.disclosed.some((d) => d.key === k));
console.log(`      Agent A discloses : ${shown}`);
console.log(`      Agent A hides     : ${hidden.join(", ")}`);

const accepted = await acceptIfCapable(presentation, "capability", "payments.execute");
console.log(`\n[A2A] Agent B verifies proof + capability match -> accepted=${accepted}`);

// negative: a peer asking for a capability the agent doesn't hold must be refused
const dataCred = await issueCapabilityCredential(AGENT_A, { capability: "data.read" });
const dataPres = await presentCapability(dataCred, "capability");
const wrongly = await acceptIfCapable(dataPres, "capability", "payments.execute");
console.log(`[A2A] mismatched capability is refused -> accepted=${wrongly}`);

const ok = accepted === true && wrongly === false;
console.log(`\nRESULT: A2A capability exchange ${ok ? "WORKS ✅ (prove one capability, hide the manifest)" : "FAILED ❌"}`);
process.exit(ok ? 0 : 1);
