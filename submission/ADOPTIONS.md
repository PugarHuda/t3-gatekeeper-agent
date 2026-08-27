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
| **MCP server** | The agent *as* an MCP server over stdio: `gate_evaluate`, `bind_credential`, `check_credential_status`, `discover_agent`, `resolve_erc8004_agent`, `check_erc8004_registry`, `fetch_paid_resource`, `gate_execute`, plus two resources. This is the distribution story — a host adds one line of config and gets the mandate gate. | 19 Node tests driving a **real MCP client** over stdio |
| **Node discovery** | `npm run discover` reads the node's own inventory with an **agent key** over plain HTTPS — no session, no wasm, no credits: which core contracts it runs and at what version, our contract as the node describes it, and this agent's delegation verdict. Version drift on the node is what has broken this project hardest (bugs #12, #19); this makes it one command instead of an autopsy. | 3 Node tests + live |
| **x402 (HTTP 402 payments)** | A 402's payment requirement becomes an `Action` and goes through the same mandate. Only on approval is an EIP-3009 `TransferWithAuthorization` signed (real EIP-712) and the request retried. Verification recovers the payer with ecrecover — the facilitator's `/verify` minus the balance read — and the EIP-712 domain is checked against the deployed token's own `DOMAIN_SEPARATOR()`, so "a settlement contract would accept this" is verified rather than asserted. | 28 Node tests + 6 Playwright over real HTTP; `npm run x402:domain` live |

## Not implemented, and why

Listed so nobody has to infer it from silence.

| Adoption | Why not |
| --- | --- |
| **ERC-8004 mint** | Needs a gas-funded wallet — the one thing that cannot be defaulted. The script has the correct ABI, preflights the registry before spending gas, refuses to run unconfigured (no fake mint), and now defaults `agentURI` to the card served with `application/json` and CORS rather than to raw.githubusercontent, which serves `text/plain`. Set `ERC8004_PRIVATE_KEY` and it mints; nothing else is missing. |
| **ERC-8004 reputation** | Follows the mint. Our per-action audit rows are the right signal for it, but nothing is written on-chain today. |
| **In-contract `vp.verify`** | Attempted and blocked by the host: importing `host:interfaces/vp` registers fine, then 500s on every invoke (bug #7). Without it the enclave cannot verify a BBS+ proof itself — see STATUS_AND_ROADMAP §3.1 for exactly what that costs. Re-checked 2026-08-27: the repro contract was reverted in June, so the finding stands on the June evidence and would cost a fresh registration to re-stage. |
| **On-chain revocation registry** | Needs a deployed contract and gas. The `revoke_vc` code path is written and tested with an injected registry, and the status list above covers the same need without a chain. |
| **AP2 / agentic-commerce rails** | **Not implemented**, and we now think AP2 is the wrong target here. No AP2 message format is produced or consumed, so calling it an adoption would be a claim about a resemblance rather than about code. x402 was built instead, because it can be exercised end to end against a real counterparty. See the row below for what we found while looking. |
| **`tee:agent-connect` (T3's own commerce rails)** | **Attempted, and blocked by the platform — not a design choice.** The node serves `tee:agent-connect@1.4.0`, undocumented (bug #26). It is the natural home for this gate: deciding whether an intent may be confirmed is exactly `commerce-intent-confirm`. Every caller-facing function fails on a user-profile envelope the *host* assembles, missing a `kind` field that `tee:user`'s profile writer refuses as an unrecognised key — **bug #27**. There is no caller-side workaround; we tried every channel the SDK exposes. Repro: `node t3-qa/core-contracts-probe.mjs`, which is written to fail if it ever starts working. |
| **`tee:vc` OpenID4VP holder stack** | **Attempted, and blocked.** `tee:vc@2.6.0` carries `submit-vp` — a real DCQL/OpenID4VP request that answers `unsatisfied: query could not be satisfied with available credentials`, i.e. the node really is matching the query against credentials it holds — plus `my-presentations` (`{"presentations":[]}`) and `issue-credential`. This is the holder-side derive our June bug #3 said did not ship: it does, on the node, undocumented. Issuing into it needs `keys.generic_api` metadata; the one documented way to write keys accepts every shape **silently**, returning a real `txHash`, and the consumer still calls it missing — **bug #28**. Same repro script. This remains the most promising route to closing our biggest correctness gap, and it is one platform fix away. |
| **Entra Agent ID** | Not implemented. Listed by the ADK; nothing here talks to it. |
| **x402 settlement** | The protocol, the signature and the verification all run (above), and `npm run x402:domain` proves the signatures are valid **for the real token**: it reads `DOMAIN_SEPARATOR()` off the deployed Base Sepolia USDC contract and compares it byte for byte with the domain we sign under. They match. **Broadcasting** the authorisation is what does not run: that needs a facilitator and a funded wallet. `settle()` posts the spec's `/settle` body when `X402_FACILITATOR_URL` is set and **refuses** when it is not, because a receipt this process invented would be believed by whatever reads it. |
