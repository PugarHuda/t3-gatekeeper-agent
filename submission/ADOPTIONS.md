# Adoption roadmap — cheap / high / out-of-box

The Terminal 3 ADK advertises one SDK across **A2A, ERC-8004, Entra Agent ID, MCP,
and Web Bot Auth**. This catalogs concrete adoptions of those ecosystems for the
Gatekeeper Agent, graded by effort-to-value, with what's shipped vs. roadmap.

## ✅ Cheap adopt — shipped in this repo
| Adoption | What & why | Status |
| --- | --- | --- |
| **Agent Card** (`agent/agent-card.json`) | A2A `AgentCard` + ERC-8004 agent-card shape: name, skills, DID, endpoints, trust (TDX + BBS+). Resolvable by A2A clients / ERC-8004 registries. | shipped |
| **Richer mandate dimensions** | Added **counterparty allow-list** (pay only approved payees) and a **valid-after window** (future-dated authorizations) to the TEE contract (v0.2.0). 6 live demo scenarios. | shipped |
| **Deny-by-default + wildcard** | Least-privilege allow-lists found & fixed during QA. | shipped |
| **CI + tests + MIT license** | `npm test` (23 offline crypto/protocol tests), 15 Rust unit tests, GitHub Actions. | shipped |

## ✅ High adopt — now shipped
| Adoption | What & why | Status |
| --- | --- | --- |
| **Web Bot Auth (RFC 9421)** | `agent/src/web-bot-auth.mjs`, **wired into the main runtime as step [5] DISPATCH** in `agent.mjs`: every approved action request is signed with HTTP Message Signatures (Ed25519, `tag="web-bot-auth"`) so destinations (and Cloudflare/AWS WAF/Vercel) can verify the agent cryptographically; rejected actions are never dispatched. The "front door" for agentic commerce — already adopted by **Visa TAP** and **Mastercard Agent Pay**. Runs in `npm run demo`; 5 tests. | **shipped + integrated** |
| **A2A capability exchange** | `agent/src/a2a.mjs` + runnable `npm run demo:a2a` — two agents handshake by exchanging **BBS+ capability credentials** with selective disclosure (built on `selective-disclosure.mjs`): Agent A proves one capability without revealing the rest of its manifest; the peer verifies and matches the required capability. DIF presentation-exchange over A2A. 2 tests. | **shipped + integrated** |
| **Stateful velocity limits** | `gate-contract` `spend()` (v0.5.0, contract_id 165) — a cumulative per-window spend cap tracked in the contract's KV map (`kv-store.put`), the map provisioned by `npm run setup` with the contract as sole reader+writer. Turns the mandate from per-tx into per-window, **enforced in hardware across invocations** (the agent cannot reset the counter). Runnable as `npm run demo:velocity` (and `t3-qa/velocity-test.mjs`): 3 spends, the 3rd rejected once the running total would exceed the cap. | **shipped + integrated** |
| **Credential revocation** | `agent/src/revocation.mjs` — a revocation **pre-gate** (`[2b]` in `agent.mjs`) calling `@terminal3/revoke_vc` `isRevoked()` against an EVM status registry: a revoked credential is a kill-switch that blocks the action even if the BBS+ proof still verifies. **Config-gated**: skipped (fail-open) when `REVOCATION_REGISTRY_ADDRESS` + `REVOCATION_RPC_URL` are unset, enforced when set; `failClosed` toggles fail-open/closed on an unreachable registry. Gate logic covered by 6 unit tests (injected `isRevokedFn`). Live enforcement needs a published registry + RPC. | **shipped + integrated** (gated) |

## 🔶 High adopt — designed, clear path
| Adoption | What & why | Effort |
| --- | --- | --- |
| **In-contract `vp.verify`** | Move VC verification *into* the TEE so even the agent can't bypass eligibility. **Attempted, blocked by the host:** we implemented it (contract world `import host:interfaces/vp@2.1.0;` + a `verify_vp` entry point calling `vp::verify`), and it **builds and registers** (`contract_id 164`). But the testnet host then 500s on *every* invocation of that contract — `vp.verify` is documented as `host:interfaces@2.2.0` yet exported in the 2.1.0 world. Filed as **Track B Reports 7–8**. The shipped agent stays on the clean `gate@0.5.0` (no `vp` import). | blocked — needs a host that satisfies `vp@2.2.0` + a node-trusted issuer |

## 🟣 Out-of-box adopt — differentiators
| Adoption | What & why |
| --- | --- |
| **ERC-8004 on-chain identity + reputation** | Mint the agent as an **ERC-721 "Trustless Agent"** whose `agentURI` resolves to our `agent-card.json`, and accrue on-chain **reputation** from audited outcomes. ERC-8004 went live on Ethereum mainnet **29 Jan 2026** with 21k+ agents; authored by MetaMask/EF/Google/Coinbase. Our per-action audit rows are exactly the signal a reputation oracle consumes. **Registration script shipped** (`agent/src/erc8004-register.mjs`, `npm run register:erc8004`): real `ethers` call to `IdentityRegistry.register(agentURI)` with the exact EIP-8004 ABI, reads back the minted `agentId` from the `Registered` event. Refuses to run until a gas-funded wallet + registry address are configured (no fake mint) — so the only thing left to "turn it on" is funding, not code. **We also tried the no-wallet route** — Terminal 3's own host `agent-registry.register-agent` (writes an on-chain agent URI via the session DID, covered by testnet credits) — but importing that host interface into a contract hits the same systemic 500 as `vp` (registers as `contract_id 170`, then every invoke 500s). Filed under **Track B Report 7**. So on-chain identity is currently reachable only via the external ERC-8004 route. |
| **AP2 / agentic-commerce rails** | Align the mandate + Web Bot Auth path with **Google AP2** and **Visa/Mastercard** agent-pay so the Gatekeeper can transact at real merchants under hardware-bounded delegation. |

## References
- ERC-8004 Trustless Agents — https://eco.com/support/en/articles/13221214-what-is-erc-8004-the-ethereum-standard-enabling-trustless-ai-agents · developer guide https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/
- Web Bot Auth — IETF draft https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/ · Cloudflare https://blog.cloudflare.com/verified-bots-with-cryptography/ · repo https://github.com/cloudflare/web-bot-auth
- A2A Protocol — spec https://a2a-protocol.org/latest/specification/ · repo https://github.com/a2aproject/A2A
- AI Agents with DIDs + VCs — https://arxiv.org/html/2511.02841v1
