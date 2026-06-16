// ERC-8004 Trustless-Agents registration — mint this agent's on-chain identity.
//
// ERC-8004's IdentityRegistry is an ERC-721 where tokenId = agentId and
// tokenURI = agentURI (resolves to the agent registration file — we point it at
// our agent-card.json). This script calls `register(agentURI)` and reads back the
// minted agentId from the `Registered` event.
//
// It performs a REAL on-chain transaction, so it refuses to run until you supply
// a funded wallet + the registry address. Nothing is mocked: with the env unset
// it prints what's required and exits without sending anything.
//
//   ERC8004_RPC_URL=...            EVM RPC (the chain the registry is deployed on)
//   ERC8004_REGISTRY_ADDRESS=0x... IdentityRegistry address
//   ERC8004_PRIVATE_KEY=0x...      a GAS-FUNDED key that will own the agent NFT
//   AGENT_URI=https://...          (optional) defaults to the hosted agent-card.json
import { readFileSync } from "node:fs";

// Minimal human-readable ABI (ERC-8004 IdentityRegistry, per EIP-8004).
const ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
];

const DEFAULT_AGENT_URI =
  "https://raw.githubusercontent.com/PugarHuda/t3-gatekeeper-agent/master/agent/agent-card.json";

// Load agent/.env if present (does not override real env).
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* .env optional */ }

const rpc = process.env.ERC8004_RPC_URL;
const registry = process.env.ERC8004_REGISTRY_ADDRESS;
const pk = process.env.ERC8004_PRIVATE_KEY;
const agentUri = process.env.AGENT_URI || DEFAULT_AGENT_URI;

if (!rpc || !registry || !pk) {
  console.log("ERC-8004 registration is not configured — nothing sent (no fake mint).");
  console.log("Set these in agent/.env (or the environment) to register on-chain:");
  console.log("  ERC8004_RPC_URL=<EVM RPC URL>");
  console.log("  ERC8004_REGISTRY_ADDRESS=<IdentityRegistry address>");
  console.log("  ERC8004_PRIVATE_KEY=<gas-funded owner key>");
  console.log(`  AGENT_URI=<registration file URI>   (default: ${DEFAULT_AGENT_URI})`);
  process.exit(2);
}

const { ethers } = await import("ethers");
const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(pk, provider);
const idRegistry = new ethers.Contract(registry, ABI, wallet);

console.log(`Registering agent on ERC-8004 IdentityRegistry ${registry}`);
console.log(`  owner   : ${wallet.address}`);
console.log(`  agentURI: ${agentUri}`);

const tx = await idRegistry.register(agentUri);
console.log(`  tx sent : ${tx.hash} — waiting for confirmation…`);
const receipt = await tx.wait();

let agentId;
for (const log of receipt.logs) {
  try {
    const parsed = idRegistry.interface.parseLog(log);
    if (parsed?.name === "Registered") { agentId = parsed.args.agentId; break; }
  } catch { /* not our event */ }
}
console.log(`✅ Registered in block ${receipt.blockNumber}. agentId = ${agentId ?? "(see Transfer event)"}`);
console.log("Update agent-card.json registrations[ERC-8004] to status:active with this agentId.");
