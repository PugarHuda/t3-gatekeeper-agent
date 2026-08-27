# Bug ledger — Terminal 3 ADK

One list, with what each report looks like **today**. Every status below was
re-checked on **2026-08-27** against `@terminal3/t3n-sdk@5.1.0`, CLI 5.1.0, and
the refreshed docs. The account was topped up on 2026-08-27, so the reports that
previously read *not re-tested* have been settled against a live network — the
metering ones with measured numbers rather than estimates.

Detailed write-ups for #1–#8 are in
[`TRACK_B_BUG_REPORTS.md`](TRACK_B_BUG_REPORTS.md); for #9–#18 in
[`SUPERTEAM_SUBMISSION.md`](SUPERTEAM_SUBMISSION.md) §6. New reports #19–#21 are
written up in full at the bottom of this file, along with #22 and #23.

DID under test: `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f`

## Status at a glance

| # | Report | Filed | Status 2026-08-27 |
| --- | --- | --- | --- |
| 1 | `verifyBbsVc` reports the reason as the literal string `undefined` | Jun | **reproduces** |
| 2 | `getNodeUrl("testnet")` returns `"testnet"`, not a URL | Jun | **reproduces on 5.1.0** |
| 3 | "Smart VCs" docs promise ZK selective disclosure; no holder-side derive ships | Jun | **reproduces** |
| 4 | Referenced onboarding repo `Terminal-3/adk-getting-start` is empty | Jun | **reproduces** (size 0, last push 2026-06-06) |
| 5 | Windows TEE-contract build fails, undocumented | Jun | **reproduces** (still need the GNU toolchain) |
| 6 | `tenant.claim()` fails for an already-provisioned tenant | Jun | **reproduces on 5.1.0**, and the method moved — see below |
| 7 | `vp` / `agent-registry` imports register, then 500 on every execute | Jun | **stands on June evidence** — the repro build was reverted; see below |
| 8 | Re-registering a tail makes the host run the latest version for everyone | Jun | **partly adopted** — see below |
| 9 | `t3n token balance` / `token usage` always fail | Aug | ✅ **fixed** |
| 10 | `agent registry --full` prints `owner_eth_address` as a decimal byte array | Aug | **reproduces** |
| 11 | Documented `agent host-card` step fails with `NotScopeWriter` | Aug | **likely fixed** — now fails on credits instead |
| 12 | Org-owned agents impossible: node ran `tee:organisation/contracts` 0.4.1 | Aug | ✅ **fixed** — node is on 0.17.0 |
| 13 | Documented `curl /api/agent-card/<did>` returns 404 after registration | Aug | **reproduces**, refined below |
| 14 | Quickstart's `setEnvironment("sandbox")` throws | Aug | ✅ **fixed** — `sandbox` now aliases testnet |
| 15 | `npx @terminal3/t3n-sdk` silently resolves a stale local install | Aug | **not currently reproducible** — see below |
| 16 | One contract registration exhausts an entire grant | Aug | **reproduces**, now measured — see below |
| 17 | No way to see where credits went (`entries: []`) | Aug | **reproduces**, and now provably: 5.7e9 spent, ledger still empty |
| 18 | The published SDK is obfuscated, so any error is undebuggable | Aug | **reproduces on 5.1.0** |
| 19 | The node dropped support for the SDK the old docs shipped, silently | **new** | open |
| 20 | `trustAnchor` required from 5.x; the error never names the one-line fix | **new** | open |
| 21 | Metering is inconsistent and unpublished: some writes are free, others cost 6.7× a full grant | Aug | open, now with numbers |
| 22 | BBS+ credentials cannot carry a signed `credentialStatus`, so nothing the SDK issues can be revoked | **new** | open |
| 23 | The per-minute fuel budget is spent at the per-call *maximum*, capping every tenant at 10 calls/minute | **new** | open |

Four fixed, one likely fixed, one partly adopted into the docs. Thank you — the
ones that got fixed were the ones that most got in a newcomer's way.

### The three that were previously *not re-tested*

**#6 reproduces, and the method moved.** On 5.1.0 `tenant.claim()` is not a
function at all — it is now `tenant.tenant.claim()`, with no migration note, the
same undocumented-break pattern as #19 and #20. Called on an already-provisioned
tenant it still fails:

```
RPC Error: Internal error [648ace63-303f-4d36-b1fc-5fb70d26da31]
```

An `evaluate` call immediately before and immediately after both returned
`approved`, so this is the claim path failing, not a sick session.

**#7 stands on its June evidence and was not re-staged.** The contract that
imported `host:interfaces/vp` was reverted in June to unbrick the production
tail, so `gate@0.4.0` no longer exports `verify_vp` — invoking it now returns
`Function not found ... walked every interface export`, which is the revert, not
a fix. Re-staging it would cost a fresh 1.37e9-credit registration and risk the
same footgun, so it is left as filed.

**#15 does not reproduce here any more**, because the precondition is gone: the
local `t3-qa/node_modules` now holds SDK 5.1.0, which ships a bin, so
`npx --yes @terminal3/t3n-sdk whoami --env testnet` resolves and returns a proper
`No API key` error. The original failure needed an older local copy without a
bin. Reported as environment-dependent rather than fixed.

### Measured on 2026-08-27, on a funded account

Every number below is the delta between two `getUsage()` reads around a single
call, on `did:t3n:3d7dd668…`, SDK 5.1.0, testnet:

| Operation | Credits |
| --- | --- |
| One `evaluate` contract execution | **30,034,055** (identical across repeats) |
| Registering a 255,706-byte component | **1,370,147,045** (about 5,358 per byte, or 45 executions) |
| `agent-auth-update` egress grant | free at the observed resolution |
| KV map create, and control-plane `map-entry-set` | free at the observed resolution |

These are the numbers #16, #17 and #21 are about. None of them is published
anywhere, and `getUsage().entries` stayed `[]` across all of it.

### On #8

The docs Changelog entry for 2026-07-06 adds "a warning about contract
version-shadowing on re-registration" to the Register page. That is this report,
and the warning is the right fix for the dangerous half of it.

The other half stands: there is still no API that returns a contract's numeric
`contract_id`. `t3n contract get <name>` echoes the *script name* back in a field
labelled `contract_id` and gives you `current_version`, so a caller that needs
the numeric id — to write a map ACL, for instance — still has to capture it from
the registration response and store it themselves. Losing it means re-registering
to get it back, and re-registering is the single most expensive call there is.

### On #13, refined

The finding is sharper than originally filed. Creating an org-owned agent now
reports `private default card hosted`, and the CLI tells you to run
`t3n agent card-publish`. Until you do, the documented verification step:

```
$ curl https://cn-api.sg.testnet.t3n.terminal3.io/api/agent-card/did:t3n:8f8849…
{"error":"no agent card hosted for this DID","code":"not_found",
 "request_id":"2bfbe82a-749a-49d2-8b3c-0bb164aadacb"}
```

…404s, for an agent that was *just told* it has a card hosted. Two separate
things to fix: the walkthrough's verification step should include the publish
call that makes it true, and the error should distinguish "no card exists" from
"a card exists but is not published" — they are different problems with different
fixes, and right now they are the same sentence.

The error text itself is a genuine improvement over the bare 404 we reported in
August.

---

## #19 — The node dropped support for the SDK version the old docs shipped, with no notice

**Impact: high.** Every integration written against the previous docs is now
broken, and nothing in the error says why.

`@terminal3/t3n-sdk@3.5.2` was the version pinned by work done during the June
and August bounty rounds. Against the node today:

```
Error: HTTP 400: Invalid params
{"code":"bad_request",
 "detail":"token.get-usage: request params must be sealed to this session key",
 "request_id":"2901523a-450d-4a04-b9c5-b0748a855d65"}
```

The same call on 5.1.0, same key, same node, same second, succeeds. So the node
changed which params it expects sealed, and 3.5.2 can no longer talk to it.

Two things make this worse than an ordinary breaking change:

1. **The error blames the request, not the version.** "request params must be
   sealed to this session key" reads like the caller did something wrong. There
   is no "unsupported SDK version" and no minimum-version header, so the obvious
   next move is to debug your own code — against an obfuscated bundle (#18).
2. **There is nowhere to look it up.** The docs Changelog says plainly that no
   SDK release history exists yet. So a developer who hits this cannot discover
   which version they need, when it changed, or what else changed with it.

Note this is the mirror image of #9: the CLI's `token balance` was failing
*because* it sealed params the server wanted plaintext. That got fixed by
changing the server, which broke the older SDK. A published compatibility matrix
would have made both of these a five-minute read.

**Suggested fix:** reject an unsupported client with an error that names the
version, and publish a "minimum SDK version" line on the Quickstart.

## #20 — `trustAnchor` is required from 5.x, and nothing connects the error to the fix

**Impact: medium** — a doc gap rather than a defect, but it lands on exactly the
developers already dealing with #19.

```js
new T3nClient({ wasmComponent, handlers: { EthSign: … } });   // the 3.x form
// SDK 5.1.0 → T3nConfigError, code=CONFIG_ERROR, field=trustAnchor
```

Credit where due: the change is right and the error is one of the better ones in
this SDK. Requiring the anchor rather than defaulting it is the correct call for
a security parameter — it pins the node's DKG attestation, so a failed handshake
is a trust failure instead of a silent downgrade — and the message explains what
a `TrustAnchor` is and names the `{ unsafe_trust_server: true }` opt-out along
with a warning not to use it against a real node.

The gap is the migration, not the message:

- It does not name **`fetchTrustedManifest("testnet")`**, which is the entire
  fix and is exported from the same module.
- It does not say which version introduced the requirement, and the docs
  Changelog has no SDK section to look it up in (see #19).
- The Quickstart shows the new form without marking it as new, so a developer
  comparing their working 3.x code against it sees no signal that this one line
  is the breaking difference.

Repro: `node t3-qa/trust-anchor-probe.mjs` — builds a client both ways against
the same installed SDK, offline.

**Suggested fix:** append "build one with `fetchTrustedManifest(env)`" to the
error, and add one Changelog line naming the version. Same note should mention
that `getScriptVersion` is now `getContractVersion`.

## #21 — Metering is inconsistent and unpublished

**Impact: medium**, rising to high the moment someone plans a budget.

With a balance of exactly zero (`credit_exhausted: true`), this succeeded:

```
$ t3n agent create --org did:t3n:93d8852… --name … --uri … --env testnet
agent created: did:t3n:8f8849397fb511899fcf90caa4bdc75b0792d808
private default card hosted
```

That call minted a DID, issued an API key, and hosted a card — three writes — for
free. In the same session, on the same account, these were refused:

```
$ t3n agent card-publish --owner … --agent …
error: InsufficientCredit (account=3d7dd668…, required=10000000000, available=0)

$ t3n agent host-card --file agent-card.json
error: InsufficientCredit (account=3d7dd668…, required=10000000000, available=0)
```

`required=10000000000` is about 6.7× the entire initial grant of 1.487e9 (#16).
So publishing a card is priced at several times a full test account, while
creating the agent it belongs to is free. There is no published price list, no
pre-flight estimate, and — because `getUsage().entries` is empty (#17) — no way
to see afterwards what was charged.

**Suggested fix:** publish the price of each control call, or return the cost in
the response. A developer cannot plan around a number they can only discover by
running out.

## #22 — A BBS+ credential cannot carry a signed `credentialStatus`, so nothing the SDK issues can be revoked

**Where** `@terminal3/bbs_vc@0.2.36` — `createBbsCredential()`

**What happens.** `createBbsCredential(issuer, user, credentials, type, validFrom,
validUntil, options, proofFunction, w3cBbs)` has no parameter for
`credentialStatus`, and signs only what it builds. The obvious workaround —
issue the credential, then attach the status entry — silently invalidates the
proof:

```js
const vc = await createBbsCredential(issuer, subject, { accreditedInvestor: true },
  ["VerifiableCredential"], undefined, undefined, undefined, undefined, true);
(await verifyBbsVCW3c(vc)).isValid;            // true

vc.credentialStatus = {                        // the W3C VCDM 2.0 placement
  type: "BitstringStatusListEntry", statusPurpose: "revocation",
  statusListIndex: "7", statusListCredential: "https://issuer.example/status.json",
};
(await verifyBbsVCW3c(vc)).isValid;            // false
```

The failure prints `computed bbsHeader:` and `bbsHeader from base:` to stdout and
returns `isValid: false` with no message naming the added field, so what a
developer actually sees is "my credential stopped verifying".

**Why it matters.** `credentialStatus` is how every W3C revocation mechanism
works — Bitstring Status List, StatusList2021, and Terminal 3's own `revoke_vc`
story all hang off it. Without a signed one, an issuer using this SDK cannot
publish revocation a verifier can trust: the entry can only be bolted on
afterwards, by anyone, and a holder can simply drop it.

It cost us a real outage. The status-list integration was written while the
account was out of credits, so the live path never ran; the first funded run
aborted at the eligibility gate with `verify=false` and no explanation.

**What we do instead**, until this is fixed: the issuer puts the same entry
*inside* `credentialSubject`, where the signature does cover it, and the checker
reads either placement (`credentialStatusOf` in `agent/src/revocation.mjs`). Both
halves are pinned by tests in `agent/test/status-list.test.mjs` — including one
that fails if the SDK ever gains a signed top-level field, so we find out.

**Asked for.** A `credentialStatus` argument on `createBbsCredential` (or in
`options`) that is included in the signed message set — and, failing that, an
error from `verifyBbsVCW3c` that names the field that changed.

## #23 — The per-minute fuel budget is spent at the per-call *maximum*, so every tenant gets exactly 10 calls a minute

**Where** testnet node `cn-api.sg.testnet.t3n.terminal3.io`, contract execution.

**What happens.** A tenant may run exactly **ten** contract executions per
minute, no matter how cheap those executions are. The eleventh fails:

```
RPC Error: quota exceeded (fuel_per_minute): tenant 3d7dd668… on contract
z:3d7dd668…:gate [request_id]
```

Measured 2026-08-27: ten `evaluate` calls succeeded in about 3 seconds, calls
11–16 all refused.

**The mechanism, from the tenant's own quota block.** `tenant.tenant.me()`
returns:

```json
"fuel_per_call_max": 50000000,
"fuel_per_minute_max": 500000000,
"outbox_calls_per_minute_max": 10
```

500,000,000 ÷ 50,000,000 = 10. And a measured `evaluate` costs **30,034,055** —
about 60% of the per-call maximum. Ten calls therefore consume 300,340,550 of
actual fuel while exhausting a 500,000,000 budget, which is consistent with the
budget being charged the per-call *ceiling* on reservation rather than what the
call used. **Two fifths of the minute's budget cannot be reached**, and lowering
a contract's fuel cost buys no extra throughput at all.

**Why it matters.** Ten calls a minute is smaller than an ordinary demo.
`npm run demo` walks nine mandate scenarios and then two live dispatches — eleven
executions — so the final scenario failed on every run until we added backoff.
Anyone following a getting-started guide that loops over examples hits this and
reads it as their own contract being broken.

**A correction to how this was first written up.** The quota is *not* invisible:
it is right there in `tenant.tenant.me()`. What is missing is anything
connecting the two — the limit appears in no doc page we could find, the error
text does not mention `tenant.me()` or the window length, and there is no
`Retry-After`.

**The sharper half.** The quota does not always identify itself. In the same
session, five consecutive executions against contracts that worked immediately
before and immediately after returned only:

```
RPC Error: Internal error [a247b2ea-0575-4d9b-b1ac-486ea2dbb33c]
RPC Error: Internal error [52b45c4d-4872-419a-aa06-d602fe1d5739]
RPC Error: Internal error [34f825c2-1db8-4b6e-ab62-0ee44e6d85c1]
RPC Error: Internal error [83ac27d8-1192-4d0b-b019-adc32766da39]
RPC Error: Internal error [8c2dcb73-9c7d-4500-a01b-681e1fcac9bc]
```

We spent real time suspecting the contract, then a tail-shadowing bug, before the
same calls started working again untouched. A rate limit indistinguishable from a
broken deployment is worse than a rate limit.

**Asked for.** Charge the fuel a call actually used, not its ceiling; document
the window next to the quota; always return the typed `quota exceeded` error
rather than `Internal error`; and include a `Retry-After`.

**Worked around** in `agent/src/lib.mjs` — `executeContract()` retries only this
error, with backoff, and prints why it is waiting.

## Also worth publishing: the tenant quota block

Nothing in the docs told us these existed, and two of them are close enough to
matter on a first project. `tenant.tenant.me().quotas`, 2026-08-27:

```json
{ "max_contracts": 10, "max_maps": 50, "max_map_keys": 10000,
  "max_wasm_bytes": 1048576, "max_value_bytes": 262144,
  "fuel_per_call_max": 50000000, "fuel_per_minute_max": 500000000,
  "writes_per_minute_max": 600, "outbox_calls_per_minute_max": 10 }
```

`max_contracts: 10` is the one to warn newcomers about: registrations are the
most expensive call there is, there is no delete, and re-registering to recover a
lost `contract_id` (see #8) spends one of the ten.
