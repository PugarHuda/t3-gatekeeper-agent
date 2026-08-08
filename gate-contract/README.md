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

| Version | State |
| --- | --- |
| 0.8.0 | current source — adds `allowed_issuers` + `counterparty_limits`. Built and unit-tested, **not registered** (testnet credits exhausted). |
| 0.7.0 | `contract_id 479` — live on testnet. Adds `execute_action` + clock-derived spend window. |
| 0.6.0 | `contract_id 175` — the version the live `HTTP 200` egress evidence was captured against. |

## Deploy

Register the WASM to your tenant from the agent side — see `../agent` (`npm run
setup`), which calls `tenant.contracts.register({ tail: "gate", version, wasm })`.
