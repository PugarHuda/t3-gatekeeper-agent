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
| Crypto unit tests | `cd agent && npm test` | 10/10 pass (issue/verify, tamper, SD, edge cases) |
| TEE contract unit tests | `cd gate-contract && cargo test` | 15 unit + 1 doc test pass |
| TEE contract build | `cargo build --release --target wasm32-wasip2` | ~158 KB wasm component |
| Contract deploy | `cd agent && npm run setup` | registered (latest `contract_id` 124, tail `gate@0.2.0`) |
| Mandate enforced in TEE | `npm run demo` | $1k→approved, $9k→rejected, DOGE→rejected |
| Counterparty allow-list | (same) | approved payee→approved, unknown payee→rejected |
| Valid-after window | (same) | future-dated mandate → rejected ("not active until …") |
| Deny-by-default (security) | `node t3-qa/gate-deploy-invoke.mjs` | empty mandate → **rejected** inside the enclave |
| Full agent (predicate) | `cd agent && npm run demo` | identity → VC gate → TEE mandate → audit |
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
See `submission/TRACK_B_BUG_REPORTS.md`: `verifyBbsVc` `undefined` message
(root-caused in source), `getNodeUrl` returns wrong value, selective-disclosure
docs/API gap (the derive primitive exists but isn't wrapped), empty
`adk-getting-start` repo, Windows linker prerequisite undocumented, `tenant.claim()`
HTTP 500.
