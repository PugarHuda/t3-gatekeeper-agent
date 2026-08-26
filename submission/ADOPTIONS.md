# Ecosystem adoptions — what runs, and what does not

The Terminal 3 ADK advertises one SDK across **A2A, ERC-8004, Entra Agent ID, MCP
and Web Bot Auth**. This is the honest catalogue of which of those the Gatekeeper
Agent actually implements.

The rule for this file: an adoption is **shipped** only if it runs — covered by a
test, a live call, or both. Everything else is listed under "not implemented"
with the reason, in its own words, rather than described in a way that reads like
a feature.

Run `node verify.mjs` to exercise every shipped row that does not need a network.

---

## Shipped and exercised

| Adoption | What it does here | Evidence |
| --- | --- | --- |
| **A2A Agent Card** | `agent/agent-card.json` — name, skills, DID, endpoints, trust (TDX + BBS+), in A2A `AgentCard` shape. | live at `/.well-known/agent-card.json` |
| **A2A discovery** | `discoverPeer(origin)` fetches `/.well-known/agent-card.json` over HTTP and validates it. A peer needs only the domain — nothing shared in advance. | 8 Node tests against a real server |
| **A2A capability exchange** | Two agents establish trust by exchanging a BBS+ **capability credential** with selective disclosure: prove one capability, hide the manifest. | `npm run demo:a2a`, 2 Node tests |
| **Web Bot Auth (RFC 9421)** | Every approved action's outbound request is signed with Ed25519, including an RFC 9530 `Content-Digest` over the body, with a freshness window so a captured signature expires. | 14 Node tests + a live round trip over the public internet |
| **Web Bot Auth key directory** | The Ed25519 JWKS is published at `/.well-known/http-message-signatures-directory` with the RFC media type, so any destination can verify with no prior exchange. | live-site tests |
| **W3C Bitstring Status List v1.0** | Credential revocation published as a gzipped 131,072-entry bitstring and checked over HTTPS. No chain, no gas — this is the revocation path that actually runs. | 19 Node tests; `npm run status-list` |
| **ERC-8004 (read + preflight)** | Resolve any agent's owner and URI from the live reference registry on Sepolia, check whether an address owns one, and verify a registry's bytecode carries `register(string)` **before** a mint spends gas. | `npm run erc8004`, live |
| **T3 host audit ledger** | `audit.get-mine` read back and reconciled against the agent's own rows, keeping *committed* separate from *claimed*. | `npm run audit`, 10 Node tests |
| **`http-with-placeholders`** | The contract imports the PII-safe outbound interface and routes any body carrying `{{profile.*}}` markers through it, so the host substitutes the investor's data and the plaintext never enters the component. | in the compiled component; Rust tests for the routing rule |
| **In-TEE outbound HTTP (`http`)** | The enclave performs the approved call itself, in the same invocation as the decision. | live, HTTP 200 |
| **Egress authorisation** | `agent-auth-update` grant scoped to contract, functions and destination hosts; an ungranted host is refused by name. | live |
| **Stateful velocity limit** | Cumulative spend held in the enclave's own KV across invocations, with the window derived from the cluster clock rather than supplied by the caller. | live 3-spend test |
| **Idempotent dispatch** | A caller-chosen key; a retry replays the recorded outcome instead of placing a second order. | 5 Rust + 2 Playwright |
| **Credential/action binding** | The agent commits to which credential it verified *and which action for*; the enclave recomputes that commitment from the action it is about to perform. | 8 Rust + 12 Node cross-language conformance |
| **Deny-by-default mandates** | Amount cap, assets, kinds, counterparties, per-payee sub-limits, trusted issuers, validity window, expiry. An empty mandate approves nothing. | 47 Rust tests |

## Not implemented, and why

Listed so nobody has to infer it from silence.

| Adoption | Why not |
| --- | --- |
| **ERC-8004 mint** | Needs a gas-funded wallet. The script has the correct ABI, preflights the registry, and **refuses to run unconfigured** — there is no fake mint. Funding is the only missing piece. |
| **ERC-8004 reputation** | Follows the mint. Our per-action audit rows are the right signal for it, but nothing is written on-chain today. |
| **In-contract `vp.verify`** | Attempted and blocked by the host: importing `host:interfaces/vp` registers fine, then 500s on every invoke (bug #7, repro contract 164). Without it the enclave cannot verify a BBS+ proof itself — see STATUS_AND_ROADMAP §3.1 for exactly what that costs. |
| **On-chain revocation registry** | Needs a deployed contract and gas. The `revoke_vc` code path is written and tested with an injected registry, and the status list above covers the same need without a chain. |
| **AP2 / agentic-commerce rails** | **Not implemented.** The pieces AP2 needs — a hardware-held mandate, a signed request, an in-enclave dispatch — exist here, but no AP2 message format is produced or consumed, so calling this an adoption would be a claim about a resemblance rather than about code. |
| **MCP** | Not implemented. The agent exposes no MCP server or client. |
| **Entra Agent ID** | Not implemented. Listed by the ADK; nothing here talks to it. |
| **x402 / HTTP 402 payments** | Not implemented. It is a natural fit for the mandate — a per-request price the enclave could approve or refuse — but it would need a funded stablecoin wallet to be anything other than a shape. |
