# Terminal 3 Bounty — Track B: Bug & Documentation-Gap Reports

Environment for all reproductions unless noted: Windows 11, Node v26.3.0,
`@terminal3/t3n-sdk@3.5.2`, `@terminal3/vc_core@0.0.37`, `@terminal3/bbs_vc@0.2.36`,
testnet (`https://cn-api.sg.testnet.t3n.terminal3.io`).

> Submit each report **separately** on DoraHacks (first-report-wins). Re-verify on
> the current testnet before sending — a fix may already have shipped. The Node-16
> `engines` mismatch is intentionally excluded (already reported by another team).

---

## Report 1 — `verifyBbsVc` reports `undefined` instead of the failure reason
**Type:** bug (SDK) · **Severity:** low · **Package:** `@terminal3/bbs_vc@0.2.36`

**Description.** When verification of a BBS+ credential fails, the returned
message is `"BBS+ signature verification failed: undefined"`. The interpolated
reason is the literal string `undefined`, so callers and logs get no diagnostic.
A variable that should carry the error/reason is unset at the format site.

**Reproduction.**
```js
const vcCore = require("@terminal3/vc_core");
const bbs = require("@terminal3/bbs_vc");
(async () => {
  const issuer = new bbs.BbsDID(vcCore.randomKeyBls());
  const user = new bbs.BbsDID(vcCore.randomKeyBls());
  const vc = await bbs.createBbsCredential(
    issuer, new vcCore.DID(...vcCore.getMethodIdentifier(user.did)),
    { accreditedInvestor: false }, ["VerifiableCredential"],
    undefined, undefined, undefined, undefined, true);
  vc.credentialSubject.accreditedInvestor = true;          // tamper
  console.log(await bbs.verifyBbsVCW3c(vc));
})();
// => { isValid: false, message: 'BBS+ signature verification failed: undefined' }
```
**Expected.** `message` names the actual failure cause (e.g. proof/hash mismatch).
**Actual.** The cause renders as the literal `undefined`.
**Fix.** Interpolate the real error variable at the throw/return site in the
verify path (the `undefined` token indicates a wrong/unset identifier).

---

## Report 2 — `getNodeUrl(env)` returns the env string; `getNodeUrl()` returns PROD
**Type:** bug (SDK) · **Severity:** medium · **Package:** `@terminal3/t3n-sdk@3.5.2`

**Description.** `getNodeUrl("testnet")` returns the string `"testnet"` rather than
the testnet base URL, and the argument-less `getNodeUrl()` returns the
**production** URL. A developer who relies on `getNodeUrl("testnet")` to configure
the tenant `baseUrl` will either get an invalid URL or be silently pointed at
production.

**Reproduction.**
```js
import { getNodeUrl, NODE_URLS } from "@terminal3/t3n-sdk";
console.log(NODE_URLS);            // { testnet: 'https://cn-api.sg.testnet...', production: 'https://cn-api.sg.prod...' }
console.log(getNodeUrl("testnet")); // => "testnet"   (BUG: not a URL)
console.log(getNodeUrl());          // => "https://cn-api.sg.prod.t3n.terminal3.io" (PROD)
```
**Expected.** `getNodeUrl("testnet")` returns `NODE_URLS.testnet`; the no-arg form
defaults to the configured environment, not unconditionally production.
**Actual.** Returns the literal arg / the production URL.
**Impact.** Easy to misconfigure a tenant client against production from a testnet
build. (Workaround used in our build: read `NODE_URLS.testnet` directly.)
**Fix.** Map the `env` argument to `NODE_URLS[env]`; default the no-arg form to the
active environment from `setEnvironment`.

---

## Report 3 — "Smart VCs" docs claim selective-disclosure VPs, but the SDK ships no derive/presentation function
**Type:** documentation gap · **Severity:** medium · **Surface:** docs + `@terminal3/bbs_vc`

**Description.** `https://docs.terminal3.io/intro/components/vc` ("Smart VCs")
states T3 "leverages zero-knowledge (ZK) proofs to enable selective disclosure in
VPs." The published `@terminal3/bbs_vc` package exports credential **issuance**
(`createBbsCredential`) and **verification** (`verifyBbsVc`/`verifyBbsVCW3c`) plus
low-level primitives (`selectJsonLd`, `getMandatoryPointers`, `makeBBSPlusW3cProof`
— which requires the issuer private key), but **no holder-side
derive-presentation function** (no `deriveProof` / `createPresentation` /
`disclose`). The docs give no function names and no code example for the
selective-disclosure flow they advertise, so a developer cannot produce a
reduced-claims VP from the documented API.

**Reproduction.**
```js
const bbs = require("@terminal3/bbs_vc");
console.log(Object.keys(bbs).filter(k => /derive|disclos|present|reveal/i.test(k)));
// => []   (no holder-side disclosure-derivation export)
```
Cross-check: the "Smart VCs" page lists no SDK function names or code for
issuing/deriving/verifying a selectively-disclosed VP.
**Expected.** Either a documented derive-VP function with an example, or docs that
state selective-disclosure derivation is not yet exposed.
**Fix.** Add the holder-side derive API (or document its absence) and add an
end-to-end issue→derive→verify code sample to the VC docs.

---

## Report 4 — Referenced onboarding repo `Terminal-3/adk-getting-start` is empty
**Type:** documentation/onboarding gap · **Severity:** low · **Surface:** GitHub / onboarding

**Description.** `https://github.com/Terminal-3/adk-getting-start` is reachable but
empty ("This repository is empty"), despite being the natural getting-started
landing for the ADK. New developers following the onboarding find no template,
no quickstart, and no host-WIT files (the actual working example lives in a
different repo, `Terminal-3/z-tenant-flight`).
**Reproduction.** Open the URL — the repo shows the empty-repository placeholder.
**Expected.** A starter template (contract skeleton + `wit/deps` + register/invoke
script), or removal of the empty repo so it doesn't read as the entry point.
**Fix.** Populate the repo or redirect onboarding to `z-tenant-flight`.

---

## Report 5 — Building a TEE contract on Windows fails with no native host linker, and the docs don't mention the requirement
**Type:** documentation/onboarding gap · **Severity:** medium · **Surface:** dev-env docs

**Description.** `set-up-dev-env` lists only `rustup target add wasm32-wasip2` +
`cargo install wasm-tools`. But `cargo build --target wasm32-wasip2` compiles
build-script/proc-macro crates (`serde_derive`, `wit-bindgen-macro`, …) for the
**host** triple, which needs a native linker. On a clean Windows box without
Visual C++ Build Tools this fails, and the failure mode is confusing:
- from Git Bash, the MSYS coreutil `link` shadows MSVC `link.exe` →
  `error: linking with link.exe failed … link: extra operand`;
- from PowerShell → `error: linker link.exe not found`.

**Reproduction.** On Windows without VS Build Tools: `git clone` the
`z-tenant-flight` example and run `cargo build --target wasm32-wasip2 --release`.
**Workaround that works (should be documented).**
```powershell
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup target add wasm32-wasip2 --toolchain stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu build --target wasm32-wasip2 --release
```
**Expected.** The dev-env docs state the host-linker prerequisite (VS C++ Build
Tools, or the `windows-gnu` toolchain) for Windows users.
**Fix.** Add a Windows prerequisites note to `set-up-dev-env`.

---

## Candidate 6 (verify before submitting) — `tenant.claim()` returns HTTP 500
**Type:** bug (backend) · **Severity:** medium · **Confidence:** to re-verify

`TenantClient.tenant.claim()` returned `HTTP 500 Internal error` (with a
`request_id`) for an already-provisioned tenant, rather than a clean
already-claimed response; `contracts.register()` then succeeded normally. Capture
a fresh `request_id` and confirm it isn't environment-specific before submitting.
```
claim → HTTP 500: Internal error [<request_id>] ({"code":"internal_error", ...})
```
