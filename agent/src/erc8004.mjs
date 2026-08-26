// ERC-8004 Trustless Agents — the read side, and the preflight that guards the write.
//
// The registration script has always had the correct ABI, but it had never been
// pointed at a real registry, so "we support ERC-8004" rested on nothing you
// could check. This module is the part that runs today, against the live
// deployment, with no wallet and no gas:
//
//   - resolve any agent's owner and registration URI
//   - ask whether an address owns an agent already
//   - PREFLIGHT a registry address before spending gas on it
//
// The preflight matters. `register()` on the wrong address is a transaction that
// costs real money and either reverts or, worse, succeeds against some other
// ERC-721 and mints something that is not an agent identity. Checking the
// contract's name and confirming the exact selector is in its deployed bytecode
// is two RPC reads and turns that class of mistake into a refusal.
import { ethers } from "ethers";

/** Function the register script calls. Its selector is checked against bytecode. */
export const REGISTER_SIGNATURE = "register(string)";
export const REGISTER_SELECTOR = ethers.id(REGISTER_SIGNATURE).slice(0, 10);

/** The reads this module makes. Deliberately a subset — no write ABI here. */
const READ_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
];

/**
 * Reference-implementation registries, deployed alongside the January 2026
 * mainnet launch. Addresses are the same across these testnets because the
 * deployments are deterministic; each was confirmed by reading `name()` back.
 *
 * These are defaults, not hardcoded destinations — ERC8004_REGISTRY_ADDRESS and
 * ERC8004_RPC_URL override both, and preflight runs against whatever you supply.
 */
export const REGISTRIES = {
  "ethereum-sepolia": {
    chainId: 11155111,
    identity: "0x7177a6867296406881E20d6647232314736Dd09A",
    reputation: "0xB5048e3ef1DA4E04deB6f7d0423D06F63869e322",
    validation: "0x662b40A526cb4017d947e71eAF6753BF3eeE66d8",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
};

export const DEFAULT_NETWORK = "ethereum-sepolia";

/** Resolve a network name to its registry config, with a useful error if unknown. */
export function registryFor(network = DEFAULT_NETWORK) {
  const cfg = REGISTRIES[network];
  if (!cfg) {
    throw new Error(
      `unknown ERC-8004 network "${network}" — known: ${Object.keys(REGISTRIES).join(", ")}. ` +
        `Set ERC8004_RPC_URL and ERC8004_REGISTRY_ADDRESS to use another chain.`,
    );
  }
  return cfg;
}

/**
 * Build {provider, contract} from explicit env, falling back to the named
 * network. Env always wins, so a different chain needs no code change.
 */
export function connect({ rpc, address, network = DEFAULT_NETWORK } = {}) {
  const cfg = REGISTRIES[network];
  const url = rpc || process.env.ERC8004_RPC_URL || cfg?.rpc;
  const at = address || process.env.ERC8004_REGISTRY_ADDRESS || cfg?.identity;
  if (!url || !at) throw new Error("ERC-8004: need an RPC URL and a registry address");
  const provider = new ethers.JsonRpcProvider(url);
  return { provider, address: at, contract: new ethers.Contract(at, READ_ABI, provider) };
}

/**
 * Confirm the address really is an ERC-8004 IdentityRegistry before any gas is
 * spent on it. Returns a report rather than throwing, so a caller can print
 * every problem at once instead of discovering them one transaction at a time.
 */
export async function preflight(opts = {}) {
  const { provider, address, contract } = connect(opts);
  const report = { address, ok: false, checks: [] };
  const check = (name, pass, detail) => report.checks.push({ name, pass, detail });

  const code = await provider.getCode(address);
  const deployed = code && code !== "0x";
  check("a contract is deployed at the address", deployed, deployed ? `${(code.length - 2) / 2} bytes` : "no code");
  if (!deployed) return report;

  let name = null;
  try {
    name = await contract.name();
  } catch (e) {
    check("name() is readable", false, String(e.shortMessage ?? e.message).slice(0, 80));
  }
  if (name !== null) {
    // The reference deployment names itself exactly this. A different ERC-721
    // answering name() is precisely the mistake this preflight exists to catch,
    // so an unexpected name is a warning, not a hard failure — a fork may
    // legitimately rename, and the selector check below is the load-bearing one.
    check("name() looks like an agent registry", /agent/i.test(name), JSON.stringify(name));
  }

  // The load-bearing check: the exact function the register script will call
  // must exist in the deployed bytecode.
  const hasRegister = code.includes(REGISTER_SELECTOR.slice(2));
  check(`${REGISTER_SIGNATURE} is in the bytecode`, hasRegister, REGISTER_SELECTOR);

  report.name = name;
  report.ok = deployed && hasRegister;
  return report;
}

/** Read one agent's on-chain record. Returns null for an id nobody has minted. */
export async function resolveAgent(agentId, opts = {}) {
  const { contract } = connect(opts);
  try {
    const [owner, uri] = await Promise.all([
      contract.ownerOf(agentId),
      contract.tokenURI(agentId).catch(() => ""),
    ]);
    return { agentId: String(agentId), owner, uri };
  } catch (e) {
    // A nonexistent token reverts; that is an answer, not a failure.
    if (/nonexistent|invalid token|ERC721/i.test(String(e.shortMessage ?? e.message))) return null;
    throw e;
  }
}

/** How many agent identities an address owns. 0 means "not registered". */
export async function ownedBy(owner, opts = {}) {
  const { contract } = connect(opts);
  const count = await contract.balanceOf(owner);
  return { owner, count: Number(count), registered: count > 0n };
}
