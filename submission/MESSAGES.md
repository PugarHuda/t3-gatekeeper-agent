# Paste-ready messages

Everything below is written to be sent as-is, in the order listed. Nothing here
is sent automatically. Numbers are as of 2026-08-31, head `b80ae10`, and every
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
lose a submission — re-checked 2026-08-31 and this doc is STILL owner-only, so
this step has not been done yet. The form says so too: "Make sure this link is
accessible by everyone!" (v1–v4 are renamed "OLD … do not submit"; v5 is the only
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
reports re-verified against the refreshed docs, three already fixed outright by
Terminal 3 and two more part-way, and three that turned out to be corrections to
our own earlier findings.

Happy to hand it over to Terminal 3 to host and maintain: nothing personal is
in the running path, a scoped agent key replaces the tenant's Ethereum key,
and MAINTENANCE.md is the handover.
```

Repo: https://github.com/PugarHuda/t3-gatekeeper-agent
Evidence: https://gatekeeper-evidence.vercel.app

### The form's actual fields, in order

The Superteam form asks for six things. Paste-ready, one per field.

**1. Link to Your Submission** *(the form warns "make sure this link is
accessible by everyone" — do step 1 above first, then open it in a private
window)*

```
https://docs.google.com/document/d/1W0EHiVu26P4t76Gw6pVSwDTGi5PPJyDvN5MNie3bW-0/edit
```

**2. Tweet Link**

```
https://x.com/BangDropID/status/2092653732848976141
```

**3. Email address**

```
hudapugar@gmail.com
```

**4. What is your DID generated from the page?**

```
did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f
```

**5. Would you want to continue running this / pass it to us to run it?**

```
I would rather hand it over — a reference agent belongs with the people who own
the platform it demonstrates. I would keep contributing to it. If you would
prefer I keep running it I am glad to, and would apply to the startup program.

The handover work is already done, because "can someone else run this?" was the
design constraint this round rather than a paragraph at the end. Nothing personal
is in the running path: no personal wallet, no hardcoded DID, no committed key,
no database, no cron, no background worker. Every canonical map name is derived
at runtime from tenant_did() inside the enclave, so the code does not know whose
tenant it is running in.

Six steps, full version in MAINTENANCE.md §6: (1) claim your own tenant key and
DID — and do NOT take my Ethereum key, provision a scoped revocable agent key
with `agent create` instead; (2) `npm run setup` re-registers the contract under
your tenant; (3) the mandate is JSON, the only business config; (4) set
BROKER_API_KEY — your secrets map ACL names your contract id, so my key is
unreadable to you and yours to me; (5) generate a fresh Web Bot Auth key and
publish the JWKS; (6) `npx vercel deploy --prod` from the repo root for the site
and the hosted doors.

`node verify.mjs` before and after. If it passes the logic is intact, and
MAINTENANCE.md §5 lists the five environmental failures with their fixes.
```

**6. Anything Else?**

```
Repo: https://github.com/PugarHuda/t3-gatekeeper-agent
Evidence site: https://gatekeeper-evidence.vercel.app
Hosted doors: /api/a2a (A2A v1.0) and /api/mcp (MCP Streamable HTTP), signed
requests only — the card and the ERC-8004 registration both name them.

Verify it without an account: `node verify.mjs` — 321 checks, no API key, no
network, no credits. Add `cd qa-console && npm run test:site` for 27 live checks
against the deployment (network, still no key).

On chain: ERC-8004 agent #201 on Sepolia, tx 0x37965ccd…; an x402 payment
settled on Base Sepolia through a public facilitator, tx 0x52b164d133…, both
balances checked at explicit block tags rather than from the receipt.

Bugs: 29 reports with repros in submission/BUGS.md, re-tested against the
refreshed docs. Three are fixed, one likely, one half-adopted. The three worth
your team's time are also emailed to devrel@terminal3.io: two core contracts
(tee:vc, tee:agent-connect) that the node serves, no doc mentions, and that
cannot be called at all (#27, #28); audit.get-mine empty while activity.log has
everything (#29); and the per-minute fuel budget charged at the per-call maximum,
capping every tenant at 10 calls a minute (#23).

This is a returning project — it placed 2nd in the previous round. What is new
is in §0 of the doc, aimed at the maintainability criterion.
```

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

Rust→WASM on @Terminal3io · 321 tests · 29 bugs found

https://gatekeeper-evidence.vercel.app
```

Paste the tweet URL into the Superteam form. (The posted tweet says *277 tests*,
which was true on 28 Aug; the count is 321 today. Not worth editing a live post
over — the block above is the current wording for any repost.)

---

## 4. Telegram DM to @wardumb — only if credits run low

**Not needed today.** `npm run auth` on 2026-08-30 reads **71,101,637,901**
credits — a contract registration costs 1.37e9 and a call 3.0e7, so that is
about 51 registrations or 2,367 calls of headroom. Send this only if
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

And thank you for the fixes: `token balance`, org-owned agents and the
`sandbox` alias all work now (#9, #12, #14), and the version-shadowing
warning from June made it onto the Register page (#8). The other half of
that one is still open — there is no API that returns a contract's numeric
contract_id, so a caller that needs it for a map ACL has to capture it from
the registration response and never lose it.

Thanks!
```

**Sent 2026-08-30** from hudapugar@gmail.com to devrel@terminal3.io, subject
as above.
