# gate-contract

A Terminal 3 **z-space tenant TEE contract** that enforces a delegated agent's
spending **mandate** inside the Enclave. It is the hardware half of the
Gatekeeper Agent: the agent proves *who* the user is and *that they are eligible*
(a BBS+ verifiable credential); this contract enforces *how much / what / until
when* — bounds the agent itself cannot override.

## What it does

`evaluate(req)` takes a proposed action and checks it against the user's mandate:

| Gate | Rule |
| --- | --- |
| amount | `action.amount_cents <= mandate.max_amount_cents` |
| asset | `action.asset ∈ mandate.allowed_assets` (**deny-by-default**: empty = nothing allowed; `"*"` = any) |
| kind | `action.kind ∈ mandate.allowed_kinds` (**deny-by-default**: empty = nothing allowed; `"*"` = any) |
| counterparty | `action.counterparty ∈ mandate.allowed_counterparties` (opt-in: empty = not enforced) |
| **issuer** | `action.issuer ∈ mandate.allowed_issuers` — which KYC issuers this mandate trusts (opt-in) |
| **sub-limit** | `action.amount_cents <= mandate.counterparty_limits[counterparty]`, applied *in addition* to the global cap |
| valid-after | `cluster_timestamp >= mandate.valid_after_secs` (`0` = active immediately) |
| expiry | `cluster_timestamp <= mandate.expires_at_secs` (`0` = no expiry) |
| **credential** | `mandate.credential_key` names the entry in `z:<tid>:secrets` holding the bearer token for the outbound call. The agent never sees it — the host hands the value to the enclave, which puts it in the `Authorization` header. Empty = send no credential. |
| **require-credential** | when true, `execute_action` refuses any action without a credential binding that matches it. Off by default; a mandate that names `allowed_issuers` should set it, or the issuer check is only as good as the caller's honesty. |
| **require-idempotency-key** | when true, an action with no idempotency key is refused. Worth setting on any mandate that moves money: without a key a timeout is ambiguous, and the safe response (retry) is also the dangerous one. |

Eleven rules in total, all in `src/gate.rs`. The last three are why `evaluate`
alone is not the whole story — they are enforced by `execute_action`, which is
the function that also makes the outbound call.

Allow-lists are **least-privilege**: an empty list permits nothing (an
unconfigured mandate must not approve everything), and the wildcard `"*"`
explicitly permits any value. Asset/kind matching is exact (case-sensitive).

**Why `allowed_issuers` matters.** A BBS+ signature proves the issuer signed the
claim — it says nothing about whether that issuer is anyone the fund trusts, and
a delegated agent can generate its own issuer key. Without this dimension an
agent can mint its own "accredited investor" credential and pass the gate.

## Functions

| Function | Purpose |
| --- | --- |
| `evaluate` | Decide only. Accepts an **inline** mandate for dry-runs; reports `mandate_source`. |
| `execute_action` | **The one that cannot be bypassed.** Reads the mandate from KV (no inline escape hatch), decides, and performs the outbound HTTP call in the *same* enclave invocation — so a rejected action never reaches the network. |
| `dispatch_action` | Raw outbound call, kept for diagnostics. |
| `spend` | Stateful cumulative velocity limit. The window is derived from the cluster clock, **not** the caller — a caller-supplied window resets the counter by renaming it. |

`evaluate` and `dispatch_action` are separate host calls, so an agent can simply
skip the first: on their own they make the gate *advisory*. `execute_action`
exists because the decision and the network call have to be the same call.

It reads the mandate from the tenant-provisioned `mandate` KV map
(`z:<tid>:mandate`, key `default`) so the **calling agent cannot forge it**. The
decision, reasons, tenant DID, and cluster timestamp form a structured audit row.

Host capabilities used: `tenant_context` (DID + cluster timestamp),
`kv_store` (read mandate, read-modify-write the spend counter), `logging`,
`http` (outbound dispatch — gated by the caller's `agent-auth` grant).

## Build

Requires the `wasm32-wasip2` target. On **Windows without Visual C++ Build
Tools**, use the bundled-linker `windows-gnu` toolchain (build-script crates
need a native host linker the MSVC target lacks):

```powershell
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup target add wasm32-wasip2 --toolchain stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu build --lib --target wasm32-wasip2 --release
```

On Linux/macOS the plain target works:

```bash
rustup target add wasm32-wasip2
cargo build --lib --target wasm32-wasip2 --release
```

Output: `target/wasm32-wasip2/release/gate_contract.wasm`.

> `--lib` matters: the crate also ships a `gate_cli` binary (the host build of the
> same decision logic, used by `qa-console/`). Its wasm-only code paths reference
> host bindings that only exist in the library, so building *all* targets for
> wasm fails. Cargo cannot target-gate a binary, so scope the wasm build to the lib.

Run the host unit tests — 28 of them, covering every mandate dimension including
deny-by-default, boundary amounts, a self-issued credential, and a sub-limit that
must not be rescued by the global cap:

```bash
cargo test --target x86_64-pc-windows-gnu     # or your host triple
```

The crate also builds `gate_cli`, a host binary exposing the same `decide()` so
`../qa-console` can drive the real rules from a browser without a second copy of
them in JavaScript.

## Versions

The version is single-sourced from `Cargo.toml`: Rust reads it through
`env!("CARGO_PKG_VERSION")` and the agent parses the same file. There is no
second place to edit, so a contract cannot be registered under a number that is
not the code inside it.

| Version | State |
| --- | --- |
| **0.10.0** | **current source, live on testnet as `contract_id 749`** (registered 2026-08-27). Adds the sealed credential (`credential_key`), the credential/action binding, idempotent dispatch, and `http-with-placeholders`. Promoted only after `npm run probe` registered it under a throwaway tail and invoked it, which is how we confirmed the node really serves `http-with-placeholders`. |
| 0.8.0 – 0.9.0 | never registered — the account balance was zero for three weeks (bugs #16, #17). 0.8.0 added `allowed_issuers` + `counterparty_limits`; both ship inside 0.10.0. |
| 0.7.0 | `contract_id 479`. Added `execute_action` + the clock-derived spend window. |
| 0.6.0 | `contract_id 175` — the version the first live `HTTP 200` egress evidence was captured against. |
| 0.5.0 | `contract_id 165` — a clean version registered to make "latest" healthy after 0.4.0 bricked the tail (bug #8). |
| 0.4.0 | `contract_id 164` — imported `host:interfaces/vp`; registers, then 500s on every call (bug #7). Kept as the repro. |
| 0.3.0 | `contract_id 160` — added `spend()`, the stateful velocity limit. |

## Deploy

Register the WASM to your tenant from the agent side — see `../agent` (`npm run
setup`), which calls `tenant.contracts.register({ tail: "gate", version, wasm })`.
