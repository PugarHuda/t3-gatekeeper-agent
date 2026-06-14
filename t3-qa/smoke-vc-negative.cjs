// Negative test: tampering must make verification fail (proves verify isn't a stub)
const vcCore = require("@terminal3/vc_core");
const bbs = require("@terminal3/bbs_vc");

(async () => {
  const issuer = new bbs.BbsDID(vcCore.randomKeyBls());
  const user = new bbs.BbsDID(vcCore.randomKeyBls());
  const vc = await bbs.createBbsCredential(
    issuer,
    new vcCore.DID(...vcCore.getMethodIdentifier(user.did)),
    { accreditedInvestor: false, netWorthUSD: 1000 },
    ["VerifiableCredential", "AccreditationCredential"],
    undefined, undefined, undefined, undefined, true
  );

  const clean = await bbs.verifyBbsVCW3c(vc);
  console.log("clean credential verify:", JSON.stringify(clean));

  // Attacker flips the claim: not accredited -> accredited, 1000 -> 9,000,000
  const tampered = JSON.parse(JSON.stringify(vc));
  tampered.credentialSubject.accreditedInvestor = true;
  tampered.credentialSubject.netWorthUSD = 9_000_000;

  let tamperedResult;
  try {
    tamperedResult = await bbs.verifyBbsVCW3c(tampered);
  } catch (e) {
    tamperedResult = { isValid: false, message: "threw: " + (e.message || e) };
  }
  console.log("TAMPERED credential verify:", JSON.stringify(tamperedResult));

  if (tamperedResult && tamperedResult.isValid === true) {
    console.log("\n🚨 CRITICAL: tampered credential STILL verifies as valid — signature not enforced!");
  } else {
    console.log("\n✅ GOOD: tampering correctly rejected — signature is enforced.");
  }
})();
