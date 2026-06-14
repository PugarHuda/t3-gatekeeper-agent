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
| expiry | `cluster_timestamp <= mandate.expires_at_secs` (`0` = no expiry) |

Allow-lists are **least-privilege**: an empty list permits nothing (an
unconfigured mandate must not approve everything), and the wildcard `"*"`
explicitly permits any value. Asset/kind matching is exact (case-sensitive).

It reads the mandate from the tenant-provisioned `mandate` KV map
(`z:<tid>:mandate`, key `default`) so the **calling agent cannot forge it**. An
inline mandate may be passed for demo/dry-run; the response reports
`mandate_source`. The decision, reasons, tenant DID, and cluster timestamp form a
structured audit row.

Host capabilities used: `tenant_context` (DID + cluster timestamp),
`kv_store` (read mandate), `logging` (audit line).

## Build

Requires the `wasm32-wasip2` target. On **Windows without Visual C++ Build
Tools**, use the bundled-linker `windows-gnu` toolchain (build-script crates
need a native host linker the MSVC target lacks):

```powershell
rustup toolchain install stable-x86_64-pc-windows-gnu
rustup target add wasm32-wasip2 --toolchain stable-x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu build --target wasm32-wasip2 --release
```

On Linux/macOS the plain target works:

```bash
rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2 --release
```

Output: `target/wasm32-wasip2/release/gate_contract.wasm`.

Run the host unit tests (pure `decide()` logic):

```bash
cargo test --target x86_64-pc-windows-gnu     # or your host triple
```

## Deploy

Register the WASM to your tenant from the agent side — see `../agent` (`npm run
setup`), which calls `tenant.contracts.register({ tail: "gate", version, wasm })`.
