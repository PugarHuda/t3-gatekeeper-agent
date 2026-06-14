// True BBS+ selective disclosure on top of Terminal 3 keys.
//
// Terminal 3's @terminal3/bbs_vc ships credential issuance + base verification,
// but does NOT wrap the holder-side derive step (`createProof`) that the W3C
// bbs-2023 suite is built for. This module fills that gap: an issuer signs a
// full record, the holder derives a zero-knowledge proof revealing ONLY the
// claims a verifier needs, and the verifier checks it without ever seeing the
// hidden claims. Keys are Terminal 3 BLS keys (vc_core); the ZK derive uses the
// BBS primitives the stack already ships (@mattrglobal/bbs-signatures).
import * as vcCore from "@terminal3/vc_core";
import * as bbs from "@terminal3/bbs_vc";
import { blsSign, blsCreateProof, blsVerifyProof } from "@mattrglobal/bbs-signatures";
import { randomBytes } from "node:crypto";

const utf8 = (s) => new TextEncoder().encode(s);
const toBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const toHex = (u8) => Buffer.from(u8).toString("hex");
const encodeClaim = (k, v) => utf8(`${k}=${v}`);

/**
 * ISSUER — sign a full claim record. Each claim becomes one BBS message, so any
 * subset can later be selectively disclosed. Returns a credential the holder keeps.
 */
export async function issueRecord(claims) {
  const skHex = vcCore.randomKeyBls();
  const issuerPublicKey = bbs.blsG2PublicKeyFromPrivateKey(skHex);
  const keys = Object.keys(claims);
  const messages = keys.map((k) => encodeClaim(k, claims[k]));
  const signature = await blsSign({
    keyPair: { publicKey: toBytes(issuerPublicKey), secretKey: toBytes(skHex) },
    messages,
  });
  return { issuerPublicKey, keys, claims, signature: toHex(signature) };
}

/**
 * HOLDER — derive a proof that reveals ONLY `revealKeys`, hiding everything else.
 * The hidden claim values are never included in the output.
 */
export async function discloseOnly(cred, revealKeys) {
  if (!Array.isArray(revealKeys) || revealKeys.length === 0) {
    throw new Error("discloseOnly: reveal at least one claim");
  }
  for (const k of revealKeys) {
    if (!cred.keys.includes(k)) {
      throw new Error(`discloseOnly: unknown claim '${k}' (signed claims: ${cred.keys.join(", ")})`);
    }
  }
  const publicKey = toBytes(cred.issuerPublicKey);
  const messages = cred.keys.map((k) => encodeClaim(k, cred.claims[k]));
  const revealed = [...new Set(revealKeys.map((k) => cred.keys.indexOf(k)))].sort((a, b) => a - b);
  const nonce = randomBytes(32);
  const proof = await blsCreateProof({ signature: toBytes(cred.signature), publicKey, messages, revealed, nonce });
  // Disclosed messages in original-index order (verifier needs the same order).
  const disclosed = revealed.map((i) => ({ key: cred.keys[i], value: cred.claims[cred.keys[i]] }));
  return { issuerPublicKey: cred.issuerPublicKey, disclosed, proof: toHex(proof), nonce: toHex(nonce) };
}

/**
 * VERIFIER — confirm the disclosed claims were genuinely issuer-signed, without
 * learning the hidden ones. Returns true/false.
 */
export async function verifyDisclosure(d) {
  const publicKey = toBytes(d.issuerPublicKey);
  const messages = d.disclosed.map(({ key, value }) => encodeClaim(key, value));
  const res = await blsVerifyProof({ proof: toBytes(d.proof), publicKey, messages, nonce: toBytes(d.nonce) });
  return res.verified === true;
}
