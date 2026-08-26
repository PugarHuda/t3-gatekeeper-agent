// W3C Bitstring Status List v1.0 — credential revocation that actually runs.
//
// The existing revocation gate (`revocation.mjs`) calls T3's `revoke_vc` against
// an on-chain registry. It is correct, and it is dormant: there is no registry
// deployed, so in practice it fails open and checks nothing. Deploying one needs
// a funded wallet, which is the same blocker ERC-8004's mint has.
//
// Bitstring Status List has no such blocker. It is the W3C mechanism for
// publishing revocation state as a compressed bitstring inside a verifiable
// credential, served over HTTPS — no chain, no gas, no key. A credential carries
// a `credentialStatus` entry naming the list and its own index in it; a verifier
// fetches the list, decompresses it, and reads one bit.
//
// It is also privacy-preserving by construction, which matters for this use
// case: the list is large and every holder is one bit in it, so fetching it
// tells the issuer nothing about which credential is being checked. An issuer
// that could see "someone just checked index 42,117" would learn when a specific
// investor is transacting.
//
// Spec: https://www.w3.org/TR/vc-bitstring-status-list/
import { gzipSync, gunzipSync } from "node:zlib";

/**
 * Minimum list length the spec mandates. Smaller lists leak: with 100 entries,
 * "someone checked this list" narrows the holder to one of a hundred people.
 */
export const MINIMUM_ENTRIES = 131_072;

/** Where this deployment publishes its revocation list. */
export const STATUS_LIST_URL =
  process.env.STATUS_LIST_URL
  ?? `${process.env.STATUS_LIST_BASE ?? "https://gatekeeper-evidence.vercel.app"}/status/revocation.json`;

/**
 * The index the published list marks revoked, so the demo has a case that comes
 * back REVOKED. A check that has only ever returned "fine" has not been shown
 * to work.
 */
export const DEMO_REVOKED_INDEX = 7;

/** Multibase prefix for base64url-no-pad, which is what the spec uses. */
const MULTIBASE_BASE64URL = "u";

/** Encode raw bitstring bytes as the spec's `encodedList`: gzip, then multibase. */
export function encodeList(bytes) {
  return MULTIBASE_BASE64URL + gzipSync(Buffer.from(bytes)).toString("base64url");
}

/** Reverse of {@link encodeList}. Throws on an unsupported multibase prefix. */
export function decodeList(encodedList) {
  if (typeof encodedList !== "string" || encodedList.length < 2) {
    throw new Error("encodedList is empty");
  }
  const prefix = encodedList[0];
  if (prefix !== MULTIBASE_BASE64URL) {
    // Being explicit beats decoding garbage: another prefix is a different
    // base, and guessing would produce a bitstring that reads as "not revoked".
    throw new Error(`unsupported multibase prefix ${JSON.stringify(prefix)} — expected "u" (base64url)`);
  }
  return new Uint8Array(gunzipSync(Buffer.from(encodedList.slice(1), "base64url")));
}

/**
 * Read one status bit.
 *
 * Bits are numbered from the left of the bitstring, so index 0 is the MOST
 * significant bit of byte 0. Getting this backwards yields a list that answers
 * confidently and wrongly, which is worse than failing.
 */
export function getBit(bytes, index) {
  if (!Number.isInteger(index) || index < 0) throw new Error(`invalid status index ${index}`);
  const byte = index >> 3;
  if (byte >= bytes.length) throw new Error(`status index ${index} is past the end of the list`);
  return (bytes[byte] >> (7 - (index & 7))) & 1;
}

/** Set one status bit, same numbering as {@link getBit}. */
export function setBit(bytes, index, on = true) {
  const byte = index >> 3;
  if (byte >= bytes.length) throw new Error(`status index ${index} is past the end of the list`);
  const mask = 1 << (7 - (index & 7));
  if (on) bytes[byte] |= mask;
  else bytes[byte] &= ~mask;
  return bytes;
}

/**
 * Build a BitstringStatusListCredential marking `revoked` indices.
 *
 * This is the document an issuer publishes. It is a verifiable credential in
 * shape; it carries no proof here because the issuer's signing key is the
 * issuer's business — a deployment that needs the list itself signed can sign
 * this object with the same BBS+/Ed25519 machinery the rest of the agent uses.
 */
export function buildStatusList({
  id,
  issuer,
  revoked = [],
  length = MINIMUM_ENTRIES,
  statusPurpose = "revocation",
  validFrom,
} = {}) {
  if (length < MINIMUM_ENTRIES) {
    throw new Error(`status list must hold at least ${MINIMUM_ENTRIES} entries (got ${length}) — a short list identifies its holders`);
  }
  const bytes = new Uint8Array(Math.ceil(length / 8));
  for (const i of revoked) {
    if (i >= length) throw new Error(`revoked index ${i} is outside a list of ${length}`);
    setBit(bytes, i, true);
  }
  return {
    "@context": [
      "https://www.w3.org/ns/credentials/v2",
    ],
    id,
    type: ["VerifiableCredential", "BitstringStatusListCredential"],
    issuer,
    ...(validFrom ? { validFrom } : {}),
    credentialSubject: {
      id: `${id}#list`,
      type: "BitstringStatusList",
      statusPurpose,
      encodedList: encodeList(bytes),
    },
  };
}

/**
 * Check a credential's `credentialStatus` entry against its published list.
 *
 * Returns a report. `revoked` is only ever true when the bit was actually read —
 * a fetch failure is `checked: false`, and it is the CALLER's policy whether
 * that blocks the action. Turning "I could not reach the list" into "not
 * revoked" is the failure mode this whole gate exists to prevent, so it is not
 * done here.
 */
export async function checkStatus(credentialStatus, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const entry = Array.isArray(credentialStatus) ? credentialStatus[0] : credentialStatus;
  if (!entry) return { checked: false, revoked: false, reason: "credential carries no credentialStatus" };

  if (entry.type !== "BitstringStatusListEntry") {
    return { checked: false, revoked: false, reason: `unsupported credentialStatus type ${entry.type}` };
  }
  const index = Number(entry.statusListIndex);
  const url = entry.statusListCredential;
  if (!url || !Number.isInteger(index)) {
    return { checked: false, revoked: false, reason: "entry is missing statusListCredential or statusListIndex" };
  }

  let list;
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { checked: false, revoked: false, reason: `status list ${url}: HTTP ${res.status}` };
    list = await res.json();
  } catch (e) {
    return { checked: false, revoked: false, reason: `status list ${url}: ${e.message}` };
  }

  const subject = list?.credentialSubject;
  if (subject?.type !== "BitstringStatusList") {
    return { checked: false, revoked: false, reason: "fetched document is not a BitstringStatusList" };
  }
  // A list published for suspension does not answer a revocation question.
  if (entry.statusPurpose && subject.statusPurpose && entry.statusPurpose !== subject.statusPurpose) {
    return {
      checked: false,
      revoked: false,
      reason: `statusPurpose mismatch: entry says ${entry.statusPurpose}, list says ${subject.statusPurpose}`,
    };
  }

  try {
    const bytes = decodeList(subject.encodedList);
    return {
      checked: true,
      revoked: getBit(bytes, index) === 1,
      index,
      statusPurpose: subject.statusPurpose ?? entry.statusPurpose ?? "revocation",
      listEntries: bytes.length * 8,
    };
  } catch (e) {
    return { checked: false, revoked: false, reason: e.message };
  }
}

/** The `credentialStatus` entry an issuer puts inside an issued credential. */
export function statusEntry({ statusListCredential, statusListIndex, statusPurpose = "revocation" }) {
  return {
    id: `${statusListCredential}#${statusListIndex}`,
    type: "BitstringStatusListEntry",
    statusPurpose,
    statusListIndex: String(statusListIndex),
    statusListCredential,
  };
}
