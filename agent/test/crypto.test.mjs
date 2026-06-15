// Offline crypto tests — no testnet / API key required.
// Covers the VC eligibility gate (both modes) end-to-end.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as vcCore from "@terminal3/vc_core";
import * as bbs from "@terminal3/bbs_vc";
import { issueRecord, discloseOnly, verifyDisclosure } from "../src/selective-disclosure.mjs";

const subjectDid = () => new bbs.BbsDID(vcCore.randomKeyBls()).did;

async function makeCred(claims) {
  const issuer = new bbs.BbsDID(vcCore.randomKeyBls());
  const vc = await bbs.createBbsCredential(
    issuer,
    new vcCore.DID(...vcCore.getMethodIdentifier(subjectDid())),
    claims,
    ["VerifiableCredential", "AccreditationCredential"],
    undefined, undefined, undefined, undefined, true,
  );
  return vc;
}

test("predicate VC issues and verifies", async () => {
  const vc = await makeCred({ accreditedInvestor: true });
  const res = await bbs.verifyBbsVCW3c(vc);
  assert.equal(res.isValid, true);
  assert.equal(vc.proof.cryptosuite, "bbs-2023");
});

test("tampered VC is rejected (signature enforced)", async () => {
  const vc = await makeCred({ accreditedInvestor: false });
  vc.credentialSubject.accreditedInvestor = true; // tamper after signing
  const res = await bbs.verifyBbsVCW3c(vc);
  assert.equal(res.isValid, false);
});

test("selective disclosure reveals only the chosen claim", async () => {
  const cred = await issueRecord({
    fullName: "Aisha Rahman",
    dateOfBirth: "1990-04-12",
    netWorthUSD: 5_000_000,
    accreditedInvestor: true,
  });
  const d = await discloseOnly(cred, ["accreditedInvestor"]);
  // exactly the chosen claim is disclosed; hidden claims are absent from the
  // disclosed set (the opaque proof bytes are not scanned — they carry no plaintext)
  const disclosedKeys = d.disclosed.map((x) => x.key);
  assert.deepEqual(disclosedKeys, ["accreditedInvestor"]);
  for (const hidden of ["fullName", "dateOfBirth", "netWorthUSD"]) {
    assert.ok(!disclosedKeys.includes(hidden), `${hidden} must stay hidden`);
  }
  assert.equal(await verifyDisclosure(d), true);
});

test("forged disclosed value is rejected", async () => {
  const cred = await issueRecord({ accreditedInvestor: true, tier: "gold" });
  const d = await discloseOnly(cred, ["accreditedInvestor"]);
  d.disclosed[0].value = false; // claim a different value than was signed
  assert.equal(await verifyDisclosure(d), false);
});
