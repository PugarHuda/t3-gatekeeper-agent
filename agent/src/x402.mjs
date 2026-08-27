// x402 — HTTP 402 payments, with the mandate deciding whether to pay.
//
// x402 turns "Payment Required" back into a status code an agent can act on: a
// server answers 402 with what it costs, the client signs an EIP-3009 transfer
// authorisation, and retries. It is the cleanest fit this project has found for
// the gate, because it inverts the usual question. The interesting decision is
// not *can* the agent pay — it holds a key, so it can — but *may* it, at this
// price, to this recipient, right now.
//
// So the 402's requirement is mapped into an ordinary `Action` and run through
// the same enclave mandate as every other action. An agent that is allowed to
// buy RWA is not thereby allowed to spend the treasury on API calls: `x402.pay`
// is its own `kind`, and deny-by-default means a mandate that never mentions it
// refuses it.
//
// WHAT IS REAL HERE, precisely:
//   * The 402 challenge, the headers, and their base64-JSON encoding follow the
//     v2 HTTP transport spec (PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
//     PAYMENT-RESPONSE).
//   * The signature is a real EIP-712 `TransferWithAuthorization` over the real
//     EIP-3009 type hash. `verifyPayment` recovers the signer with ecrecover and
//     checks it against `authorization.from` — the same check a facilitator's
//     /verify does, minus the on-chain balance read.
//   * Both sides run in the tests, over real HTTP, against real signatures.
//
// WHAT IS NOT: settlement. Moving the tokens needs a facilitator and a funded
// wallet. `settle()` calls a facilitator when one is configured and REFUSES when
// one is not, rather than returning a receipt nobody paid for.
import { ethers } from "ethers";

export const X402_VERSION = 2;

// v2 HTTP transport. (v1 used `X-PAYMENT`; both are read on input, because a
// resource server in the wild may still be on either, and being strict on what
// you send while lenient on what you accept costs nothing here.)
export const HEADER_REQUIRED = "payment-required";
export const HEADER_SIGNATURE = "payment-signature";
export const HEADER_RESPONSE = "payment-response";
const LEGACY_SIGNATURE_HEADERS = ["x-payment"];

/** The `kind` an x402 payment takes in a mandate. Deny-by-default covers it. */
export const PAYMENT_KIND = "x402.pay";

/** EIP-3009. This type hash is fixed by the standard, not by x402. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// ── header codec ────────────────────────────────────────────────────────────

/** Base64-encoded JSON, as all three x402 headers are defined to carry. */
export function encodeHeader(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function decodeHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Read the payment challenge from a 402, header first, body as the fallback. */
export async function readChallenge(res) {
  const fromHeader = decodeHeader(res.headers.get(HEADER_REQUIRED));
  if (fromHeader) return fromHeader;
  // Some servers put the same object in the body instead. Same data, and
  // refusing to read it would fail a payment for a formatting preference.
  try {
    const body = await res.clone().json();
    if (body?.x402Version) return body;
  } catch { /* not JSON — there is simply no challenge */ }
  return null;
}

/** Read a payment payload off an incoming request's headers. */
export function readPaymentHeader(headers) {
  const get = (k) => (typeof headers.get === "function" ? headers.get(k) : headers[k]);
  for (const name of [HEADER_SIGNATURE, ...LEGACY_SIGNATURE_HEADERS]) {
    const decoded = decodeHeader(get(name));
    if (decoded) return decoded;
  }
  return null;
}

// ── networks and units ──────────────────────────────────────────────────────

/** CAIP-2 → EIP-155 chain id. `eip155:84532` is Base Sepolia. */
export function chainIdFor(network) {
  const m = /^eip155:(\d+)$/.exec(String(network ?? ""));
  if (!m) throw new Error(`x402: unsupported network ${JSON.stringify(network)} — expected CAIP-2 eip155:<chainId>`);
  return Number(m[1]);
}

/**
 * Atomic token units → cents, for the mandate.
 *
 * Decimals are NOT guessed. A wrong guess here is a wrong number in front of the
 * spending limit — off by a factor of 100 in whichever direction the guess
 * missed — so an asset that does not declare its decimals is refused instead.
 *
 * Rounding is UP, deliberately. If a price does not divide into whole cents the
 * mandate is shown the larger number, because the failure that matters is a
 * payment slipping under a cap it should have hit.
 */
export function amountToCents(amount, decimals) {
  if (!Number.isInteger(decimals) || decimals < 2) {
    throw new Error(`x402: refusing to price an asset with unknown decimals (${decimals}) — set extra.decimals`);
  }
  const atomic = BigInt(amount);
  if (atomic < 0n) throw new Error("x402: negative amount");
  const perCent = 10n ** BigInt(decimals - 2);
  return Number((atomic + perCent - 1n) / perCent); // ceil
}

/**
 * The `Action` a payment requirement becomes, for the gate.
 *
 * `counterparty` is the payee address, so a mandate can allow-list who may be
 * paid — the single most useful control here, since the amount is usually small
 * and the recipient is the part an attacker wants to change.
 */
export function actionForRequirement(requirement, { decimals } = {}) {
  const d = decimals ?? requirement?.extra?.decimals;
  return {
    kind: PAYMENT_KIND,
    asset: requirement?.extra?.name ?? requirement?.asset ?? "",
    amount_cents: amountToCents(requirement.amount, d),
    counterparty: requirement.payTo,
  };
}

/** Pick a requirement this client can actually satisfy. */
export function selectRequirement(challenge, { scheme = "exact", network } = {}) {
  const accepts = challenge?.accepts ?? [];
  const usable = accepts.filter((a) => a.scheme === scheme && (!network || a.network === network));
  if (!usable.length) {
    throw new Error(
      `x402: no requirement matches scheme=${scheme}${network ? ` network=${network}` : ""} ` +
      `(offered: ${accepts.map((a) => `${a.scheme}/${a.network}`).join(", ") || "none"})`,
    );
  }
  return usable[0];
}

// ── client: sign ────────────────────────────────────────────────────────────

/**
 * The EIP-712 domain a requirement signs under.
 *
 * Four values, and every one of them load-bearing: get any wrong and the
 * signature recovers to a stranger, at the only moment it matters. `name` and
 * `version` are the TOKEN CONTRACT's own domain fields, which is why they are
 * required in `extra` rather than defaulted to something plausible.
 *
 * `npm run x402:domain` checks this against the deployed token's own
 * DOMAIN_SEPARATOR, so the agreement is verified rather than assumed.
 */
export function eip712Domain(requirement) {
  const name = requirement?.extra?.name;
  const version = requirement?.extra?.version;
  if (!name || !version) {
    throw new Error("x402: requirement.extra must carry the token's EIP-712 `name` and `version`");
  }
  return {
    name,
    version: String(version),
    chainId: chainIdFor(requirement.network),
    verifyingContract: ethers.getAddress(requirement.asset),
  };
}

/** The domain separator our signatures commit to, as the token computes it. */
export function domainSeparator(requirement) {
  return ethers.TypedDataEncoder.hashDomain(eip712Domain(requirement));
}

/**
 * Sign an EIP-3009 transfer authorisation for one requirement.
 *
 * The domain's `name` and `version` come from the requirement's `extra`, because
 * they are the token contract's own EIP-712 domain fields and getting them wrong
 * produces a signature that verifies against nothing. They are required rather
 * than defaulted for that reason.
 */
export async function signPayment({ requirement, resource, wallet, validForSecs = 600, nowSecs }) {
  const domain = eip712Domain(requirement); // throws if `extra` is incomplete
  const now = nowSecs ?? Math.floor(Date.now() / 1000);
  const authorization = {
    from: await wallet.getAddress(),
    to: ethers.getAddress(requirement.payTo),
    value: String(requirement.amount),
    // A minute of slack backwards: the signer's clock and the settling node's
    // clock are not the same clock, and a `validAfter` in the future makes the
    // authorisation unusable on arrival.
    validAfter: String(now - 60),
    validBefore: String(now + validForSecs),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await wallet.signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, authorization);

  return {
    x402Version: X402_VERSION,
    ...(resource ? { resource } : {}),
    accepted: requirement,
    payload: { signature, authorization },
  };
}

// ── server / facilitator: verify ────────────────────────────────────────────

/**
 * Everything a facilitator's /verify checks except the payer's balance.
 *
 * Returns a report rather than throwing, and never says `valid: true` on a
 * check it could not perform. The recipient and the amount are compared against
 * the requirement the SERVER holds, not the one echoed back in the payload —
 * `accepted` is attacker-controlled, and trusting it would let a client sign a
 * one-cent authorisation and label it as the ten-dollar one.
 */
export function verifyPayment(paymentPayload, requirement, { nowSecs } = {}) {
  const fail = (invalidReason, payer = null) => ({ isValid: false, invalidReason, payer });

  if (paymentPayload?.x402Version !== X402_VERSION) return fail(`unsupported x402Version ${paymentPayload?.x402Version}`);
  const auth = paymentPayload?.payload?.authorization;
  const signature = paymentPayload?.payload?.signature;
  if (!auth || !signature) return fail("payload is missing signature or authorization");

  const name = requirement?.extra?.name;
  const version = requirement?.extra?.version;
  if (!name || !version) return fail("server requirement has no EIP-712 domain (extra.name / extra.version)");

  let payer;
  try {
    payer = ethers.verifyTypedData(eip712Domain(requirement), TRANSFER_WITH_AUTHORIZATION_TYPES, {
      from: auth.from, to: auth.to, value: auth.value,
      validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce,
    }, signature);
  } catch (e) {
    return fail(`signature does not recover: ${String(e.shortMessage ?? e.message).slice(0, 120)}`);
  }

  // The signature is valid for SOMETHING. These checks decide whether it is
  // valid for THIS request.
  if (ethers.getAddress(payer) !== ethers.getAddress(auth.from)) {
    return fail("signature was not produced by authorization.from", payer);
  }
  if (ethers.getAddress(auth.to) !== ethers.getAddress(requirement.payTo)) {
    return fail(`pays ${auth.to}, but this resource is paid at ${requirement.payTo}`, payer);
  }
  if (BigInt(auth.value) < BigInt(requirement.amount)) {
    return fail(`authorises ${auth.value}, less than the required ${requirement.amount}`, payer);
  }
  const now = nowSecs ?? Math.floor(Date.now() / 1000);
  if (now < Number(auth.validAfter)) return fail("authorization is not valid yet", payer);
  if (now >= Number(auth.validBefore)) return fail("authorization has expired", payer);

  return { isValid: true, payer };
}

// ── settlement ──────────────────────────────────────────────────────────────

/**
 * Hand the authorisation to a facilitator to broadcast.
 *
 * This is the one step that needs money to exist. With no facilitator
 * configured it refuses — a settlement receipt this process invented would be
 * worse than no receipt, because something downstream would believe it.
 */
export async function settle(paymentPayload, requirement, {
  facilitatorUrl = process.env.X402_FACILITATOR_URL,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  if (!facilitatorUrl) {
    return {
      success: false,
      errorReason: "no facilitator configured — set X402_FACILITATOR_URL to settle for real",
      settled: false,
      payer: paymentPayload?.payload?.authorization?.from ?? null,
    };
  }
  const res = await fetchImpl(new URL("/settle", facilitatorUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements: requirement }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  return { ...body, settled: body?.success === true };
}

// ── server helper ───────────────────────────────────────────────────────────

/** The 402 a resource server sends: status, headers and body all consistent. */
export function paymentRequired({ accepts, resource, error = "payment required" }) {
  const challenge = { x402Version: X402_VERSION, error, ...(resource ? { resource } : {}), accepts };
  return {
    status: 402,
    headers: { [HEADER_REQUIRED]: encodeHeader(challenge), "content-type": "application/json" },
    body: challenge,
  };
}

/** The receipt header a server returns once payment is accepted. */
export function settlementHeader(settlement) {
  return { [HEADER_RESPONSE]: encodeHeader(settlement) };
}

// ── client: the whole flow ──────────────────────────────────────────────────

/**
 * Fetch a resource, and if it costs money, ask the mandate before paying.
 *
 * `decide` is injected rather than imported so this works against the compiled
 * contract offline (gate_cli) or the enclave, without this module choosing.
 * It receives the Action and must return `{ decision, reasons }`.
 *
 * A rejected payment is not an error — it is the gate doing its job — so it
 * comes back as a result with `paid: false` and the reasons, and the caller
 * decides what that means.
 */
export async function fetchWithMandate(url, {
  decide,
  wallet,
  fetchImpl = fetch,
  init = {},
  scheme = "exact",
  network,
  decimals,
  settleWith = null,
} = {}) {
  const first = await fetchImpl(url, init);
  if (first.status !== 402) return { response: first, paid: false, reason: "no payment was required" };

  const challenge = await readChallenge(first);
  if (!challenge) throw new Error("x402: 402 response carried no payment requirements");

  const requirement = selectRequirement(challenge, { scheme, network });
  const action = actionForRequirement(requirement, { decimals });

  const verdict = await decide(action, { requirement, challenge });
  if (verdict?.decision !== "approved") {
    return { paid: false, response: first, action, requirement, decision: verdict, reason: "refused by mandate" };
  }
  if (!wallet) {
    throw new Error("x402: the mandate approved this payment but no wallet is configured (set X402_PRIVATE_KEY)");
  }

  const payment = await signPayment({ requirement, resource: challenge.resource, wallet });
  const settlement = settleWith ? await settle(payment, requirement, settleWith) : null;

  const retry = await fetchImpl(url, {
    ...init,
    headers: { ...(init.headers ?? {}), [HEADER_SIGNATURE]: encodeHeader(payment) },
  });
  return {
    paid: true,
    response: retry,
    action,
    requirement,
    payment,
    settlement,
    receipt: decodeHeader(retry.headers.get(HEADER_RESPONSE)),
  };
}

/** The agent's payment wallet, or null. Never invented — an unfunded key is a
 *  real key that signs real authorisations, but a missing one is not one. */
export function loadPaymentWallet(env = process.env) {
  const key = env.X402_PRIVATE_KEY;
  return key ? new ethers.Wallet(key) : null;
}

/**
 * A throwaway signer, for demos and QA.
 *
 * Real key, real signatures, no money — which is exactly what a console that
 * must not move funds needs. It lives here so `ethers` has one owner in this
 * repo; callers get a wallet without taking the dependency themselves.
 */
export function ephemeralWallet() {
  return ethers.Wallet.createRandom();
}
