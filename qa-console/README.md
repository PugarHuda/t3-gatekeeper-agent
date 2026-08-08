# QA console — happy path & wrong paths, offline

A browser console over the gate contract's **real** decision logic, plus a
Playwright suite that drives it.

The rules are never reimplemented in JavaScript. `server.mjs` shells out to
`gate_cli`, a host build of the same `gate::decide()` the enclave runs, so a
passing test here is evidence about the contract itself. A JS copy of the rules
would drift from the Rust and prove nothing.

```bash
# build the host binary once (Windows: use the gnu toolchain, see ../gate-contract/README.md)
cd ../gate-contract && cargo build --bin gate_cli --release

cd ../qa-console
npm start          # http://localhost:4173 — click through the scenarios
npm test           # 10 Playwright tests: happy path, wrong paths, API abuse
npm run test:site  # 5 tests against the deployed evidence site
npm run shots      # regenerate the console screenshots
```

Playwright comes from `../submission/demo-web/node_modules` via a directory
junction:

```powershell
New-Item -ItemType Junction -Path node_modules -Target ..\submission\demo-web\node_modules
```

## What it covers

| Path | Case | Asserts |
| --- | --- | --- |
| Happy | in-mandate purchase | approved, **and no reasons attached** |
| Wrong | over the cap | rejected, `exceeds mandate max` |
| Wrong | disallowed asset + kind | **both** failures reported, not just the first |
| Wrong | unlisted counterparty | rejected, names the offending payee |
| Wrong | expired mandate | rejected, `expired` |
| Wrong | unconfigured mandate | denies by default — the fail-closed guarantee |
| Abuse | malformed JSON | 400, no crash |
| Abuse | missing action | 400 |
| Abuse | negative amount | must not approve (no unsigned wrap-around past the cap) |
| Abuse | unknown route | 404 |

## What it deliberately does not cover

Enclave-only properties — the KV-held mandate, atomic decide-and-dispatch, TDX
attestation, egress grants. Those need a live TEE and are verified against
testnet instead; see [`../submission/VERIFICATION.md`](../submission/VERIFICATION.md).
