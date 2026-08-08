# Status & roadmap — what is built, what is shallow, what is worth building

Honest inventory as of **7 August 2026**. The rule for this file: "shipped" means
it runs and is covered by a test or a live run. Anything that needs infrastructure
I do not have is listed as such, not quietly claimed.

---

## 1. Shipped and verified

| # | Capability | Where | Proof |
| --- | --- | --- | --- |
| 1 | **DID identity over an attested TEE session** — handshake → authenticate | `agent/src/lib.mjs` | live testnet, screenshot 01 |
| 2 | **BBS+ predicate credential gate** — issue + verify, tamper rejected | `agent/src/agent.mjs` | 27 Node tests, live run |
| 3 | **True ZK selective disclosure** — reveal one claim, hide the record | `agent/src/selective-disclosure.mjs` | `npm run demo:sd`, tests |
| 4 | **Rust → WASM TEE contract** enforcing amount / asset / kind / counterparty / valid-after / expiry, deny-by-default | `gate-contract/src/gate.rs` | 20 Rust tests + live invoke |
| 5 | **Unforgeable mandate** — read from KV inside the enclave; `execute_action` has no inline-mandate path | `gate.rs::execute_action` | Rust tests; live blocked on credits (§4) |
| 6 | **Atomic decide-and-dispatch** — decision and outbound call are one enclave invocation, so a rejected action cannot reach the network | `gate.rs::execute_action` | Rust tests; live blocked on credits |
| 7 | **In-TEE outbound HTTP** — the enclave performs the call, `HTTP 200` | `gate.rs::dispatch_action` | live testnet, screenshot 05 |
| 8 | **Egress authorisation** — `agent-auth-update` grant scoped to contract + functions + hosts | `agent/src/grant-egress.mjs` | live, screenshot 06; ungranted host refused by name |
| 9 | **Stateful velocity limit** — cumulative spend held in enclave KV across invocations | `gate.rs::spend` | live 3-spend test |
| 10 | **Caller-proof spend window** — the day bucket is derived from the cluster clock, not supplied by the caller | `gate.rs::day_bucket` | 3 Rust tests |
| 11 | **Web Bot Auth (RFC 9421)** — Ed25519 signature incl. RFC 9530 body digest, **with a published key directory** so any destination can verify with nothing shared in advance | `agent/src/web-bot-auth.mjs`, `site/.well-known/…` | 14 Node tests + **live round trip over the public internet** |
| 11b | **Trusted credential issuers** — the mandate names which KYC issuers it accepts, so a self-issued credential is refused | `gate.rs` `allowed_issuers` | 4 Rust + 2 Playwright |
| 11c | **Per-counterparty sub-limits** — a tighter ceiling per payee, applied *in addition* to the global cap | `gate.rs` `counterparty_limits` | 4 Rust + 1 Playwright |
| 12 | **A2A capability exchange** with selective disclosure | `agent/src/a2a.mjs` | 2 Node tests |
| 13 | **Revocation pre-gate** — `revoke_vc` kill-switch before acting | `agent/src/revocation.mjs` | 6 Node tests (injected registry) |
| 14 | **Structured audit row** per action, approved *and* rejected | `agent/src/agent.mjs` | every run |
| 15 | **On-network Agent ID** — DID resolves to an ERC-8004 / A2A card | `agent/agent-card.json` | live, screenshot 04 |
| 16 | **QA console + Playwright E2E** — happy path, 5 wrong paths, 4 abuse cases | `qa-console/` | 10 tests |
| 17 | **Evidence site** | `site/` | 5 Playwright tests, deployed |
| 18 | **Reproducible screenshots** — commands run for real, output rendered | `submission/screenshots/capture.mjs` | 12 shots |

**Test totals: 82** — 28 Rust, 33 Node, 13 Playwright E2E, 8 live-site (incl. the
Web Bot Auth key round trip).

---

## 2. Built but deliberately shallow

Honest about depth, so nobody is misled by a feature list.

| Item | What is real | What is shallow | Cost to deepen |
| --- | --- | --- | --- |
| ~~Web Bot Auth~~ | **Resolved 8 Aug** — key persisted via `WBA_PRIVATE_KEY`, JWKS published, verified live against the deployed directory | — | done |
| **Revocation** | Gate logic + tests are real | Fail-**open** when unconfigured, and no registry is published, so it is dormant in practice | Deploy a registry contract; flip `failClosed` default |
| **A2A** | Credential exchange works | No live peer — the counterparty is in-process | Stand up a second agent |
| **Audit trail** | Emitted per action, structured | Written to stdout, not to the T3 audit ledger via `getAuditEvents` | Wire `audit.get-mine` — small |
| **Selective disclosure** | Cryptographically real, verified | Not wired into the *contract* decision; the enclave trusts the agent's verdict | Needs in-contract `vp.verify` — blocked (bug #7) |
| **ERC-8004** | Correct ABI, refuses to fake a mint | Never executed — needs a funded wallet | Fund a wallet |

---

## 3. Not built — ranked by value

Ordered by what would most improve the product, not by ease.

> ~~1. Issuer trust registry~~ and ~~3. Per-counterparty sub-limits~~ were the top
> two here; both are **implemented and tested as of 8 Aug** (§1, rows 11b/11c).
> They ship in contract source **0.8.0**, which is built and unit-tested but not
> yet registered — see §4.

1. **Bind the credential to the action in-enclave.** Today the VC check happens in
   the agent and the enclave takes its word for the issuer DID. The enclave now
   checks that DID against `allowed_issuers`, but a compromised agent could still
   *claim* a trusted issuer it never verified. Passing the proof into
   `execute_action` and verifying it there closes the loop. Blocked on `vp.verify`
   (bug #7) — otherwise implementable as a hash commitment today.
   **This is now the biggest remaining correctness gap.**
2. **Settlement callback + idempotency key.** If the enclave's HTTP call times out,
   the order may have executed. An idempotency key and a status re-check would make
   retries safe. Today a timeout is ambiguous — a real risk for a payments path.
3. **Mandate lifecycle**: issue / amend / revoke a mandate with an audit trail,
   rather than a single seeded `default` key.
4. **Multi-party approval** — actions over a threshold require a second DID to
   co-sign. Natural fit for treasury use.
5. **Human-readable mandate receipts** — a signed statement the investor can read,
   rather than JSON.
6. **`http-with-placeholders`** for real credential injection, so the broker API key
   lives in the enclave secrets map and never in the agent.

---

## 4. Blocked, with the reason

| Item | Blocker | Not my code |
| --- | --- | --- |
| Live `execute_action` verification | **Testnet credits exhausted** — one 204 KB contract registration drained the full grant; every call now reports `required=10000000000, available=0` (bugs #16, #17) | ✅ |
| Seeding the KV mandate | Same credit exhaustion — `map-entry-set` needs the storage deposit | ✅ |
| In-contract `vp.verify` | Host does not serve the interface; registers then 500s (bug #7) | ✅ |
| Org-owned agent registration | Node runs `tee:organisation/contracts` 0.4.1, CLI needs ≥0.6.0 (bug #12) | ✅ |
| ERC-8004 mint | Needs a gas-funded wallet | ✅ |
| Public agent card hosting | `host-card` fails (bug #11) | ✅ |

**Unblocking step:** the bounty offers a top-up — DM `@wardumb` with the DID
`did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f`. With credits restored, §1 items
5 and 6 get their live verification and the mandate gets seeded.
