// `npm run x402:domain` — does a signature this agent makes mean anything on chain?
//
// Every other x402 check in this repo verifies our signature with our own
// verifier. That proves the two halves agree with each other and nothing about
// the world. The claim worth making is stronger: that a settlement contract
// would accept it.
//
// That claim rests entirely on the EIP-712 domain — four values, and if any one
// is wrong the signature recovers to a stranger, silently, at the only moment it
// counts. So this reads the domain from the DEPLOYED TOKEN and compares.
//
// No wallet, no gas, no funds: `DOMAIN_SEPARATOR()` is a view call. It lives
// here rather than in `npm test` because `node verify.mjs` promises to run
// offline, and this needs a live chain.
import { ethers } from "ethers";
import { eip712Domain, domainSeparator, verifyPayment, signPayment, ephemeralWallet, TRANSFER_WITH_AUTHORIZATION_TYPES } from "./x402.mjs";

const RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const USDC = process.env.X402_ASSET || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = process.env.X402_NETWORK || "eip155:84532";

const ABI = [
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
];

const provider = new ethers.JsonRpcProvider(RPC);
const token = new ethers.Contract(USDC, ABI, provider);

let failed = 0;
const check = (label, pass, detail = "") => {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
};

const [chain, name, version, decimals, onChainSeparator] = await Promise.all([
  provider.getNetwork(), token.name(), token.version(), token.decimals(), token.DOMAIN_SEPARATOR(),
]);

console.log(`x402 EIP-712 domain, checked against the deployed token`);
console.log(`  rpc    ${RPC}`);
console.log(`  token  ${USDC}  ${JSON.stringify(name)} v${JSON.stringify(version)}  ${decimals} decimals`);
console.log(`  chain  ${chain.chainId} (${NETWORK})\n`);

// The requirement we would actually sign, built from what the chain says.
const requirement = {
  scheme: "exact", network: NETWORK, amount: "10000", asset: USDC,
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: "eip3009", name, version, decimals: Number(decimals) },
};

check(
  "the CAIP-2 network resolves to the chain we are talking to",
  eip712Domain(requirement).chainId === Number(chain.chainId),
  `${eip712Domain(requirement).chainId} vs ${chain.chainId}`,
);

const ours = domainSeparator(requirement);
check(
  "our domain separator is byte-identical to the token's own",
  ours === onChainSeparator,
  `ours     ${ours}\n        on-chain ${onChainSeparator}`,
);

// The fixtures every other x402 test uses. If the token moves, they should stop
// being right here rather than quietly keep signing under a stale domain.
check("the fixtures the offline tests use are the token's real values",
  name === "USDC" && String(version) === "2" && Number(decimals) === 6,
  `name=${JSON.stringify(name)} version=${JSON.stringify(version)} decimals=${decimals}`);

// And a real signature, recovered WITHOUT going through our verifier.
const wallet = ephemeralWallet();
const payment = await signPayment({ requirement, wallet });
const recovered = ethers.verifyTypedData(
  { name, version: String(version), chainId: Number(chain.chainId), verifyingContract: USDC },
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  payment.payload.authorization,
  payment.payload.signature,
);
check("a signature we produced recovers to its signer under the chain's own domain",
  recovered === wallet.address, `${recovered}`);
check("and our own verifier agrees", verifyPayment(payment, requirement).payer === wallet.address);

console.log(
  failed === 0
    ? `\nSignatures this agent produces are valid for ${name} at ${USDC}.\nSettlement needs a funded wallet and a facilitator; the cryptography does not.`
    : `\n${failed} check(s) failed — do not trust this agent's x402 signatures until they pass.`,
);
process.exit(failed === 0 ? 0 : 1);
