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
