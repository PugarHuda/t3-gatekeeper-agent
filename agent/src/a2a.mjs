// A2A capability exchange — two agents establish trust before collaborating by
// exchanging a BBS+ *capability credential* with selective disclosure. Agent A
// proves it holds a needed capability (issued by a trusted authority) WITHOUT
// revealing the rest of its capability manifest. Mirrors the A2A AgentCard +
// DIF presentation-exchange pattern, on top of Terminal 3 BBS+.
import { issueRecord, discloseOnly, verifyDisclosure } from "./selective-disclosure.mjs";

/** A capability authority issues Agent A its full capability manifest. */
export async function issueCapabilityCredential(agentDid, manifest) {
  return issueRecord({ agent: agentDid, ...manifest });
}

/** Agent A presents ONLY the capability the peer asked for (hides the rest). */
export async function presentCapability(cred, capabilityKey) {
  return discloseOnly(cred, ["agent", capabilityKey]);
}

/** Agent B verifies the presentation and that the claimed capability matches. */
export async function acceptIfCapable(presentation, requiredKey, requiredValue) {
  const ok = await verifyDisclosure(presentation);
  const claim = presentation.disclosed.find((d) => d.key === requiredKey);
  return ok && claim !== undefined && String(claim.value) === String(requiredValue);
}

// ── discovery ───────────────────────────────────────────────────────────────
//
// The capability exchange above assumed you already had a peer. Finding one is
// the other half of A2A, and it is a real network operation: a client that knows
// only a domain fetches `/.well-known/agent-card.json` and reads what the agent
// is, what it can do, and how to authenticate to it.
//
// Ours is published at that path on the evidence site, so a peer can discover
// this agent with nothing shared in advance — the same property the Web Bot Auth
// key directory has, for the same reason.

/** The path A2A clients look at when they know only a domain. */

// Discovery and validation live in a2a-card.mjs (no crypto); re-exported here
// so existing imports keep working.
export { AGENT_CARD_PATH, discoverPeer, validateAgentCard, skillIds } from "./a2a-card.mjs";
