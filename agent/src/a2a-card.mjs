// A2A discovery and card validation — no cryptography, no Terminal 3 packages.
//
// Split out of a2a.mjs so a host that only needs to find and validate agent
// cards (the MCP server, the hosted functions) never loads the BBS+ stack: that
// chain ends in an ESM-only dependency some Node runtimes cannot `require`,
// and the card code has no business dragging it in.

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
  // A card is addressable one of two ways. v0.3 put a single `url` (or, in
  // our ERC-8004 flavour, a `did`) at the top level; v1.0 moved to
  // `supportedInterfaces`, one entry per transport, each with its own URL and
  // protocol version. A validator that only knew the first shape would call
  // every v1.0 agent unreachable — which is what this one did until the SDK's
  // own client resolved our card and this check failed against it.
  const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  interfaces.forEach((i, n) => {
    if (!i?.url) problems.push(`supportedInterfaces[${n}] has no url`);
    if (!i?.protocolBinding) warnings.push(`supportedInterfaces[${n}] names no protocolBinding`);
  });
  const addressable = Boolean(card.url || card.did || interfaces.some((i) => i?.url));
  if (!addressable) problems.push("card has neither url, did nor a supportedInterfaces url — nothing to talk to");

  const version = card.protocolVersion ?? interfaces.find((i) => i?.protocolVersion)?.protocolVersion;
  if (!version) warnings.push("no protocolVersion — client must guess the dialect");
  if (!card.capabilities) warnings.push("no capabilities block");

  return { valid: problems.length === 0, problems, warnings };
}

/** Skill ids a peer advertises, for matching against what you need. */
export function skillIds(card) {
  return Array.isArray(card?.skills) ? card.skills.map((s) => s?.id).filter(Boolean) : [];
}
