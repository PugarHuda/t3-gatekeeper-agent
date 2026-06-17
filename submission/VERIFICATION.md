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
| Offline unit tests | `cd agent && npm test` | 23/23 pass (issue/verify, tamper, SD, edge cases, A2A, Web Bot Auth, revocation) |
| TEE contract unit tests | `cd gate-contract && cargo test` | 15 unit + 1 doc test pass |
| TEE contract build | `cargo build --release --target wasm32-wasip2` | ~187 KB wasm component |
| Contract deploy | `cd agent && npm run setup` | registered (latest `contract_id` 175, tail `gate@0.6.0`) |
| Mandate enforced in TEE | `npm run demo` | $1k→approved, $9k→rejected, DOGE→rejected |
| Counterparty allow-list | (same) | approved payee→approved, unknown payee→rejected |
| Valid-after window | (same) | future-dated mandate → rejected ("not active until …") |
| Revocation pre-gate | (same) | `[2b]` checked before acting; skipped (fail-open) until a registry is configured |
| Signed + in-TEE dispatch | (same) | `[5]` approved request signed (web-bot-auth) **and** executed via host `http` from inside the TEE (typed `egress_denied` until host-allowlisted) |
| Deny-by-default (security) | `node t3-qa/gate-deploy-invoke.mjs` | empty mandate → **rejected** inside the enclave |
| Stateful velocity limit | `cd agent && npm run demo:velocity` | 3 spends, 3rd rejected; running total held in the TEE across calls |
| A2A capability exchange | `cd agent && npm run demo:a2a` | prove one capability, hide the manifest; mismatch refused |
| Full agent (predicate) | `cd agent && npm run demo` | identity → VC gate → revocation → TEE mandate → audit → dispatch |
| Full agent (selective disclosure) | `cd agent && npm run demo:sd` | agent sees only `{accreditedInvestor:true}` |
| TDX attestation | `node t3-qa/attestation-parse.mjs` | `tee_type=0x81` (TDX); `REPORT_DATA == keccak512(attestation_msg)` ✅; 3 DKG peers; PCK chain |

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

## Issues reported to Terminal 3 (Track B — not our code)
See `submission/TRACK_B_BUG_REPORTS.md` (8 reports): `verifyBbsVc` `undefined`
message (root-caused in source), `getNodeUrl` returns the wrong value,
selective-disclosure docs/API gap (the derive primitive exists but isn't wrapped),
empty `adk-getting-start` repo, Windows linker prerequisite undocumented,
`tenant.claim()` HTTP 500, importing `vp`/`agent-registry` deploys but 500s on
every `execute` (while `http` works) with no register-time validation, and the
newest contract version shadowing pinned versions (a broken deploy bricks older
ones; no get-contract-id API; private-map ACL re-register footgun).
