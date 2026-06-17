# Gatekeeper Agent — Demo Video Script (~3 min)

Goal: show the agent chaining the Terminal 3 SDK end to end, live on testnet —
identity, BBS+ VC gate, revocation, hardware mandate, audit, and a signed +
in-TEE-executed dispatch. Record the terminal at ~120 cols. Keep the API key
off-screen.

---

## Scene 0 — Hook (0:00–0:15)
**On screen:** the README architecture diagram.
**Say:**
> "AI agents that act on your money usually need your credentials and your data.
> The Gatekeeper Agent never holds either. It proves you're *eligible* with a
> verifiable credential, and a hardware TEE enforces *how much* it can spend —
> on Terminal 3."

## Scene 1 — The TEE contract (0:15–0:45)
**On screen:** `gate-contract/src/gate.rs` (the `decide()` gates) and `wit/world.wit`.
**Say:**
> "The mandate is enforced by this Rust contract, compiled to a WASM component
> and run inside Terminal 3's enclave. It checks amount, asset, kind and expiry —
> and reads the mandate from a tenant KV map the agent itself can't forge."
**Do:** run the unit tests:
```powershell
cd gate-contract
cargo +stable-x86_64-pc-windows-gnu test --target x86_64-pc-windows-gnu
```
> "Fifteen gate tests, green."

## Scene 2 — Build + deploy (0:45–1:15)
**Do:**
```powershell
cargo +stable-x86_64-pc-windows-gnu build --target wasm32-wasip2 --release
cd ../agent
npm run setup
```
**Say (over the `register ✅ contract_id …` line):**
> "We compile to a wasm component and register it to our tenant on testnet —
> that's a real on-chain contract id."

## Scene 3 — Run the agent (1:15–2:15)
**Do:**
```powershell
npm run demo
```
**Narrate each tagged line as it prints:**
> "**[1] Identity** — the agent authenticates and gets its did:t3n over an
> encrypted session.
> **[2] VC gate** — a trusted issuer signs a BBS+ credential proving
> *accredited investor = true*. Notice what's NOT here: no net worth, no name,
> no date of birth. We verify it cryptographically — and a tampered claim would
> fail.
> **[2b] Revocation** — before acting, the agent checks an on-chain revocation
> registry. A revoked credential is a kill-switch, even if the proof still
> verifies. (Here it's skipped until a registry is configured.)
> **[3] Mandate** — now the agent asks the TEE contract to approve an action.
> A $1,000 RWA buy is **approved**. A $9,000 buy is **rejected** — over the cap.
> A DOGE swap is **rejected** — wrong asset and wrong action kind.
> **[4] Audit** — every decision, approved or rejected, produces a structured
> audit row with the issuer, the action and the reason.
> **[5] Dispatch** — and only on approval, the request is **signed with Web Bot
> Auth** so the destination can verify the caller, *and* executed **from inside
> the TEE** via the contract's `dispatch_action`. Watch the in-TEE call: it
> returns `egress_denied` — the enclave really made the outbound call; the host's
> per-contract allowlist just hasn't whitelisted this merchant yet. That's the
> credential-injection path where the agent never holds the secret."

## Scene 3.5 — True selective disclosure (the showstopper) (2:15–2:45)
**Do:**
```powershell
npm run demo:sd
```
**Narrate the `[2] VC GATE` block:**
> "Same flow — but watch the credential gate now. The issuer signed the user's
> **full** KYC record: full name, date of birth, **net worth of five million
> dollars**, and the accredited-investor flag. The holder derives a
> zero-knowledge proof that reveals **only** the accredited flag. Look at what the
> agent actually sees: `{ accreditedInvestor: true }`. The name, the birth date,
> the net worth — **never revealed**, mathematically hidden, yet the agent is
> cryptographically sure the issuer signed them. That's BBS+ selective disclosure
> — and we had to build the holder-side derive ourselves because the SDK ships
> the primitive but doesn't wrap it yet."

## Scene 3.6 — Hardware velocity limit (optional bonus, +0:20)
**Do:**
```powershell
cd ../t3-qa
node velocity-test.mjs
```
**Narrate the three `spend` lines:**
> "One more guarantee: a cumulative spend cap, enforced in the enclave. The daily
> limit is $5,000. The agent spends $2,000, then $2,000 — both approved. The third
> $2,000 would push the running total to $6,000, so the contract **rejects** it.
> That running total lives in the TEE's KV store — the agent can't reset its own
> budget between calls."

## Scene 4 — Why it matters (2:45–3:10)
**On screen:** the SDK-layer table from `agent/README.md`.
**Say:**
> "Identity, verifiable credentials, revocation, a hardware-enforced mandate
> contract, audit, and an action that's both signed and executed inside the
> enclave — the full Terminal 3 stack, in one agent. It also speaks the
> ecosystem's languages: Web Bot Auth on the way out and A2A capability exchange
> agent-to-agent. This is the pattern a bank's trading desk or a permissioned-DeFi
> venue needs: delegate to an agent without handing over data or trust. Thanks for
> watching."

---

### Capture checklist
- [ ] `.env` filled with a FRESH key (rotate the exposed one first).
- [ ] Terminal font large enough to read the tagged `[1]…[5]` lines.
- [ ] Pause ~1s on `contract_id` and on each APPROVED/REJECTED line.
- [ ] Don't show the key: run `npm run setup` in a shell where `.env` was already loaded, or clear scrollback.
