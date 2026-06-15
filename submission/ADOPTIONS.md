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
| **CI + tests + MIT license** | `npm test` (10 offline crypto tests), 15 Rust unit tests, GitHub Actions. | shipped |

## 🔶 High adopt — designed, clear path
| Adoption | What & why | Effort |
| --- | --- | --- |
| **Web Bot Auth (RFC 9421)** | Sign the agent's outbound action requests with HTTP Message Signatures so destinations (and Cloudflare/AWS WAF/Vercel) can verify the agent cryptographically. This is the "front door" for agentic commerce — already adopted by **Visa TAP** and **Mastercard Agent Pay**. Maps directly to the ADK's "Web Bot Auth" surface. | medium — sign requests with the agent's key; publish a key directory |
| **In-contract `vp.verify`** | Move VC verification *into* the TEE: the host exposes `host:interfaces/vp.verify` (we read its WIT). The contract would verify the presentation inside the enclave instead of the agent layer, so even the agent can't bypass eligibility. Needs the issuer registered as node-trusted (`issuer-untrusted` is a typed error). | medium — import `vp`, call `verify`, register a trusted issuer |
| **A2A capability exchange** | Two agents handshake by exchanging **BBS+ capability credentials** with selective disclosure (we already built the derive in `selective-disclosure.mjs`). DIF presentation-exchange over A2A. | medium — A2A server + present/verify loop |
| **Credential revocation** | `@terminal3/revoke_vc` (`isRevoked(vcId, issuer, opts)`) checks an on-chain status registry before the gate. Adds a kill-switch to eligibility. Needs an EVM RPC + a published registry entry. | medium — wire `getProvider` + registry |

## 🟣 Out-of-box adopt — differentiators
| Adoption | What & why |
| --- | --- |
| **ERC-8004 on-chain identity + reputation** | Mint the agent as an **ERC-721 "Trustless Agent"** pointing to `agent-card.json`, and accrue on-chain **reputation** from audited outcomes. ERC-8004 went live on Ethereum mainnet **29 Jan 2026** with 21k+ agents; authored by MetaMask/EF/Google/Coinbase. Our per-action audit rows are exactly the signal a reputation oracle consumes. |
| **AP2 / agentic-commerce rails** | Align the mandate + Web Bot Auth path with **Google AP2** and **Visa/Mastercard** agent-pay so the Gatekeeper can transact at real merchants under hardware-bounded delegation. |
| **Stateful velocity limits** | A daily cumulative spend cap tracked in the contract's KV map (`kv-store.put`) — turns the mandate from per-tx into per-window, enforced in hardware across invocations. |

## References
- ERC-8004 Trustless Agents — https://eco.com/support/en/articles/13221214-what-is-erc-8004-the-ethereum-standard-enabling-trustless-ai-agents · developer guide https://blog.quicknode.com/erc-8004-a-developers-guide-to-trustless-ai-agent-identity/
- Web Bot Auth — IETF draft https://datatracker.ietf.org/doc/draft-meunier-web-bot-auth-architecture/ · Cloudflare https://blog.cloudflare.com/verified-bots-with-cryptography/ · repo https://github.com/cloudflare/web-bot-auth
- A2A Protocol — spec https://a2a-protocol.org/latest/specification/ · repo https://github.com/a2aproject/A2A
- AI Agents with DIDs + VCs — https://arxiv.org/html/2511.02841v1
