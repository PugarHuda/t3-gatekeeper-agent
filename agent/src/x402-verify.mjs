// `npm run x402:verify` — does a signature this agent makes mean anything to
// anyone else?
//
// Every other x402 check in this repo verifies our signature with our own
// verifier. That proves the two halves agree with each other and nothing about
// the world. The claim worth making is stronger: that a settlement contract
// would accept it.
//
// It is checked twice, from the outside in.
//
//   1. The EIP-712 domain — four values, and if any one is wrong the signature
//      recovers to a stranger, silently, at the only moment it counts. Read
//      `DOMAIN_SEPARATOR()` off the DEPLOYED TOKEN and compare.
//   2. A real, independent facilitator. `POST /verify` at the public x402
//      facilitator hands our payload to someone else's implementation, which
//      recovers the payer itself and SIMULATES the transfer on chain. If it
//      comes back rejecting us for anything other than an empty wallet, our
//      x402 is wrong and every other test in this repo was agreeing with itself.
//
// No wallet, no gas, no funds: `DOMAIN_SEPARATOR()` is a view call, and /verify
// only simulates. Nothing here can move money — `settle` is deliberately not
// called. It lives here rather than in `npm test` because `node verify.mjs`
// promises to run offline, and this needs a live chain.
import { ethers } from "ethers";
import { eip712Domain, domainSeparator, verifyPayment, signPayment, ephemeralWallet, loadPaymentWallet, TRANSFER_WITH_AUTHORIZATION_TYPES } from "./x402.mjs";
import { loadEnv } from "./lib.mjs";

// Read agent/.env so a configured payment wallet is picked up here too. Missing
// is fine — the checks below run on a throwaway key when there is none.
try { loadEnv(new URL("../.env", import.meta.url)); } catch { /* no .env: fine */ }

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

// A real signature, recovered WITHOUT going through our verifier.
//
// The configured payment wallet when there is one, so this doubles as the
// readiness check for settlement; otherwise a throwaway key, which signs just
// as validly and holds just as little.
const configured = loadPaymentWallet();
const wallet = configured ?? ephemeralWallet();
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

// ── someone else's implementation ──────────────────────────────────────────
//
// The decisive check. Everything above is still our code checking our code.
// This hands the payload to an independent facilitator, which recovers the
// payer itself and SIMULATES the transfer on chain. If it rejects us for
// anything other than an empty wallet, our x402 is wrong and every other test
// in this repo has been agreeing with itself.
//
// `/verify` only simulates. `settle` — the call that would broadcast — is
// deliberately not made here, so this check can never move money.
const FACILITATOR = (process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator").replace(/\/$/, "");
console.log(`\nasking an independent facilitator to verify it:\n  ${FACILITATOR}`);

try {
  const supported = await (await fetch(`${FACILITATOR}/supported`, { signal: AbortSignal.timeout(20_000) })).json();
  const kinds = supported.kinds ?? [];
  check(
    "the facilitator supports our scheme on our network",
    kinds.some((k) => k.scheme === requirement.scheme && k.network === NETWORK),
    `offers ${kinds.filter((k) => k.network === NETWORK).map((k) => k.scheme).join(", ") || "nothing"} on ${NETWORK}`,
  );

  const res = await fetch(`${FACILITATOR}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements: requirement }),
    signal: AbortSignal.timeout(30_000),
  });
  const verdict = await res.json();

  check("it accepted the payload as well-formed", res.status === 200, `HTTP ${res.status}`);
  check(
    "it recovered the SAME payer from our signature",
    String(verdict.payer).toLowerCase() === wallet.address.toLowerCase(),
    `${verdict.payer}  (we signed with ${wallet.address})`,
  );

  // The wallet is empty on purpose, so the only acceptable rejection is that.
  // Anything else means the signature, domain, nonce or encoding is wrong.
  const onlyMoney = verdict.isValid === true
    || /insufficient_balance|insufficient_funds/i.test(String(verdict.invalidReason));
  check(
    "the only thing it objects to is an empty wallet",
    onlyMoney,
    verdict.isValid ? "accepted outright" : String(verdict.invalidReason),
  );
  if (onlyMoney && verdict.isValid !== true) {
    console.log("        it simulated transferWithAuthorization on chain and got as far as the");
    console.log("        balance check — so the signature, domain, nonce and validity window");
    console.log("        all passed against the real token, in someone else's implementation.");
  }
} catch (e) {
  failed++;
  console.log(`  FAIL  could not reach the facilitator\n        ${String(e.message ?? e).slice(0, 140)}`);
}

// ── settlement readiness ───────────────────────────────────────────────────
// The one thing still missing is money, so say exactly where it goes.
const balance = await new ethers.Contract(
  USDC, ["function balanceOf(address) view returns (uint256)"], provider,
).balanceOf(wallet.address);

console.log(`\nsettlement readiness`);
console.log(`  wallet   ${wallet.address}  ${configured ? "(X402_PRIVATE_KEY)" : "(throwaway — set X402_PRIVATE_KEY to keep one)"}`);
console.log(`  balance  ${ethers.formatUnits(balance, Number(decimals))} ${name}`);
if (balance > 0n) {
  console.log(`  Funded — this wallet can settle. Set X402_FACILITATOR_URL=${FACILITATOR}`);
  console.log(`  and fetchWithMandate will settle on approval.`);
} else if (configured) {
  // The key is kept; only the money is missing. Say the one remaining thing.
  console.log(`  Empty, which is exactly why /verify stops at the balance check.`);
  console.log(`  Fund THIS address with Base Sepolia USDC and settlement works:`);
  console.log(`    ${wallet.address}`);
  console.log(`    https://faucet.circle.com   (choose Base Sepolia, paste the address)`);
  console.log(`  It needs USDC only — no ETH. EIP-3009 settlement is broadcast by the`);
  console.log(`  facilitator, so the payer never pays gas.`);
} else {
  console.log(`  Empty, and the key above is a throwaway — a different address every run,`);
  console.log(`  so there is nothing stable to fund. Set X402_PRIVATE_KEY in agent/.env`);
  console.log(`  first, re-run this, and fund the address it prints.`);
}

console.log(
  failed === 0
    ? `\nSignatures this agent produces are valid for ${name} at ${USDC}, and an\n` +
      `independent facilitator agrees. Settlement needs a funded wallet; the\n` +
      `cryptography does not, and it is done.`
    : `\n${failed} check(s) failed — do not trust this agent's x402 signatures until they pass.`,
);
process.exit(failed === 0 ? 0 : 1);
