# X posts — paste-ready

The submission form has a Tweet Link field. Post one of these, then paste the
tweet URL into the form.

Tag: **@Terminal3io** · **@SuperteamEarn** (verify both handles before posting —
I have not confirmed them).

---

## Option A — single tweet (recommended)

The hook is the security finding, not the feature list. It is concrete, it is
verifiable, and it is the part a reader can't get anywhere else.

```
Built an AI agent that can spend your money — without being trusted with it.

A private-credit fund can only sell to accredited investors. Today that means
storing everyone's passport. Here the fund learns exactly one fact — "this buyer
is accredited" — as a zero-knowledge proof.

The spending mandate lives inside a TEE, so the agent can't widen its own limits:
the decision and the outbound order are the same enclave call.

Auditing my own contract for this, I found 3 ways the gate could be bypassed —
including one where the agent supplied the very limits it was judged against.
All fixed.

Rust → WASM on @Terminal3io, 321 tests, 29 bugs reported.

https://gatekeeper-evidence.vercel.app
```

*(~890 characters — fits in a single premium post. For the 280-char limit, use
Option B.)*

---

## Option B — 280-character version

```
An AI agent that can spend your money, without being trusted with it.

Fund learns one fact — "buyer is accredited" — as a ZK proof. Mandate is enforced
inside a TEE, so the agent can't raise its own limit.

Rust→WASM on @Terminal3io · 321 tests · 29 bugs found

https://gatekeeper-evidence.vercel.app
```

---

## Option C — thread (best reach)

**1/**
```
Built an AI agent that can spend your money — without being trusted with it.

Rust → WASM contract running in a TEE on @Terminal3io.

Here's the problem it solves, and the 3 security holes I found in my own code
along the way. 🧵
```

**2/**
```
A private-credit fund is legally barred from selling to non-accredited investors.

So today every buyer uploads a passport, bank statements, a net-worth letter —
and the fund stores all of it.

A compliance cost on the way in. A breach liability forever after. To answer one
yes/no question.
```

**3/**
```
Now the investor delegates buying to an AI agent, and two things break:

→ the agent needs their account credentials, so a prompt injection spends real money
→ the limits live in the agent's own prompt — the exact thing that can't be trusted
  to enforce them
```

**4/**
```
Gatekeeper:

The fund learns ONE fact — "this buyer is accredited" — proven by a BBS+
zero-knowledge proof. Never the net worth behind it.

The mandate lives in the enclave's key-value store. The agent cannot read it,
cannot widen it, cannot skip it.
```

**5/**
```
Then I audited my own contract and found 3 ways to bypass the gate:

1. it accepted an inline mandate — the agent supplied the limits it was judged against
2. decide and dispatch were separate calls — the agent could just skip the first
3. the velocity window was caller-supplied — rename it, counter resets

All fixed.
```

**6/**
```
A 4th, found later: the gate trusted ANY credential issuer.

A BBS+ signature proves the issuer signed the claim. It says nothing about
whether that issuer is anyone the fund trusts — and the agent generates its own
issuer key.

So it could mint its own "accredited investor" credential. Fixed.
```

**7/**
```
82 automated tests — 28 Rust, 33 Node, 21 Playwright.

Mostly wrong paths. A gate that only proves it says yes is worthless: over the
cap, disallowed asset, unlisted payee, expired mandate, self-issued credential,
and an unconfigured mandate that must deny by default.
```

**8/**
```
Also filed 29 bugs and doc gaps to @Terminal3io with repro steps, incl. one
security issue: redactSecrets() redacts `private_key` but NOT `privateKey` —
the ordinary camelCase spelling. `mnemonic` and `seed` aren't covered at all.

A redaction helper should fail closed.
```

**9/**
```
Evidence, screenshots, and every command run for real:
https://gatekeeper-evidence.vercel.app

Code:
https://github.com/PugarHuda/t3-gatekeeper-agent

Built for the @SuperteamEarn × @Terminal3io bounty.
```

---

## Notes before posting

- **Verify the handles.** I have not confirmed `@Terminal3io` or `@SuperteamEarn`
  are the correct accounts — check them, a wrong tag is worse than no tag.
- Attach `submission/screenshots/out/05-full-flow.png` (the full run) or
  `13-qa-console-self-issued.png` (the attack being refused) to post 1 — a
  terminal screenshot performs better than a link preview.
- Version claims are safe now: **v0.10.0 is live** as `contract_id 749`. The
  posts above still avoid naming a version, which needs no maintenance.
- **The post that actually went out** (28 Aug,
  https://x.com/BangDropID/status/2092653732848976141) says *277 tests* — true
  when posted, 321 today. It is not worth editing a live post over; the drafts
  above carry the current number for any repost.
