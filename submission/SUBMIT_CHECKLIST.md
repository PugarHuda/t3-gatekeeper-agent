# Submission checklist — Terminal 3 Agent Dev Kit Bounty

Deadline: **22 Jun 2026 23:59 GMT+8**. Repo: https://github.com/PugarHuda/t3-gatekeeper-agent

## 0. Do FIRST (security)
- [ ] **Rotate the exposed T3N API key** (the one used during dev). Put the fresh key in `agent/.env`. Do this before recording so the demo uses a clean key.

## 1. Record the demo video (~2.5–3 min)
Script: [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md). Capture at ~120 cols, key off-screen.

**Credit budget** (measured: 1 contract `execute` ≈ **31 credits**; `getUsage`/auth ~free):
| Command | ~Executes | ~Credits |
| --- | --- | --- |
| `npm run setup` (register/deploy) | — | **expensive — SKIP, gate@0.6.0/175 is already deployed** |
| `npm run demo` | ~8 (6 evaluate + 2 dispatch) | ~250 |
| `npm run demo:sd` | full SD flow | ~250 |
| `npm run demo:velocity` | 3 spends | ~95 |
| `npm run demo:a2a`, `register:erc8004` | 0 (offline) | 0 |
> One full recording pass ≈ **~600 credits**. **Do NOT run `npm run setup`** during
> recording — the contract is already live, and re-deploying is the only expensive
> op. With a fresh 20,000-token key that's ~30 passes; even a partially-used key
> with ~2,000 left is ~3 passes. Re-claiming a key for the **same** Google account
> returns the **same** DID and does **not** refill credits — a fresh balance needs a
> new account (which would orphan the deployed contracts, so prefer to conserve).
- [ ] Scene 1–2: contract unit tests + build (`cargo +stable-x86_64-pc-windows-gnu test --target x86_64-pc-windows-gnu`, then `--release` build)
- [ ] Scene 3: `npm run demo` — narrate `[1] identity → [2] VC gate → [2b] revocation → [3] mandate (approve/reject) → [4] audit → [5] sign + in-TEE dispatch`
- [ ] Scene 3.5: `npm run demo:sd` — true selective disclosure (the showstopper)
- [ ] Optional: `npm run demo:velocity`, `npm run demo:a2a`
- [x] Uploaded to YouTube → https://youtu.be/gVY3y4j6XT4 (linked in `BUIDL_DESCRIPTION.md` + root README)

## 2. Submit the BUIDL on DoraHacks
- [ ] Title + description from [`BUIDL_DESCRIPTION.md`](BUIDL_DESCRIPTION.md) (paste-ready)
- [x] Repo link (https://github.com/PugarHuda/t3-gatekeeper-agent) + demo video (https://youtu.be/gVY3y4j6XT4)
- [ ] Tech stack line

## 3. Fill the registration form
- [ ] Answers from [`REGISTRATION_ANSWERS.md`](REGISTRATION_ANSWERS.md) (5 questions, copy-paste)

## 4. Submit the Track B bug reports (8) — SEPARATELY, first-report-wins
Full write-ups in [`TRACK_B_BUG_REPORTS.md`](TRACK_B_BUG_REPORTS.md). Titles ready to paste:

1. **`verifyBbsVc` reports `undefined` instead of the failure reason** — bug, `@terminal3/bbs_vc`, low. Tamper a VC → `message: "BBS+ signature verification failed: undefined"` (unset `error` field interpolated).
2. **`getNodeUrl("testnet")` returns the string `"testnet"`; `getNodeUrl()` returns the PROD url** — bug, `@terminal3/t3n-sdk`, medium. Easy to point a testnet build at production.
3. **"Smart VCs" docs claim ZK selective-disclosure VPs, but the SDK ships no holder-side derive function** — doc gap, medium. Capability exists one layer down (`@mattrglobal/bbs-signatures` `createProof`/`verifyProof`); docs give no function names or example.
4. **Referenced onboarding repo `Terminal-3/adk-getting-start` is empty** — onboarding gap, low.
5. **Building a TEE contract on Windows fails (no native host linker) and the docs don't mention it** — doc gap, medium. Workaround: the `stable-x86_64-pc-windows-gnu` toolchain.
6. **`tenant.claim()` returns HTTP 500 for an already-provisioned tenant** — backend bug, medium (re-verify the `request_id` before sending).
7. **Importing `host:interfaces/vp` or `agent-registry` registers but then 500s on every `execute` (host doesn't serve them); no register-time validation** — backend/WIT bug, high. Evidence table: `http` (id 174) works; `vp` (id 164) / `agent-registry` (id 170) 500. Repro scripts in `t3-qa/`.
8. **Registering a new version under a tail makes the host run the LATEST version for every `execute` (a broken deploy bricks pinned older versions); no get-contract-id API; private-map ACL re-register footgun** — backend bug, high.

> Note for reports 7–8: re-verify on the current testnet before submitting (a fix may have shipped); capture fresh `request_id`s.

## 5. Referral
- [ ] (Optional) add a referrer email in the registration form.

---

## Optional — email to devrel@terminal3.io
Two host-side changes would unlock the last roadmap items (everything else is shipped and live):

```
Subject: Gatekeeper Agent (bounty) — two host-side asks to unlock on-chain + in-TEE action

Hi Terminal 3 team,

Submitting "Gatekeeper Agent" for the ADK bounty
(https://github.com/PugarHuda/t3-gatekeeper-agent). It chains identity → BBS+ VC
gate → revocation → hardware mandate (gate@0.6.0, contract_id 175) → audit →
Web Bot Auth signature → in-TEE dispatch, plus true selective disclosure, A2A,
and a stateful velocity limit.

Two things are host-gated and would complete the picture:

1. Egress allowlist. The contract's `dispatch_action` calls host `http` from
   inside the TEE; it returns `host/http.egress_denied` because our tenant's
   `authorised_hosts` is empty. How do we add an egress host for our contract?
   I couldn't find it in the SDK (ContractPublishInput is tail/version/wasm only).

2. vp / agent-registry. Importing host:interfaces/vp@2.1.0 or
   agent-registry@2.1.0 registers fine but then 500s on EVERY execute (incl.
   evaluate), while http works. vp.verify's own doc comment says it's @2.2.0.
   Are these served to tenant contracts on testnet yet? (Filed as a bug report
   with repro contract_ids 164 / 170 / 174.)

Also reported 8 onboarding/SDK issues separately via the bounty.

Thanks!
```
