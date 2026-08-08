# Gatekeeper Agent

A delegated AI agent that executes **permissioned actions on behalf of a user**
without ever holding the user's sensitive data — built on the Terminal 3 Agent
Dev Kit. Every outbound action passes two independent gates before it is allowed:

1. an **eligibility gate** — a BBS+ verifiable credential proving the user
   qualifies (e.g. *accredited investor*) **without revealing net worth, name, or
   DOB**, and
2. a **mandate gate** — a TEE contract that enforces the spending bound
   (amount / asset / kind / expiry) **in hardware**, so the bound is not the
   agent's own promise.

Each action — approved or rejected — produces a structured audit row.

## Why this uses the SDK *in its entirety*

| Layer | SDK surface | Where |
| --- | --- | --- |
| Identity | `T3nClient` · `handshake()` · `authenticate()` · `loadWasmComponent()` · `metamask_sign` | `src/lib.mjs` |
| Verifiable credential | `@terminal3/bbs_vc` `createBbsCredential` / `verifyBbsVCW3c`, `@terminal3/vc_core` keys+DIDs | `src/agent.mjs` |
| Revocation pre-gate | `@terminal3/revoke_vc` `isRevoked()` — on-chain kill-switch checked before acting (config-gated) | `src/revocation.mjs` |
| TEE mandate contract | `TenantClient.contracts.register()` / `execute()` + a Rust→WASM contract | `src/setup.mjs`, `../gate-contract` |
| Audit | structured per-action row (issuer, decision, reasons) | `src/agent.mjs` |
| Dispatch (sign) | RFC 9421 Web Bot Auth — approved requests are signed so the destination can verify the caller | `src/web-bot-auth.mjs`, `src/agent.mjs` |
| Dispatch (execute) | In-TEE outbound call via contract `dispatch_action` (host `http`) — the action executes in the enclave (verified: HTTP 200) | `../gate-contract` `dispatch_action`, `src/agent.mjs` |
| Egress grant | `tee:user/contracts::agent-auth-update` — the *caller* authorises which hosts the enclave may reach, per contract + function | `src/grant-egress.mjs` (`npm run grant:egress`) |
| Atomic decide-and-act | `execute_action` — mandate read from KV (no inline override), decision and outbound call in one enclave invocation | `../gate-contract` `execute_action` |
| Issuer trust | mandate `allowed_issuers` — a self-issued eligibility credential is refused | `../gate-contract`, `src/agent.mjs` |
| Web Bot Auth key directory | published JWKS so a destination can resolve `keyid` and verify with nothing shared in advance | `src/web-bot-auth.mjs`, `../site/.well-known/…` |

## Run

```bash
cp .env.example .env          # paste your T3N_API_KEY + DID from the claim page
npm install
# build + register the TEE contract once (see ../gate-contract/README.md to build the wasm):
npm run setup
# authorise the enclave to reach ACTION_ENDPOINT's host (agent-auth grant)
npm run grant:egress
# run the agent: identity -> VC gate -> TEE mandate -> audit -> signed in-TEE dispatch
npm run demo
```

`npm run auth` is a quick connectivity check (authenticate + token balance).

### Other entry points

| Command | What it runs |
| --- | --- |
| `npm run demo:sd` | True BBS+ selective disclosure (reveal one claim, hide the rest). |
| `npm run demo:a2a` | A2A capability exchange — prove one capability to a peer, hide the manifest. *(offline)* |
| `npm run demo:velocity` | Hardware velocity limit — cumulative per-window spend cap held in the TEE across calls. *(needs `npm run setup` first)* |
| `npm run grant:egress` | Self-grant the enclave's outbound-HTTP allowlist for `ACTION_ENDPOINT`'s host (`agent-auth-update`). Without it, in-TEE dispatch returns `egress_denied`. |
| `npm run register:erc8004` | Mint the agent's ERC-8004 on-chain identity (`IdentityRegistry.register(agentURI)`). Needs a gas-funded wallet + registry address; refuses to run unconfigured. |
| `npm test` | 40 offline tests (crypto, edge cases, A2A, revocation, Web Bot Auth incl. the published key directory and the signature freshness window). |

## Two eligibility-gate modes

**`npm run demo` — predicate credential.** A trusted issuer attests *only* the
predicate the action needs — `{ accreditedInvestor: true }` — so the raw net
worth / identity never enter the credential. Uses the SDK's supported
issue + verify path (`createBbsCredential` / `verifyBbsVCW3c`).

**`npm run demo:sd` — true selective disclosure.** The issuer signs the user's
**full** KYC record once (`fullName, dateOfBirth, netWorthUSD, accreditedInvestor`);
the holder derives a zero-knowledge proof revealing **only** `accreditedInvestor`,
and the agent verifies it **without ever seeing** the hidden claims. See
`src/selective-disclosure.mjs`.

> Terminal 3's `@terminal3/bbs_vc` ships issuance + base verification but does not
> wrap the holder-side derive step. The underlying `@mattrglobal/bbs-signatures`
> *does* expose it (`createProof` / `verifyProof`), so `selective-disclosure.mjs`
> bridges Terminal 3 BLS keys (`vc_core.randomKeyBls` +
> `blsG2PublicKeyFromPrivateKey`) to those primitives to deliver real
> selective disclosure. (See Track B Report 3.)

## Example output

```
[1] IDENTITY   did:t3n:3d7dd668…
[2] VC GATE    issuer=did:key:zUC7…  verify=true  predicate=true  -> eligible=true
[2b] REVOCATION skipped  (revocation registry not configured)   # enforced when REVOCATION_* set
[3] MANDATE    buy $1,000 of USDC RWA      TEE decision = APPROVED
[4] AUDIT      {"decision":"approved",…}
[5] DISPATCH   POST https://your-endpoint/…  signed (web-bot-auth)  destination-verifiable=true
               in-TEE call -> executed in TEE (HTTP 200)          # after `npm run grant:egress`
               in-TEE call -> egress gated: host/http.egress_denied … no matching agent_auth grant   # without it
[3] MANDATE    buy $9,000 of USDC RWA      TEE decision = REJECTED  reasons=["amount 900000 exceeds mandate max 500000"]
[5] DISPATCH   skipped — action not approved, nothing sent
```
