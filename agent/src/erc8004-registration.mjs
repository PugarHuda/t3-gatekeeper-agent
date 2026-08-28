// The ERC-8004 registration file — what `agentURI` must resolve to.
//
// ERC-8004 is an ERC-721: the token's URI points at a JSON document, and the
// spec fixes that document's shape (`type: …#registration-v1`, `services`,
// `active`, …) so registries, explorers and other agents can read it without
// knowing who wrote it. Our A2A card is a different document with a different
// shape. Pointing the mint at the card would have registered an identity that
// every conformant resolver rejects — and the URI is written on chain, so
// fixing it afterwards is a second transaction.
//
// This file is GENERATED from agent-card.json so the two cannot disagree about
// what the agent is called or does; the ERC-8004-specific parts (services,
// trust models, the on-chain registration itself) are here.
import { readFileSync } from "node:fs";
import { REGISTRIES, DEFAULT_NETWORK } from "./erc8004.mjs";

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const SITE = "https://gatekeeper-evidence.vercel.app";
/** Where the site serves it. Same origin as the card and the key directory. */
export const REGISTRATION_URL = `${SITE}/.well-known/erc8004-registration.json`;

const CARD = JSON.parse(readFileSync(new URL("../agent-card.json", import.meta.url), "utf8"));

/**
 * `{namespace}:{chainId}:{identityRegistry}` — the spec's registry reference,
 * CAIP-2 chain plus the registry address.
 */
export function agentRegistryRef(network = DEFAULT_NETWORK) {
  const r = REGISTRIES[network];
  return `eip155:${r.chainId}:${r.identity}`;
}

/**
 * Build the document.
 *
 * `minted` is `{ agentId, network }` once the agent exists on chain, and is
 * omitted before. The file is published either way: a resolver that finds an
 * empty `registrations` learns the agent is not yet minted, which is true.
 */
export function buildRegistrationFile({ minted = null, a2aEndpoint = null } = {}) {
  const services = [
    { name: "web", endpoint: SITE },
    // The A2A entry points at the card, as the spec's own example does.
    { name: "A2A", endpoint: `${SITE}/.well-known/agent-card.json`, version: "1.0" },
    { name: "DID", endpoint: CARD.did, version: "v1" },
  ];
  // The live A2A JSON-RPC endpoint, when this deployment has one to name.
  if (a2aEndpoint) services.push({ name: "A2A-JSONRPC", endpoint: a2aEndpoint, version: "1.0" });
  // MCP is served over stdio; there is no URL to advertise, and inventing one
  // would be exactly the kind of entry this file exists to prevent.

  return {
    type: REGISTRATION_TYPE,
    name: CARD.name,
    description: CARD.description,
    image: `${SITE}/agent-image.svg`,
    services,
    // We speak x402 — a 402 from any endpoint we call goes through the mandate.
    x402Support: true,
    active: true,
    registrations: minted
      ? [{ agentId: Number(minted.agentId), agentRegistry: agentRegistryRef(minted.network) }]
      : [],
    // What a counterparty can verify about this agent. "tee-attestation" is
    // literal: the mandate runs in an Intel TDX enclave and the session is
    // bound to a verified quote. "reputation" names the ERC-8004 registry.
    supportedTrust: ["tee-attestation", "reputation"],
  };
}

/** The checks a resolver would make, so a bad file fails here and not on chain. */
export function validateRegistrationFile(doc) {
  const problems = [];
  if (doc?.type !== REGISTRATION_TYPE) problems.push(`type must be ${REGISTRATION_TYPE}`);
  for (const f of ["name", "description", "image"]) {
    if (typeof doc?.[f] !== "string" || !doc[f]) problems.push(`${f} is required`);
  }
  if (!Array.isArray(doc?.services) || doc.services.length === 0) problems.push("services must be a non-empty array");
  (doc?.services ?? []).forEach((s, i) => {
    if (!s?.name) problems.push(`services[${i}] has no name`);
    if (!s?.endpoint) problems.push(`services[${i}] has no endpoint`);
  });
  if (typeof doc?.active !== "boolean") problems.push("active must be a boolean");
  (doc?.registrations ?? []).forEach((r, i) => {
    if (!Number.isInteger(r?.agentId)) problems.push(`registrations[${i}].agentId must be an integer`);
    if (!/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(r?.agentRegistry ?? "")) {
      problems.push(`registrations[${i}].agentRegistry must be {namespace}:{chainId}:{address}`);
    }
  });
  return { valid: problems.length === 0, problems };
}
