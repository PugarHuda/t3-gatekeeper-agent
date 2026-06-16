# DoraHacks BUIDL Description — paste-ready

**Title:** Gatekeeper Agent — VC-gated permissioned actions with a hardware mandate

**Tagline:** A delegated AI agent that executes permissioned financial actions on
behalf of a user without ever holding their credentials or sensitive data —
eligibility proven by a BBS+ verifiable credential, the spending bound enforced by
a Terminal 3 TEE contract, every action audited.

---

## The Problem
AI agents that transact on your behalf normally need your credentials and your
personal data in memory. That's an exploitable attack surface, a prompt-injection
leak waiting to happen, and a non-starter for banks and institutions. And
"eligibility" (accredited investor, licensed, KYC'd) is usually proven by handing
over the raw documents — exposing far more than the one fact that matters.

## The Solution
The Gatekeeper Agent puts **two independent gates** in front of every outbound
action, using the Terminal 3 Agent Dev Kit end-to-end:

1. **Eligibility gate (verifiable credential).** A trusted issuer signs a **BBS+
   credential**; the agent verifies the user qualifies (e.g. accredited investor)
   without seeing the underlying data. Two modes ship: a **predicate credential**
   (`{ accreditedInvestor: true }`), and **true BBS+ selective disclosure** where
   the issuer signs the user's *full* KYC record and the holder derives a
   zero-knowledge proof revealing **only** the accredited flag — net worth, name
   and DOB stay mathematically hidden. (We implemented the holder-side derive
   ourselves: the SDK ships the primitive via `@mattrglobal/bbs-signatures`'
   `createProof`/`verifyProof` but doesn't wrap it — see our Track B report.)
2. **Mandate gate (hardware).** A **Rust→WASM TEE contract** enforces the user's
   spending mandate inside Terminal 3's enclave — max amount, allowed assets,
   allowed action kinds, allowed counterparties, a valid-after window, expiry —
   reading the mandate from a tenant KV map the agent itself cannot forge. It also
   enforces a **stateful cumulative velocity cap**: a running per-window total is
   kept in the contract's KV store and the action is rejected once the total would
   exceed the cap — held **across invocations in hardware**, so the agent cannot
   reset its own budget.

Every decision, approved or rejected, produces a structured audit row.

## Beyond the core gate — ecosystem interop (all shipped, tested)
The agent layer also implements two standards the ADK targets:
- **Web Bot Auth (RFC 9421).** The agent signs its outbound action requests with
  Ed25519 HTTP Message Signatures (`tag="web-bot-auth"`) so a destination — or a
  Cloudflare/WAF in front of it — can cryptographically verify the request came
  from this agent before acting. This is the "front door" already adopted by Visa
  TAP and Mastercard Agent Pay.
- **A2A capability exchange.** Two agents handshake by exchanging a BBS+
  capability credential with **selective disclosure**: an agent proves it holds a
  required capability (e.g. `payments.execute`) without revealing the rest of its
  capability manifest.
- **Credential-revocation pre-gate.** Before trusting the eligibility VC, the
  agent checks `@terminal3/revoke_vc` `isRevoked()` against an on-chain status
  registry — a kill-switch that blocks the action even if the BBS+ proof still
  verifies. Config-gated (fail-open until a registry + RPC are set).
- **In-TEE action dispatch.** An approved action is executed from *inside the
  enclave* via the contract's `dispatch_action` (host `http` interface) — the path
  where `http-with-placeholders` injects credentials so the agent never holds
  them. Verified live: the TEE performs the call and returns a typed
  `egress_denied` until the merchant host is on the per-contract allowlist.
- **ERC-8004 on-chain identity.** `npm run register:erc8004` mints the agent as an
  ERC-721 Trustless Agent via the real EIP-8004 `register(agentURI)` ABI (refuses
  to run without a funded wallet — no fake mint).

## How It Works
1. **Identity** — `T3nClient.handshake()` + `authenticate()` → the agent's
   `did:t3n` over an encrypted TEE session.
2. **VC gate** — `@terminal3/bbs_vc` `createBbsCredential` (issuer) +
   `verifyBbsVCW3c` (agent). Eligible only if the BBS+ proof verifies AND the
   predicate holds. No personal data is ever in the credential.
3. **Mandate** — `TenantClient.contracts.execute("gate", "evaluate", …)` runs the
   gate-contract **inside the enclave**; it resolves the tenant DID and a
   cluster-pinned timestamp host-side and returns approved/rejected + reasons.
4. **Audit** — one structured row per action (issuer, decision, reasons, ts).

## Terminal 3 SDK Integration (the full stack, not just auth)
- `@terminal3/t3n-sdk`: `loadWasmComponent`, `setEnvironment`, `eth_get_address`,
  `metamask_sign`, `T3nClient.handshake/authenticate/getUsage`, and the tenant
  control plane — `TenantClient.contracts.register()` / `execute()`.
- `@terminal3/bbs_vc` + `@terminal3/vc_core`: BBS+ credential issuance,
  verification, BLS keys and DIDs.
- A custom **Rust → wasm32-wasip2 TEE contract** importing host `tenant-context`,
  `kv-store`, and `logging` interfaces.

## Verified end-to-end on T3N testnet
- Auth: handshake → authenticate → getUsage (20,000 credits).
- BBS+ VC: issue (`bbs-2023` DataIntegrityProof) + verify; tampered claim →
  `isValid:false` (signature enforced, not a stub).
- True selective disclosure: issuer signs the full KYC record, holder derives a
  ZK proof revealing only the accredited flag; forged value / wrong nonce rejected.
- TEE contract: compiled to a wasm component, registered to the tenant
  (on-chain `contract_id`), and `evaluate()` invoked inside the enclave returning
  approved/rejected with the cluster timestamp and tenant DID.
- Stateful velocity limit: `spend()` (gate@0.6.0, contract_id 175) — 3 spends in
  one window, the 3rd rejected once the running total would exceed the cap.
- Test coverage: 23 offline crypto/protocol tests + 15 Rust unit tests, CI green.

## Why This Matters
This is the pattern a bank's trading desk or a permissioned-DeFi / RWA venue
needs: delegate bounded execution to an AI agent **without** handing over
credentials or data. Eligibility is a verifiable fact, the spending limit is
enforced in hardware rather than by the agent's own promise, and every action
leaves a cryptographic audit trail.

## Links
- Code: https://github.com/PugarHuda/t3-gatekeeper-agent
- Demo video: <add link>

## Tech Stack
TypeScript · `@terminal3/t3n-sdk` · `@terminal3/bbs_vc` · `@terminal3/vc_core` ·
Rust → `wasm32-wasip2` (wit-bindgen, serde) · Terminal 3 TEE / z-space tenant
contracts.
