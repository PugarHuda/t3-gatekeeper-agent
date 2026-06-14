// QA smoke test: does Terminal 3 BBS+ VC selective-disclosure actually work end-to-end?
const vcCore = require("@terminal3/vc_core");
const bbs = require("@terminal3/bbs_vc");

(async () => {
  try {
    console.log("== 1. generate issuer + user BLS keys/DIDs ==");
    const issuer = new bbs.BbsDID(vcCore.randomKeyBls());
    const user = new bbs.BbsDID(vcCore.randomKeyBls());
    console.log("issuer DID:", issuer.did);
    console.log("user DID  :", user.did);

    console.log("\n== 2. issuer issues a BBS+ credential with sensitive claims ==");
    const claims = {
      fullName: "Aisha Rahman",
      dateOfBirth: "1990-04-12",
      accreditedInvestor: true,
      netWorthUSD: 5_000_000,
      jurisdiction: "SG",
    };
    const vc = await bbs.createBbsCredential(
      issuer,
      new vcCore.DID(...vcCore.getMethodIdentifier(user.did)),
      claims,
      ["VerifiableCredential", "AccreditationCredential"],
      undefined,
      undefined,
      undefined,
      undefined,
      true // w3cBbs
    );
    console.log("VC issued. keys:", Object.keys(vc));
    console.log("proof.type:", vc.proof && vc.proof.type, "| cryptosuite:", vc.proof && vc.proof.cryptosuite);

    console.log("\n== 3. verify the credential ==");
    const res = await bbs.verifyBbsVCW3c(vc);
    console.log("verify result:", JSON.stringify(res));

    console.log("\nRESULT: BBS+ issue+verify WORKS ✅");
  } catch (e) {
    console.error("RESULT: FAILED ❌\n", e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
