# Paste-ready messages

Everything below is written to be sent as-is. Nothing here is sent automatically.

---

## 1. Telegram DM to @wardumb — the credit top-up

**Send this first.** It unblocks registering v0.9.0, seeding the KV mandate, and
the two remaining live screenshots. https://t.me/wardumb

```
Hi — requesting a testnet top-up, quoting Superteam.

DID: did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f

The account is at 0 with credit_exhausted: true. Registering one 204 KB
contract took it from the full 1.487e9 grant to zero, and every write since
returns required=10000000000, available=0 — about 6.7x a full grant for a
single control call.

I'm submitting for the current "build a trusted agent" bounty
(github.com/PugarHuda/t3-gatekeeper-agent). Contract v0.9.0 is built and
unit-tested; it just needs credits to register and seed its mandate map.

Two things you may want from that, separate from the top-up:

1. The node no longer works with @terminal3/t3n-sdk 3.5.2 — getUsage() returns
   400 "token.get-usage: request params must be sealed to this session key"
   (request_id 2901523a-450d-4a04-b9c5-b0748a855d65). Same call on 5.1.0 is
   fine. Anything built against the previous docs is broken with no version
   error and no changelog to check.

2. Metering looks inconsistent: at zero balance, `agent create --org` minted a
   DID, issued an API key and hosted a card for free, while `agent card-publish`
   and `agent host-card` both demanded 10000000000.

Both are written up with repro steps in the submission. Thanks!
```

---

## 2. X post — the bonus, tagging @terminal3io

Pair it with `submission/screenshots/out/07-tests.png` or `11-qa-console-approved.png`.

```
Built an AI agent that cannot spend outside its mandate — because the mandate
is enforced by a Rust contract in a TDX enclave, not by the agent's own code.

Tokenised private credit: prove an investor is accredited with a BBS+ ZK proof,
reveal nothing else, and let the fund never store a passport again.

New this round on @terminal3io:
• the broker API key lives in the enclave's secrets map — the agent never holds it
• decision + outbound order are ONE enclave call, so a rejected trade can't dial out
• one command, 85 checks, no key and no credits: node verify.mjs
• 21 bug reports filed, 4 already fixed by the team

Repo + evidence 👇
github.com/PugarHuda/t3-gatekeeper-agent
gatekeeper-evidence.vercel.app
```

Shorter variant if the above runs long:

```
An AI agent that *cannot* overspend: the limits live in a Rust TDX enclave, not
in the agent's prompt.

Accredited-investor proof via BBS+ ZK — the fund learns one bit, stores no
passport. The broker API key sits in the enclave; the agent never holds it.

Built on @terminal3io ADK. 85 checks in one command, 21 bugs filed.
github.com/PugarHuda/t3-gatekeeper-agent
```

---

## 3. Superteam Earn submission fields

**Link:** the public Google Doc (built from `SUBMISSION.md` — see §4 below).

**Short description**, if the form asks for one:

```
Gatekeeper — an enterprise agent for tokenised private-credit distribution that
cannot act outside its owner's mandate. Eligibility is proven with a BBS+
zero-knowledge credential (the fund learns "accredited", never the net worth);
the spending mandate is enforced inside a TDX enclave by a Rust contract the
agent cannot write to. This round adds the broker credential living in the
enclave's secrets map, a one-command 85-check verification with no API key, a
full maintenance and handover manual, and 21 bug reports re-verified against the
refreshed docs — four of which Terminal 3 has since fixed.

Happy to hand it over to Terminal 3 to host and maintain; nothing personal is in
the running path and the handover steps are documented.
```

---

## 4. Publishing the Google Doc

```bash
cd submission
node make-google-doc.mjs      # -> google-doc.html
node make-docx.mjs            # -> submission.docx
```

Either path works; the .docx is the more reliable one because the images are
real embedded parts rather than a clipboard round trip:

- **Upload** `submission.docx` to Drive, right-click → Open with Google Docs,
  then Share → "Anyone with the link" → Viewer.
- **Or** open `google-doc.html` in a browser, Ctrl+A, Ctrl+C, paste into a blank
  Google Doc, and share the same way.

Check the share setting before submitting — a doc that only you can open is the
most common way to lose a submission.

---

## 5. Optional — email to devrel@terminal3.io

```
Subject: Gatekeeper (Superteam round 3) — SDK 3.5.2 no longer works against testnet

Hi Terminal 3 team,

Submitting Gatekeeper for the "build a trusted agent" bounty:
github.com/PugarHuda/t3-gatekeeper-agent

One thing worth raising outside the bug list, because it affects everyone who
followed the previous docs and not just me: the node has stopped accepting
@terminal3/t3n-sdk 3.5.2. getUsage() returns

  400 token.get-usage: request params must be sealed to this session key
  request_id 2901523a-450d-4a04-b9c5-b0748a855d65

while the identical call on 5.1.0 succeeds. The error reads as a caller mistake,
there's no unsupported-version signal, and the docs changelog says there is no
SDK release history yet — so there's nowhere to look up what changed. A
minimum-version line on the Quickstart would cover it.

The migration itself was two lines, for whoever asks next:
  - add trustAnchor: await fetchTrustedManifest("testnet")
  - rename getScriptVersion -> getContractVersion

Also: thank you for the fixes. token balance works, org-owned agents work now
that the node is on tee:organisation/contracts 0.17.0, setEnvironment("sandbox")
is accepted, and the version-shadowing warning we reported in June is in the
docs. Four of our reports closed since August — the full ledger with today's
status is at submission/BUGS.md in the repo.

Thanks!
```
