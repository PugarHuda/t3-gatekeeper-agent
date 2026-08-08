//! gate_cli — run the contract's REAL decision logic on the host.
//!
//! Same `gate::decide()` the enclave runs; only the host calls (KV, clock, http)
//! are absent, so the caller passes the mandate and `now` explicitly. This exists
//! so the QA console and the Playwright suite can exercise the actual rules
//! without spending testnet credits — and without a second copy of the rules in
//! JavaScript, which would drift from the contract and prove nothing.
//!
//! Usage:  echo '{"action":{...},"mandate":{...},"now_secs":123}' | gate_cli
//! Output: {"decision":"approved"|"rejected","reasons":[...],"now_secs":123}
use std::io::Read;

#[path = "../gate.rs"]
mod gate;

#[derive(serde::Deserialize)]
struct Req {
    action: gate::Action,
    mandate: gate::Mandate,
    #[serde(default)]
    now_secs: u64,
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!(r#"{{"error":"could not read stdin"}}"#);
        std::process::exit(2);
    }
    let req: Req = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => {
            println!("{}", serde_json::json!({ "error": format!("bad input: {e}") }));
            std::process::exit(1);
        }
    };
    let (approved, reasons) = gate::decide(&req.action, &req.mandate, req.now_secs);
    println!(
        "{}",
        serde_json::json!({
            "decision": if approved { "approved" } else { "rejected" },
            "reasons": reasons,
            "now_secs": req.now_secs,
        })
    );
}
