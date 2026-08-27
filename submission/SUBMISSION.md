# Gatekeeper — an enterprise agent that cannot spend outside its mandate

**Superteam Earn × Terminal 3 — "Try out new docs to build a trusted agent with T3N that we can distribute / host"**

| | |
| --- | --- |
| Author | Pugar Huda |
| Agent DID | `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f` |
| Public repo | https://github.com/PugarHuda/t3-gatekeeper-agent |
| Evidence site | https://gatekeeper-evidence.vercel.app |
| Network | T3N testnet (`https://cn-api.sg.testnet.t3n.terminal3.io`) |
| SDK | `@terminal3/t3n-sdk` **5.1.0** (migrated from 3.5.2 for this round) |
| Verified on | 27 August 2026 |
| **Post-challenge** | **Happy to hand it over to Terminal 3 — see §5** |

---

## 0. What this is

An AI agent buys tokenised private-credit notes for an investor, and **cannot**
place an order outside the limits its owner set — not because it promises not
to, but because the limits are enforced by a Rust contract running in a TDX
enclave that the agent has no way to write to.

This is a returning project. It placed 2nd in the previous Terminal 3 round, and
this submission is not a re-paste of that one. What is new here is aimed
squarely at what the sponsor asked for this time — *usefulness and ease of
maintenance after the challenge ends*:

| New this round | Why it matters to whoever runs this next |
| --- | --- |
| Migrated 3.5.2 → **5.1.0** | The old pin no longer talks to the node at all (bug #19) |
| **Broker credential moved into the enclave** | The agent can no longer leak a key it never holds |
| **Credential bound to the action, in-enclave** | Closes the gap where a verification done for one action could pay for another |
| **Idempotent dispatch** | A timed-out order can be retried without becoming two orders |
| **Revocation that actually runs** | W3C Bitstring Status List, published and checked over HTTPS — no chain, no gas |
| **ERC-8004 live** | Real reads against the reference registry, and a preflight that refuses to mint against the wrong contract |
| **A2A discovery** | The card is published at the well-known path; a peer needs only the domain |
| **Audit ledger read back** | The host's record, reconciled against the agent's own account of events |
| **Served over MCP** | The gate stops being a repo you clone. One line of config and any MCP host has it — and the offline tools need no Terminal 3 account at all |
| **x402 payments, mandate-gated** | An HTTP 402 becomes an action the mandate judges. A price or a payee outside it is refused *before* a signature exists |
| **Probe before promote** | `npm run probe` registers to a throwaway tail and invokes it, so a build that would brick the production tail is caught for the price of one registration |
| **`node verify.mjs`** — one command | Prove the repo is healthy with no key, no network, no credits. It prints its own total |
| **MAINTENANCE.md** | Every knob, the real failure modes, a handover sequence |
| Version single-sourced; CI runs the same script | Two classes of drift removed rather than documented |
| **23 bug reports**, each re-verified | Including 4 of ours that Terminal 3 has since fixed, and two new ones found by shipping: a credential the SDK cannot make revocable, and a rate limit smaller than the demo |
| **Metering measured, not guessed** | 30,034,055 credits a call; 1,370,147,045 a registration. Nothing publishes these |

| Bounty requirement | Where |
| --- | --- |
| Sign up via SSO, obtain DID & API key | §1 |
| Complete the Quickstart | §2 · shot 01 |
| Complete the Walkthrough (write/build/register/invoke/test) | §3 · shots 03, 07 |
| Build an enterprise agent, useful and maintainable | §4, §6 |
| Say whether you will keep running it, and how handover works | **§5** |
| Screenshots | §9 — 23, every one from real command output |
| Bugs faced | §8 — 23 reports, [full ledger](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/submission/BUGS.md) |

Every screenshot is produced by `submission/screenshots/capture.mjs`, which runs
each command for real and renders its actual stdout and stderr — including the
failures. Nothing is retyped. The raw `.txt` sits beside every `.png`.

---

## 1. Identity and credits

Claimed through the ADK community link. The DID is stable across re-claims; each
new API key derives its own Ethereum address but authenticates to the same DID.

- DID: `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f`
- Derived address for the current key: `0x548a66377d7f34902ce08e5b060b8d6d1a24fe14`
- **Balance: 0, `credit_exhausted: true`** — see §10. One contract registration
  consumed the entire grant, which is bug #16 and is the reason two things in
  this submission are marked "built, not yet live".

📷 **Screenshot 02 — `02-cli-whoami.png`** · 📷 **Screenshot 04 — `04-agent-registered.png`** — the network resolving our DID, and the agent card registered on-network.

---

## 2. Quickstart on the refreshed docs

The new Quickstart runs **verbatim** on 5.1.0. Copy-paste, `npx tsx`, done — no
edits, no missing steps. That is worth saying plainly, because the rest of §7 is
about what broke, and the entry path itself is now clean.

📷 **Screenshot 01 — `01-quickstart-auth.png`**

```
environment: "testnet"
derived eth address: 0x548a66377d7f34902ce08e5b060b8d6d1a24fe14
WASM loaded ✅   handshake ✅   authenticate ✅
{"value":"did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f"}
getUsage ✅: {"balance":{"available":0,...,"credit_exhausted":true}}

RESULT: live testnet auth WORKS ✅
```

Source: `t3-qa/auth-test.mjs`.

---

## 3. The walkthrough — a real Rust TEE contract

Not a hello-world. `gate-contract/` is a mandate-enforcement contract compiled to
`wasm32-wasip2`, ~215 KB.

**What it enforces inside the enclave:** an amount cap, allowed assets, allowed
action kinds, a counterparty allow-list, per-counterparty sub-limits, trusted
credential issuers, a validity window, an expiry, and a cumulative velocity limit
held in the contract's own KV map. Deny-by-default throughout — an empty mandate
approves nothing.

| Step | Result |
| --- | --- |
| Write | `gate-contract/src/gate.rs` — 32 Rust unit tests |
| Build | `cargo build --lib --target wasm32-wasip2 --release` → 215 KB component (bug #5 covers the Windows blocker and the fix) |
| Register | `TenantClient.contracts.register()` → v0.6.0 = id 175, v0.7.0 = id 479 |
| Invoke | `contracts.execute("gate", …)` → approved/rejected, decided inside the TEE |
| Test | 32 Rust + 40 Node + 13 Playwright, all green |

📷 **Screenshot 03 — `03-contract-deployed.png`** — live on the network, checkable without my key.

Anyone can confirm:

```
npx @terminal3/t3n-sdk contract get z:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f:gate --env testnet
```

---

## 4. The use case, concretely

**Meridian Private Credit Fund** sells a note with a $250,000 minimum. Securities
law lets them sell only to accredited investors, so today every buyer uploads a
passport, bank statements and a net-worth attestation, and Meridian stores all of
it. That is a compliance cost on the way in and a breach liability forever after:
they become custodian of a data set they never wanted, to answer one yes/no
question.

Now the investor delegates the buying to an AI agent, and two things break at
once. The agent needs account credentials, so a prompt injection spends real
money. And the limits — $5,000 a trade, USDC only, this fund only — live in the
agent's prompt or its own code, which is exactly the thing that cannot be trusted
to enforce them.

Gatekeeper answers both:

- Meridian learns **one fact** — this buyer is accredited — proven by a BBS+
  zero-knowledge proof. Not the net worth behind it, not the name, not the DOB.
- The mandate lives in the **enclave's** key-value store. The agent cannot widen
  its own ceiling, the decision and the outbound order are the same enclave
  invocation, and a rejected action never reaches the network.

**Who this is for:** tokenised RWA and private-credit distribution platforms, and
the treasury or wealth agents transacting with them. It maps to T3's
"Permissioned DeFi / RWA" area, using accredited-investor proof as an
authorization gate rather than a form-filling exercise.

The chain, all on the ADK:

```
[1]  IDENTITY    handshake + authenticate               → did:t3n
[2]  VC GATE     BBS+ credential verify                 → eligible, no PII revealed
[2b] REVOCATION  on-chain kill-switch (revoke_vc)       → blocks a revoked holder
[3]  MANDATE     execute_action, mandate read from KV   → TEE decision + reasons
[4]  AUDIT       structured row per action              → approved AND rejected
[5]  DISPATCH    Web Bot Auth signature + in-TEE POST   → HTTP 200 from the enclave
```

📷 **Screenshot 06 — `06-egress-grant.png`** — `agent-auth-update` accepted. A
contract's outbound HTTP is authorised by the **caller**, scoped to contract,
functions and destination hosts. With the grant the enclave's POST completes
(HTTP 200); without it the same call returns a typed `host/http.egress_denied`.

📷 **Screenshot 05 — `05-full-flow.png`** — six scenarios in one run: an approved
buy that really dispatches, an over-mandate buy rejected, a disallowed asset and
kind rejected, an approved counterparty, an unknown counterparty rejected, and a
future-dated mandate rejected — each with the enclave's own reason strings.

### 4.1 Closing the gap the enclave could not close before

The honest weakness in the previous submission was this: the enclave checked the
credential's issuer against `allowed_issuers`, but the issuer was a field the
caller set, sitting next to a claim of "yes, I verified a credential" that was
bound to nothing at all. An agent could verify a credential for a $500 purchase
and then submit a $500,000 one.

The agent now commits, **before the decision**, to which credential it verified
and which action it verified it for — issuer, subject, claims digest, action
digest, nonce. The enclave recomputes that commitment from the action it is
actually about to perform, using SHA-256 compiled into the component, so it
needs no host interface and works on a node that does not serve `vp`. A mismatch
is a rejection carried in the reasons array. A mandate can require a binding, so
omitting the field stops being the way around the check, and the issuer the
mandate is tested against must be the one inside the commitment.

**What this does not do**, because the distinction is the whole point: it does
not prove the BBS+ proof was valid. A dishonest agent can still commit to a
credential it never checked. Closing that needs in-contract `vp.verify`, which
this node does not serve (bug #7). What is gone is the ability to detach a real
verification from what it authorised.

The scheme exists in JavaScript and in Rust, which is how these things quietly
become two schemes that each verify only against themselves. So the test suite
runs the **compiled Rust** and asserts the two agree on every digest and
commitment.

📷 **Screenshot 19 — `19-qa-console-binding-moved.png`** — a real credential,
verified for $500, refused when spent on $4,000.

### 4.2 A retry must not become a second order

If the enclave's outbound call times out, the order may already have executed
upstream, and both answers are wrong: retrying risks a duplicate, giving up
risks none. `execute_action` takes a caller-chosen idempotency key, records the
outcome under it, and returns that recorded outcome on a repeat rather than
dialling out again. The mandate can require one, because on a path that moves
money the ambiguity is not acceptable.

The record is written *after* the call, deliberately: a crash mid-flight leaves
no record and the retry goes out. A visible possible-duplicate beats a silent
"already done" for an order that never happened.

### 4.3 Revocation that runs today

The old revocation gate called T3's `revoke_vc` against an on-chain registry.
The code was right and it did nothing, because no registry is deployed — it
failed open. Deploying one needs a funded wallet.

**W3C Bitstring Status List v1.0** needs no chain. Revocation state is a gzipped
bitstring published inside a credential over HTTPS; a verifier fetches it and
reads one bit. Ours is generated, verified by reading it straight back, and
published: 131,072 entries in 556 bytes. That length is the spec's minimum and
it is a privacy floor — every holder is one bit among 131,072, so an issuer
watching fetches learns nothing about who is transacting.

Index 7 is revoked on purpose. A check that has only ever returned "fine" has
not been shown to work, so the demo issues a credential at that index and prints
the blocked case beside the passing one.

📷 **Screenshot 18 — `18-status-list.png`**

### 4.4 ERC-8004, actually connected

Previously this was a script with the right ABI that had never been pointed at a
registry. The reference deployment is live on Sepolia at
`0x7177a686…`, and the read side works today with **no wallet and no gas**:
resolve any agent's owner and URI, and check whether an address owns one (ours
does not — a mint needs funding, and the script still refuses rather than
faking it).

The preflight is the part worth having. `register()` against the wrong address
either reverts and wastes the fee, or succeeds against some unrelated ERC-721
and mints a token that is not an agent identity, with nothing to notice. It
checks that code is deployed, that `name()` looks like a registry, and that the
selector `0xf2c298be` is present in the bytecode — verified against the real
chain, including against Sepolia WETH, which it correctly refuses.

📷 **Screenshot 16 — `16-erc8004-live.png`**

### 4.5 The audit trail is no longer just our word for it

The agent prints a structured row per action — which is the *agent's* account of
events, exactly the thing this project argues you should not have to take on
faith. `audit.get-mine` returns the host's record of the same dispatches, and it
works at a zero balance.

The field that makes it worth reading is `committed`. An event can carry
`outcome: "success"` inside a batch that never committed — the call said it
worked and then rolled back. The reconciliation keeps those apart and
corroborates a dispatch only against committed events.

📷 **Screenshot 17 — `17-audit-ledger.png`**

### 4.6 The broker credential never touches the agent

Until this round the outbound order went out with no `Authorization` header at
all. Pointing it at a real broker would have meant putting the broker's API key
in the agent — which contradicts the entire argument of the project, since the
agent is the component you assume is compromised.

The key now lives in `z:<tid>:secrets`, a map whose ACL names the contract as its
only reader. `npm run setup` seals it in through the control plane, which
bypasses the ACL on write, and after that there is no path back out: not for the
agent, not for the script that wrote it, not for anyone holding the tenant key.
The contract fetches it **only after** `execute_action` has approved the action.

Which secret to use is named by the **mandate**, not the request — same reasoning
as every other mandate field: the caller does not choose which credential it
spends. It also means a different operator points this at their own broker by
editing a KV entry instead of editing Rust.

A mandate that names a credential the map does not hold is an **error, not a
fallback**. Quietly dropping the header would turn a provisioning mistake into an
anonymous payment instruction at a broker. Three tests hold that rule down.

---

### 4.7 The gate, served over MCP

Everything above is only useful to someone who clones this repository. That is
not distribution, and the brief asked for an agent that can be distributed.

So the agent is now also an **MCP server**. A host adds one line:

```bash
claude mcp add gatekeeper -- node /abs/path/to/agent/src/mcp-server.mjs
```

and gets eight tools. The one that matters most is `gate_evaluate`: it answers
from `gate_cli`, the host build of the *same Rust source* the enclave runs. So a
host can ask "is this action inside the mandate?" before every action —
**offline, free, with no Terminal 3 account and no credits** — and get the
contract's real answer rather than a JavaScript approximation of it that would
agree with itself and prove nothing.

`gate_execute` is the other half, and it deliberately does not degrade. Without
credentials it says what is missing and points at `gate_evaluate`. A gate that
quietly falls back to a local guess when it cannot reach the enclave is not a
gate, and a host would never know the difference.

The test for this does not call the tool functions. It spawns the server as a
subprocess and drives it with the official MCP client over stdio, because a test
that imported the functions would prove the functions work and say nothing about
whether the server does (19 tests). One of them runs the same input through both
paths and asserts the results are identical — so if anyone ever reimplements the
rules in JS to make the server faster, it fails.

*Shot 21.* Also `npm run demo:mcp`, which is the same thing in ten seconds.

### 4.8 x402 — the mandate decides whether to pay

An agent that can pay for things can be talked into paying for the wrong things.
x402 makes that concrete: a server answers HTTP 402 with a price, and the agent
signs and retries.

The interesting question is not *can* the agent pay — it holds a key, so it can —
but *may* it, at this price, to this recipient. So the payment requirement is
mapped into an ordinary `Action` and goes through the same enclave mandate as
every trade:

| From the 402 | Becomes |
| --- | --- |
| `amount` + the asset's decimals | `amount_cents`, **rounded up** — a fraction of a cent must never round a payment *under* a cap |
| `extra.name` | `asset` |
| `payTo` | `counterparty`, so a mandate can allow-list who may be paid |
| — | `kind: "x402.pay"`, its own category |

That last row is the point. Permission to trade is not permission to spend on
APIs: a mandate that never mentions `x402.pay` refuses every paywall, because
deny-by-default already covers it. And an asset that does not declare its
decimals is **refused rather than guessed** — a wrong guess there is a spending
limit off by a factor of a hundred.

What is real: the v2 HTTP transport (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
`PAYMENT-RESPONSE`, base64 JSON), a genuine EIP-712 signature over the EIP-3009
`TransferWithAuthorization` type hash against the real Base Sepolia USDC domain,
and verification that recovers the payer with ecrecover — the same check a
facilitator's `/verify` performs, minus the balance read. The verifier compares
against the *server's own* requirement, never the one echoed back in the payload,
because that field is attacker-controlled; a test signs a one-cent authorisation,
relabels it as the ten-dollar one, and watches it get refused.

What is not real, said plainly: **settlement**. Broadcasting needs a facilitator
and a funded wallet. `settle()` posts the spec's `/settle` body when
`X402_FACILITATOR_URL` is set and **refuses** when it is not, because a receipt
this process invented would be believed by whatever read it.

28 Node tests and 6 Playwright tests, all over real HTTP against a real 402.
*Shots 20 and 22*, and `npm run demo:x402`.

## 5. After the challenge: I would rather hand this over

**I am happy for Terminal 3 to take this over and host it**, and I would keep
contributing to it. If you would prefer I keep running it, I am glad to do that
too and would apply to the startup program — but the honest recommendation is
that a reference agent belongs with the people who own the platform it
demonstrates.

Either way, the work to make that possible is already done, because "can someone
else run this?" was the design constraint this round rather than a paragraph at
the end.

**Nothing personal is in the running path.** No personal wallet, no hardcoded
DID, no committed key, no database, no cron, no background worker. Every
canonical map name is derived at runtime from `tenant_did()` inside the enclave,
so the code does not know whose tenant it is running in.

**The handover, concretely** (full version in
[MAINTENANCE.md §6](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/MAINTENANCE.md)):

1. **Tenant account** — you claim your own key and DID. It appears in
   `agent/.env` and `agent/agent-card.json`; nothing else references it.
2. **Contract** — re-register under your tenant with `npm run setup`. My
   deployment keeps running under mine; there is no shared state.
3. **Mandate** — edit `MANDATE` in `agent/src/lib.mjs` or write the KV entry
   directly. This is the only business config, and it is JSON.
4. **Broker credential** — set `BROKER_API_KEY`, run setup once. My key is
   unreadable to you and yours to me: the map's ACL names a contract id, and
   yours is new.
5. **Web Bot Auth key** — generate a fresh one, publish the JWKS, update the
   agent card. Until then outbound signatures verify against nobody.
6. **Evidence site** — `site/` is static; `npx vercel deploy --prod`. Not
   load-bearing except for the JWKS in step 5.

Run `node verify.mjs` before and after. If it passes, the logic is intact and
anything still wrong is environmental — and §5 of MAINTENANCE.md lists those
five environmental failures with their fixes.

---

## 6. Ease of maintenance, as actual changes

The sponsor called this the very important criterion, so it is worth showing
what changed rather than asserting a property.

**One command tells you if it works.**

```bash
node verify.mjs
```

Rust unit tests → wasm component build → Node tests → Playwright end-to-end over
the *real* Rust decision function. 220 checks, no API key, no network, no credits.
It selects the GNU toolchain automatically on Windows, which is otherwise a
documented footgun a newcomer hits on their first build.

📷 **Screenshot 07 — `07-tests.png`**

**CI runs that same script**, so CI and a developer's machine cannot drift into
disagreeing about what "the checks" are. The Playwright stage skips itself in CI
— `qa-console/node_modules` is a local junction that does not exist on a fresh
checkout — and it prints SKIP rather than quietly passing.

**The contract version is single-sourced.** It used to be typed in three files
that had to agree: `Cargo.toml`, `lib.rs`, and the agent's `lib.mjs`. Shipping
0.9.0 meant editing all three, which is the moment to notice. Rust now reads
`env!("CARGO_PKG_VERSION")` and the agent parses the same `Cargo.toml`. The
failure mode this prevents — a contract registered under a number that is not the
code inside it — is now impossible rather than merely unlikely.

**`setup.mjs` got shorter while gaining a feature.** It had three copies of
create-map-then-fix-the-ACL and needed a fourth for the secrets map. It now has
one `ensureMap`, and the file is shorter with the new map in it than it was
without.

**MAINTENANCE.md** is the operator's document: every configuration knob and what
its absence means, the five things that actually go wrong with the fix for each,
and the handover sequence. Two defaults are called out as deliberately
unsafe-looking rather than left to be discovered — an empty `TRUSTED_ISSUERS`
accepts a credential the agent minted itself, and an unset revocation registry
lets a revoked investor through. Both are opt-in because the demo has no real KYC
issuer, and a production operator must set both.

---

## 7. Trying the refreshed docs

The docs are visibly better than in June: the ADK Tour and Agent Auth pages are
filled in, Common Errors has real triage guidance, and there is now a Reference
and a Changelog. The **`outbound-http-auth-by-user`** tip is the single most
useful page in the set — it is what turned my last blocked feature into a working
one, because it explains that a contract's egress is authorised by the *caller*,
not the contract.

I also want to flag something good: the Changelog entry for 6 July adds "a
warning about contract version-shadowing on re-registration". **That is bug #8
from my June report, adopted into the docs.** Seeing a report land is a strong
reason to keep filing them.

What broke, and it is the one thing I would most like fixed:

**The node no longer talks to the SDK version the previous docs shipped.** On
3.5.2, `getUsage()` now returns:

```
HTTP 400 {"code":"bad_request",
 "detail":"token.get-usage: request params must be sealed to this session key",
 "request_id":"2901523a-450d-4a04-b9c5-b0748a855d65"}
```

The same call on 5.1.0 succeeds, same key, same node, same second. The error
reads like the caller's mistake, there is no "unsupported version" signal, and
the Changelog states outright that no SDK release history exists — so there is
nowhere to look up what changed. That is bug #19.

Migrating then surfaced bug #20: `trustAnchor` is a required constructor field
from 5.x. The change is correct and its error message is genuinely good, but it
never names `fetchTrustedManifest()` — the one-line fix, exported from the same
module — and nothing says which version introduced it.

📷 **Screenshot 14 — `14-bug-trust-anchor.png`** — both constructor forms against
the same installed SDK. Repro: `node t3-qa/trust-anchor-probe.mjs`, offline.

For the next person, the whole migration was: add
`trustAnchor: await fetchTrustedManifest("testnet")`, rename `getScriptVersion`
to `getContractVersion`. Two lines. Finding those two lines took the afternoon.

---

## 8. Bugs — 23 reports, each re-verified today

The full ledger with repro steps and request IDs:
**[submission/BUGS.md](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/submission/BUGS.md)**

Rather than re-paste eighteen old reports, I re-checked every one of them against
5.1.0 and the refreshed docs. Some were no longer true, and citing a fixed bug is
worse than citing none.

**Fixed since my last report — thank you:**

| # | Was | Now |
| --- | --- | --- |
| 9 | `t3n token balance` / `token usage` always failed | ✅ returns a real row |
| 12 | Org-owned agents impossible — node ran `tee:organisation/contracts` 0.4.1 | ✅ node is on **0.17.0**; `agent create --org` succeeded end to end |
| 14 | `setEnvironment("sandbox")` threw | ✅ `sandbox` aliases testnet |
| 11 | Documented `agent host-card` failed `NotScopeWriter` | ✅ scope error gone; now only credits |
| 8 | Version shadowing on re-registration undocumented | ✅ warning added to the docs (the no-`contract_id`-API half still stands) |

📷 **Screenshot 08 — `08-bug-token-balance.png`** · 📷 **Screenshot 10 — `10-bug-node-version.png`** · 📷 **Screenshot 09 — `09-bug-host-card.png`**

**Still reproducing, checked 26 Aug:** #1 the BBS+ verifier still interpolates an
unset field into `"verification failed: undefined"`; #2 `getNodeUrl("testnet")`
still returns the string `"testnet"` while `NODE_URLS` in the same module holds
the right value; #3 still no holder-side derive — `makeBBSPlusW3cProof` takes a
private key and lives in `issueBbsVc.ts`, so it is issuance, not disclosure; #4
the referenced onboarding repo is still empty, last pushed 6 June; #5, #10,
#13, #16, #17, #18.

**New this round:**

- **#19 — the node dropped support for the SDK the old docs shipped**, silently
  (above). Highest impact of the three: it breaks existing integrations and gives
  them nothing to search for.
- **#20 — `trustAnchor` required from 5.x**, with no migration note (above).
- **#21 — metering is inconsistent and unpublished.** At a balance of exactly
  zero, `agent create --org` minted a DID, issued an API key and hosted a card —
  three writes, free. In the same session `agent card-publish` and
  `agent host-card` demanded `required=10000000000`, roughly **6.7× the entire
  initial grant**. There is no price list, no pre-flight estimate, and because
  `getUsage().entries` is empty (#17) no way to see afterwards what was charged.

📷 **Screenshot 15 — `15-bug-metering.png`**

### 8.1 And four in my own contract

Auditing my own work turned up four real weaknesses. All are fixed:

1. **The mandate was forgeable.** `evaluate` accepted an inline mandate and the
   demo passed one — the agent supplied the limits it was judged against. The KV
   path existed but was never exercised. `execute_action` reads from KV with no
   inline escape hatch.
2. **The gate was skippable.** `evaluate` and `dispatch_action` were separate
   calls and nothing in dispatch knew a mandate existed, so an agent could just
   not call `evaluate`. The gate was advisory. `execute_action` makes the
   decision and the outbound call one invocation.
3. **The velocity window was caller-supplied.** Pass a fresh string, the counter
   resets. It is now derived from the cluster clock inside the enclave.
4. **The gate trusted any issuer.** A BBS+ signature proves the issuer signed —
   never that the issuer is anyone the fund trusts. Since the agent generates its
   own issuer key in the demo, it could mint its own accreditation and pass. The
   mandate now carries `allowed_issuers`.

The first two mean the pre-0.7.0 mandate held only while the agent cooperated,
which is precisely the assumption this project exists to remove.

---

## 9. Evidence

### The wrong paths matter more than the happy one

A gate that only proves it says yes is worthless. `qa-console/` is a browser
console driven by Playwright that runs the contract's **real Rust `decide()`** via
a host build — the rules are never reimplemented in JavaScript, because a JS copy
would drift from the contract and prove nothing.

📷 **Screenshot 11 — `11-qa-console-approved.png`** · 📷 **Screenshot 12 — `12-qa-console-rejected.png`** · 📷 **Screenshot 13 — `13-qa-console-self-issued.png`**

| Path | Case | Asserted |
| --- | --- | --- |
| Happy | in-mandate purchase | approved, no reasons attached |
| Happy | credential from a trusted issuer | approved |
| Wrong | **self-issued credential** | rejected — not trusted |
| Wrong | payee sub-limit under the global cap | rejected — per-counterparty limit |
| Wrong | over the cap | rejected, names the ceiling |
| Wrong | disallowed asset + kind | **both** failures reported, not just the first |
| Wrong | unlisted counterparty | rejected, names the payee |
| Wrong | expired mandate | rejected |
| Wrong | unconfigured mandate | denies by default — the fail-closed guarantee |
| Abuse | malformed JSON / missing action / unknown route | 400 / 400 / 404, no crash |
| Abuse | negative amount | must not approve — no unsigned wrap past the cap |
| Credential | mandate names a secret the map lacks | **errors — does not send unauthenticated** |

**`node verify.mjs` reports its own total — 220 offline checks** at the time of
writing (47 Rust, 96 Node, 18 Playwright end-to-end), plus the live-site and
submission-artifact suites. The number comes from the runners rather than from
this sentence, because every hand-written count in this repo has been wrong
within a day of being written. The live-site set
includes a Web Bot Auth key round trip over the public internet — sign locally,
fetch the public key from
`/.well-known/http-message-signatures-directory`, verify — with nothing shared in
advance, which is the entire point of a key directory.

### Screenshot index

All in `submission/screenshots/out/`, each with the raw `.txt` it was rendered
from, and republished with captions at https://gatekeeper-evidence.vercel.app.

| # | File | Shows |
| --- | --- | --- |
| 01 | `01-quickstart-auth.png` | Quickstart on 5.1.0 — trustAnchor → handshake → authenticate → getUsage, live |
| 02 | `02-cli-whoami.png` | the network returning our Agent DID |
| 03 | `03-contract-deployed.png` | our Rust TEE contract live at 0.10.0 — and bug #8, the id field echoing the name back |
| 04 | `04-agent-registered.png` | Agent ID registered — and bug #10, the address as a decimal array |
| 05 | `05-full-flow.png` | the whole agent on 0.10.0: VC gate → TEE mandate → audit → in-TEE dispatch (**HTTP 200**) |
| 06 | `06-egress-grant.png` | `agent-auth-update` — the caller authorising enclave egress |
| 07 | `07-tests.png` | `node verify.mjs` — 220 checks, no key, no credits |
| 08 | `08-bug-token-balance.png` | bug #9 **fixed** |
| 09 | `09-bug-host-card.png` | bug #11 — no longer `NotScopeWriter` |
| 10 | `10-bug-node-version.png` | bug #12 **fixed** — node on 0.17.0 |
| 11 | `11-qa-console-approved.png` | QA happy path |
| 12 | `12-qa-console-rejected.png` | QA wrong path — unlisted payee refused by name |
| 13 | `13-qa-console-self-issued.png` | QA wrong path — a self-issued credential refused |
| 14 | `14-bug-trust-anchor.png` | bug #20 — both constructor forms, same SDK |
| 15 | `15-bug-metering.png` | bug #21 — publishing a card costs 6.7× a full grant |
| 16 | `16-erc8004-live.png` | ERC-8004 live reads + mint preflight, no wallet, no gas |
| 17 | `17-audit-ledger.png` | `audit.get-mine` — the host's own record, read back |
| 18 | `18-status-list.png` | the published W3C revocation list, 131,072 entries |
| 19 | `19-qa-console-binding-moved.png` | a credential verified for $500, refused on $4,000 |
| 20 | `20-qa-console-x402-paid.png` | the console paying a real 402, with the payee recovered from the signature |
| 21 | `21-mcp-server.png` | the gate over MCP — a real client, a real subprocess, eight tools, no account |
| 22 | `22-x402-mandated-payment.png` | x402 — one payment made, three refused before anything was signed |
| 23 | `23-probe-before-promote.png` | the build proven under a throwaway tail before production points at it |

Shots 05 and 06 were **re-captured live on 2026-08-27** against gate@0.10.0,
once the account was topped up — so the working flow in shot 05 is the current
contract, not a remembered one. It also shows the revocation pre-gate doing
something for the first time: a control credential at the list index we publish
as revoked comes back **REVOKED and blocked**, next to a healthy one that does
not. Until the status list was actually served, that check could only report
"not checked", which is what it correctly did.

Everything above is live at https://gatekeeper-evidence.vercel.app — all 23
shots, the A2A agent card, the Web Bot Auth key directory and the revocation
status list. `capture.mjs` syncs the PNGs into `site/shots/` itself, and
`npm run status-list` republishes the agent card, so neither is a manual step to
forget.

---

## 10. Honest status

I would rather state this than imply a live run I did not do.

| | |
| --- | --- |
| **On the network now** | **v0.10.0, `contract_id 749`**, registered 2026-08-27 |
| **Proven live** | the KV mandate read, the credential/action binding, idempotent dispatch, in-enclave outbound HTTP (**200**), and `http-with-placeholders` — which until this week had only ever been compiled in |
| **Also live** | the evidence site, the A2A agent card, the Web Bot Auth key directory and the W3C revocation status list — every live assertion in the suite passes (17/17) |
| **Still not live** | the ERC-8004 mint (needs a gas-funded wallet) and x402 settlement (needs a facilitator and a funded stablecoin wallet). Both refuse to run unconfigured rather than faking it |

An earlier draft of this section said v0.9.0 was built but unregistered because
the balance was zero. A top-up landed on 2026-08-27, so that is no longer true
and the live evidence in §9 is from this week.

Getting there taught the two newest bug reports. The build was promoted only
after `npm run probe` registered it to a throwaway tail and invoked it — which
is how we learned the node really does serve `http-with-placeholders`, rather
than assuming it. And the first funded run of the demo failed at the eligibility
gate with `verify=false`, because the status-list work written during the
credit outage had been attaching `credentialStatus` *after* signing; the SDK
offers no way to sign one at all (bug #22). Code written while it cannot be run
is code that has not been tested, and this is what that costs.

A full inventory of what is shipped, what is deliberately shallow, and what is
worth building next is in
[STATUS_AND_ROADMAP.md](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/submission/STATUS_AND_ROADMAP.md).
The biggest remaining correctness gap, stated plainly: the enclave can prove the
agent committed to a specific credential for *this* action (§4.1), but not that
the underlying BBS+ proof was ever valid. Closing that needs in-contract
`vp.verify`, which the node does not serve (bug #7).

---

## 11. Reproduce it yourself

No key needed:

```bash
npx @terminal3/t3n-sdk contract get z:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f:gate --env testnet
npx @terminal3/t3n-sdk agent registry did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f --env testnet
```

No key, no credits, no network — the whole test suite:

```bash
git clone https://github.com/PugarHuda/t3-gatekeeper-agent
cd t3-gatekeeper-agent/agent && npm ci && cd ..
node verify.mjs                  # 220 checks
```

With your own key:

```bash
cp agent/.env.example agent/.env          # T3N_API_KEY + DID
cd gate-contract && cargo build --lib --target wasm32-wasip2 --release && cd ../agent
npm run setup                             # register + create and seed the 3 KV maps
npm run grant:egress                      # authorise the enclave's outbound host
npm run demo                              # the full chain
```

---

Repo: https://github.com/PugarHuda/t3-gatekeeper-agent ·
Evidence: https://gatekeeper-evidence.vercel.app ·
Maintenance & handover: [MAINTENANCE.md](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/MAINTENANCE.md)
