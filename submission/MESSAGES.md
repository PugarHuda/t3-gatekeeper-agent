# Paste-ready messages

Everything below is written to be sent as-is, in the order listed. Nothing here
is sent automatically. Numbers are as of 2026-08-30, head `a4490d0`, and every
one of them is printed by a command in the repo rather than typed from memory.

---

## 1. Share the Google Doc — 1 minute, do this first

The doc already exists in your Drive, generated from `SUBMISSION.md` with all
32 screenshots embedded (current: hosted A2A/MCP doors, the wasm component host,
the MCP Registry listing, signed card + did:web, A2A streaming, axe, 321 checks):

**v5 — submit this one:**
https://docs.google.com/document/d/1W0EHiVu26P4t76Gw6pVSwDTGi5PPJyDvN5MNie3bW-0/edit

Share → *Anyone with the link* → Viewer → copy link. Open it in a private
window before submitting: a doc only you can open is the most common way to
lose a submission — as of 2026-08-30 this doc is still owner-only, so this step
has not been done yet. (v1–v4 are renamed "OLD … do not submit"; v5 is the only
one with the signed card, did:web, A2A streaming and the 321-check count.)

Fallbacks, both tested by `qa-console/doc.test.mjs` / `docx.test.mjs`:
`submission/submission.docx` (Drive → upload → Open with Google Docs) or
`submission/google-doc.html` (open, Ctrl+A, Ctrl+C, paste into a blank Doc).

---

## 2. Superteam Earn — submission fields

**Link:** the Google Doc from step 1.
**Tweet link:** https://x.com/BangDropID/status/2092653732848976141 (posted 28 Aug).

**Short description**, if the form asks for one:

```
Gatekeeper — an enterprise agent for tokenised private-credit distribution that
cannot act outside its owner's mandate. Eligibility is proven with a BBS+
zero-knowledge credential (the fund learns "accredited", never the net worth);
the spending mandate is enforced inside a TDX enclave by a Rust contract the
agent cannot write to, and the decision and the outbound order are one enclave
call, so a rejected trade cannot dial out.

Distributable three ways: an MCP server (stdio and Streamable HTTP), an A2A
v1.0 endpoint on the official SDK — both hosted live at
gatekeeper-evidence.vercel.app/api/a2a and /api/mcp, deciding with the very
wasm component registered on the node — and an ERC-8004 identity (agent #201,
Sepolia) whose registration names that endpoint. Every HTTP call must carry a
web-bot-auth signature resolved from the caller's own published key. x402 payments go through the same mandate — one
was settled on Base Sepolia through the public facilitator and checked against
the chain.

321 offline checks in one command with no API key; 32 screenshots, all from
real command output, republished at gatekeeper-evidence.vercel.app; 29 bug
reports re-verified against the refreshed docs, four already fixed by
Terminal 3, and three that turned out to be corrections to our own earlier
findings.

Happy to hand it over to Terminal 3 to host and maintain: nothing personal is
in the running path, a scoped agent key replaces the tenant's Ethereum key,
and MAINTENANCE.md is the handover.
```

Repo: https://github.com/PugarHuda/t3-gatekeeper-agent
Evidence: https://gatekeeper-evidence.vercel.app

---

## 3. X post — DONE: https://x.com/BangDropID/status/2092653732848976141

Three variants are in `X_POST.md` (single premium post, 280-char, thread). If
you only post one, post Option A with `screenshots/out/32-x402-settled.png` or
`27-prove-enclave.png` attached. The current short version:

```
An AI agent that can spend your money, without being trusted with it.

Fund learns one fact — "buyer is accredited" — as a ZK proof. Mandate is enforced
inside a TEE, so the agent can't raise its own limit. Today it paid for a
resource over x402 through that mandate, settled on Base Sepolia by a public
facilitator, and it holds ERC-8004 identity #201.

Rust→WASM on @Terminal3io · 277 tests · 29 bugs found

https://gatekeeper-evidence.vercel.app
```

Paste the tweet URL into the Superteam form.

---

## 4. Telegram DM to @wardumb — only if credits run low

**Not needed today.** The account holds ~34e9 credits after everything in this
round; a contract registration costs 1.37e9 and a call 3.0e7. Send this only if
`npm run auth` shows the balance under ~2e9:

```
Hi — requesting a testnet top-up, quoting Superteam.

DID: did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f
Repo: github.com/PugarHuda/t3-gatekeeper-agent (round-3 submission)

Balance is at <amount>. Measured costs on 2026-08-27: 30,034,055 per contract
call and 1,370,147,045 per registration of a 255 KB component — so a
registration is about 45 calls. Nothing publishes these; they are written up
as bug #21 in the submission, with the per-minute quota (#23) beside them.

Thanks!
```

---

## 5. Optional — email to devrel@terminal3.io

Worth sending because three of the findings are about the platform rather than
about us, and two of them contradict the docs.

```
Subject: Gatekeeper (Superteam round 3) — three platform findings worth a look

Hi Terminal 3 team,

Submitting Gatekeeper for the "build a trusted agent" bounty:
github.com/PugarHuda/t3-gatekeeper-agent — 29 reports in submission/BUGS.md,
each with a repro. Three seem worth raising outside the list:

1. The node serves two core contracts nothing documents: tee:vc (a full
   OpenID4VP holder — submit-vp takes a DCQL query and answers "unsatisfied")
   and tee:agent-connect (commerce intents/quotes). Neither can be used: the
   commerce contract requires a profile field `kind` that user-upsert refuses
   as an unrecognised key (#27), and issue-credential wants keys.generic_api
   metadata that user-upsert accepts silently and the reader still calls
   missing (#28). node t3-qa/core-contracts-probe.mjs reproduces both and
   exits non-zero if either starts working.

2. audit.get-mine is empty after 39 dispatches, while getActivityLog() has
   every call with a sequence number and hash (#29). If activity.log is the
   audit trail, the docs should say so; if get-mine is meant to be populated,
   it is not.

3. The per-minute fuel budget is charged the per-call MAXIMUM, not the fuel
   used: fuel_per_minute_max / fuel_per_call_max = exactly 10 calls, while a
   measured call uses 60% of the cap (#23). Two fifths of the minute cannot be
   reached, and the refusal sometimes arrives as a bare "Internal error".

And thank you for the fixes — token balance, org-owned agents, the sandbox
alias, and the version-shadowing warning we reported in June are all in.

Thanks!
```
