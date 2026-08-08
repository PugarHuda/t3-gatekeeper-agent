# Terminal 3 ADK — Agent ID, test credits & first Rust contract

**Superteam Earn bounty submission — "Create Agent ID, claim free tokens, & deploy first RUST contract on the network" (LOL ventures)**

| | |
| --- | --- |
| Author | Pugar Huda |
| Agent DID | `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f` |
| Public repo | https://github.com/PugarHuda/t3-gatekeeper-agent |
| Evidence site | https://gatekeeper-evidence.vercel.app |
| Demo video | https://youtu.be/gVY3y4j6XT4 |
| Network | T3N **testnet** (`https://cn-api.sg.testnet.t3n.terminal3.io`) |
| Verified on | 7–8 August 2026 |

---

## 0. Summary

Every required step is complete, and then some. I claimed an Agent ID and test
credits, finished the Quickstart, walked the full contract lifecycle
(write → build → register → invoke → test) with a **Rust → WASM contract that is
live on the network right now**, registered the Agent ID on-network, and went
well past "first contract" into a working use case: an agent that can only act
after a verifiable-credential eligibility check and a hardware-enforced spending
mandate.

| Bounty requirement | Status | Evidence |
| --- | --- | --- |
| Sign up via SSO, get ID + API key | ✅ | §1 |
| Complete **Quickstart** | ✅ | §2 · screenshot 01 |
| Complete **Walkthrough** (write/build/register/invoke/test contract) | ✅ | §3 · screenshots 03, 05 |
| Agent Auth + register an Agent ID | ✅ | §4 · screenshots 02, 04 |
| Screenshot completion | ✅ | §7 — 13 screenshots, all from real command output |
| Highlight bugs | ✅ | §6 — **18 issues**, each with repro steps and request IDs |
| **Bonus:** go beyond the first contract, provide a use case | ✅ | §5 |
| **Bonus:** QA — happy path & wrong paths under Playwright | ✅ | §5.1 — 82 automated tests |

All 13 screenshots were produced by
[`submission/screenshots/capture.mjs`](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/submission/screenshots/capture.mjs),
which **executes each command for real** and renders its actual stdout/stderr —
including the failures. Nothing is hand-typed transcript; the raw `.txt` capture
sits next to every `.png`.

---

## 1. Agent ID and test credits

Signed up through the ADK community link, which issued the API key and DID on the
success page (shown once). The DID is stable across re-claims — I re-claimed on
7 Aug 2026 and got the **same DID** back with a **different** API key, and each
key derives its own Ethereum address while authenticating to that same DID.

- DID: `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f`
- Derived address for the current key: `0x548a66377d7f34902ce08e5b060b8d6d1a24fe14`
- Credits on the current key: `1,487,000,000` available

> ⚠️ Note for the sponsor: a re-claim for the same Google account returns the same
> DID and does **not** top the balance up. Also, the units changed — in June this
> field read `20000`, it now reads `1487000000` for the same kind of account.

---

## 2. Quickstart — one authenticated call

`setEnvironment` → `loadWasmComponent` → `T3nClient` → `handshake()` →
`authenticate()` → `getUsage()`, run live against testnet.

📷 **Screenshot 01 — `01-quickstart-auth.png`**

```
environment: "testnet"
derived eth address: 0x548a66377d7f34902ce08e5b060b8d6d1a24fe14
loading WASM component...
WASM loaded ✅
handshake ✅
authenticate ✅ {"value":"did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f"}
getUsage ✅: {"balance":{"available":1487000000,...}}

RESULT: live testnet auth WORKS ✅
```

Source: [`t3-qa/auth-test.mjs`](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/t3-qa/auth-test.mjs).
Two issues found here — see bugs **#14** (`setEnvironment("sandbox")` from the
docs throws) and **#2** (`getNodeUrl`).

---

## 3. Walkthrough — the Rust TEE contract

I wrote a real mandate-enforcement contract rather than a hello-world:
[`gate-contract/`](https://github.com/PugarHuda/t3-gatekeeper-agent/tree/master/gate-contract),
Rust → `wasm32-wasip2` component, ~213 KB.

**What it enforces inside the enclave** — amount cap, allowed assets, allowed
action kinds, a counterparty allow-list, a valid-after window, expiry, and a
*stateful* cumulative velocity limit held in the contract's own KV map (so the
agent cannot reset its own counter between calls). Deny-by-default throughout:
an empty mandate rejects.

| Step | Result |
| --- | --- |
| Write | `gate-contract/src/gate.rs`, 28 Rust unit tests |
| Build | `cargo build --lib --target wasm32-wasip2 --release` → 213 KB wasm **component** (`0d 00 01 00` magic) — see bug **#5** for the Windows blocker + the fix that worked |
| Register | `TenantClient.contracts.register({tail,version,wasm})` → **v0.6.0 = `contract_id 175`**, **v0.7.0 = `contract_id 479`** |
| Invoke | `contracts.execute("gate","evaluate")` → approved/rejected **inside the TEE** |
| Test | 28 Rust host tests + 33 offline Node tests + 13 Playwright, all green |

> **Current state, stated plainly:** v0.7.0 (`contract_id 479`) is registered and
> is the version the host now runs for this tail. Its two new enclave-only
> properties — the KV-held mandate and atomic decide-and-dispatch — are covered by
> Rust tests but have **not yet been exercised live**, because registering v0.7.0
> exhausted the account's credits (bug #16) before the mandate could be seeded.
> The v0.6.0 evidence below (including the `HTTP 200` from inside the enclave) was
> captured live earlier the same day. I would rather say this than imply a live run
> I did not do.

**It is live on the network right now** — anyone can confirm without my key:

📷 **Screenshot 03 — `03-contract-deployed.png`**

```
$ t3n contract get z:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f:gate --env testnet
script_name      z:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f:gate
current_version  0.6.0
```

📷 **Screenshot 07 — `07-tests.png`** — 33/33 offline tests pass.

---

## 4. Agent Auth + Agent ID registration

**Agent Auth.** The most useful thing I learned in the docs: a contract's
outbound HTTP is authorised by the **caller**, not by the contract. The grant is
triple-scoped — contract, functions, and destination hosts:

```js
await client.execute({
  script_name: "tee:user/contracts",
  script_version: await getScriptVersion(BASE_URL, "tee:user/contracts"),
  function_name: "agent-auth-update",
  input: { agents: [{ agentDid, scripts: [{
    scriptName: "z:<tid>:gate", versionReq: "0.6.0",
    functions: ["evaluate", "spend", "dispatch_action"],
    allowedHosts: ["postman-echo.com"],
  }] }] },
});
```

📷 **Screenshot 06 — `06-egress-grant.png`** → `agent-auth-update ✅ {"tx_hash":"tx:107:97354"}`

This turned my last blocked feature into a working one. With the grant, the
contract's outbound POST **completes from inside the enclave (HTTP 200)**;
without it, the same call returns a typed `host/http.egress_denied`, and a host
that isn't on the grant is refused by name. Deny-by-default, per destination.
(Two gotchas the docs don't state: `script_version` is **required** on this call,
and a literal `"latest"` is rejected — resolve it with `getScriptVersion`.)

**Agent ID registration.** Registered on-network with the `t3n` CLI:

📷 **Screenshot 02 — `02-cli-whoami.png`** · 📷 **Screenshot 04 — `04-agent-registered.png`**

```
$ t3n whoami --env testnet
did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f

$ t3n agent registry did:t3n:3d7dd668… --full --env testnet
agent_uri          https://raw.githubusercontent.com/PugarHuda/t3-gatekeeper-agent/master/agent/agent-card.json
registered_at      1786116745
updated_at         1786116745
owner_eth_address  84,138,102,55,125,127,52,144,44,224,142,91,6,11,141,109,26,36,254,20
```

The agent card is an ERC-8004 / A2A-shaped document listing four skills.
Getting here surfaced four issues — bugs **#10, #11, #12, #13**. In particular
the documented public-agent step (`agent host-card`) **does not work**;
`agent set-card --uri` is the path that does.

---

## 5. Beyond the first contract — the use case

**Who, exactly: tokenised private-credit distribution.**

Take **Meridian Private Credit Fund**, selling a $250k-minimum note to
individuals. Securities law lets them sell only to *accredited* investors, so
today every buyer uploads a passport, bank statements and a net-worth
attestation, and Meridian stores all of it. That is a compliance cost on the way
in and a breach liability forever after — they are now custodians of a data set
they never wanted, purely to answer one yes/no question.

Now the investor delegates buying to an AI agent. Two things break at once. The
agent needs the investor's account credentials, so a prompt injection or a bad
model day spends real money. And the "limits" — $5,000 a trade, USDC only, this
fund only — live in the agent's own prompt or code, which is exactly the thing
that cannot be trusted to enforce them.

**Gatekeeper answers both.** Meridian learns exactly one fact — *this buyer is
accredited* — proven by a BBS+ zero-knowledge proof, never the net worth behind
it. And the mandate lives in the enclave's key-value store, so the agent cannot
widen its own ceiling: the decision and the outbound order are the **same enclave
call**, and a rejected action never reaches the network.

**Target users:** tokenised RWA / private-credit distribution platforms, and the
treasury or wealth agents transacting with them. **Where it fits T3:** the
"Permissioned DeFi / RWA" solution area — accredited-investor proof as an
authorization gate rather than a form-filling exercise.

The general principle: an agent should *prove* it is allowed to act without ever
holding the data that proves it, and its limits should be enforced by hardware,
not by its own code.

The chain, all running on the ADK:

```
[1] IDENTITY   handshake + authenticate                → did:t3n
[2] VC GATE    BBS+ credential verify                  → eligible, no PII revealed
[2b] REVOCATION on-chain kill-switch (revoke_vc)       → blocks a revoked holder
[3] MANDATE    contracts.execute("gate","evaluate")    → TEE decision + reasons
[4] AUDIT      structured row per action               → approved AND rejected
[5] DISPATCH   Web Bot Auth signature + in-TEE POST    → HTTP 200 from the enclave
```

📷 **Screenshot 05 — `05-full-flow.png`** — six scenarios in one run: an approved
buy that dispatches for real, an over-mandate buy rejected, a disallowed
asset+kind rejected, an approved counterparty, an unknown counterparty rejected,
and a future-dated mandate rejected — each with the enclave's own reason strings.

Things worth a look beyond the core gate:

- **True zero-knowledge selective disclosure.** The issuer signs a full KYC
  record; the holder derives a proof revealing *only* `accreditedInvestor`, and
  the agent verifies it without ever seeing name, DOB, or net worth. The SDK
  ships issue + verify but not the holder-side derive — see bug **#3** — so I
  bridged T3 BLS keys into `@mattrglobal/bbs-signatures`' `createProof`.
- **Hardware velocity limit.** Cumulative per-window spend held in the TEE across
  invocations; the third spend in a window is rejected by the enclave.
- **A2A capability exchange.** One agent proves a single capability to a peer and
  hides the rest of its manifest.
- **Web Bot Auth (RFC 9421).** Outbound requests signed with Ed25519 including a
  RFC 9530 `Content-Digest` over the body, so a destination can verify the caller.
- **ERC-8004.** A ready-to-run mint script using the real `register(agentURI)`
  ABI; it refuses to run unconfigured, so there is no fake on-chain claim.

**Where this goes:** permissioned DeFi / RWA distribution, where "is this buyer
accredited?" and "is this trade inside their mandate?" must both be answered
before the order leaves — and answered in a way a regulator can audit without the
platform ever holding the investor's personal data.

### 5.1 QA — the wrong paths matter more than the happy one

A gate that only proves it says *yes* is worthless. `qa-console/` is a browser
console driven by Playwright, running the contract's **real** Rust `decide()` via
a host build — the rules are never reimplemented in JavaScript, because a JS copy
would drift from the contract and prove nothing.

📷 `11-qa-console-approved.png` — happy path: an in-mandate purchase approved.

📷 `12-qa-console-rejected.png` — wrong path: an unlisted payee refused by name.

📷 `13-qa-console-self-issued.png` — the attack that matters: an agent's
self-issued "accredited investor" credential refused as untrusted.

| Path | Case | Asserted |
| --- | --- | --- |
| Happy | in-mandate purchase | approved **with no reasons attached** |
| Happy | credential from a trusted issuer | approved |
| Wrong | **self-issued credential** | rejected — `not trusted` |
| Wrong | payee sub-limit under the global cap | rejected — `per-counterparty limit` |
| Wrong | over the cap | rejected, `exceeds mandate max` |
| Wrong | disallowed asset + kind | **both** failures reported, not just the first |
| Wrong | unlisted counterparty | rejected, names the payee |
| Wrong | expired mandate | rejected |
| Wrong | unconfigured mandate | denies by default — the fail-closed guarantee |
| Abuse | malformed JSON / missing action / unknown route | 400 / 400 / 404, no crash |
| Abuse | negative amount | must not approve — no unsigned wrap-around past the cap |

**82 automated tests total:** 28 Rust, 33 Node, 13 Playwright E2E, and 8 against
the live deployed site — including that every screenshot actually renders (an
evidence page of broken images is a real defect) and a **Web Bot Auth key round
trip over the public internet**: sign locally, fetch the public key from
`/.well-known/http-message-signatures-directory`, verify. Nothing shared in
advance, which is the entire point of a key directory and exactly what an
ephemeral per-run key could never demonstrate.

### 5.2 Three security holes I found in my own contract, and fixed

Auditing my own work for this submission turned up three genuine weaknesses.
All three are fixed in **v0.7.0**:

1. **The mandate was forgeable.** `evaluate` accepted an inline mandate from the
   caller, and the demo passed one — so the agent was being judged against limits
   it supplied itself. The KV path existed but was never exercised. `execute_action`
   now reads the mandate from KV with **no inline escape hatch**.
2. **The gate was skippable.** `evaluate` and `dispatch_action` were separate host
   calls, and nothing in `dispatch_action` knew a mandate existed — an agent could
   simply not call `evaluate`. The gate was advisory. `execute_action` makes the
   decision and the outbound call one invocation.
3. **The velocity limit could be reset.** The spend window was a caller-supplied
   string, so passing a fresh one each call kept the running total at zero.
   The window is now derived from the cluster clock inside the enclave.

The first two mean the pre-0.7.0 mandate held only while the agent cooperated —
which is precisely the assumption this project exists to remove.

**A fourth, found after that (fixed in 0.8.0): the gate trusted any issuer.** A
BBS+ signature proves the issuer signed the claim — it says nothing about whether
that issuer is anyone the fund trusts. The agent generates its own issuer key in
the demo, so it could mint its own "accredited investor" credential and pass. The
mandate now carries `allowed_issuers`, and the enclave checks the credential's
issuer against it. Same release adds **per-counterparty sub-limits** — "$50k to
Meridian, $5k to anyone else" — applied *in addition* to the global cap, never
instead of it (there is a test asserting a generous sub-limit cannot widen the
overall ceiling).

---

## 6. Bugs, doc gaps, and onboarding friction (15)

Numbering continues from the eight I filed during the ADK bounty in June. Those
eight have full write-ups with repro scripts in
[`submission/TRACK_B_BUG_REPORTS.md`](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/submission/TRACK_B_BUG_REPORTS.md);
the ten new ones are written up in full below.

### New in this submission (10)

**#9 — `t3n token balance` and `t3n token usage` are broken (CLI 4.30.0).**
Every call fails; the params appear to be sealed while the server expects a
plaintext struct. The SDK's own `getUsage()` works fine against the same node
with the same key, so this is CLI-side.

📷 `08-bug-token-balance.png`
```
$ t3n token balance --env testnet
error: RPC Error: invalid token.get-usage params: invalid type: string
"rGiZ+IfQrOnpJL0xuLSMAQXwJr4cEtwBYChLxVBBJqlJMnNdDeto", expected struct GetUsageParams
[f4dab8a1-b2d9-46e1-9552-99a3e2e54ae7]
```
Request IDs: `cc515bd4-78b2-4fb6-8a56-2bea6c8ed81d`, `95bcdac8-a2ec-48e0-b999-e5c02a3f98fa`
(`--json`), `6be214d1-e6f7-4ba8-9f55-8b5b6c0e6425` (`token usage`).
**Impact:** high — checking your credit balance is the first thing a new
developer does, and the CLI path for it does not work at all.

**#10 — `agent registry --full` prints `owner_eth_address` as a decimal byte
array.** 📷 04. It renders as `84,138,102,55,…` instead of
`0x548a66377d7f34902ce08e5b060b8d6d1a24fe14` (same bytes). Cosmetic but confusing
— it does not look like an address, so you cannot eyeball whether the right key
owns the agent. **Impact:** low.

**#11 — The documented "Register a Public Agent" step fails; the docs omit a
prerequisite.** Step 5 of the guide is
`t3n agent host-card --file agent-card.json --env testnet`. For a self-owned
(public) agent this returns:
```
error: RPC Error: NotScopeWriter: signing user is not a writer for this scope
[3fed6063-6241-4f32-a135-037b71b8c8f4]
```
The CLI's own `--help` mentions that writing a card needs write access to an
org's `agent-cards` scope, but the public-agent page never says so, and there is
no org in the public-agent flow at all. Attempting the self-grant first fails
differently: `OrgPolicyNotInitialised` (`c58bb202-d711-49f0-a501-8f7b16bb4473`).
**The path that does work is `t3n agent set-card --uri <url>`**, which the guide
does not mention. **Impact:** high — this is the bounty's headline task, and the
documented command for it does not succeed.

📷 `09-bug-host-card.png`

**#12 — Org-owned agents cannot be created on testnet: the CLI is ahead of the
node.** CLI 4.30.0 requires `tee:organisation/contracts >= 0.6.0`/`0.7.0`;
testnet runs **0.4.1** (confirmed via `t3n contract get tee:organisation/contracts`).
All three variants fail:
```
$ t3n agent create --org <org> --name X --uri <url>
error: createAgent: hosting a card needs tee:organisation/contracts >= 0.7.0, but the node runs 0.4.1

$ t3n agent create --org <org> --name X --uri <url> --no-card
error: createAgent: passing agentUri needs tee:organisation/contracts >= 0.6.0, but the node runs 0.4.1

$ t3n agent create --org <org> --name X --no-card
error: RPC Error: Internal error [7cc2e1d0-fa1b-4e49-8114-b8a01dad00a0]
```
Two sub-issues: the whole "Register an Organization-owned Agent" page is
unusable on testnet, and the third variant degrades to a bare `Internal error`
with no detail instead of the clear version message the other two give.
(`t3n org create` itself works fine — I created
`did:t3n:93d8852130b8fe8e15c156ab8f445af975593db9`.) **Impact:** high.

📷 `10-bug-node-version.png`

**#13 — The documented verification step returns 404 after a successful
registration.** The guide ends with
`curl https://<node>/api/agent-card/$AGENT_DID`. After registering successfully
(`agent registry` resolves my DID to its URI), that endpoint returns **404**.
Downstream of #12 — no card can be hosted — but it means the documented happy
path cannot be completed end-to-end on testnet as written. **Impact:** medium.

**#14 — The Quickstart's `setEnvironment("sandbox")` throws, with no minimum
version stated.** The claim page and Quickstart both show `setEnvironment("sandbox")`.
On `@terminal3/t3n-sdk@3.5.2`:
```
Invalid environment: sandbox. Must be one of: testnet, production
```
`sandbox` only exists in the 4.x line. The docs give no minimum SDK version, so
anyone on an older pin hits this on their very first copy-paste. Related: the
claim page issues testnet credentials while the sample code says `sandbox`.
**Impact:** medium — first line of the first example.

**#15 — `npx @terminal3/t3n-sdk` silently resolves an older local install.** The
CLI guide says to run `npx @terminal3/t3n-sdk …`. Run from a project that already
has an older SDK in `node_modules`, npx picks the *local* copy, which has no
`bin`, and you get:
```
npm error could not determine executable to run
```
No hint that a stale local version shadowed the intended one. A version note or
`npx @terminal3/t3n-sdk@latest` in the docs would fix it. **Impact:** low.

**#16 — One contract registration exhausts an entire sandbox grant, and the
storage deposit is larger than any grant.** Registering a single 204 KB contract
took the account from `1,487,000,000` available to **`0`**
(`credit_exhausted: true`). Every operation afterwards — execute, map create, map
update, control call — fails with:
```
HTTP 403 Forbidden {"code":"forbidden","detail":"InsufficientCredit
(account=3d7dd668…, required=10000000000, available=0)"}
```
The required figure, **10,000,000,000**, is about **6.7× the entire initial
grant** of 1.487e9. So a developer who follows the walkthrough — register a
contract, then create the KV maps it reads — cannot finish on one sandbox key,
and the landing page's "25 agents and ~5,000 protected actions" does not match
what one grant actually buys. Request IDs: `cc72c029-5f44-430e-8d0d-af4b85536313`
(map update), `245961d1-222e-46bd-af77-1c2e6825ad78` (`map-entry-set`),
`95c78c00-35b5-43e0-be77-6925f38eca83`. **Impact: high** — it is a hard stop
mid-walkthrough, and there is no warning beforehand that a deploy may consume
everything. A pre-flight cost estimate, or simply publishing the price of a
registration per KB, would prevent it.

**#17 — There is no way to see where your credits went.** After #16 I tried to
find what consumed the grant. `getUsage()` returns `entries: []` — an empty
ledger — and the CLI's `token usage` is broken (bug #9). So the two documented
ways to audit spend both yield nothing, and a developer who runs out has no path
to understanding why. **Impact: medium**, but it compounds #16: the failure is
unexplained *and* uninspectable.

**#18 — The published SDK is obfuscated, so any error is undebuggable.**
`@terminal3/t3n-sdk` ships minified with mangled identifiers and runtime-built
strings (`_0x3456(0x277)`), and it throws `Error` objects whose stack points into
that bundle. An uncaught rejection therefore prints **~1 MB of obfuscated source**
to the terminal instead of a message. Reproduce by calling any control function
with a wrong argument and not catching it.

The practical effect: you cannot read a stack trace, cannot set a useful
breakpoint, and cannot tell an SDK bug from your own mistake. I had to write a
wrapper in two separate places just to see what went wrong:

```js
catch (e) { console.error(String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 500)); }
```

Every diagnosis in this report — bugs #9 through #13 — required that wrapper
first. Shipping a source map, or simply not mangling a library whose whole
audience is developers integrating against it, would remove a real barrier to
adoption. **Impact: medium**, but it multiplies the cost of every other bug.
(Another participant independently reported the same obfuscation problem on the
bounty listing while I was writing this up.)

### Filed in June, re-verified for this submission

| # | Issue | Status today |
| --- | --- | --- |
| 1 | `verifyBbsVc` reports the failure reason as literal `undefined` — `"BBS+ signature verification failed: undefined"` on a tampered credential | ✅ still reproduces (7 Aug) |
| 2 | `getNodeUrl("testnet")` returns the string `"testnet"`; argless `getNodeUrl()` returns the **production** URL | ✅ still reproduces (7 Aug) — easy to point a testnet build at prod |
| 3 | "Smart VCs" docs promise ZK selective-disclosure VPs, but the SDK ships no holder-side derive function | ✅ still open (worked around via `@mattrglobal/bbs-signatures`) |
| 4 | Referenced onboarding repo `Terminal-3/adk-getting-start` is **empty** | ✅ still empty (size 0, last push 2026-06-06) |
| 5 | Building a TEE contract on Windows fails with no native linker, undocumented | ✅ open — fix that worked: `rustup toolchain install stable-x86_64-pc-windows-gnu` + build with `cargo +stable-x86_64-pc-windows-gnu` |
| 6 | `tenant.claim()` returns HTTP 500 for an already-provisioned tenant instead of a clean "already claimed" | filed June |
| 7 | Importing `host:interfaces/vp` or `agent-registry` registers fine but then **500s on every execute**; no register-time validation (`http` works — evidence table in the write-up) | ✅ re-verified 19 Jun, repro contracts 164 / 170 / 174 |
| 8 | Registering a new version under a tail makes the host run the **latest** version for every execute, so a broken deploy bricks pinned older ones; no get-contract-id API; private-map ACL re-register footgun | filed June |

---

## 7. Screenshot index

All in [`submission/screenshots/out/`](https://github.com/PugarHuda/t3-gatekeeper-agent/tree/master/submission/screenshots),
each with the raw `.txt` it was rendered from.

| # | File | Shows |
| --- | --- | --- |
| 01 | `01-quickstart-auth.png` | Quickstart complete — handshake → authenticate → getUsage, live |
| 02 | `02-cli-whoami.png` | The network returning our Agent DID |
| 03 | `03-contract-deployed.png` | Our Rust TEE contract live on the network at v0.6.0 |
| 04 | `04-agent-registered.png` | Agent ID registered — URI, timestamps, owner (and bug #10) |
| 05 | `05-full-flow.png` | The whole agent: VC gate → TEE mandate → audit → in-TEE dispatch (HTTP 200) |
| 06 | `06-egress-grant.png` | `agent-auth-update` accepted — the caller authorising enclave egress |
| 07 | `07-tests.png` | 27/27 offline tests |
| 08 | `08-bug-token-balance.png` | Bug #9 — `token balance` fails |
| 09 | `09-bug-host-card.png` | Bug #11 — documented `host-card` step fails |
| 10 | `10-bug-node-version.png` | Bug #12 — node runs `tee:organisation/contracts` 0.4.1 |
| 11 | `11-qa-console-approved.png` | QA happy path — in-mandate purchase approved |
| 12 | `12-qa-console-rejected.png` | QA wrong path — unlisted payee refused by name |
| 13 | `13-qa-console-self-issued.png` | QA wrong path — a self-issued credential refused as untrusted |

All thirteen are also published, with captions, at
**https://gatekeeper-evidence.vercel.app**, which additionally serves the agent's
Web Bot Auth key directory at
[`/.well-known/http-message-signatures-directory`](https://gatekeeper-evidence.vercel.app/.well-known/http-message-signatures-directory).

---

## 8. Reproduce it yourself

No key needed for the first two:

```bash
npx @terminal3/t3n-sdk contract get z:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f:gate --env testnet
npx @terminal3/t3n-sdk agent registry did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f --env testnet
```

With your own key:

```bash
git clone https://github.com/PugarHuda/t3-gatekeeper-agent && cd t3-gatekeeper-agent/agent
cp .env.example .env      # your T3N_API_KEY + DID
npm install && npm test   # 27 offline tests, no credits spent
npm run setup             # register the Rust contract + seed the mandate
npm run grant:egress      # authorise the enclave's outbound host
npm run demo              # the full chain
```

No key at all — the QA suite runs entirely offline:

```bash
cd gate-contract && cargo build --bin gate_cli --release && cargo test
cd ../qa-console && node --test e2e.test.mjs    # 10 Playwright tests
```

A full inventory of what is shipped, what is deliberately shallow, and what is
worth building next is in
[`submission/STATUS_AND_ROADMAP.md`](https://github.com/PugarHuda/t3-gatekeeper-agent/blob/master/submission/STATUS_AND_ROADMAP.md).

Repo: https://github.com/PugarHuda/t3-gatekeeper-agent ·
Video: https://youtu.be/gVY3y4j6XT4
