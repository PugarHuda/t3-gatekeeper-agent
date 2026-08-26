# Bug ledger — Terminal 3 ADK

One list, with what each report looks like **today**. Every status below was
re-checked on **2026-08-26** against `@terminal3/t3n-sdk@5.1.0`, CLI 5.1.0, and
the refreshed docs, except the four marked *not re-tested* — those need testnet
credits the account does not currently have, and guessing would be worse than
saying so.

Detailed write-ups for #1–#8 are in
[`TRACK_B_BUG_REPORTS.md`](TRACK_B_BUG_REPORTS.md); for #9–#18 in
[`SUPERTEAM_SUBMISSION.md`](SUPERTEAM_SUBMISSION.md) §6. New reports #19–#21 are
written up in full at the bottom of this file.

DID under test: `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f`

## Status at a glance

| # | Report | Filed | Status 2026-08-26 |
| --- | --- | --- | --- |
| 1 | `verifyBbsVc` reports the reason as the literal string `undefined` | Jun | **reproduces** |
| 2 | `getNodeUrl("testnet")` returns `"testnet"`, not a URL | Jun | **reproduces on 5.1.0** |
| 3 | "Smart VCs" docs promise ZK selective disclosure; no holder-side derive ships | Jun | **reproduces** |
| 4 | Referenced onboarding repo `Terminal-3/adk-getting-start` is empty | Jun | **reproduces** (size 0, last push 2026-06-06) |
| 5 | Windows TEE-contract build fails, undocumented | Jun | **reproduces** (still need the GNU toolchain) |
| 6 | `tenant.claim()` 500s for an already-provisioned tenant | Jun | *not re-tested* — needs credits |
| 7 | `vp` / `agent-registry` imports register, then 500 on every execute | Jun | *not re-tested* — needs a registration |
| 8 | Re-registering a tail makes the host run the latest version for everyone | Jun | **partly adopted** — see below |
| 9 | `t3n token balance` / `token usage` always fail | Aug | ✅ **fixed** |
| 10 | `agent registry --full` prints `owner_eth_address` as a decimal byte array | Aug | **reproduces** |
| 11 | Documented `agent host-card` step fails with `NotScopeWriter` | Aug | **likely fixed** — now fails on credits instead |
| 12 | Org-owned agents impossible: node ran `tee:organisation/contracts` 0.4.1 | Aug | ✅ **fixed** — node is on 0.17.0 |
| 13 | Documented `curl /api/agent-card/<did>` returns 404 after registration | Aug | **reproduces**, refined below |
| 14 | Quickstart's `setEnvironment("sandbox")` throws | Aug | ✅ **fixed** — `sandbox` now aliases testnet |
| 15 | `npx @terminal3/t3n-sdk` silently resolves a stale local install | Aug | *not re-tested* — workaround still in use |
| 16 | One contract registration exhausts an entire grant | Aug | **reproduces** — balance still 0 |
| 17 | No way to see where credits went (`entries: []`) | Aug | **reproduces** |
| 18 | The published SDK is obfuscated, so any error is undebuggable | Aug | **reproduces on 5.1.0** |
| 19 | The node dropped support for the SDK the old docs shipped, silently | **new** | open |
| 20 | `trustAnchor` required from 5.x; the error never names the one-line fix | **new** | open |
| 21 | Metering is inconsistent and unpublished: some writes are free, others cost 6.7× a full grant | **new** | open |

Four fixed, one likely fixed, one partly adopted into the docs. Thank you — the
ones that got fixed were the ones that most got in a newcomer's way.

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
