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
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/**
 * Fetch and validate a peer's agent card.
 *
 * Accepts an origin (`https://example.com`) or a full card URL. Validation is
 * deliberately strict about the fields a caller would otherwise dereference —
 * a card missing `skills` should fail here, not with `undefined is not iterable`
 * three calls later.
 */
export async function discoverPeer(originOrUrl, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const url = originOrUrl.includes("/.well-known/")
    ? originOrUrl
    : new URL(AGENT_CARD_PATH, originOrUrl).toString();

  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`agent card ${url}: HTTP ${res.status}`);

  let card;
  try {
    card = await res.json();
  } catch {
    throw new Error(`agent card ${url}: not JSON`);
  }
  return { url, card, ...validateAgentCard(card) };
}

/**
 * Check a card against what A2A clients actually need from one.
 *
 * Returns a report rather than throwing: a card can be usable while missing
 * optional metadata, and the caller should get to decide. Only the fields
 * without which interaction is impossible are `problems`.
 */
export function validateAgentCard(card) {
  const problems = [];
  const warnings = [];

  if (!card || typeof card !== "object") return { valid: false, problems: ["card is not an object"], warnings };
  for (const field of ["name", "description", "version", "skills"]) {
    if (card[field] === undefined) problems.push(`missing ${field}`);
  }
  if (card.skills !== undefined && !Array.isArray(card.skills)) problems.push("skills is not an array");
  if (Array.isArray(card.skills)) {
    card.skills.forEach((s, i) => {
      if (!s?.id) problems.push(`skills[${i}] has no id`);
      if (!s?.name) warnings.push(`skills[${i}] has no name`);
    });
    if (card.skills.length === 0) warnings.push("card advertises no skills");
  }
  // Not required by the spec, but a card without either cannot be addressed.
  if (!card.url && !card.did) problems.push("card has neither url nor did — nothing to talk to");
  if (!card.protocolVersion) warnings.push("no protocolVersion — client must guess the dialect");
  if (!card.capabilities) warnings.push("no capabilities block");

  return { valid: problems.length === 0, problems, warnings };
}

/** Skill ids a peer advertises, for matching against what you need. */
export function skillIds(card) {
  return Array.isArray(card?.skills) ? card.skills.map((s) => s?.id).filter(Boolean) : [];
}
