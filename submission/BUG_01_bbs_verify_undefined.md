# Bug Report — `verifyBbsVc` / `verifyBbsVCW3c` reports the failure reason as the literal `undefined`

**Component:** `@terminal3/bbs_vc@0.2.36` (`dist/verifyBbsVC.js`)
**Type:** bug (incorrect error reporting) · **Severity:** low
**Requires a code change:** yes · **Reproducible:** yes
**Environment:** Node v26.3.0, Windows 11; also reproduces on any platform.

## Summary
When BBS+ credential verification fails, the returned `message` is
`"BBS+ signature verification failed: undefined"`. The failure *reason* is the
literal string `undefined` rather than a real diagnostic, because the code reads
an `error` field that the underlying verifier does not set on a normal signature
mismatch.

## Root cause (confirmed in shipped source)
`@terminal3/bbs_vc/dist/verifyBbsVC.js`, function `verifyBbsSignature` (the
`bbs-2023` path), and the duplicate in the `BbsPlusSignature2020` branch:

```js
const isVerified = await blsVerify({ publicKey, messages, signature }); // @mattrglobal/bbs-signatures
return {
  isValid: isVerified.verified,
  message: isVerified.verified
    ? 'Verification successful'
    : `BBS+ signature verification failed: ${isVerified.error}`,
};
```

`@mattrglobal/bbs-signatures`' `blsVerify` resolves `{ verified: false }` **without
an `error` property** when the signature simply does not verify (the `error`
field is only populated when the call throws internally). Interpolating
`isVerified.error` therefore yields `undefined`.

## Reproduction
```js
const vcCore = require("@terminal3/vc_core");
const bbs = require("@terminal3/bbs_vc");
(async () => {
  const issuer = new bbs.BbsDID(vcCore.randomKeyBls());
  const user   = new bbs.BbsDID(vcCore.randomKeyBls());
  const vc = await bbs.createBbsCredential(
    issuer, new vcCore.DID(...vcCore.getMethodIdentifier(user.did)),
    { accreditedInvestor: false }, ["VerifiableCredential"],
    undefined, undefined, undefined, undefined, true);
  vc.credentialSubject.accreditedInvestor = true;        // tamper one claim
  console.log(await bbs.verifyBbsVCW3c(vc));
})();
```
Output:
```
{ isValid: false, message: 'BBS+ signature verification failed: undefined' }
```

## Expected vs actual
- **Expected:** `message` states the real cause (e.g. "signature does not verify"
  / the verifier's reason).
- **Actual:** `message` ends in the literal `undefined`.

## Impact
Any caller logging the message gets no signal for *why* verification failed
(mismatch vs malformed proof vs wrong key), which hampers debugging of credential
integration — exactly the onboarding phase this bounty targets.

## Suggested fix
Provide a fallback and/or surface the verifier's real reason, in both branches:
```js
const reason = isVerified.error ?? 'signature does not verify';
message: `BBS+ signature verification failed: ${reason}`,
```
