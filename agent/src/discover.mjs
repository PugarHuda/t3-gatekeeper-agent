// What the node actually runs, and what this agent is actually allowed to do.
//
//   npm run discover
//
// Everything here uses the SDK's `discover*` reads, which are a different door
// from the rest of this repo: they take an **agent API key** (`t3n_key_…`) over
// plain HTTPS instead of an attested session opened with the tenant's Ethereum
// key. That difference is the point, twice over.
//
// For OPERATIONS: these reads need no session, no wasm component, and no
// credits. Version drift on the node is the failure mode that has bitten this
// project hardest — a node upgrade silently dropped support for the SDK the docs
// shipped (bug #19), and an org contract we needed sat two minor versions behind
// (bug #12). Both were invisible until something broke. This prints the node's
// own inventory, so it is one command instead of an autopsy.
//
// For HANDOVER: whoever runs this agent next should not be handed the tenant's
// Ethereum private key, which can spend credits and register contracts. An agent
// key is scoped and revocable, and it is what a hosted deployment should carry.
// Provision one with:
//
//   t3n agent create --org <org-did> --name <name>   # prints the key ONCE
//
// The reads themselves are honest about their limits: `delegation.check` answers
// for the *agent*, not for the tenant's `agent-auth` egress grant, so a `false`
// here does not mean the enclave cannot reach its destination. It is said in the
// output rather than left for someone to assume.
import {
  discoverWhoami, discoverListContracts, discoverDescribeContract, discoverCheckDelegation,
} from "@terminal3/t3n-sdk";
import { BASE_URL, CONTRACT_TAIL, loadEnv } from "./lib.mjs";

/** Core contracts we depend on, and why — so a version change means something. */
export const WATCHED = {
  "tee:user": "egress grants (agent-auth-update) and tenant admission",
  "tee:organisation": "org-owned agents; ran 0.4.1 when the CLI needed 0.6.0+ (bug #12)",
  "tee:agent-registry": "registers this agent's card on-network (agent set-card)",
  "tee:vc": "credential issue + OpenID4VP presentation (see the note in discover's output)",
  "tee:agent-connect": "commerce intents, quotes and confirmations — T3's own agentic-commerce rails",
  "tee:org-data": "the 'agent-cards' scope a card write needs; a missing writer here is bug #11",
};

/** Read the node's inventory and this agent's standing. Pure reads, no credits. */
export async function survey({ baseUrl = BASE_URL, apiKey, tenantDid, contractTail = CONTRACT_TAIL } = {}) {
  if (!apiKey) throw new Error("survey: an agent API key is required (T3N_AGENT_KEY)");
  const opts = { baseUrl, apiKey };

  const who = await discoverWhoami(opts);
  const core = await discoverListContracts(opts, {});

  // The tenant contract, described by the node rather than by our Cargo.toml.
  // A mismatch here means what is deployed is not what this repo builds.
  let contract = null;
  if (tenantDid) {
    const name = `z:${tenantDid.replace("did:t3n:", "")}:${contractTail}`;
    try {
      contract = await discoverDescribeContract(opts, { contract: name });
    } catch (e) {
      contract = { contract: name, error: String(e.message ?? e).slice(0, 160) };
    }
  }

  let delegation = null;
  if (tenantDid && who?.did) {
    try {
      delegation = await discoverCheckDelegation(opts, {
        contract: `z:${tenantDid.replace("did:t3n:", "")}:${contractTail}`,
        pii_did: who.did,
        functions: ["evaluate", "execute_action"],
        scopes: [],
      });
    } catch (e) {
      delegation = { error: String(e.message ?? e).slice(0, 160) };
    }
  }

  return { who, core, contract, delegation };
}

if (process.argv[1]?.endsWith("discover.mjs")) {
  loadEnv(new URL("../.env", import.meta.url));
  const apiKey = process.env.T3N_AGENT_KEY;
  if (!apiKey) {
    console.error(
      "No T3N_AGENT_KEY in agent/.env.\n" +
      "These reads take an agent key, not the tenant's Ethereum key — the tenant key\n" +
      "returns a bare HTTP 400 here with nothing to explain it (bug #24). Provision one:\n" +
      "  npx @terminal3/t3n-sdk agent create --org <org-did> --name <name> --env testnet\n" +
      "It is printed exactly once.",
    );
    process.exit(1);
  }

  const { who, core, contract, delegation } = await survey({
    apiKey,
    tenantDid: process.env.DID,
  });

  console.log(`agent      ${who.did}`);
  console.log(`orgs       ${who.organisations?.join(", ") || "(none)"}\n`);

  console.log(`core contracts the node is running (${core.contracts.length}):`);
  for (const c of core.contracts) {
    const why = WATCHED[c.name];
    console.log(`  ${c.name.padEnd(22)} ${String(c.version).padEnd(9)} ${why ?? ""}`);
  }

  // Two of these are served but appear in no documentation we could find, and
  // have no SDK helper. Saying so here is the difference between a tool and a
  // list: the next person reads this instead of rediscovering it.
  const undocumented = core.contracts.filter((c) => c.name === "tee:vc" || c.name === "tee:agent-connect");
  if (undocumented.length) {
    console.log(`\n  Note: ${undocumented.map((c) => c.name).join(" and ")} are served by the node but`);
    console.log(`  documented nowhere and wrapped by no SDK helper (bug #26). tee:vc carries a`);
    console.log(`  full OpenID4VP holder stack (submit-vp / my-presentations, DCQL queries);`);
    console.log(`  tee:agent-connect carries commerce intents and quotes.`);
  }

  console.log(`\nour contract, as the node describes it:`);
  if (contract?.error) {
    console.log(`  ${contract.contract}\n  ${contract.error}`);
    console.log(`  (an agent outside the tenant cannot describe its contracts — expected)`);
  } else {
    console.log(`  ${contract.contract} @ ${contract.version}`);
    const fns = contract.descriptor?.functions ?? [];
    console.log(`  functions: ${fns.map((f) => f.name).join(", ") || "(none listed)"}`);
  }

  console.log(`\ndelegation check for evaluate + execute_action:`);
  console.log(`  ${JSON.stringify(delegation)}`);
  console.log(`  This is the AGENT's member/org delegation. It is NOT the tenant's`);
  console.log(`  agent-auth egress grant — 'authorised: false' here says nothing about`);
  console.log(`  whether the enclave may reach its destination. Use npm run grant:egress`);
  console.log(`  for that, and note the node returns 'missing: []' either way (bug #25).`);
}
