//! gate-contract v0.1.0 — hardware-enforced action mandate gate.
//!
//! The agent layer authenticates the user (did:t3n) and proves eligibility via
//! a BBS+ verifiable credential. This contract is the independent SECOND gate:
//! it enforces the user's spending MANDATE inside the Enclave (max amount,
//! allowed assets, allowed action kinds, expiry) so the bound is held by
//! hardware, not by the agent's own promise.
//!
//! The mandate is provisioned ONCE by the tenant admin into the `mandate` KV
//! map (`z:<tid>:mandate`, key `default`) and the calling agent cannot override
//! it. For demo / dry-run an inline mandate may be passed in the request; the
//! response always reports which source was used.
//!
//! # Host-capability requirements
//! ```json
//! { "host_capabilities": ["kv_store", "logging", "tenant_context"] }
//! ```
#![warn(clippy::style)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.2.0";

wit_bindgen::generate!({
    world: "gate-contract",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

mod gate;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::gate_contract::contracts::Guest for Component {
    fn evaluate(
        req: exports::z::gate_contract::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("evaluate: missing input")?;
        gate::evaluate(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: alloc::vec::Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION must be MAJOR.MINOR.PATCH");
        for part in parts {
            assert!(part.parse::<u32>().is_ok(), "each part must be a number");
        }
    }
}
