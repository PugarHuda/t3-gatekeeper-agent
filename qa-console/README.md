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
npm test           # 50 Playwright tests — e2e (42) + a11y (3) + site-ui (5)
npm run test:site  # 27 tests against the deployed site and the hosted doors
npm run shots      # regenerate the console screenshots
```

`npm test` is the suite `../verify.mjs` runs, and it is three files:

| File | Tests | Covers |
| --- | --- | --- |
| `e2e.test.mjs` | 42 | console happy paths, wrong paths, API abuse; x402 through the mandate; A2A v1.0 and MCP-over-HTTP by hand-written JSON-RPC; the server-gone error state |
| `a11y.test.mjs` | 3 | axe-core over the console and the evidence page |
| `site-ui.test.mjs` | 5 | copy buttons, navigation, keyboard-scrollable screenshot frames, and the page with JavaScript off |

`npm run test:site` needs the network but no API key — it checks the deployed
site, the Web Bot Auth key directory, A2A discovery, the hosted `/api/a2a` and
`/api/mcp` doors (signed and unsigned), did:web + the signed agent card, and
that a signature older than the hosted 120 s window is refused.

Three more suites live here because they guard artifacts rather than code:

```bash
node --test doc.test.mjs     # 5  — the Google-Doc export renders, no markdown leaked
node --test docx.test.mjs    # 6  — submission.docx package integrity
node --test video.test.mjs   # 5  — the demo video decodes, and has an audio track
```

These three are deliberately **not** in `verify.mjs`: they guard the submission
artefacts, not the product, and `video.test.mjs` needs the rendered mp4.

Playwright comes from `../submission/demo-web/node_modules` via a directory
junction:

```powershell
New-Item -ItemType Junction -Path node_modules -Target ..\submission\demo-web\node_modules
```

## What it covers

| Path | Case | Asserts |
| --- | --- | --- |
| Happy | in-mandate purchase | approved, **and no reasons attached** |
| Happy | credential from a trusted issuer | approved |
| Wrong | over the cap | rejected, `exceeds mandate max` |
| Wrong | disallowed asset + kind | **both** failures reported, not just the first |
| Wrong | unlisted counterparty | rejected, names the offending payee |
| Wrong | expired mandate | rejected, `expired` |
| Wrong | **self-issued credential** | rejected as untrusted — the agent minting its own accreditation |
| Wrong | payee sub-limit under the global cap | rejected, `per-counterparty limit` |
| Wrong | unconfigured mandate | denies by default — the fail-closed guarantee |
| Abuse | malformed JSON | 400, no crash |
| Abuse | missing action | 400 |
| Abuse | negative amount | must not approve (no unsigned wrap-around past the cap) |
| Abuse | unknown route | 404 |

## What it deliberately does not cover

Enclave-only properties — the KV-held mandate, atomic decide-and-dispatch, TDX
attestation, egress grants. Those need a live TEE and are verified against
testnet instead; see [`../submission/VERIFICATION.md`](../submission/VERIFICATION.md).
