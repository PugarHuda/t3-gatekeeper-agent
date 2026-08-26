// Bind a verified credential to the action it authorises.
//
// The agent verifies the BBS+ eligibility proof — the enclave cannot, because
// that needs host `vp.verify`, which this node does not serve. So the enclave
// stops trusting the agent twice: the agent must commit, before the decision, to
// *which* credential it verified and *which* action it verified it for. The
// enclave recomputes that commitment from the action it is actually about to
// perform, and refuses if they differ.
//
// The concrete attack this closes: verify a credential for a $500 purchase, then
// submit a $500,000 one carrying the same "yes, I checked" claim. Same
// credential, different action, different digest, rejected.
//
// What it does NOT do, said plainly: prove the proof was valid. A dishonest
// agent can still commit to a credential it never verified. Closing that needs
// in-contract proof verification — see bug #7.
//
// This must agree with `gate.rs` exactly. `test/credential-binding.test.mjs`
// asserts that against the compiled Rust rather than by inspection.
import { createHash, randomBytes } from "node:crypto";

/** Must equal `gate::BINDING_DOMAIN`. */
export const BINDING_DOMAIN = "t3-gatekeeper/cred-binding/v1";

/**
 * Length-prefixed SHA-256 over an ordered field list, hex encoded.
 *
 * The prefix is what stops ("ab","c") and ("a","bc") hashing the same — without
 * it an attacker chooses where one field ends and the next begins, and can move
 * data across a boundary without changing the digest.
 */
function sha256Hex(parts) {
  const h = createHash("sha256");
  for (const p of parts) {
    const bytes = Buffer.from(String(p), "utf8");
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(bytes.length));
    h.update(len);
    h.update(bytes);
  }
  return h.digest("hex");
}

/** Digest of the action, over exactly the fields `gate::action_digest` uses. */
export function actionDigest(action) {
  return sha256Hex([
    action.kind ?? "",
    action.asset ?? "",
    String(action.amount_cents ?? 0),
    action.counterparty ?? "",
  ]);
}

/** The commitment. Both sides compute this; the enclave compares. */
export function expectedCommitment(binding, action) {
  return sha256Hex([
    BINDING_DOMAIN,
    binding.issuer ?? "",
    binding.subject ?? "",
    binding.claims_digest ?? "",
    actionDigest(action),
    binding.nonce ?? "",
  ]);
}

/**
 * Digest of the claims the agent actually saw and verified.
 *
 * Keys are sorted so the digest does not depend on object ordering, and each
 * key and value is length-prefixed for the same reason as above. The enclave
 * treats this as opaque — it never sees the claims — so this format only has to
 * be stable, not shared.
 */
export function claimsDigest(claims) {
  const parts = [];
  for (const k of Object.keys(claims).sort()) {
    parts.push(k, JSON.stringify(claims[k]));
  }
  return sha256Hex(parts);
}

/**
 * Build a binding for a credential the agent has just verified.
 *
 * Call this AFTER verification succeeds. Building one for an unverified
 * credential is how the remaining gap gets exploited, so the argument is named
 * `verified` to make a caller notice they are asserting something.
 */
export function bindCredential({ issuer, subject, claims, verified }, action) {
  if (verified !== true) {
    throw new Error(
      "bindCredential: refusing to bind a credential that was not verified — " +
        "pass verified:true only after the BBS+ proof checks out",
    );
  }
  if (!issuer || !subject) throw new Error("bindCredential: issuer and subject are required");

  const binding = {
    issuer,
    subject,
    claims_digest: claimsDigest(claims ?? {}),
    // Single-use: a binding cannot be replayed for a later action, even an
    // identical one.
    nonce: randomBytes(16).toString("hex"),
  };
  binding.commitment = expectedCommitment(binding, action);
  return binding;
}
