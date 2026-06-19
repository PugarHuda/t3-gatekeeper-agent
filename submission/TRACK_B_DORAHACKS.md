# Track B — paste-ready per-bug submissions (DoraHacks)

Submit each as a **separate** entry. Title goes in the title field; the block below
it goes in the description field. Full write-ups + code: `TRACK_B_BUG_REPORTS.md`.
Environment for all: Windows 11, Node v26, `@terminal3/t3n-sdk@3.5.2`,
`vc_core@0.0.37`, `bbs_vc@0.2.36`, testnet `cn-api.sg.testnet.t3n.terminal3.io`.

---

### 1 — `verifyBbsVc` returns the literal `undefined` instead of the failure reason
**Type:** bug (SDK `@terminal3/bbs_vc`) · **Severity:** low
> Verifying a tampered BBS+ credential returns `message: "BBS+ signature verification failed: undefined"`. In `dist/verifyBbsVC.js`, `verifyBbsSignature` interpolates `${isVerified.error}`, but `@mattrglobal/bbs-signatures` resolves `{ verified:false }` with no `error` field on a normal mismatch, so it renders `undefined`. Same pattern in the `BbsPlusSignature2020` branch. **Repro:** issue a VC, flip a claim, call `verifyBbsVCW3c`. **Fix:** fallback e.g. `isVerified.error ?? 'signature mismatch'`.

### 2 — `getNodeUrl("testnet")` returns the string `"testnet"`; `getNodeUrl()` returns PROD
**Type:** bug (SDK `@terminal3/t3n-sdk`) · **Severity:** medium
> `getNodeUrl("testnet")` returns the literal arg `"testnet"` instead of the testnet base URL, and the no-arg `getNodeUrl()` returns the **production** URL — so a testnet build is easily misconfigured against prod. **Repro:** `console.log(getNodeUrl("testnet"), getNodeUrl())`. **Fix:** map `env → NODE_URLS[env]`; default the no-arg form to the active environment. Workaround: read `NODE_URLS.testnet` directly.

### 3 — "Smart VCs" docs claim ZK selective-disclosure VPs, but the SDK ships no holder-side derive
**Type:** documentation gap · **Severity:** medium
> The "Smart VCs" page advertises ZK selective disclosure in VPs, but `@terminal3/bbs_vc` exports only issuance + base verification — no `deriveProof`/`createPresentation`/`disclose`, and the docs give no function names or example. The primitive exists one layer down (`@mattrglobal/bbs-signatures` `createProof`/`verifyProof`); we built the missing W3C wrapper ourselves and it works end-to-end. **Repro:** `Object.keys(require('@terminal3/bbs_vc')).filter(k=>/derive|disclos|present/i.test(k))` → `[]`. **Fix:** ship/document a derive-VP function with an issue→derive→verify sample.

### 4 — Referenced onboarding repo `Terminal-3/adk-getting-start` is empty
**Type:** onboarding gap · **Severity:** low
> `github.com/Terminal-3/adk-getting-start` is reachable but empty, despite being the natural getting-started landing. New devs find no template, quickstart, or host-WIT files (the real example lives in `Terminal-3/z-tenant-flight`). **Fix:** populate it or redirect onboarding to `z-tenant-flight`.

### 5 — Building a TEE contract on Windows fails with no native linker, undocumented
**Type:** documentation/onboarding gap · **Severity:** medium
> `cargo build --target wasm32-wasip2` compiles proc-macro/build-script crates for the host triple, which needs a native linker. On a clean Windows box: Git Bash → `link: extra operand` (MSYS `link` shadows MSVC); PowerShell → `linker link.exe not found`. The dev-env docs don't mention this. **Fix that works (should be documented):** install `stable-x86_64-pc-windows-gnu` + add `wasm32-wasip2` to it, then `cargo +stable-x86_64-pc-windows-gnu build --target wasm32-wasip2 --release`.

### 6 — `tenant.claim()` returns HTTP 500 for an already-provisioned tenant
**Type:** bug (backend) · **Severity:** medium · **Confidence:** re-verify before submit
> `TenantClient.tenant.claim()` returned `HTTP 500 Internal error` (with `request_id`) for an already-provisioned tenant instead of a clean already-claimed response; `contracts.register()` then worked normally. Capture a fresh `request_id` and confirm it isn't environment-specific before sending.

### 7 — Importing `vp` or `agent-registry` deploys but 500s on every `execute`; no register-time validation
**Type:** bug (backend / WIT) · **Severity:** high
> The `interfaces` world exports many interfaces, but only some are actually served to tenant contracts — with no way to tell from the WIT, and the punishment is invoke-time. Tested in isolation under throwaway tails: `http@2.1.0` works (id 174; `http.call` returns a typed `egress_denied`); `vp@2.1.0` (id 164) and `agent-registry@2.1.0` (id 170) **register fine but then return HTTP 500 on EVERY function, including `evaluate`** — never a typed error. (`vp.verify`'s doc comment even says it's `@2.2.0`, post-dating the 2.1.0 package.) **Repro:** `t3-qa/vp-verify-test.mjs`, `agent-registry-test.mjs`, vs `http-probe-test.mjs`. **Re-verified 2026-06-19 (execute-only, still 500s):** `idreg@0.1.0` `evaluate` `[a7f453ab…]`, `register_agent` `[814ad336…]`, `gate@0.4.0` `verify_vp` `[040d6434…]` — while the control `gate@0.6.0` `evaluate` (imports `http`, id 175) returned `approved` ✅ in the same session, so the host is healthy and the 500s are import-specific. **Fix:** validate imports against the host's provided set at register time and return a typed rejection; mark unimplemented interfaces in the published WIT.

### 8 — Newest contract version shadows pinned versions; no get-contract-id API; private-map ACL re-register footgun
**Type:** bug (backend) · **Severity:** high
> After a working `gate@0.3.0`, registering a broken `gate@0.4.0` under the same tail made `execute(... version:"0.3.0" ...)` — explicitly pinning the good version — start returning HTTP 500 too. The host appears to run the **latest** registered version for the tail regardless of the `version` field, so a bad deploy bricks callers pinned to an older, working one; recovery needed a higher clean version. **Secondary:** there's no API to fetch the current `contract_id` for a tail, and a private KV map's reader/writer ACL is keyed by `contract_id`, so re-registering silently breaks any map ACL pinned to the old id (and a contract needs to be in **both** readers AND writers to read-modify-write its own state — a write-only ACL yields `read denied`). None of this is documented. **Fix:** honour the pinned `version` on execute (or refuse a non-executable contract at register); expose a get-contract-id; document the map-ACL/re-register interaction.
