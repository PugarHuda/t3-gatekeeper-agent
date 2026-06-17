# Gatekeeper Agent — Demo Video Script (~3 min, with voice-over)

Show the agent chaining the Terminal 3 SDK end to end, live on testnet — identity,
BBS+ VC gate, revocation, hardware mandate, audit, and a signed + in-TEE-executed
dispatch. Record the terminal at ~120 cols. Keep the API key off-screen.

---

## 🎙️ Voice-over & sync — read this first
**There must be a voice-over** (narration) the whole way through — the "Say:" lines
below are the script. To keep the **audio in sync with the terminal**, the demos
print fast, so use the built-in **pacing flag**:

```powershell
$env:DEMO_PAUSE_MS = "2500"      # 2.5 s gap before each scenario prints
npm run demo                      # now each [3] MANDATE … appears one at a time
```
`DEMO_PAUSE_MS` works for `npm run demo`, `demo:sd`, and `demo:velocity`. Tune it
(2000–3000 ms) to your speaking pace.

**Two ways to record (pick one):**
1. **Live narration (simplest).** Set `DEMO_PAUSE_MS`, hit enter, and read each
   cue as its line appears. Re-run if you fumble — a full demo is ~250 credits.
2. **Record then voice-over in post (cleanest).** Capture the terminal silently
   (with pacing on), then add narration in CapCut/DaVinci/Premiere, dragging each
   VO beat onto the matching line. Best lip-to-line sync.

**Sync rule:** start speaking a cue the instant its line appears; finish before the
next line. The cue sheet in Scene 3 pairs each spoken beat to the exact on-screen
line.

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
**Say (while the tests run):**
> "The mandate is enforced by this Rust contract, compiled to a WASM component and
> run inside Terminal 3's enclave. It checks amount, asset, kind, counterparty and
> expiry — reading the mandate from a tenant KV map the agent itself can't forge."
**Do:**
```powershell
cd gate-contract
cargo +stable-x86_64-pc-windows-gnu test --target x86_64-pc-windows-gnu
```
> "Fifteen gate tests, green."

## Scene 2 — Build + deploy (0:45–1:15)
> ⚠️ Skip the deploy if `gate@0.6.0` is already registered — re-deploying is the
> only expensive op. To show it anyway, narrate over the `contract_id` line.
**Do:**
```powershell
cargo +stable-x86_64-pc-windows-gnu build --target wasm32-wasip2 --release
cd ../agent
npm run setup
```
**Say (over `Registered ✅ … contract_id …`):**
> "We compile to a wasm component and register it to our tenant on testnet —
> that's a real on-chain contract id."

## Scene 3 — Run the agent (1:15–2:15) — CUE SHEET
**Do:**
```powershell
$env:DEMO_PAUSE_MS = "2500"
npm run demo
```
**Narrate each line as it appears (cue → say):**

| When you see on screen | Say |
| --- | --- |
| `[1] IDENTITY   did:t3n:3d7dd668…` | "The agent authenticates over an encrypted session — that's its did:t3n." |
| `[2] VC GATE … verify=true … eligible=true` | "A trusted issuer signed a BBS+ credential proving *accredited investor*. No net worth, no name, no date of birth — and we verify it cryptographically." |
| `[2b] REVOCATION skipped …` | "Before acting, it checks an on-chain revocation registry — a kill-switch even if the proof still verifies." |
| `[3] MANDATE  buy $1,000 …  APPROVED` | "Now the TEE contract judges the action. A thousand-dollar RWA buy — approved." |
| `[5] DISPATCH … signed (web-bot-auth, body digest)` + `in-TEE call -> egress gated` | "On approval it signs the request with Web Bot Auth — body and all — *and* executes it from inside the enclave. The call really left the TEE; the host just hasn't allowlisted this merchant yet." |
| `[3] MANDATE  buy $9,000 …  REJECTED  reasons=["amount … exceeds … max …"]` | "Nine thousand — rejected, over the cap." |
| `[3] MANDATE  swap into DOGE …  REJECTED` | "A DOGE swap — rejected: wrong asset and wrong action kind." |
| `[3] MANDATE  pay APPROVED counterparty …  APPROVED` | "Paying an approved counterparty — allowed." |
| `[3] MANDATE  pay UNKNOWN counterparty …  REJECTED` | "An unknown payee — blocked by the counterparty allow-list." |
| `[3] MANDATE  future-dated …  REJECTED ("not active until …")` | "And a future-dated mandate — not active yet. Every one of these is decided in hardware, with an audit row." |

## Scene 3.5 — True selective disclosure (the showstopper) (2:15–2:45)
**Do:**
```powershell
npm run demo:sd
```
**Narrate the `[2] VC GATE` block (let it sit on screen):**
> "Same flow — but watch the credential gate. The issuer signed the user's **full**
> KYC record: full name, date of birth, **a net worth of five million dollars**,
> and the accredited flag. The holder derives a zero-knowledge proof revealing
> **only** the accredited flag. Look at what the agent sees: just
> `{ accreditedInvestor: true }`. Name, birth date, net worth — never revealed,
> mathematically hidden, yet provably issuer-signed. That's BBS+ selective
> disclosure — we built the holder-side derive ourselves because the SDK ships the
> primitive but doesn't wrap it."

## Scene 3.6 — Hardware velocity limit (optional bonus, +0:20)
**Do:**
```powershell
npm run demo:velocity
```
**Narrate the three `spend` lines:**
> "One more guarantee — a cumulative spend cap, enforced in the enclave. Limit
> five thousand. Two thousand, then two thousand — both approved. The third would
> hit six thousand, so the contract **rejects** it. That running total lives in
> the TEE's KV store; the agent can't reset its own budget between calls."

## Scene 4 — Why it matters (2:45–3:10)
**On screen:** the SDK-layer table from `agent/README.md`.
**Say:**
> "Identity, verifiable credentials, revocation, a hardware-enforced mandate
> contract, audit, and an action that's both signed and executed inside the
> enclave — the full Terminal 3 stack, in one agent. It also speaks the ecosystem's
> languages: Web Bot Auth on the way out, A2A capability exchange agent-to-agent.
> This is the pattern a bank's trading desk or a permissioned-DeFi venue needs:
> delegate to an agent without handing over data or trust. Thanks for watching."

---

### Capture checklist
- [ ] `.env` has your current key; balance ≥ ~600 credits per full run (see SUBMIT_CHECKLIST).
- [ ] **Voice-over recorded end to end** — narration on every scene.
- [ ] `DEMO_PAUSE_MS` set (≈2500) so audio lands on each line.
- [ ] Terminal font large enough to read the tagged `[1]…[5]` lines.
- [ ] Don't show the key on screen (run `npm run setup` with `.env` already loaded, or clear scrollback).
- [ ] Add the final video link to `BUIDL_DESCRIPTION.md` (`<add link>`).
