// `npm run erc8004` — what our ERC-8004 identity actually looks like on-chain,
// read live from the registry. No wallet, no gas, no key.
//
// This is the honest answer to "do you support ERC-8004": the registry is real,
// we read it, we can prove whether we are in it, and the write path is
// preflighted against the same contract. What we have NOT done is mint — that
// needs a gas-funded wallet, and the script refuses rather than pretending.
import { readFileSync } from "node:fs";
import { preflight, resolveAgent, ownedBy, connect, REGISTRIES, DEFAULT_NETWORK } from "./erc8004.mjs";

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

// Read a live agent back, to show the reads are real and not a shape we invented.
const sample = process.env.ERC8004_SAMPLE_ID ?? "1";
const agent = await resolveAgent(sample, { network: net });
console.log(agent
  ? `  sample agent #${agent.agentId}\n    owner ${agent.owner}\n    uri   ${agent.uri || "(none set)"}`
  : `  sample agent #${sample} is not minted`);

// And our own status. The T3 API key derives an Ethereum address; that is the
// identity that would own the NFT if we minted with the same key.
const mine = process.env.ERC8004_OWNER_ADDRESS
  || (process.env.T3N_API_KEY && (await import("@terminal3/t3n-sdk")).eth_get_address(process.env.T3N_API_KEY));
if (mine) {
  const { count, registered } = await ownedBy(mine, { network: net });
  console.log(`\n  our address ${mine}`);
  console.log(`  agents owned: ${count} — ${registered ? "REGISTERED" : "not registered (needs a gas-funded mint)"}`);
}

console.log(`\nTo mint: fund that address with ${net} ETH, then \`npm run register:erc8004\`.`);
