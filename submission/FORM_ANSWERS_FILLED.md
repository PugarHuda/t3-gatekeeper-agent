# DoraHacks submission — every field, filled & paste-ready

One file for both forms. Copy each block into the matching field. Items marked
**[YOU]** need something only you can provide (a file, a link, an account).

---

## FORM 1 — Create a new BUIDL

### Profile

**BUIDL (project) name**
```
Gatekeeper Agent — VC-gated permissioned actions with a hardware mandate
```

**BUIDL logo** — **[YOU]** JPEG/PNG, <2 MB, 480×480 px recommended. Optional but
recommended. (If you have none, the architecture diagram cropped square works.)

**Vision (Describe the problem which this project solves)** — the live form caps
this at **256 characters**. Paste this 255-char version:
```
AI agents that transact for you normally hold your credentials and data in memory. Gatekeeper Agent gates every action with a BBS+ verifiable credential (selective-disclosure eligibility) and a hardware-TEE spending mandate — so the agent holds neither.
```

The long description below goes in the **Details** rich-text field, not Vision
(source of truth: `BUIDL_DESCRIPTION.md`):
```
THE PROBLEM
AI agents that transact on your behalf normally need your credentials and your personal data in memory. That's an exploitable attack surface, a prompt-injection leak waiting to happen, and a non-starter for banks and institutions. And "eligibility" (accredited investor, licensed, KYC'd) is usually proven by handing over the raw documents — exposing far more than the one fact that matters.

THE SOLUTION
The Gatekeeper Agent puts two independent gates in front of every outbound action, using the Terminal 3 Agent Dev Kit end-to-end:

1. Eligibility gate (verifiable credential). A trusted issuer signs a BBS+ credential; the agent verifies the user qualifies (e.g. accredited investor) without seeing the underlying data. Two modes ship: a predicate credential ({ accreditedInvestor: true }), and true BBS+ selective disclosure where the issuer signs the user's full KYC record and the holder derives a zero-knowledge proof revealing only the accredited flag — net worth, name and DOB stay mathematically hidden. (We implemented the holder-side derive ourselves: the SDK ships the primitive via @mattrglobal/bbs-signatures' createProof/verifyProof but doesn't wrap it.)

2. Mandate gate (hardware). A Rust→WASM TEE contract enforces the user's spending mandate inside Terminal 3's enclave — max amount, allowed assets, allowed action kinds, allowed counterparties, a valid-after window, expiry — reading the mandate from a tenant KV map the agent itself cannot forge. It also enforces a stateful cumulative velocity cap: a running per-window total is kept in the contract's KV store and the action is rejected once the total would exceed the cap — held across invocations in hardware, so the agent cannot reset its own budget.

Every decision, approved or rejected, produces a structured audit row.

ECOSYSTEM INTEROP (all shipped, tested)
- Web Bot Auth (RFC 9421): the agent signs outbound action requests with Ed25519 HTTP Message Signatures so a destination (or a Cloudflare/WAF in front of it) can verify the request came from this agent. Adopted by Visa TAP and Mastercard Agent Pay.
- A2A capability exchange: two agents handshake by exchanging a BBS+ capability credential with selective disclosure — proving a capability (e.g. payments.execute) without revealing the rest of the manifest.
- Credential-revocation pre-gate: checks @terminal3/revoke_vc isRevoked() against an on-chain status registry — a kill-switch even if the BBS+ proof still verifies.
- In-TEE action dispatch: an approved action is executed from inside the enclave via the contract's dispatch_action (host http), the path where http-with-placeholders injects credentials so the agent never holds them.
- ERC-8004 on-chain identity: npm run register:erc8004 mints the agent as an ERC-721 Trustless Agent via the real EIP-8004 register(agentURI) ABI (no fake mint).

TERMINAL 3 SDK INTEGRATION (the full stack, not just auth)
- @terminal3/t3n-sdk: loadWasmComponent, setEnvironment, metamask_sign, T3nClient.handshake/authenticate/getUsage, and the tenant control plane TenantClient.contracts.register()/execute().
- @terminal3/bbs_vc + @terminal3/vc_core: BBS+ credential issuance, verification, BLS keys and DIDs.
- A custom Rust → wasm32-wasip2 TEE contract importing host tenant-context, kv-store, and logging interfaces.

VERIFIED END-TO-END ON T3N TESTNET
Auth (20,000 credits), BBS+ issue/verify with tamper-rejection, true selective disclosure (forged value / wrong nonce rejected), TEE contract registered on-chain (contract_id 175, gate@0.6.0) and evaluated inside the enclave, stateful velocity limit (3 spends, 3rd rejected). 27 offline crypto/protocol tests + 15 Rust unit tests, CI green. The crypto and contract logic can be verified with no API key: cd agent && npm test, cd gate-contract && cargo test.

WHY THIS MATTERS
This is the pattern a bank's trading desk or a permissioned-DeFi / RWA venue needs: delegate bounded execution to an AI agent without handing over credentials or data. Eligibility is a verifiable fact, the spending limit is enforced in hardware rather than by the agent's own promise, and every action leaves a cryptographic audit trail.

Tech stack: TypeScript · @terminal3/t3n-sdk · @terminal3/bbs_vc · @terminal3/vc_core · Rust → wasm32-wasip2 (wit-bindgen, serde) · Terminal 3 TEE / z-space tenant contracts.
```

### Category

**Is this BUIDL an AI Agent?** → **Yes**

### Links

**GitHub/Gitlab/Bitbucket**
```
https://github.com/PugarHuda/t3-gatekeeper-agent
```

**Project website (optional)** — leave blank, or use the README:
```
https://github.com/PugarHuda/t3-gatekeeper-agent#readme
```

**Demo video (REQUIRED)**
```
https://youtu.be/gVY3y4j6XT4
```

**Social links (at least one REQUIRED — up to 3)**
```
https://www.linkedin.com/in/pugar-huda-mantoro/
https://x.com/BangDropID
https://github.com/PugarHuda
```

---

## FORM 2 — Registration / organizer questions

**What is the problem your agent is solving?**
```
AI agents that transact on a user's behalf normally need the user's credentials and personal data in memory — an exploitable surface and a non-starter for banks and institutions. The Gatekeeper Agent executes permissioned financial actions (e.g. an RWA / permissioned-DeFi purchase) on behalf of a user while holding neither their credentials nor their sensitive data: eligibility is proven by a BBS+ verifiable credential (with selective disclosure), and the spending mandate — amount, asset, counterparty, time window, and a cumulative per-window velocity cap — is enforced inside a hardware TEE that the agent itself cannot bypass or reset. Every action leaves a redacted audit row.
```

**Why is verifiable identity important for your agent?**
```
The agent must prove two things before acting: that the user is eligible (e.g. an accredited investor) and that the agent is acting within a mandate. A BBS+ verifiable credential lets a trusted issuer attest the eligibility predicate cryptographically — without exposing net worth, name, or DOB — and the did:t3n identity binds the agent's attested TEE session and its on-chain audit trail. Eligibility becomes a verifiable fact rather than the agent's unverifiable claim. The same identity layer also lets the agent prove its own capabilities to peer agents (A2A) and cryptographically sign its outbound requests (Web Bot Auth, RFC 9421) so a destination can trust who is calling.
```

**What is one thing we can improve in your documentation?**
```
The "Smart VCs" page advertises ZK selective-disclosure VPs, but the published @terminal3/bbs_vc package exposes only issuance + verification (no holder-side derive-presentation function) and the docs give no function names or code example for the selective-disclosure flow. Please add an end-to-end issue→derive→verify VC sample, or document that derivation isn't yet exposed and point developers to the transitive @mattrglobal/bbs-signatures createProof/verifyProof that actually does the derive. Secondary: the Windows dev-env docs omit the native host-linker prerequisite for cargo build --target wasm32-wasip2 (we had to use the stable-x86_64-pc-windows-gnu toolchain).
```

**Which of this describes you the best?** → **Developer** (solo builder)

**Who referred you to the hackathon?** → optional — leave blank, or enter the
referrer's email if someone referred you.

---

## Still owed by you (cannot be auto-filled)
1. ✅ BUIDL logo — `submission/logo/logo.png` (480×480 PNG)
2. ✅ Demo video — https://youtu.be/gVY3y4j6XT4
3. ✅ Social links — LinkedIn / X / GitHub (above)
4. **[YOU]** The 8 Track B bug reports are submitted SEPARATELY — see
   `TRACK_B_BUG_REPORTS.md` / `TRACK_B_DORAHACKS.md` (paste-ready)
5. **[YOU]** Rotate the dev API key (the one used during dev) if not already done
