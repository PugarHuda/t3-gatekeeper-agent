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
