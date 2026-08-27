# Running and maintaining the Gatekeeper Agent

This is the operator's document. It assumes you did not write any of this code
and that whoever did is not available to ask.

If you only read one line: **`node verify.mjs`** proves the whole repo still
works, offline, without an API key, and without spending a credit.

---

## 1. What it is, and what breaks if it stops

An agent buys tokenised private-credit notes on an investor's behalf. Two
independent gates stand between "the agent decided to buy" and "an order left
the building":

1. **Eligibility** — a BBS+ verifiable credential proves the investor is
   accredited without revealing net worth, name, or date of birth. Verified in
   the agent layer, then **bound to the action** by a commitment the enclave
   recomputes, so a verification done for one action cannot authorise another.
2. **Mandate** — amount cap, allowed assets, allowed action kinds, allowed
   payees, per-payee sub-limits, trusted credential issuers, a validity window,
   and a cumulative velocity limit. Enforced *inside the TEE*, read from a KV
   map the agent cannot write.

Nothing about this is high-availability. It is a request/response agent: if it
stops, no order goes out, and no order going out is the safe failure. There is
no queue to drain, no state to reconcile, and no partial write to clean up —
with one exception, noted in §5.

## 2. The one command

```bash
node verify.mjs
```

Runs, in order: the contract's Rust unit tests on the host, a wasm component
build, the agent's Node tests, and the Playwright end-to-end suite that drives
the *real* Rust decision function through the QA console. It prints its own total — 118 at the time of writing, and the number comes
from the runners rather than from this sentence. Zero credits, no network, no key.

It is the same set CI runs (`.github/workflows/ci.yml`). If it passes, the
logic is intact; anything still broken is environmental, and §5 lists those.

## 3. Everything that is configuration

No behaviour is hardcoded to the original operator. All of it lives in
`agent/.env` (see `agent/.env.example`) or in a KV map.

| Where | Name | What it controls | Unset means |
| --- | --- | --- | --- |
| `.env` | `T3N_API_KEY`, `DID` | the tenant account everything runs under | nothing runs |
| `.env` | `ACTION_ENDPOINT` | where an approved order is POSTed | an illustrative `broker.example` URL |
| `.env` | `EGRESS_HOSTS` | hosts the enclave may reach | the `ACTION_ENDPOINT` host |
| `.env` | `BROKER_API_KEY` | sealed into the secrets map by `npm run setup` | outbound call is unauthenticated |
| `.env` | `TRUSTED_ISSUERS` | KYC issuers the mandate accepts | **not enforced — any issuer passes** |
| `.env` | `WBA_PRIVATE_KEY` | Web Bot Auth signing key | an ephemeral key nobody can verify |
| `.env` | `REVOCATION_*` | on-chain credential kill-switch | revocation check skipped (fail-open) |
| `.env` | `ERC8004_PRIVATE_KEY` | funds the on-chain identity mint | the mint refuses; reads still work |
| `.env` | `ERC8004_NETWORK` / `_RPC_URL` / `_REGISTRY_ADDRESS` | which registry to use | the Sepolia reference deployment |
| KV | `z:<tid>:mandate[default]` | **the actual limits** | the contract denies everything |
| KV | `z:<tid>:secrets[broker_api_key]` | the broker credential | see `BROKER_API_KEY` |
| KV | `z:<tid>:spent` | velocity counter, contract-owned | contract recreates the entry |
| KV | `z:<tid>:dispatched` | idempotency records, contract-owned | idempotency unavailable; logged, not fatal |

The mandate itself carries the rest, and two of its fields are switches an
operator should understand rather than inherit:

| Mandate field | Effect when true |
| --- | --- |
| `require_credential` | every action must carry a credential binding that matches it; omitting it is a rejection, not a skipped check |
| `require_idempotency_key` | every action must carry a retry key, so a timed-out dispatch is never ambiguous |

Two of those defaults are deliberately unsafe-looking and worth saying plainly:
an empty `TRUSTED_ISSUERS` means the gate accepts a credential the agent minted
itself, and an unset `REVOCATION_*` means a revoked investor still passes. Both
are opt-in because the demo has no real KYC issuer and no published revocation
registry. **A production operator must set both.**

## 4. Standing it up from nothing

```bash
git clone <repo> && cd t3-gatekeeper-agent
node verify.mjs                       # prove it works before touching the network

cp agent/.env.example agent/.env      # add T3N_API_KEY + DID
cd gate-contract && cargo build --lib --target wasm32-wasip2 --release
cd ../agent
npm run probe                         # prove the build works under a throwaway tail FIRST
npm run setup                         # register the contract, create + seed the 4 maps
npm run grant:egress                  # authorise the enclave's outbound host
npm run demo                          # the full chain, end to end

### Do not hand over the tenant's Ethereum key

`T3N_API_KEY` in `agent/.env` is an Ethereum private key. It can spend credits,
register contracts and rewrite grants — everything this tenant can do. It is the
wrong thing to put on a host you do not control.

The node has a second, scoped door: an **agent key**, provisioned once and
revocable, which the SDK's `discover*` reads take.

```bash
npx @terminal3/t3n-sdk agent create --org <org-did> --name <name> --env testnet
# prints { agentDid, apiKey: "t3n_key_<id>.<secret>", keyId } — ONCE
```

Put it in `agent/.env` as `T3N_AGENT_KEY` and run `npm run discover`: it prints
which core contracts the node is running and at what version, our contract as
the node describes it, and this agent's delegation verdict — no session, no
credits. That is the check to run first when something that worked last week
stops working, because twice now the cause was the node moving underneath us
(bugs #12 and #19).

Note the key kinds are not interchangeable and the node will not tell you which
one it wanted: the tenant key returns a bare `HTTP 400` from these reads
(bug #24).

### Handing the gate to someone else's agent

The point of the MCP server is that nobody has to clone this repo to use the
gate. One line, and any MCP host has it:

```bash
claude mcp add gatekeeper -- node /abs/path/to/agent/src/mcp-server.mjs
```

`gate_evaluate`, `bind_credential`, `check_credential_status`, `discover_agent`,
`resolve_erc8004_agent`, `check_erc8004_registry` and `fetch_paid_resource` all
work with **no Terminal 3 account at all** — they run the compiled contract
logic locally, or read public chains and documents. Only `gate_execute` needs
`agent/.env` and credits, and it says so instead of guessing.

Build `gate_cli` first, or the offline tools have nothing to call:

```bash
cd gate-contract && cargo build --bin gate_cli --release --target x86_64-pc-windows-gnu
```

(Read `gatekeeper://status` from the server to see whether it found the binary.)
```

`npm run setup` is idempotent and safe to re-run: it re-points every map's ACL
at the newly registered contract id, which is necessary because that id changes
on every registration.

**`npm run setup` is also the only expensive command.** Measured on
2026-08-27: registering the 255,706-byte wasm costs **1,370,147,045 credits**
(about 5,358 per byte), against **30,034,055** for one contract call. A grant of
4e10 buys roughly 29 registrations, or 1,300 calls. Do not
run it to "check something" — check with `verify.mjs` instead, and check the
balance with `npm --prefix agent run auth` first.

## 5. The five things that actually go wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every call 403s, `required=10000000000, available=0` | out of credits | request a top-up (`t.me/wardumb` for testnet grants) |
| `quota exceeded (fuel_per_minute)` after ~10 calls | the node allows 10 contract executions per minute (bug #23) | nothing to fix — `executeContract()` in `agent/src/lib.mjs` backs off and says so. Check the live limits with `tenant.tenant.me().quotas` |
| A run of bare `RPC Error: Internal error` on contracts that worked a minute ago | usually the same per-minute quota, which does not always name itself | wait a minute and retry before suspecting the contract |
| `verify=false` at the eligibility gate, with no reason | something was added to the credential after it was signed (bug #22) | put it in the claims, where `createBbsCredential` signs it — see `credentialStatusOf` |
| `CONFIG_ERROR field=trustAnchor` | SDK <5.x, or a client built without `fetchTrustedManifest()` | upgrade; see the 5.1.0 migration commit |
| `host/http.egress_denied` | the destination host is not on the caller's agent-auth grant | `npm run grant:egress` — and note the grant lists *functions*, so a new contract function needs adding there |
| `read denied` on the spend map | map ACL still points at a previous contract id | re-run `npm run setup` |
| `credential binding does not match this action` | the agent verified a credential for a different action, or the two implementations drifted | run `node verify.mjs` — the conformance test compares the JS and Rust commitments |
| `idempotency unavailable` in the contract log | the `dispatched` map is missing or its ACL is stale | re-run `npm run setup`; actions still work, retries just are not deduplicated |
| The contract registers, then 500s on **every** invoke | it imports a host interface the node does not serve (`vp`, `agent-registry`) | revert the import; only `tenant-context`, `logging`, `kv-store`, `http`, and `http-with-placeholders` are served |

That last one has a nasty edge, and it is the one exception to "nothing to clean
up" in §1: registering a broken version under a tail makes the host run **that**
version for every call, including calls that pin an older one. A bad deploy
therefore takes the working contract down with it. Recovery is to register a
known-good version so that "latest" is healthy again — which costs a full
registration, so verify on a throwaway tail first.

## 6. Handing it to someone else

Nothing personal is in the running path — no personal wallet, no personal
account, no hardcoded DID, no key committed anywhere. Transfer is:

1. **The tenant account.** A new operator claims their own API key and DID. The
   DID appears in `agent/.env` and in `agent/agent-card.json`; nothing else
   references it, because every canonical map name is derived at runtime from
   `tenant_did()` inside the enclave.
2. **The contract.** Probe it first (`npm run probe`), then re-register under
   the new tenant with `npm run setup`. The
   old deployment keeps running under the old tenant and is not shared state.
3. **The mandate.** Edit `MANDATE` in `agent/src/lib.mjs` and re-run setup, or
   write the KV entry directly. This is the only "business config", and it is
   JSON.
4. **The broker credential.** Set `BROKER_API_KEY` and run setup once. The old
   operator's key is unreadable to the new one and vice versa — the map's ACL
   names a contract id, and that id is new.
5. **The Web Bot Auth key.** Generate a fresh one (command is in
   `.env.example`), publish the JWKS at
   `<site>/.well-known/http-message-signatures-directory`, and update
   `agent-card.json`. Until that is done, outbound signatures verify against
   nobody.
6. **The evidence site.** `site/` is a static directory; `npx vercel deploy
   --prod` from inside it. It is not load-bearing — the agent does not read it —
   except for the JWKS in step 5.

There is no database, no cron, no background worker, and no secret held outside
either the operator's own `.env` or the enclave.

## 7. Where the bodies are buried

- **The version is single-sourced** to `gate-contract/Cargo.toml`. Rust reads it
  via `env!("CARGO_PKG_VERSION")`, the agent parses the same file. Bump it in
  one place; do not reintroduce a second.
- **Build the component with `--lib`.** The crate also has a `gate_cli` binary
  (a host build of the same decision function, used by the QA console). Cargo
  cannot target-gate a bin, so a bare `cargo build --target wasm32-wasip2`
  fails. `verify.mjs` and CI already pass `--lib`.
- **The QA console never reimplements the rules.** It shells out to `gate_cli`.
  A JavaScript copy of the mandate logic would drift from the contract and prove
  nothing, so if you are tempted to add one, don't.
- **`z:<tid>:spent` and `z:<tid>:dispatched` need the contract in *both* readers
  and writers.** Both read-modify-write; a write-only ACL fails with
  `read denied`.
- **The credential binding exists in two languages** — `agent/src/credential-binding.mjs`
  and `gate.rs`. They must agree byte for byte or the check verifies nothing.
  `agent/test/credential-binding.test.mjs` runs the compiled Rust and compares,
  so do not "fix" one side without running it.
- **Idempotency records are written *after* the outbound call.** A crash
  mid-flight therefore leaves no record and the retry goes out. That direction is
  deliberate: a visible possible-duplicate beats a silent "already done" for an
  order that never happened.
- **On Windows**, host builds need the GNU toolchain
  (`rustup toolchain install stable-x86_64-pc-windows-gnu`) because there is no
  MSVC linker by default. `verify.mjs` selects it automatically.

## 8. What this deliberately does not do

Listed honestly in [`submission/STATUS_AND_ROADMAP.md`](submission/STATUS_AND_ROADMAP.md).
The short version: the enclave can prove a credential was committed to *this*
action, but not that the underlying BBS+ proof was ever valid — closing that
needs in-contract `vp.verify`, which the node does not serve. Mandates still have
no lifecycle beyond a single seeded `default` entry.
