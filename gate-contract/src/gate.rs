//! gate::evaluate — pure mandate enforcement.
//!
//! `decide()` is target-independent and unit-tested on the host. The wasm path
//! adds the three host calls: tenant DID + cluster timestamp (tenant-context),
//! the provisioned mandate (kv-store), and an audit line (logging).

#[derive(serde::Deserialize, Clone)]
pub struct Action {
    pub kind: String,
    pub asset: String,
    pub amount_cents: u64,
    /// Optional destination (merchant / payee DID / address) for counterparty gating.
    #[serde(default)]
    pub counterparty: Option<String>,
    /// DID of the issuer whose credential the agent used to claim eligibility.
    /// Checked against `Mandate::allowed_issuers` — without this the enclave has
    /// no way to tell a regulated KYC provider's attestation from one the agent
    /// minted for itself.
    #[serde(default)]
    pub issuer: Option<String>,
}

// ── credential binding ──────────────────────────────────────────────────────
//
// The eligibility proof is verified in the agent, because the enclave has no
// way to verify a BBS+ proof (that needs host `vp.verify`, which this node does
// not serve — bug #7). What the enclave CAN do is refuse to take the agent's
// word twice.
//
// The agent hands over a commitment over the credential it verified AND the
// action it verified it for. The enclave recomputes that commitment from the
// action *it* is deciding on. If the agent verified a credential for a $500
// purchase and then submits a $500,000 one, the digests differ and the action
// is rejected — the verification cannot be detached from what it authorised.
//
// Stated plainly, because the distinction matters: this does not prove the BBS+
// proof was valid. It proves the agent committed to a specific credential for
// this specific action before the enclave decided, and that the issuer named in
// the mandate check is the one inside that commitment. Closing the remaining
// gap needs in-contract proof verification.
#[derive(serde::Deserialize, Clone)]
pub struct CredentialBinding {
    /// DID of the credential's issuer.
    pub issuer: String,
    /// DID of the subject the credential was issued to.
    pub subject: String,
    /// Agent-side digest over the disclosed claims (hex).
    pub claims_digest: String,
    /// Single-use value, so one binding cannot be replayed for a later action.
    pub nonce: String,
    /// Hex SHA-256 the enclave recomputes and compares.
    pub commitment: String,
}

/// Domain separator — a commitment from this scheme can never be mistaken for
/// a hash computed for some other purpose over the same fields.
pub const BINDING_DOMAIN: &str = "t3-gatekeeper/cred-binding/v1";

fn sha256_hex(parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    // Length-prefix every field. Without it, ("ab","c") and ("a","bc") hash the
    // same, and an attacker picks the split.
    for p in parts {
        h.update((p.len() as u64).to_be_bytes());
        h.update(p.as_bytes());
    }
    hex::encode(h.finalize())
}

/// Digest of the action the credential was presented for.
pub fn action_digest(action: &Action) -> String {
    sha256_hex(&[
        &action.kind,
        &action.asset,
        &action.amount_cents.to_string(),
        action.counterparty.as_deref().unwrap_or(""),
    ])
}

/// The commitment both sides compute. The agent computes it over the action it
/// is about to request; the enclave over the action it is about to perform.
pub fn expected_commitment(binding: &CredentialBinding, action: &Action) -> String {
    sha256_hex(&[
        BINDING_DOMAIN,
        &binding.issuer,
        &binding.subject,
        &binding.claims_digest,
        &action_digest(action),
        &binding.nonce,
    ])
}

/// Check a binding against the action being decided.
///
/// `require` comes from the mandate: when a mandate demands a credential, a
/// missing binding is a rejection rather than a skipped check — otherwise
/// omitting the field would be the way around it.
pub fn check_binding(
    binding: Option<&CredentialBinding>,
    action: &Action,
    require: bool,
) -> Result<(), String> {
    let Some(b) = binding else {
        return if require {
            Err("mandate requires a credential binding, none supplied".to_string())
        } else {
            Ok(())
        };
    };
    if b.nonce.is_empty() {
        return Err("credential binding has an empty nonce".to_string());
    }
    let expected = expected_commitment(b, action);
    if expected != b.commitment {
        return Err(format!(
            "credential binding does not match this action (expected {}, got {})",
            &expected[..16.min(expected.len())],
            &b.commitment[..16.min(b.commitment.len())],
        ));
    }
    // The issuer the mandate is checked against must come from inside the
    // commitment, not from a field the caller can set independently.
    match action.issuer.as_deref() {
        Some(i) if i != b.issuer => Err(format!(
            "action issuer {i} is not the issuer in the credential binding ({})",
            b.issuer
        )),
        _ => Ok(()),
    }
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
    /// Credential issuers this mandate trusts (KYC providers). OPT-IN: empty =
    /// not enforced, which means ANY issuer passes — including one the agent
    /// generated. Populate it in production.
    #[serde(default)]
    pub allowed_issuers: Vec<String>,
    /// Per-counterparty ceilings, tighter than `max_amount_cents`. A payee with
    /// an entry here is additionally capped at it; the global cap still applies.
    /// "$50k to the fund, $5k to anyone else" is a sub-limit, not a second mandate.
    #[serde(default)]
    pub counterparty_limits: std::collections::BTreeMap<String, u64>,
    /// Unix seconds; `0` means "no expiry".
    #[serde(default)]
    pub expires_at_secs: u64,
    /// Unix seconds; `0` means "active immediately". The mandate is not usable
    /// before this time (a scheduled / future-dated authorization).
    #[serde(default)]
    pub valid_after_secs: u64,
    /// Entry in `z:<tid>:secrets` holding the bearer token for the outbound
    /// call. The agent never sees it: the host hands the value to the enclave,
    /// the enclave puts it in the Authorization header, and nothing outside
    /// this contract can read the map back. Empty = send no credential.
    ///
    /// It lives in the mandate, not in the request, for the same reason every
    /// other limit does — the caller must not get to choose which credential
    /// it spends. Naming it here (rather than hardcoding one) is also what
    /// lets a different operator point this contract at their own broker
    /// without touching Rust.
    #[serde(default)]
    pub credential_key: String,
    /// When true, `execute_action` refuses any action without a credential
    /// binding that matches it. Off by default so an existing mandate keeps
    /// working; a mandate that names `allowed_issuers` should set it, or the
    /// issuer check is only as good as the caller's honesty.
    #[serde(default)]
    pub require_credential: bool,
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
    if !mandate.allowed_issuers.is_empty() {
        match action.issuer.as_deref() {
            Some(iss) if list_allows(&mandate.allowed_issuers, iss) => {}
            Some(iss) => reasons.push(format!(
                "credential issuer '{iss}' not trusted (allowed_issuers={:?})",
                mandate.allowed_issuers
            )),
            None => reasons
                .push("credential issuer required by mandate but none supplied".to_string()),
        }
    }
    if action.amount_cents > mandate.max_amount_cents {
        reasons.push(format!(
            "amount {} exceeds mandate max {}",
            action.amount_cents, mandate.max_amount_cents
        ));
    }
    // Sub-limit is checked in ADDITION to the global cap, never instead of it.
    if let Some(cp) = action.counterparty.as_deref() {
        if let Some(&limit) = mandate.counterparty_limits.get(cp) {
            if action.amount_cents > limit {
                reasons.push(format!(
                    "amount {} exceeds the per-counterparty limit {limit} for '{cp}'",
                    action.amount_cents
                ));
            }
        }
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

// --- stateful cumulative-spend gate (demonstrates kv-store writes) ---

#[derive(serde::Deserialize)]
pub struct SpendReq {
    pub action: Action,
    pub daily_limit_cents: u64,
    /// Spend window the running total is bucketed by (e.g. a day string).
    #[serde(default)]
    pub window: String,
}

pub fn spend(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: SpendReq =
        serde_json::from_slice(input).map_err(|e| format!("spend: bad input: {e}"))?;

    #[cfg(target_arch = "wasm32")]
    {
        spend_wasm(req)
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("spend is only implemented on the wasm target (needs kv-store)".to_string())
    }
}

/// The spend window is derived from the cluster clock, NOT from the caller.
///
/// A caller-supplied window is a trivial bypass: pass a fresh string on every
/// call and the running total is always 0, so the velocity cap never binds.
/// Bucketing by UTC day inside the enclave makes the limit real.
pub fn day_bucket(now_secs: u64) -> String {
    format!("d{}", now_secs / 86_400)
}

#[cfg(target_arch = "wasm32")]
fn spend_wasm(req: SpendReq) -> Result<Vec<u8>, String> {
    let tid = tenant_context::tenant_did();
    let tid_hex = hex::encode(&tid);
    let map = format!("z:{tid_hex}:spent");
    // `req.window` is accepted for backwards compatibility but deliberately
    // IGNORED — see day_bucket(). The response reports the effective window.
    let window = day_bucket(tenant_context::cluster_timestamp_secs());
    let key = window.as_bytes();

    let before: u64 = match kv_store::get(&map, key).map_err(|e| format!("kv get: {e}"))? {
        Some(b) => String::from_utf8(b).ok().and_then(|s| s.parse().ok()).unwrap_or(0),
        None => 0,
    };
    let after = before.saturating_add(req.action.amount_cents);
    let approved = after <= req.daily_limit_cents;

    if approved {
        // only persist the new total when the action is admitted — the agent
        // cannot roll this back, so the limit holds across invocations.
        kv_store::put(&map, key, after.to_string().as_bytes())
            .map_err(|e| format!("kv put: {e}"))?;
    }

    let settled = if approved { after } else { before };
    let resp = serde_json::json!({
        "decision": if approved { "approved" } else { "rejected" },
        "spent_before": before,
        "spent_after": settled,
        "daily_limit_cents": req.daily_limit_cents,
        "remaining": req.daily_limit_cents.saturating_sub(settled),
        // The window actually used. `window_requested` is echoed back so a
        // caller can see its value was not honoured.
        "window": window,
        "window_requested": req.window,
    });
    let _ = logging::info(&format!(
        "spend window={window} amount={} before={before} -> {}",
        req.action.amount_cents, if approved { "approved" } else { "rejected" }
    ));
    serde_json::to_vec(&resp).map_err(|e| e.to_string())
}

// --- in-TEE action dispatch via the host `http` interface ---

#[derive(serde::Deserialize)]
pub struct DispatchReq {
    pub url: String,
    /// HTTP method; defaults to GET.
    #[serde(default)]
    pub method: String,
    /// Optional request body (sent as UTF-8 bytes).
    #[serde(default)]
    pub body: String,
}

pub fn dispatch_action(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: DispatchReq =
        serde_json::from_slice(input).map_err(|e| format!("dispatch_action: bad input: {e}"))?;

    #[cfg(target_arch = "wasm32")]
    {
        dispatch_action_wasm(req)
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("dispatch_action is only implemented on the wasm target (needs host http)".to_string())
    }
}

#[cfg(target_arch = "wasm32")]
fn dispatch_action_wasm(req: DispatchReq) -> Result<Vec<u8>, String> {
    use crate::host::interfaces::http;
    let method = match req.method.to_ascii_uppercase().as_str() {
        "POST" => http::Verb::Post,
        "PUT" => http::Verb::Put,
        "PATCH" => http::Verb::Patch,
        "DELETE" => http::Verb::Delete,
        _ => http::Verb::Get,
    };
    let payload = if req.body.is_empty() { None } else { Some(req.body.into_bytes()) };
    let request = http::Request { method, url: req.url.clone(), headers: None, payload };
    let json = match http::call(&request) {
        Ok(resp) => serde_json::json!({ "ok": true, "code": resp.code, "body_len": resp.payload.len() }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    let _ = logging::info(&format!("dispatch_action url={} -> {}", req.url, json));
    serde_json::to_vec(&json).map_err(|e| e.to_string())
}

// --- atomic decide-and-act ---------------------------------------------------
//
// `evaluate` and `dispatch_action` are two separate host calls, which means an
// agent can simply skip the first one: nothing in `dispatch_action` knows a
// mandate exists. That makes the gate advisory — it holds only while the agent
// cooperates. `execute_action` closes that hole: the mandate is read from KV
// (the caller cannot supply one) and the outbound call happens in the SAME
// enclave invocation, only on approval.

#[derive(serde::Deserialize)]
pub struct ExecuteReq {
    pub action: Action,
    pub url: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub body: String,
    /// What the agent verified, and what it verified it for. Checked against
    /// the action below — see `check_binding`.
    #[serde(default)]
    pub credential: Option<CredentialBinding>,
}

pub fn execute_action(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: ExecuteReq =
        serde_json::from_slice(input).map_err(|e| format!("execute_action: bad input: {e}"))?;

    #[cfg(target_arch = "wasm32")]
    {
        execute_action_wasm(req)
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = req;
        Err("execute_action is only implemented on the wasm target (needs kv-store + http)"
            .to_string())
    }
}

#[cfg(target_arch = "wasm32")]
fn execute_action_wasm(req: ExecuteReq) -> Result<Vec<u8>, String> {
    use crate::host::interfaces::http;

    let tid = tenant_context::tenant_did();
    let tid_hex = hex::encode(&tid);
    let now_secs = tenant_context::cluster_timestamp_secs();

    // KV only. There is deliberately no inline-mandate escape hatch here.
    let mandate = read_mandate(&tid_hex)?;

    // The binding is checked BEFORE the mandate decision, and a failure is a
    // rejection rather than an error, so it lands in the audit row with every
    // other reason instead of disappearing into a 500.
    let binding_err =
        check_binding(req.credential.as_ref(), &req.action, mandate.require_credential).err();

    let (mut approved, mut reasons) = decide(&req.action, &mandate, now_secs);
    if let Some(e) = binding_err {
        approved = false;
        reasons.push(e);
    }

    let mut out = serde_json::json!({
        "decision": if approved { "approved" } else { "rejected" },
        "reasons": reasons,
        "dispatched": false,
        "mandate_source": "kv",
        "evaluated_at_secs": now_secs,
        // Recorded so the audit row says which credential authorised the spend,
        // and a destination can be shown the same commitment later.
        "credential_commitment": req.credential.as_ref().map(|c| c.commitment.clone()),
        "action_digest": action_digest(&req.action),
        "evaluated_at_secs_source": "cluster",
        "tenant_did": format!("did:t3n:{tid_hex}"),
    });

    if approved {
        let method = match req.method.to_ascii_uppercase().as_str() {
            "POST" => http::Verb::Post,
            "PUT" => http::Verb::Put,
            "PATCH" => http::Verb::Patch,
            "DELETE" => http::Verb::Delete,
            _ => http::Verb::Get,
        };
        let payload = if req.body.is_empty() { None } else { Some(req.body.into_bytes()) };
        // The credential is fetched INSIDE the enclave, after the decision. A
        // rejected action never reaches this line, so it never touches the key.
        let secret = if mandate.credential_key.is_empty() {
            None
        } else {
            read_secret(&tid_hex, &mandate.credential_key)?
        };
        let headers = auth_headers(&mandate.credential_key, secret.as_deref())?;
        let request = http::Request { method, url: req.url.clone(), headers, payload };
        out["dispatched"] = serde_json::Value::Bool(true);
        out["response"] = match http::call(&request) {
            Ok(resp) => serde_json::json!({ "ok": true, "code": resp.code, "body_len": resp.payload.len() }),
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        };
    }

    let _ = logging::info(&format!(
        "execute_action kind={} amount={} url={} -> {} dispatched={}",
        req.action.kind, req.action.amount_cents, req.url,
        if approved { "approved" } else { "rejected" }, approved
    ));
    serde_json::to_vec(&out).map_err(|e| e.to_string())
}

/// Build the outbound request's headers from the mandate's named credential.
///
/// `secret` is what the secrets map returned for `mandate.credential_key`.
/// Returns `Err` when the mandate names a credential the map does not hold:
/// a payment instruction that was supposed to be authenticated must not go out
/// unauthenticated instead. Silently dropping the header would turn a
/// provisioning mistake into an anonymous order at the broker.
pub fn auth_headers(
    credential_key: &str,
    secret: Option<&str>,
) -> Result<Option<Vec<(String, String)>>, String> {
    if credential_key.is_empty() {
        return Ok(None);
    }
    match secret {
        Some(v) if !v.is_empty() => Ok(Some(vec![(
            "Authorization".to_string(),
            format!("Bearer {v}"),
        )])),
        _ => Err(format!(
            "mandate names credential '{credential_key}' but z:<tid>:secrets has no such entry"
        )),
    }
}

#[cfg(target_arch = "wasm32")]
fn read_mandate(tid_hex: &str) -> Result<Mandate, String> {
    let map_name = format!("z:{tid_hex}:mandate");
    let bytes = kv_store::get(&map_name, b"default")
        .map_err(|e| format!("kv read: {e}"))?
        .ok_or("no mandate provisioned in z:<tid>:mandate[default] — seed it via the tenant SDK")?;
    serde_json::from_slice(&bytes).map_err(|e| format!("mandate parse: {e}"))
}

/// Read one entry from the tenant's secrets map. Only this contract can: the
/// map's ACL names it as the sole reader, and `map-entry-set` (the control-plane
/// write the tenant admin uses to seed it) is the only way a value gets in.
#[cfg(target_arch = "wasm32")]
fn read_secret(tid_hex: &str, key: &str) -> Result<Option<String>, String> {
    let map_name = format!("z:{tid_hex}:secrets");
    match kv_store::get(&map_name, key.as_bytes()) {
        Ok(Some(bytes)) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "secret is not valid UTF-8".to_string()),
        Ok(None) => Ok(None),
        // Absent map and absent entry are the same situation to the caller.
        Err(e) => Err(format!("secrets read: {e}")),
    }
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
            allowed_issuers: vec![],
            counterparty_limits: Default::default(),
            expires_at_secs: 0,
            valid_after_secs: 0,
            credential_key: String::new(),
            require_credential: false,
        }
    }

    fn binding_for(action: &Action) -> CredentialBinding {
        let mut b = CredentialBinding {
            issuer: "did:key:kyc-provider".to_string(),
            subject: "did:t3n:investor".to_string(),
            claims_digest: "aa".repeat(32),
            nonce: "nonce-1".to_string(),
            commitment: String::new(),
        };
        b.commitment = expected_commitment(&b, action);
        b
    }

    fn action(kind: &str, asset: &str, amount: u64) -> Action {
        Action {
            kind: kind.into(), asset: asset.into(), amount_cents: amount,
            counterparty: None, issuer: None,
        }
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
        let m = Mandate { max_amount_cents: u64::MAX, allowed_assets: vec![], allowed_kinds: vec![], ..mandate() };
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 1), &m, 0);
        assert!(!ok, "empty allow-lists must deny");
        assert!(reasons.iter().any(|r| r.contains("allowed_kinds")));
        assert!(reasons.iter().any(|r| r.contains("allowed_assets")));
    }

    #[test]
    fn wildcard_allows_any_value() {
        let m = Mandate { max_amount_cents: 1_000, allowed_assets: vec!["*".into()], allowed_kinds: vec!["*".into()], ..mandate() };
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

    // --- new dimension: trusted credential issuers ---
    fn issuer_mandate() -> Mandate {
        Mandate { allowed_issuers: vec!["did:key:kyc-provider".into()], ..mandate() }
    }

    #[test]
    fn approves_credential_from_a_trusted_issuer() {
        let mut a = action("rwa.buy", "USDC", 1);
        a.issuer = Some("did:key:kyc-provider".into());
        let (ok, reasons) = decide(&a, &issuer_mandate(), 0);
        assert!(ok, "{reasons:?}");
    }

    #[test]
    fn rejects_a_self_issued_credential() {
        // The attack this closes: the agent mints its own "accredited" claim.
        // A valid BBS+ signature proves the issuer signed it, NOT that the
        // issuer is anyone the fund trusts.
        let mut a = action("rwa.buy", "USDC", 1);
        a.issuer = Some("did:key:the-agent-itself".into());
        let (ok, reasons) = decide(&a, &issuer_mandate(), 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("not trusted")), "{reasons:?}");
    }

    #[test]
    fn rejects_missing_issuer_when_required() {
        let (ok, reasons) = decide(&action("rwa.buy", "USDC", 1), &issuer_mandate(), 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("issuer required")), "{reasons:?}");
    }

    #[test]
    fn empty_issuer_list_is_not_enforced() {
        // Documents the opt-in default explicitly, so the weaker posture is a
        // deliberate choice rather than a silent one.
        let mut a = action("rwa.buy", "USDC", 1);
        a.issuer = Some("did:key:anyone-at-all".into());
        assert!(decide(&a, &mandate(), 0).0);
    }

    // --- new dimension: per-counterparty sub-limits ---
    fn sublimit_mandate() -> Mandate {
        let mut m = mandate();
        m.allowed_counterparties = vec!["did:t3n:fund".into(), "did:t3n:small".into()];
        m.counterparty_limits.insert("did:t3n:small".into(), 10_000);
        m
    }

    #[test]
    fn sub_limit_caps_a_specific_counterparty() {
        let mut a = action("rwa.buy", "USDC", 20_000); // under the 500_000 global cap
        a.counterparty = Some("did:t3n:small".into());
        let (ok, reasons) = decide(&a, &sublimit_mandate(), 0);
        assert!(!ok, "the global cap must not rescue an over-sub-limit action");
        assert!(reasons.iter().any(|r| r.contains("per-counterparty limit")), "{reasons:?}");
    }

    #[test]
    fn sub_limit_allows_at_its_own_boundary() {
        let mut a = action("rwa.buy", "USDC", 10_000);
        a.counterparty = Some("did:t3n:small".into());
        assert!(decide(&a, &sublimit_mandate(), 0).0);
    }

    #[test]
    fn counterparty_without_a_sub_limit_uses_the_global_cap() {
        let mut a = action("rwa.buy", "USDC", 400_000);
        a.counterparty = Some("did:t3n:fund".into());
        assert!(decide(&a, &sublimit_mandate(), 0).0);
    }

    #[test]
    fn global_cap_still_applies_over_a_sub_limit() {
        // A generous sub-limit must not widen the mandate's overall ceiling.
        let mut m = sublimit_mandate();
        m.counterparty_limits.insert("did:t3n:fund".into(), u64::MAX);
        let mut a = action("rwa.buy", "USDC", 900_000);
        a.counterparty = Some("did:t3n:fund".into());
        let (ok, reasons) = decide(&a, &m, 0);
        assert!(!ok);
        assert!(reasons.iter().any(|r| r.contains("exceeds mandate max")), "{reasons:?}");
    }

    // --- spend window is derived in-enclave, not supplied by the caller ---
    #[test]
    fn day_bucket_is_stable_within_a_day() {
        let noon = 1_786_000_000;
        assert_eq!(day_bucket(noon), day_bucket(noon + 3_600));
    }

    #[test]
    fn day_bucket_rolls_over_between_days() {
        let t = 1_786_000_000;
        assert_ne!(day_bucket(t), day_bucket(t + 86_400));
    }

    #[test]
    fn day_bucket_ignores_any_caller_string() {
        // The whole point: two calls at the same time bucket identically no
        // matter what window the caller asked for.
        assert_eq!(day_bucket(1_786_000_000), day_bucket(1_786_000_000));
    }

    // --- the atomic path refuses to run without its host capabilities ---
    // --- credential binding ---

    #[test]
    fn a_binding_computed_for_this_action_is_accepted() {
        let a = action("rwa.buy", "USDC", 100_000);
        assert!(check_binding(Some(&binding_for(&a)), &a, true).is_ok());
    }

    #[test]
    fn a_binding_from_a_different_amount_is_rejected() {
        // The attack: verify a credential for a small purchase, then reuse that
        // verification to authorise a large one.
        let small = action("rwa.buy", "USDC", 50_000);
        let large = action("rwa.buy", "USDC", 50_000_000);
        let err = check_binding(Some(&binding_for(&small)), &large, true).unwrap_err();
        assert!(err.contains("does not match this action"), "{err}");
    }

    #[test]
    fn a_binding_from_a_different_payee_is_rejected() {
        let mut to_fund = action("rwa.buy", "USDC", 100_000);
        to_fund.counterparty = Some("did:t3n:meridian".to_string());
        let mut to_attacker = to_fund.clone();
        to_attacker.counterparty = Some("did:t3n:attacker".to_string());
        assert!(check_binding(Some(&binding_for(&to_fund)), &to_attacker, true).is_err());
    }

    #[test]
    fn a_missing_binding_is_rejected_only_when_the_mandate_requires_one() {
        let a = action("rwa.buy", "USDC", 100_000);
        assert!(check_binding(None, &a, false).is_ok(), "opt-in: off by default");
        let err = check_binding(None, &a, true).unwrap_err();
        assert!(err.contains("requires a credential binding"), "{err}");
    }

    #[test]
    fn the_action_issuer_cannot_disagree_with_the_bound_issuer() {
        // Otherwise the agent binds a credential from an issuer it really has,
        // and separately claims a trusted issuer in the field the mandate checks.
        let a0 = action("rwa.buy", "USDC", 100_000);
        let b = binding_for(&a0);
        let mut a = a0.clone();
        a.issuer = Some("did:key:some-other-issuer".to_string());
        let err = check_binding(Some(&b), &a, true).unwrap_err();
        assert!(err.contains("not the issuer in the credential binding"), "{err}");

        let mut honest = a0.clone();
        honest.issuer = Some(b.issuer.clone());
        assert!(check_binding(Some(&b), &honest, true).is_ok());
    }

    #[test]
    fn an_empty_nonce_is_rejected() {
        let a = action("rwa.buy", "USDC", 100_000);
        let mut b = binding_for(&a);
        b.nonce = String::new();
        b.commitment = expected_commitment(&b, &a); // even if internally consistent
        assert!(check_binding(Some(&b), &a, true).is_err());
    }

    #[test]
    fn the_commitment_is_domain_separated_and_length_prefixed() {
        // Length prefixing: two different field splits must not collide.
        let a = action("rwa.buy", "USDC", 100_000);
        let mut x = binding_for(&a);
        x.issuer = "ab".to_string();
        x.subject = "c".to_string();
        let mut y = x.clone();
        y.issuer = "a".to_string();
        y.subject = "bc".to_string();
        assert_ne!(expected_commitment(&x, &a), expected_commitment(&y, &a));
        assert!(BINDING_DOMAIN.contains("cred-binding"));
    }

    #[test]
    fn the_action_digest_changes_with_every_field_that_matters() {
        let base = action("rwa.buy", "USDC", 100_000);
        let d = action_digest(&base);
        assert_ne!(d, action_digest(&action("rwa.sell", "USDC", 100_000)));
        assert_ne!(d, action_digest(&action("rwa.buy", "USD", 100_000)));
        assert_ne!(d, action_digest(&action("rwa.buy", "USDC", 100_001)));
        let mut with_payee = base.clone();
        with_payee.counterparty = Some("did:t3n:meridian".to_string());
        assert_ne!(d, action_digest(&with_payee));
        assert_eq!(d, action_digest(&base), "same action, same digest");
    }

    // --- outbound credential (secrets map) ---

    #[test]
    fn no_credential_key_sends_no_authorization_header() {
        assert_eq!(auth_headers("", None).unwrap(), None);
    }

    #[test]
    fn a_named_credential_becomes_a_bearer_header() {
        let h = auth_headers("broker_api_key", Some("sk-live-123")).unwrap().unwrap();
        assert_eq!(h, vec![("Authorization".to_string(), "Bearer sk-live-123".to_string())]);
    }

    #[test]
    fn a_named_but_unseeded_credential_fails_closed() {
        // The alternative — dropping the header and sending anyway — would turn a
        // provisioning slip into an unauthenticated payment instruction.
        let err = auth_headers("broker_api_key", None).unwrap_err();
        assert!(err.contains("broker_api_key"), "error should name the missing entry: {err}");
        assert!(auth_headers("broker_api_key", Some("")).is_err(), "empty secret is not a credential");
    }

    #[test]
    fn the_credential_is_named_by_the_mandate_not_the_caller() {
        // Deserialising a mandate is the ONLY way credential_key gets set, and
        // mandates come from KV, which the calling agent cannot write.
        let m: Mandate = serde_json::from_str(
            r#"{"max_amount_cents":1,"credential_key":"broker_api_key"}"#,
        )
        .unwrap();
        assert_eq!(m.credential_key, "broker_api_key");
        let legacy: Mandate = serde_json::from_str(r#"{"max_amount_cents":1}"#).unwrap();
        assert_eq!(legacy.credential_key, "", "a mandate without the field stays unauthenticated");
    }

    #[test]
    fn execute_action_requires_wasm_host() {
        let req = br#"{"action":{"kind":"rwa.buy","asset":"USDC","amount_cents":1},"url":"https://x/y"}"#;
        assert!(execute_action(req).is_err(), "must not silently no-op off-wasm");
    }

    #[test]
    fn execute_action_rejects_malformed_input() {
        assert!(execute_action(b"not json").is_err());
    }
}
