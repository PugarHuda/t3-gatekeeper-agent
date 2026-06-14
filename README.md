# Gatekeeper Agent — Terminal 3 Agent Dev Kit Bounty (Launch Ed)

> A delegated agent that executes **permissioned financial actions on behalf of a
> user without holding their credentials or sensitive data**. Eligibility is
> proven by a **BBS+ verifiable credential**; the spending bound is enforced by a
> **TEE contract in hardware**; every action is **audited**.

This submission deliberately exercises **all four layers** of the Terminal 3 SDK
in one coherent flow — not just authentication — to maximise the *"how well
integrated is the SDK in its entirety"* criterion.

```mermaid
flowchart TD
    U([User]) -- delegates mandate --> A
    subgraph AGENT["Gatekeeper Agent — @terminal3/t3n-sdk"]
        A["1 · IDENTITY<br/>handshake + authenticate → did:t3n"]
        V["2 · VC GATE<br/>bbs_vc.verifyBbsVCW3c(predicate)<br/>eligible, no PII revealed"]
        AU["4 · AUDIT<br/>row per action: issuer, decision, reasons"]
    end
    ISS([Trusted KYC issuer]) -- "BBS+ predicate cred<br/>{accreditedInvestor:true}" --> V
    A --> V
    V -- eligible --> EX{{"3 · MANDATE — contracts.execute('gate','evaluate')"}}
    subgraph TEE["Terminal 3 TEE / Enclave"]
        GC["gate-contract (Rust → wasm32-wasip2)<br/>reads z:&lt;tid&gt;:mandate KV<br/>enforces amount · asset · kind · expiry"]
    end
    EX --> GC
    GC -- "approved / rejected + reasons" --> AU
    AU --> R([Action allowed or blocked])
```


```
┌─ Gatekeeper Agent (TypeScript / @terminal3/t3n-sdk) ───────────────────────┐
│ 1. IDENTITY   handshake() + authenticate()            → did:t3n            │
│ 2. VC GATE    bbs_vc.verifyBbsVCW3c(predicateCred)    → eligible, no PII   │
│ 3. MANDATE    contracts.execute("gate", "evaluate")   → TEE decision       │
│ 4. AUDIT      structured row (issuer, decision, reasons)                   │
└────────────────────────────────────────────────────────────────────────────┘
        │                                   │
   @terminal3/bbs_vc + vc_core      gate-contract (Rust → wasm32-wasip2)
   (predicate credential)           reads mandate from z:<tid>:mandate KV,
                                    enforces amount / asset / kind / expiry
```

## Layout

| Path | What |
| --- | --- |
| `agent/` | The agent runtime (identity + VC gate + contract invoke + audit). `npm run demo`. |
| `gate-contract/` | The Rust→WASM TEE mandate contract. Builds to a wasm component, registered to the tenant. |
| `t3-qa/` | Verification sandbox — standalone smoke tests for each layer (auth, BBS+ issue/verify, tamper test, contract deploy + invoke, live TDX attestation parse). |
| `submission/` | Demo script, BUIDL description, Track B bug reports, and a [technical deep-dive](submission/TECH_DEEPDIVE.md) (BBS+ pairing trace + TDX quote byte layout, verified live). |

## Verified end-to-end on T3N testnet

Every layer was run against the live testnet, not mocked:

- **Auth** — `handshake` → `authenticate` → `getUsage` (20,000 credits).
- **BBS+ VC** — issue (`bbs-2023` DataIntegrityProof) + verify; a tampered claim
  is correctly rejected (`isValid:false`), so the signature is enforced.
- **True selective disclosure** — issuer signs a full record, holder derives a ZK
  proof revealing only one claim, verifier accepts; forged value / wrong nonce
  rejected (`npm run demo:sd`).
- **TEE contract** — `gate-contract` compiled to a 156 KB wasm component,
  registered (`contract_id` returned), and `evaluate()` invoked inside the
  Enclave returning approved/rejected decisions with the cluster timestamp and
  tenant DID resolved host-side.

## Quickstart

```bash
# 1. build the TEE contract  (Windows: see gate-contract/README.md for the gnu toolchain note)
cd gate-contract && cargo build --target wasm32-wasip2 --release && cd ..

# 2. run the agent
cd agent
cp .env.example .env        # paste T3N_API_KEY + DID from the token-claim page
npm install
npm run setup               # register the contract to your tenant
npm run demo                # identity -> VC gate -> TEE mandate -> audit
```

## Security note

The T3N API key grants full sandbox access and is shown only once on the claim
page. Keep it in `agent/.env` (gitignored); never commit or share it.
