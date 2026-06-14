// REAL selective disclosure: issuer signs a full record; holder derives a proof
// revealing ONLY one claim; verifier checks it without seeing the hidden claims.
// Keys come from Terminal 3 vc_core; the ZK derive uses the BBS primitives the
// stack already ships (@mattrglobal/bbs-signatures).
import * as vcCore from "@terminal3/vc_core";
import * as bbs from "@terminal3/bbs_vc";
import { blsSign, blsCreateProof, blsVerifyProof } from "@mattrglobal/bbs-signatures";
import { randomBytes } from "node:crypto";

const hexToBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const utf8 = (s) => new TextEncoder().encode(s);

(async () => {
  // --- Issuer keys via Terminal 3 vc_core ---
  const skHex = vcCore.randomKeyBls();
  const secretKey = hexToBytes(skHex);
  const publicKey = hexToBytes(bbs.blsG2PublicKeyFromPrivateKey(skHex));
  console.log(`issuer keys: sk=${secretKey.length}B  pk(G2)=${publicKey.length}B`);

  // --- Issuer signs the FULL KYC record (4 claims) ---
  const claims = [
    "fullName=Aisha Rahman",
    "dateOfBirth=1990-04-12",
    "netWorthUSD=5000000",
    "accreditedInvestor=true",
  ];
  const messages = claims.map(utf8);
  const signature = await blsSign({ keyPair: { publicKey, secretKey }, messages });
  console.log(`issuer signed ${claims.length} claims → signature ${signature.length}B`);

  // --- Holder derives a proof revealing ONLY claim #3 (accreditedInvestor) ---
  const nonce = randomBytes(32);
  const revealed = [3];
  const proof = await blsCreateProof({ signature, publicKey, messages, revealed, nonce });
  console.log(`\nholder derived proof: ${proof.length}B`);
  console.log(`  reveals : ${revealed.map((i) => claims[i]).join(", ")}`);
  console.log(`  hides   : ${claims.filter((_, i) => !revealed.includes(i)).join(", ")}`);

  // --- Verifier sees ONLY the revealed message, never the hidden ones ---
  const revealedMessages = revealed.map((i) => messages[i]);
  const ok = await blsVerifyProof({ proof, publicKey, messages: revealedMessages, nonce });
  console.log(`\nverify derived proof (accreditedInvestor=true): ${JSON.stringify(ok)}`);

  // --- Negative 1: verifier asserts a DIFFERENT revealed value → must fail ---
  const wrongVal = await blsVerifyProof({ proof, publicKey, messages: [utf8("accreditedInvestor=false")], nonce });
  console.log(`verify with forged value (=false):              ${JSON.stringify(wrongVal)}`);

  // --- Negative 2: wrong nonce (replay/tamper) → must fail ---
  const wrongNonce = await blsVerifyProof({ proof, publicKey, messages: revealedMessages, nonce: randomBytes(32) });
  console.log(`verify with wrong nonce:                        ${JSON.stringify(wrongNonce)}`);

  const pass = ok.verified === true && wrongVal.verified === false && wrongNonce.verified === false;
  console.log(`\nRESULT: real selective disclosure ${pass ? "WORKS ✅ (reveal subset, hide rest, forgery rejected)" : "FAILED ❌"}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("ERROR", e?.stack ?? e); process.exit(1); });
