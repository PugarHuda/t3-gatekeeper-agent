# Verification log

Every layer was exercised on the live T3N testnet (and offline where it needs no
key). Reproduce locally with the commands in each row; CI (`.github/workflows/ci.yml`)
runs the offline subset on every push.

| Layer | How to reproduce | Verified result |
| --- | --- | --- |
| Identity / auth | `cd agent && npm run auth` | authenticates `did:t3n:…`, prints credit balance |
| BBS+ issue + verify | `node t3-qa/smoke-vc.cjs` | `bbs-2023` proof, `{isValid:true}` |
| Signature enforced | `node t3-qa/smoke-vc-negative.cjs` | tampered claim → `{isValid:false}` |
| True selective disclosure | `node t3-qa/smoke-sd.mjs` | reveal 1 of 4 claims; forged value / wrong nonce → `verified:false` |
| Offline unit tests | `cd agent && npm test` | 40/40 pass (issue/verify, tamper, SD, edge cases, A2A, revocation, Web Bot Auth + key directory + freshness window) |
| TEE contract unit tests | `cd gate-contract && cargo test` | 28 unit + 1 doc test pass |
| TEE contract build | `cargo build --lib --release --target wasm32-wasip2` | ~213 KB wasm component (`0d 00 01 00` — component, not core module) |
| Contract deploy | `cd agent && npm run setup` | registered — `gate@0.6.0` = `contract_id 175`, `gate@0.7.0` = `contract_id 479` |
| Mandate enforced in TEE | `npm run demo` | $1k→approved, $9k→rejected, DOGE→rejected |
| Counterparty allow-list | (same) | approved payee→approved, unknown payee→rejected |
| Valid-after window | (same) | future-dated mandate → rejected ("not active until …") |
| Revocation pre-gate | (same) | `[2b]` checked before acting; skipped (fail-open) until a registry is configured |
| Signed + in-TEE dispatch | (same) | `[5]` approved request signed (web-bot-auth) **and** executed via host `http` from inside the TEE — **HTTP 200** after `npm run grant:egress`; typed `egress_denied` without the grant |
| Egress grant | `cd agent && npm run grant:egress` | `agent-auth-update` accepted (`tx_hash`), enclave may then reach the granted host only |
| Mandate rules, offline | `cd qa-console && node --test e2e.test.mjs` | 13 Playwright tests over the contract's real Rust `decide()` — 2 happy paths, 7 wrong paths, 4 abuse cases |
| Evidence site | `cd qa-console && node --test site.test.mjs` | 10 tests incl. every screenshot renders (naturalWidth ≠ 0) and a Web Bot Auth key round trip over the public internet |
| Submission artifacts | `cd qa-console && node --test doc.test.mjs docx.test.mjs video.test.mjs` | 16 tests — exports render, `.docx` package integrity, the video decodes **with an audio track** |
| Deny-by-default (security) | `node t3-qa/gate-deploy-invoke.mjs` | empty mandate → **rejected** inside the enclave |
| Stateful velocity limit | `cd agent && npm run demo:velocity` | 3 spends, 3rd rejected; running total held in the TEE across calls |
| A2A capability exchange | `cd agent && npm run demo:a2a` | prove one capability, hide the manifest; mismatch refused |
| Full agent (predicate) | `cd agent && npm run demo` | identity → VC gate → revocation → TEE mandate → audit → dispatch |
| Full agent (selective disclosure) | `cd agent && npm run demo:sd` | agent sees only `{accreditedInvestor:true}` |
| TDX attestation | `node t3-qa/attestation-parse.mjs` | `tee_type=0x81` (TDX); `REPORT_DATA == keccak512(attestation_msg)` ✅; 3 DKG peers; PCK chain |

> **Deployment state (8 Aug 2026).** Source is **v0.8.0** (`allowed_issuers` +
> per-counterparty sub-limits) — built and unit-tested but **not registered**,
> because registering v0.7.0 exhausted the account's credits (bug #16) before the
> mandate could be seeded. The version live on the network is **v0.7.0**
> (`contract_id 479`); the live `HTTP 200` egress evidence was captured on v0.6.0
> earlier the same day. Rows above marked "verified live" refer to those runs.

## Issues found by QA and fixed in this repo
1. **`discloseOnly` silently ignored unknown reveal keys** — a typo'd claim name
   disclosed nothing instead of erroring. Fixed: now throws
   `unknown claim '<k>'`. (test: `agent/test/edge-cases.test.mjs`)
2. **`discloseOnly` accepted an empty reveal set** — Fixed: throws
   `reveal at least one claim`.
3. **gate-contract allow-lists were allow-by-default** — an empty
   `allowed_assets`/`allowed_kinds` approved *everything*. Fixed: **deny-by-default**
   with an explicit `"*"` wildcard (least privilege). Verified live: empty mandate
   now denies. (tests: `gate-contract/src/gate.rs`)
4. **The mandate was forgeable** — `evaluate` accepted an inline mandate and the
   demo supplied one, so the agent was judged against limits it chose itself. The
   KV path existed but was never exercised. Fixed in v0.7.0: `execute_action`
   reads from KV with no inline escape hatch.
5. **The gate was skippable** — `evaluate` and `dispatch_action` were separate
   host calls and nothing in dispatch knew a mandate existed. Fixed: decision and
   outbound call are one enclave invocation.
6. **The velocity window was caller-supplied** — passing a fresh window string
   reset the running total. Fixed: derived from the cluster clock.
7. **Any issuer was trusted** — a BBS+ signature proves the issuer signed, not
   that the issuer is trusted, and the agent generates its own issuer key. Fixed
   in v0.8.0: `allowed_issuers`.
8. **Web Bot Auth signatures never expired** — `created` was read but not
   checked, so a captured request replayed forever. Fixed: freshness window
   (default 5 min, skew-tolerant) plus optional `expectedKeyid` binding.
   (tests: `agent/test/web-bot-auth.test.mjs`)

## Issues reported to Terminal 3 (not our code)
**19 in total.** The eleven found since June are written up in
[`SUPERTEAM_SUBMISSION.md`](SUPERTEAM_SUBMISSION.md) §6 — including a broken CLI
`token balance`, a documented agent-registration step that fails, a CLI/node
version skew, credit exhaustion after a single contract registration, and
`redactSecrets` leaking `privateKey` / `mnemonic` / `seed`.

The original eight are in `submission/TRACK_B_BUG_REPORTS.md`: `verifyBbsVc` `undefined`
message (root-caused in source), `getNodeUrl` returns the wrong value,
selective-disclosure docs/API gap (the derive primitive exists but isn't wrapped),
empty `adk-getting-start` repo, Windows linker prerequisite undocumented,
`tenant.claim()` HTTP 500, importing `vp`/`agent-registry` deploys but 500s on
every `execute` (while `http` works) with no register-time validation, and the
newest contract version shadowing pinned versions (a broken deploy bricks older
ones; no get-contract-id API; private-map ACL re-register footgun).
