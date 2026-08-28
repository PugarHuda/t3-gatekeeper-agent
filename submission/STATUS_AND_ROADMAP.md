# Status & roadmap — what is built, what is shallow, what is worth building

Honest inventory as of **27 August 2026**. The rule for this file: "shipped" means
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
| 12b | **A2A discovery** — the card is published at `/.well-known/agent-card.json`; `discoverPeer()` fetches and validates a peer's card over HTTP | `agent/src/a2a.mjs`, `site/.well-known/` | 8 Node tests over a real server |
| 13 | **Revocation pre-gate** — `revoke_vc` kill-switch before acting | `agent/src/revocation.mjs` | 12 Node tests |
| 13b | **W3C Bitstring Status List** — revocation published as a 131,072-entry list and checked over HTTPS, no chain required | `agent/src/status-list.mjs`, `site/status/revocation.json` | 19 Node tests |
| 14 | **Structured audit row** per action, approved *and* rejected | `agent/src/agent.mjs` | every run |
| 14b | **Host audit ledger** — `audit.get-mine` read back and reconciled against the agent's rows, distinguishing committed from merely claimed | `agent/src/audit.mjs` | 10 Node tests + live read |
| 15 | **On-network Agent ID** — DID resolves to an ERC-8004 / A2A card | `agent/agent-card.json` | live, screenshot 04 |
| 15b | **ERC-8004 live reads + mint preflight** — resolve agents and verify the registry's bytecode before spending gas | `agent/src/erc8004.mjs` | live against Sepolia, `npm run erc8004` |
| 15c | **Credential bound to the action** — commitment recomputed inside the enclave from the action it is about to perform | `gate.rs`, `agent/src/credential-binding.mjs` | 8 Rust + 12 Node (cross-language conformance) |
| 15d | **Idempotent dispatch** — a retry replays the recorded outcome instead of placing a second order | `gate.rs::execute_action` | 5 Rust + 2 Playwright |
| 16 | **QA console + Playwright E2E** — happy path, wrong paths, binding and idempotency attacks, abuse cases | `qa-console/` | 18 tests |
| 17 | **Evidence site** | `site/` | Playwright + live tests, deployed |
| 18 | **Reproducible screenshots** — commands run for real, output rendered | `submission/screenshots/capture.mjs` | 15 shots |

| 19 | **Signature freshness window** — a Web Bot Auth signature expires (default 5 min, skew-tolerant); `created` is inside the signature base so it cannot be back-dated | `agent/src/web-bot-auth.mjs` | 7 Node tests |

**Test totals: run `node verify.mjs` — it prints its own total (253 offline
checks at the time of writing), plus the live-site and artifact suites.**
## 2. Depth, honestly

The rule for this section: say what is real, and say what is still only a
gesture. Five items sat here as "shallow" in August. Four of them were fixed on
27 August rather than re-described.

| Item | State |
| --- | --- |
| ~~Web Bot Auth~~ | **Resolved 8 Aug.** Key persisted, JWKS published, verified live against the deployed directory. |
| ~~Audit trail~~ | **Resolved 27 Aug.** `npm run audit` reads the host's own ledger via `audit.get-mine` and reconciles it against the agent's rows. It distinguishes committed from claimed — an event can say `outcome: success` in a batch that rolled back. |
| ~~A2A~~ | **Resolved 27 Aug.** The agent card is published at `/.well-known/agent-card.json`, and `discoverPeer()` fetches and validates a peer card over real HTTP. A peer needs only the domain. |
| ~~Revocation~~ | **Resolved 27 Aug.** A W3C Bitstring Status List is generated and published (131,072 entries, 556 bytes). The gate reads one bit over HTTPS with no chain involved; the on-chain registry remains the fallback. |
| ~~ERC-8004~~ | **Read side resolved 27 Aug.** Live against the reference deployment on Sepolia: resolve agents, check ownership, and preflight the registry before spending gas. The **mint is still not done** — it needs a funded wallet, and the script refuses rather than faking it. |
| **Selective disclosure** | Cryptographically real and verified. The enclave now checks that the credential was **bound to this action**, but still cannot verify the BBS+ proof itself — see §3.1. |
| **Placeholder dispatch** | The contract imports `http-with-placeholders` and routes bodies carrying profile markers through it. Unit-tested and built into the component; **not yet exercised live**, because registering the new contract needs credits (§4). |
| **Idempotency** | Implemented end to end in the enclave with a contract-owned record map. The validation rules are tested; the replay path is wasm-only and shares §4's blocker. |

## 3. Not built — ranked by value

Ordered by what would most improve the product, not by ease.

> Items 1–3 of the previous list — issuer trust registry, per-counterparty
> sub-limits, and the credential/action binding — are **implemented**. So is the
> settlement idempotency key. What follows is what is genuinely still absent.

### 3.1 The remaining correctness gap, stated precisely

The enclave can now prove that the agent committed to a specific credential for
*this specific action* before the decision was made: the commitment covers the
issuer, subject, claims digest, action digest and a nonce, and the enclave
recomputes it from the action it is about to perform. Moving a verification from
a $500 purchase to a $500,000 one fails.

What it still cannot do is verify that the BBS+ proof was ever valid. A
dishonest agent can commit to a credential it never checked. Closing that needs
in-contract proof verification — `vp.verify`, which this node does not serve
(bug #7). Everything short of that is bookkeeping about a claim, and the code
and docs say so rather than implying more.

### 3.2 Still absent

1. **Mandate lifecycle** — issue / amend / revoke a mandate with an audit trail,
   rather than a single seeded `default` key.
2. **Multi-party approval** — actions over a threshold require a second DID to
   co-sign. Natural fit for treasury use.
3. **Human-readable mandate receipts** — a signed statement the investor can
   read, rather than JSON.
4. **A live A2A counterparty** — discovery and capability exchange are both
   real, but the peer in the demo is still this process. A second deployed agent
   would exercise the round trip.
5. **Signing the status list** — the published list is a credential in shape and
   carries no proof. An issuer that needs the list itself to be verifiable can
   sign it with the machinery already here.

## 4. Blocked, with the reason

| Item | Blocker | Not my code |
| --- | --- | --- |
| Live `execute_action` verification | **Testnet credits exhausted** — one 204 KB contract registration drained the full grant; every call now reports `required=10000000000, available=0` (bugs #16, #17) | ✅ |
| Seeding the KV mandate | Same credit exhaustion — `map-entry-set` needs the storage deposit | ✅ |
| In-contract `vp.verify` | Host does not serve the interface; registers then 500s (bug #7) | ✅ |
| Org-owned agent registration | Node runs `tee:organisation/contracts` 0.4.1, CLI needs ≥0.6.0 (bug #12) | ✅ |
| ERC-8004 mint | Needs a gas-funded wallet. Reads and preflight work today against the live Sepolia registry | ✅ |
| Live placeholder + idempotency paths | Both are built into the component; exercising them needs a contract registration, which needs credits | ✅ |
| Publishing the status list and the A2A card | Written to `site/`, but Vercel's free tier refused further deployments ("more than 100 per day"); they go out on the next deploy | ✅ |
| Public agent card hosting (T3-side) | `host-card` no longer fails on scope, only on credits (bug #11 appears fixed) | ✅ |

**Unblocking step:** the bounty offers a top-up — DM `@wardumb` with the DID
`did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f`. With credits restored, one
`npm run setup` registers the current contract and seeds its four maps, and the
enclave-side items above get their live run in a single pass.

Everything not on this list runs today with no key, no credits and no wallet:
`node verify.mjs`.
