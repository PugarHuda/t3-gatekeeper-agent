//! gate::evaluate — pure mandate enforcement.
//!
//! `decide()` is target-independent and unit-tested on the host. The wasm path
//! adds the three host calls: tenant DID + cluster timestamp (tenant-context),
//! the provisioned mandate (kv-store), and an audit line (logging).

#[derive(serde::Deserialize)]
pub struct Action {
    pub kind: String,
    pub asset: String,
    pub amount_cents: u64,
    /// Optional destination (merchant / payee DID / address) for counterparty gating.
    #[serde(default)]
    pub counterparty: Option<String>,
}

#[derive(serde::Deserialize, Clone)]
pub struct Mandate {
    pub max_amount_cents: u64,
    #[serde(default)]
    pub allowed_assets: Vec<String>,
    #[serde(default)]
    pub allowed_kinds: Vec<String>,
    /// Allowed payees. OPT-IN dimension: empty = not enforced; when non-empty the
    /// action's `counterparty` must be present and listed (or `"*"`).
    #[serde(default)]
    pub allowed_counterparties: Vec<String>,
    /// Unix seconds; `0` means "no expiry".
    #[serde(default)]
    pub expires_at_secs: u64,
    /// Unix seconds; `0` means "active immediately". The mandate is not usable
    /// before this time (a scheduled / future-dated authorization).
    #[serde(default)]
    pub valid_after_secs: u64,
}

#[derive(serde::Deserialize)]
pub struct EvaluateReq {
    pub action: Action,
    #[serde(default)]
    pub mandate: Option<Mandate>,
}

#[derive(serde::Serialize)]
pub struct AuditRow {
    pub kind: String,
    pub asset: String,
    pub amount_cents: u64,
    pub max_amount_cents: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counterparty: Option<String>,
}

#[derive(serde::Serialize)]
pub struct Decision {
    pub decision: &'static str,
    pub reasons: Vec<String>,
    pub evaluated_at_secs: u64,
    pub mandate_source: &'static str,
    pub tenant_did: String,
    pub audit: AuditRow,
}

/// Returns true if `value` is permitted by an allow-list. Deny-by-default: an
/// EMPTY list permits nothing (least privilege — an unconfigured mandate must
/// not approve everything). The wildcard `"*"` explicitly permits any value.
fn list_allows(list: &[String], value: &str) -> bool {
    list.iter().any(|x| x == "*" || x == value)
}

/// Pure gate logic. Returns `(approved, reasons)`. A failing check appends a
/// human-readable reason; an empty reason list means every gate passed.
/// `allowed_assets`/`allowed_kinds` are deny-by-default (empty = nothing allowed;
/// `"*"` = any). `allowed_counterparties` is opt-in (empty = not enforced).
/// `expires_at_secs`/`valid_after_secs` of 0 disable that time bound.
pub fn decide(action: &Action, mandate: &Mandate, now_secs: u64) -> (bool, Vec<String>) {
    let mut reasons: Vec<String> = Vec::new();

    if mandate.valid_after_secs != 0 && now_secs < mandate.valid_after_secs {
        reasons.push(format!(
            "mandate not active until {} (now {now_secs})",
            mandate.valid_after_secs
        ));
    }
    if mandate.expires_at_secs != 0 && now_secs > mandate.expires_at_secs {
        reasons.push(format!(
            "mandate expired at {} (now {now_secs})",
            mandate.expires_at_secs
        ));
    }
    if !list_allows(&mandate.allowed_kinds, &action.kind) {
        reasons.push(format!(
            "action kind '{}' not permitted (allowed_kinds={:?})",
            action.kind, mandate.allowed_kinds
        ));
    }
    if !list_allows(&mandate.allowed_assets, &action.asset) {
        reasons.push(format!(
            "asset '{}' not permitted (allowed_assets={:?})",
            action.asset, mandate.allowed_assets
        ));
    }
    if !mandate.allowed_counterparties.is_empty() {
        match action.counterparty.as_deref() {
            Some(cp) if list_allows(&mandate.allowed_counterparties, cp) => {}
            Some(cp) => reasons.push(format!(
                "counterparty '{cp}' not permitted (allowed_counterparties={:?})",
                mandate.allowed_counterparties
            )),
            None => reasons.push(
                "counterparty required by mandate but none supplied".to_string(),
            ),
        }
    }
    if action.amount_cents > mandate.max_amount_cents {
        reasons.push(format!(
            "amount {} exceeds mandate max {}",
            action.amount_cents, mandate.max_amount_cents
        ));
    }

    (reasons.is_empty(), reasons)
}

fn build_decision(
    action: &Action,
    mandate: &Mandate,
    now_secs: u64,
    source: &'static str,
    tenant_did: String,
) -> Decision {
    let (ok, reasons) = decide(action, mandate, now_secs);
    Decision {
        decision: if ok { "approved" } else { "rejected" },
        reasons,
        evaluated_at_secs: now_secs,
        mandate_source: source,
        tenant_did,
        audit: AuditRow {
            kind: action.kind.clone(),
            asset: action.asset.clone(),
            amount_cents: action.amount_cents,
            max_amount_cents: mandate.max_amount_cents,
            counterparty: action.counterparty.clone(),
        },
    }
}

/// Entry point from `lib.rs`. `input` is the raw JSON bytes of the request.
pub fn evaluate(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: EvaluateReq =
        serde_json::from_slice(input).map_err(|e| format!("evaluate: bad input: {e}"))?;

    #[cfg(target_arch = "wasm32")]
    {
        evaluate_wasm(req)
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        // Host/test path: an inline mandate is required (no KV host available),
        // and time bounds are not enforced because there is no cluster timestamp.
        let mandate = req
            .mandate
            .ok_or("evaluate: inline mandate required off the wasm target")?;
        let decision = build_decision(
            &req.action,
            &mandate,
            0,
            "inline",
            "did:t3n:host-test".to_string(),
        );
        serde_json::to_vec(&decision).map_err(|e| e.to_string())
    }
}

#[cfg(target_arch = "wasm32")]
use crate::host::{
    interfaces::{kv_store, logging},
    tenant::tenant_context,
};

#[cfg(target_arch = "wasm32")]
fn evaluate_wasm(req: EvaluateReq) -> Result<Vec<u8>, String> {
    let tid = tenant_context::tenant_did();
    let tid_hex = hex::encode(&tid);
    let now_secs = tenant_context::cluster_timestamp_secs();

    // Inline mandate is for demo/dry-run only. The trusted path reads the
    // tenant-provisioned mandate from KV, which the calling agent cannot forge.
    let (mandate, source) = match req.mandate {
        Some(m) => (m, "inline"),
        None => (read_mandate(&tid_hex)?, "kv"),
    };

    let decision = build_decision(
        &req.action,
        &mandate,
        now_secs,
        source,
        format!("did:t3n:{tid_hex}"),
    );

    let _ = logging::info(&format!(
        "gate evaluate: kind={} asset={} amount_cents={} source={source} -> {}",
        req.action.kind, req.action.asset, req.action.amount_cents, decision.decision
    ));

    serde_json::to_vec(&decision).map_err(|e| e.to_string())
}

#[cfg(target_arch = "wasm32")]
fn read_mandate(tid_hex: &str) -> Result<Mandate, String> {
    let map_name = format!("z:{tid_hex}:mandate");
    let bytes = kv_store::get(&map_name, b"default")
        .map_err(|e| format!("kv read: {e}"))?
        .ok_or("no mandate provisioned in z:<tid>:mandate[default] — seed it via the tenant SDK")?;
    serde_json::from_slice(&bytes).map_err(|e| format!("mandate parse: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mandate() -> Mandate {
        Mandate {
            max_amount_cents: 500_000,
            allowed_assets: vec!["USDC".to_string(), "USD".to_string()],
            allowed_kinds: vec!["rwa.buy".to_string()],
            allowed_counterparties: vec![],
            expires_at_secs: 0,
            valid_after_secs: 0,
        }
    }

    fn action(kind: &str, asset: &str, amount: u64) -> Action {
        Action { kind: kind.into(), asset: asset.into(), amount_cents: amount, counterparty: None }
    }

    #[test]
    fn approves_within_all_bounds() {
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 100_000), &mandate(), 0);
        assert!(ok, "expected approval, got {reasons:?}");
    }

    #[test]
    fn rejects_over_amount() {
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 900_000), &mandate(), 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("exceeds mandate max")));
    }

    #[test]
    fn rejects_wrong_asset_and_kind() {
        let (ok, reasons) = decide(&action("swap", "DOGE", 1), &mandate(), 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("allowed_assets")));
        assert!(reasons.iter().any(|r| r.contains("allowed_kinds")));
    }

    #[test]
    fn rejects_when_expired() {
        let mut m = mandate();
        m.expires_at_secs = 1000;
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 1), &m, 2000);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("expired")));
    }

    #[test]
    fn amount_exactly_at_cap_is_approved() {
        let (ok, _) = decide(&action("rwa.buy", "USDC", 500_000), &mandate(), 0);
        assert!(ok);
    }

    #[test]
    fn one_cent_over_cap_is_rejected() {
        let (ok, _) = decide(&action("rwa.buy", "USDC", 500_001), &mandate(), 0);
        assert!(!ok);
    }

    #[test]
    fn empty_allowlists_deny_by_default() {
        let m = Mandate { max_amount_cents: u64::MAX, allowed_assets: vec![], allowed_kinds: vec![], allowed_counterparties: vec![], expires_at_secs: 0, valid_after_secs: 0 };
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 1), &m, 0);
        assert!(!ok, "empty allow-lists must deny");
        assert!(reasons.iter().any(|r| r.contains("allowed_kinds")));
        assert!(reasons.iter().any(|r| r.contains("allowed_assets")));
    }

    #[test]
    fn wildcard_allows_any_value() {
        let m = Mandate { max_amount_cents: 1_000, allowed_assets: vec!["*".into()], allowed_kinds: vec!["*".into()], allowed_counterparties: vec![], expires_at_secs: 0, valid_after_secs: 0 };
        let (ok, _) = decide(&action("anything", "DOGE", 1_000), &m, 0);
        assert!(ok);
    }

    #[test]
    fn asset_match_is_case_sensitive() {
        let (ok, reasons) = decide(&action("rwa.buy", "usdc", 1), &mandate(), 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("allowed_assets")));
    }

    // --- new dimension: counterparty allow-list (opt-in) ---
    #[test]
    fn approves_listed_counterparty() {
        let mut m = mandate();
        m.allowed_counterparties = vec!["did:t3n:acme".into()];
        let mut a = action("rwa.buy", "USDC", 1);
        a.counterparty = Some("did:t3n:acme".into());
        let (ok, reasons) = decide(&a, &m, 0);
        assert!(ok, "{reasons:?}");
    }

    #[test]
    fn rejects_unlisted_counterparty() {
        let mut m = mandate();
        m.allowed_counterparties = vec!["did:t3n:acme".into()];
        let mut a = action("rwa.buy", "USDC", 1);
        a.counterparty = Some("did:t3n:evil".into());
        let (ok, reasons) = decide(&a, &m, 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("counterparty 'did:t3n:evil'")));
    }

    #[test]
    fn rejects_missing_counterparty_when_required() {
        let mut m = mandate();
        m.allowed_counterparties = vec!["did:t3n:acme".into()];
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 1), &m, 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("counterparty required")));
    }

    // --- new dimension: valid-after (not-before) window ---
    #[test]
    fn rejects_before_valid_after() {
        let mut m = mandate();
        m.valid_after_secs = 5000;
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 1), &m, 1000);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("not active until")));
    }

    #[test]
    fn approves_after_valid_after() {
        let mut m = mandate();
        m.valid_after_secs = 5000;
        let (ok, _) = decide(&action("rwa.buy", "USDC", 1), &m, 6000);
        assert!(ok);
    }
}
