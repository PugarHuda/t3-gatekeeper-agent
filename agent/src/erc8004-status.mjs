// `npm run erc8004` — what our ERC-8004 identity actually looks like on-chain,
// read live from the registries. No wallet needed, no gas, no key.
//
// This is the whole loop, read from the outside in: the registry preflights
// as a registry; our token resolves to an owner and a URI; the URI resolves
// to a conformant registration file that names the token back; and the
// reputation registry answers for the same id. Every line is a live read.
import { readFileSync } from "node:fs";
import { preflight, resolveAgent, ownedBy, readReputation, reputationPreflight, connect, REGISTRIES, DEFAULT_NETWORK } from "./erc8004.mjs";
import { validateRegistrationFile, REGISTRATION_TYPE } from "./erc8004-registration.mjs";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* .env optional */ }

const net = process.env.ERC8004_NETWORK || DEFAULT_NETWORK;
const cfg = REGISTRIES[net];
const { address } = connect({ network: net });
console.log(`ERC-8004 IdentityRegistry — ${net}`);
console.log(`  ${address}`);
if (cfg?.explorer) console.log(`  ${cfg.explorer}/address/${address}\n`);

const report = await preflight({ network: net });
for (const c of report.checks) console.log(`  ${c.pass ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
console.log(`\n  registry name: ${report.name ?? "(unreadable)"}`);
console.log(`  safe to register against: ${report.ok ? "yes" : "NO — do not send a transaction"}\n`);

// Our own token when we have one, else a sample — the reads are the same.
let minted = null;
try { minted = JSON.parse(readFileSync(new URL("../erc8004-minted.json", import.meta.url), "utf8")); } catch { /* not minted */ }
const sample = process.env.ERC8004_SAMPLE_ID ?? (minted ? String(minted.agentId) : "1");
const agent = await resolveAgent(sample, { network: net });
console.log(agent
  ? `  agent #${agent.agentId}${minted && String(minted.agentId) === String(agent.agentId) ? " (ours)" : " (sample)"}\n    owner ${agent.owner}\n    uri   ${agent.uri || "(none set)"}`
  : `  agent #${sample} is not minted`);

// Follow the URI the chain returned and check it is the document the spec
// asks for. This is what a resolver does, and the one place a mint that
// "succeeded" can still be useless.
if (agent?.uri?.startsWith("http")) {
  try {
    const res = await fetch(agent.uri, { signal: AbortSignal.timeout(20_000) });
    const doc = res.ok ? await res.json() : null;
    const v = doc ? validateRegistrationFile(doc) : { valid: false, problems: [`HTTP ${res.status}`] };
    const names = v.valid && doc.registrations?.some((r) => String(r.agentId) === String(agent.agentId));
    console.log(`    ${v.valid ? "✅" : "❌"} the URI resolves to a ${REGISTRATION_TYPE.split("#")[1]} document${v.valid ? "" : ` — ${v.problems.join("; ")}`}`);
    if (v.valid) {
      console.log(`    ${names ? "✅" : "❌"} and its registrations[] names agent #${agent.agentId} back`);
      console.log(`    services: ${doc.services.map((x) => x.name).join(", ")}  ·  trust: ${(doc.supportedTrust ?? []).join(", ")}  ·  x402: ${doc.x402Support}`);
    }
  } catch (e) {
    console.log(`    ❌ could not fetch the URI: ${String(e.message).slice(0, 80)}`);
  }
}

// The Reputation Registry, for the same id. A fresh agent has none, and the
// honest number for that is zero.
if (agent) {
  try {
    const pf = await reputationPreflight({ network: net });
    console.log(`
  reputation registry ${pf.address}`);
    console.log(`    ${pf.pairedWithIdentity ? "✅" : "❌"} getIdentityRegistry() names the identity registry above`);
    if (pf.missing.length) {
      console.log(`    ⚠  this deployment predates the EIP's final interface — absent: ${pf.missing.join(", ")}`);
      console.log(`       present: ${pf.present.join(", ")}`);
    }
    const rep = await readReputation(agent.agentId, { network: net });
    console.log(`    agent #${agent.agentId}: feedback entries ${rep.count}, clients ${rep.clients.length}, score ${rep.score ?? "(none yet — nothing stands in for one)"}`);
  } catch (e) {
    console.log(`
  reputation registry: ${String(e.shortMessage ?? e.message).slice(0, 100)}`);
  }
}

// And our own status.
//
// This has to be the address that will ACTUALLY sign the mint — which is
// ERC8004_PRIVATE_KEY, the key `register:erc8004` uses. Deriving it from the T3
// key instead, as this did, prints "fund that address" about an address that is
// not the one spending the gas. The T3 key is a last resort and a poor one: it
// spends T3 credits and registers contracts, so it should not also be holding
// the agent's identity NFT.
const { ethers } = await import("ethers");
const minter = process.env.ERC8004_PRIVATE_KEY
  ? new ethers.Wallet(process.env.ERC8004_PRIVATE_KEY).address
  : null;
const mine = minter
  || process.env.ERC8004_OWNER_ADDRESS
  || (process.env.T3N_API_KEY && (await import("@terminal3/t3n-sdk")).eth_get_address(process.env.T3N_API_KEY));

if (mine) {
  const { count, registered } = await ownedBy(mine, { network: net });
  const source = minter
    ? "ERC8004_PRIVATE_KEY — the key that will sign the mint"
    : process.env.ERC8004_OWNER_ADDRESS
      ? "ERC8004_OWNER_ADDRESS — read-only; set ERC8004_PRIVATE_KEY to mint"
      : "derived from T3N_API_KEY — set ERC8004_PRIVATE_KEY instead";
  console.log(`\n  our address ${ethers.getAddress(mine)}`);
  console.log(`  (${source})`);
  console.log(`  agents owned: ${count} — ${registered ? "REGISTERED" : "not registered"}`);

  const { rpc } = REGISTRIES[net];
  const balance = await new ethers.JsonRpcProvider(rpc).getBalance(mine);
  console.log(`  balance:      ${ethers.formatEther(balance)} ETH`);

  if (registered) {
    console.log(`\nAlready minted. Nothing to do.`);
  } else if (balance === 0n) {
    console.log(`\nA mint needs gas. Fund THIS address on ${net}:`);
    console.log(`  ${ethers.getAddress(mine)}`);
    console.log(`  https://www.alchemy.com/faucets/ethereum-sepolia  (or any Sepolia faucet)`);
    console.log(`then run \`npm run register:erc8004\`.`);
  } else {
    console.log(`\nFunded. Run \`npm run register:erc8004\` to mint.`);
  }
}
