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
| TEE mandate contract | `TenantClient.contracts.register()` / `execute()` + a Rust→WASM contract | `src/setup.mjs`, `../gate-contract` |
| Audit | structured per-action row (issuer, decision, reasons) | `src/agent.mjs` |

## Run

```bash
cp .env.example .env          # paste your T3N_API_KEY + DID from the claim page
npm install
# build + register the TEE contract once (see ../gate-contract/README.md to build the wasm):
npm run setup
# run the agent: identity -> VC gate -> TEE mandate -> audit
npm run demo
```

`npm run auth` is a quick connectivity check (authenticate + token balance).

## Predicate-credential model

Terminal 3's BBS+ packages ship credential **issuance** and **verification**, but
not (yet) a turn-key holder-side selective-disclosure *derivation*. So instead of
issuing a full credential and deriving a reduced presentation, a trusted issuer
attests **only the predicate the action needs** — `{ accreditedInvestor: true }` —
and never the underlying figures. The raw net worth / identity never enter the
credential, so privacy is preserved with the issue+verify path that the SDK
supports today. (In-contract `vp.verify` is a host interface available for a
future fully-derived-VP upgrade.)

## Example output

```
[1] IDENTITY   did:t3n:3d7dd668…
[2] VC GATE    issuer=did:key:zUC7…  verify=true  predicate=true  -> eligible=true
[3] MANDATE    buy $1,000 of USDC RWA      TEE decision = APPROVED
[3] MANDATE    buy $9,000 of USDC RWA      TEE decision = REJECTED  reasons=["amount 900000 exceeds mandate max 500000"]
[3] MANDATE    swap into DOGE              TEE decision = REJECTED  reasons=["kind not in allowed_kinds","asset not in allowed_assets"]
```
