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
| Dispatch | RFC 9421 Web Bot Auth — approved requests are signed so the destination can verify the caller | `src/web-bot-auth.mjs`, `src/agent.mjs` |

## Run

```bash
cp .env.example .env          # paste your T3N_API_KEY + DID from the claim page
npm install
# build + register the TEE contract once (see ../gate-contract/README.md to build the wasm):
npm run setup
# run the agent: identity -> VC gate -> TEE mandate -> audit -> signed dispatch
npm run demo
```

`npm run auth` is a quick connectivity check (authenticate + token balance).

### Other entry points

| Command | What it runs |
| --- | --- |
| `npm run demo:sd` | True BBS+ selective disclosure (reveal one claim, hide the rest). |
| `npm run demo:a2a` | A2A capability exchange — prove one capability to a peer, hide the manifest. *(offline)* |
| `npm run demo:velocity` | Hardware velocity limit — cumulative per-window spend cap held in the TEE across calls. *(needs `npm run setup` first)* |
| `npm run register:erc8004` | Mint the agent's ERC-8004 on-chain identity (`IdentityRegistry.register(agentURI)`). Needs a gas-funded wallet + registry address; refuses to run unconfigured. |
| `npm test` | 23 offline tests (crypto, edge cases, A2A, Web Bot Auth, revocation). |

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
[5] DISPATCH   POST https://broker.example/v1/orders  signed (web-bot-auth)  destination-verifiable=true
[3] MANDATE    buy $9,000 of USDC RWA      TEE decision = REJECTED  reasons=["amount 900000 exceeds mandate max 500000"]
[5] DISPATCH   skipped — action not approved, nothing sent
```
