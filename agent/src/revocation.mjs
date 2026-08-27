// Credential-revocation pre-gate. Before the agent trusts an eligibility VC, it
// checks the issuer's on-chain status registry: a revoked credential is a
// kill-switch that blocks the action even if the BBS+ proof still verifies.
//
// Uses Terminal 3's `@terminal3/revoke_vc` `isRevoked()` against an EVM
// revocation registry. The check is CONFIG-GATED: with no registry configured
// the gate degrades gracefully (see `failClosed`) instead of pretending to run.
// `isRevokedFn` is injectable so the gate logic is unit-testable without a chain.
import { isRevoked as realIsRevoked } from "@terminal3/revoke_vc";

/**
 * Build VerificationOptions from env, or return null if revocation isn't
 * configured. Needs REVOCATION_REGISTRY_ADDRESS + REVOCATION_RPC_URL.
 */
export async function buildOptionsFromEnv(env = process.env) {
  const registry = env.REVOCATION_REGISTRY_ADDRESS;
  const rpcUrl = env.REVOCATION_RPC_URL;
  if (!registry || !rpcUrl) return null;
  const { ethers } = await import("ethers");
  return { revocationRegistryAddress: registry, provider: new ethers.JsonRpcProvider(rpcUrl) };
}

/**
 * Revocation pre-gate. Returns { checked, revoked, reason }.
 * - When `options` is null (not configured), the check is skipped; `revoked`
 *   defaults to `failClosed` (false = fail-open, true = block on uncertainty).
 * - A thrown registry/RPC error is treated the same as "couldn't check".
 */
export async function checkRevocation(vcId, issuer, {
  options = null, failClosed = false, isRevokedFn = realIsRevoked,
} = {}) {
  if (!options) {
    return { checked: false, revoked: failClosed,
      reason: "revocation registry not configured (set REVOCATION_REGISTRY_ADDRESS + REVOCATION_RPC_URL)" };
  }
  try {
    const revoked = await isRevokedFn(vcId, issuer, options);
    return { checked: true, revoked, reason: revoked ? "credential revoked on-chain" : "not revoked" };
  } catch (e) {
    return { checked: false, revoked: failClosed, reason: `revocation check failed: ${e.message}` };
  }
}

/**
 * Where a credential's status entry actually lives.
 *
 * W3C VCDM 2.0 puts `credentialStatus` at the top level, and that is checked
 * first. But Terminal 3's BBS+ issuer (`createBbsCredential`) has no parameter
 * for it and signs only `credentialSubject` — so a top-level entry can be added
 * ONLY after signing, which invalidates the proof (filed as bug #22, and
 * demonstrated in test/status-list.test.mjs). Until that is fixed, an issuer
 * using this SDK has one way to bind a credential to its revocation list that
 * the signature actually covers: put the same entry inside the subject.
 *
 * So both are read, spec placement first. The difference is not cosmetic — an
 * entry inside the subject is signed by the issuer, and one bolted on top is
 * not, which is why the unsigned placement cannot be the one we issue.
 */
export function credentialStatusOf(vc) {
  return vc?.credentialStatus ?? vc?.credentialSubject?.credentialStatus ?? null;
}

/**
 * Revocation, preferring whichever method the credential actually carries.
 *
 * Two mechanisms answer the same question. The on-chain registry above is the
 * T3-native one and needs a deployed contract; W3C Bitstring Status List needs
 * only a published document, which is why it is the one that runs today.
 *
 * Order matters: a credential that names a status list is telling you where its
 * issuer publishes revocation, so that is consulted first. The registry is the
 * fallback for credentials that carry no status entry.
 *
 * `checked` is never inferred. If neither mechanism could answer, the result
 * says so and `failClosed` decides what that means — because "we could not
 * check" and "not revoked" are different facts, and conflating them is how a
 * revoked investor keeps trading.
 */
export async function checkCredentialStatus(vc, {
  options = null, failClosed = false, isRevokedFn = realIsRevoked, fetchImpl = fetch,
} = {}) {
  const { checkStatus } = await import("./status-list.mjs");

  const entry = credentialStatusOf(vc);
  if (entry) {
    const r = await checkStatus(entry, { fetchImpl });
    if (r.checked) {
      return {
        checked: true,
        revoked: r.revoked,
        method: "bitstring-status-list",
        reason: r.revoked ? `revoked at list index ${r.index}` : `not revoked (index ${r.index})`,
      };
    }
    // Fall through to the registry rather than failing outright: a credential
    // may carry a status entry AND be covered by the registry, and one method
    // being unreachable is not a reason to skip the other.
    const viaRegistry = await checkRevocation(vc.id, vc.issuer, { options, failClosed, isRevokedFn });
    return {
      ...viaRegistry,
      method: viaRegistry.checked ? "on-chain-registry" : "none",
      reason: viaRegistry.checked ? viaRegistry.reason : `${r.reason}; ${viaRegistry.reason}`,
    };
  }

  const viaRegistry = await checkRevocation(vc?.id, vc?.issuer, { options, failClosed, isRevokedFn });
  return { ...viaRegistry, method: viaRegistry.checked ? "on-chain-registry" : "none" };
}
