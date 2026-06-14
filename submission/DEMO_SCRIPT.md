# Gatekeeper Agent — Demo Video Script (~2.5 min)

Goal: show the agent chaining **all four** Terminal 3 SDK layers, live on testnet.
Record the terminal at ~120 cols. Total ~2.5 min. Keep the API key off-screen.

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
> "Five gate tests, green."

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

## Scene 3 — Run the agent (1:15–2:10)
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
> **[3] Mandate** — now the agent asks the TEE contract to approve an action.
> A $1,000 RWA buy is **approved**. A $9,000 buy is **rejected** — over the cap.
> A DOGE swap is **rejected** — wrong asset and wrong action kind.
> **[4] Audit** — every decision, approved or rejected, produces a structured
> audit row with the issuer, the action and the reason."

## Scene 4 — Why it matters (2:10–2:30)
**On screen:** the four-layer table from `agent/README.md`.
**Say:**
> "Identity, verifiable credentials, a hardware-enforced mandate contract, and
> audit — the full Terminal 3 stack, in one agent. This is the pattern a bank's
> trading desk or a permissioned-DeFi venue needs: delegate to an agent without
> handing over data or trust. Thanks for watching."

---

### Capture checklist
- [ ] `.env` filled with a FRESH key (rotate the exposed one first).
- [ ] Terminal font large enough to read the tagged `[1]…[4]` lines.
- [ ] Pause ~1s on `contract_id` and on each APPROVED/REJECTED line.
- [ ] Don't show the key: run `npm run setup` in a shell where `.env` was already loaded, or clear scrollback.
