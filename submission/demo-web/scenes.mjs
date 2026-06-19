// Single source of truth for the Gatekeeper Agent demo video.
//
// Each scene maps 1:1 to a voice-over clip in ../voiceover/*.wav (see the segment
// map in ../voiceover/README.md). The HTML player (player.html) renders the
// scene and advances when the clip ends; record.mjs replays the page with
// Playwright, captures video, then muxes these same clips with ffmpeg — so the
// on-screen timing and the narration are driven by the *same* audio and stay in
// sync by construction.
//
// The transcript text is reconstructed verbatim from the demo sources
// (agent/src/agent.mjs, agent-sd.mjs, velocity-demo.mjs, gate-contract/src/gate.rs)
// so it matches a real `npm run demo` run line for line — no live run or credits
// required to produce the video.
//
// Line classes (for colouring): tag | ok | bad | dim | cmd | json | plain

const DID = "did:t3n:3d7dd668…";
const ISSUER = "did:key:zUC7…";
const NOW = 1781846096; // a representative epoch (~2026) for audit/window stamps

// ── Scene 0 — hook (architecture) ──────────────────────────────────────────
const HOOK_HTML = `
  <div class="hero">
    <div class="hero-title">Gatekeeper&nbsp;Agent</div>
    <div class="hero-sub">delegated action without delegated data — on Terminal&nbsp;3</div>
    <div class="flow">
      <div class="node user">User<span>mandate&nbsp;+&nbsp;KYC</span></div>
      <div class="arrow">→</div>
      <div class="gate g1">① VC&nbsp;eligibility&nbsp;gate<span>BBS+ &nbsp;·&nbsp; no PII</span></div>
      <div class="arrow">→</div>
      <div class="node agent">Agent<span>holds neither</span></div>
      <div class="arrow">→</div>
      <div class="gate g2">② TEE&nbsp;mandate&nbsp;gate<span>amount · asset · kind</span></div>
      <div class="arrow">→</div>
      <div class="node act">Action<span>signed&nbsp;·&nbsp;in-enclave</span></div>
    </div>
    <div class="hero-foot">never holds your credentials &nbsp;·&nbsp; never sees your data &nbsp;·&nbsp; hardware-enforced spend bound</div>
  </div>`;

// ── Scene 4 (why it matters) — SDK layer table ──────────────────────────────
const ROWS = [
  ["Identity", "T3nClient · handshake() · authenticate() · metamask_sign"],
  ["Verifiable credential", "@terminal3/bbs_vc createBbsCredential / verifyBbsVCW3c"],
  ["Revocation pre-gate", "@terminal3/revoke_vc isRevoked() — on-chain kill-switch"],
  ["TEE mandate contract", "TenantClient.contracts.register() / execute() + Rust→WASM"],
  ["Audit", "structured per-action row (issuer · decision · reasons)"],
  ["Dispatch · sign", "RFC 9421 Web Bot Auth — destination-verifiable request"],
  ["Dispatch · execute", "in-TEE outbound call via dispatch_action — egress allowlisted"],
];
const WHY_HTML = `
  <div class="why">
    <div class="why-title">The full Terminal&nbsp;3 stack — in one agent</div>
    <table class="why-table">
      <thead><tr><th>Layer</th><th>SDK surface</th></tr></thead>
      <tbody>
        ${ROWS.map((r) => `<tr><td class="layer">${r[0]}</td><td class="surface">${r[1]}</td></tr>`).join("\n        ")}
      </tbody>
    </table>
    <div class="why-foot">+ Web Bot Auth on egress &nbsp;·&nbsp; A2A capability exchange agent-to-agent</div>
    <div class="why-close">Delegate to an agent — without handing over data or trust.</div>
  </div>`;

export const scenes = [
  {
    id: "01-hook", wav: "01-hook.wav", est: 19,
    kind: "diagram", title: "Gatekeeper Agent", html: HOOK_HTML,
  },
  {
    id: "02-contract", wav: "02-contract.wav", est: 22,
    kind: "term", title: "gate-contract — the TEE mandate, in Rust", clear: true,
    cmd: "cargo test --target x86_64-pc-windows-gnu",
    lines: [
      { t: "   Compiling gate-contract v0.6.0", c: "dim" },
      { t: "    Finished test [unoptimized + debuginfo]", c: "dim" },
      { t: "     Running unittests src/gate.rs", c: "dim" },
      { t: "", c: "plain" },
      { t: "test gate::tests::approves_within_mandate ... ok", c: "ok" },
      { t: "test gate::tests::rejects_amount_over_max ... ok", c: "ok" },
      { t: "test gate::tests::rejects_disallowed_asset ... ok", c: "ok" },
      { t: "test gate::tests::rejects_disallowed_kind ... ok", c: "ok" },
      { t: "test gate::tests::rejects_unknown_counterparty ... ok", c: "ok" },
      { t: "test gate::tests::requires_counterparty_when_set ... ok", c: "ok" },
      { t: "test gate::tests::rejects_future_dated_mandate ... ok", c: "ok" },
      { t: "test gate::tests::velocity_running_total_in_tee ... ok", c: "ok" },
      { t: "  … 7 more gates", c: "dim" },
      { t: "", c: "plain" },
      { t: "test result: ok. 15 passed; 0 failed; 0 ignored", c: "ok" },
    ],
  },
  {
    id: "03-deploy", wav: "03-deploy.wav", est: 9,
    kind: "term", title: "build → register on testnet", clear: true,
    cmd: "cargo build --target wasm32-wasip2 --release  &&  npm run setup",
    lines: [
      { t: "    Finished release [optimized] target(s)", c: "dim" },
      { t: "Registering gate@0.6.0 (218144 bytes)…", c: "plain" },
      { t: 'Registered ✅ {"contract_id":"112","version":"0.6.0","status":"active"}', c: "ok" },
      { t: 'Spend map ✅ {"map":"z:…:spent","status":"created"}', c: "ok" },
    ],
  },
  {
    id: "04-run-identity", wav: "04-run-identity.wav", est: 7,
    kind: "term", title: "npm run demo — identity", clear: true,
    cmd: "npm run demo",
    lines: [
      { t: `[1] IDENTITY   ${DID}`, c: "tag" },
    ],
  },
  {
    id: "05-run-vcgate", wav: "05-run-vcgate.wav", est: 14,
    kind: "term", title: "npm run demo — VC eligibility gate",
    lines: [
      { t: `[2] VC GATE    issuer=${ISSUER}  verify=true  predicate=true  -> eligible=true`, c: "tag" },
    ],
  },
  {
    id: "06-run-revocation", wav: "06-run-revocation.wav", est: 10,
    kind: "term", title: "npm run demo — revocation pre-gate",
    lines: [
      { t: "[2b] REVOCATION skipped  (revocation registry not configured)", c: "dim" },
    ],
  },
  {
    id: "07-run-approved", wav: "07-run-approved.wav", est: 9,
    kind: "term", title: "npm run demo — mandate APPROVED",
    lines: [
      { t: "", c: "plain" },
      { t: "[3] MANDATE    buy $1,000 of USDC RWA", c: "tag" },
      { t: "               TEE decision = APPROVED", c: "ok" },
      { t: `[4] AUDIT      {"ts":${NOW},"eligibility":"bbs+ verified","action":{"kind":"rwa.buy","asset":"USDC","amount_cents":100000},"decision":"approved","reasons":[]}`, c: "json" },
    ],
  },
  {
    id: "08-run-dispatch", wav: "08-run-dispatch.wav", est: 16,
    kind: "term", title: "npm run demo — signed + in-TEE dispatch",
    lines: [
      { t: "[5] DISPATCH   POST https://broker.example/v1/orders  signed (web-bot-auth, body digest)  destination-verifiable=true", c: "tag" },
      { t: "               in-TEE call -> egress gated: host/http.egress_denied (host not in authorised_hosts allowlist)", c: "dim" },
    ],
  },
  {
    id: "09-run-rejections", wav: "09-run-rejections.wav", est: 26,
    kind: "term", title: "npm run demo — the mandate rejects",
    lines: [
      { t: "", c: "plain" },
      { t: "[3] MANDATE    buy $9,000 of USDC RWA (over mandate)", c: "tag" },
      { t: '               TEE decision = REJECTED  reasons=["amount 900000 exceeds mandate max 500000"]', c: "bad" },
      { t: "[5] DISPATCH   skipped — action not approved, nothing sent", c: "dim" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    swap into DOGE (asset + kind not allowed)", c: "tag" },
      { t: '               TEE decision = REJECTED  reasons=["action kind \'swap\' not permitted (allowed_kinds=[\\"rwa.buy\\"])","asset \'DOGE\' not permitted (allowed_assets=[\\"USDC\\", \\"USD\\"])"]', c: "bad" },
      { t: "[5] DISPATCH   skipped — action not approved, nothing sent", c: "dim" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    pay APPROVED counterparty (acme-treasury)", c: "tag" },
      { t: "               TEE decision = APPROVED", c: "ok" },
      { t: "[5] DISPATCH   POST https://broker.example/v1/orders  signed (web-bot-auth, body digest)  destination-verifiable=true", c: "plain" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    pay UNKNOWN counterparty", c: "tag" },
      { t: '               TEE decision = REJECTED  reasons=["counterparty \'did:t3n:unknown-payee\' not permitted (allowed_counterparties=[\\"did:t3n:acme-treasury\\"])"]', c: "bad" },
      { t: "[5] DISPATCH   skipped — action not approved, nothing sent", c: "dim" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    future-dated mandate (not yet active)", c: "tag" },
      { t: `               TEE decision = REJECTED  reasons=["mandate not active until 4102444800 (now ${NOW})"]`, c: "bad" },
      { t: "[5] DISPATCH   skipped — action not approved, nothing sent", c: "dim" },
      { t: "", c: "plain" },
      { t: "✅ Gatekeeper Agent: identity + BBS+ VC gate + hardware mandate + audit — complete.", c: "ok" },
    ],
  },
  {
    id: "10-selective-disclosure", wav: "10-selective-disclosure.wav", est: 45,
    kind: "term", title: "npm run demo:sd — true BBS+ selective disclosure", clear: true,
    cmd: "npm run demo:sd",
    lines: [
      { t: `[1] IDENTITY   ${DID}`, c: "tag" },
      { t: "[2] VC GATE    selective disclosure", c: "tag" },
      { t: "               issuer signed : fullName, dateOfBirth, netWorthUSD, accreditedInvestor", c: "plain" },
      { t: '               agent SEES     : {"accreditedInvestor":true}', c: "ok" },
      { t: "               agent HIDDEN   : fullName, dateOfBirth, netWorthUSD (never revealed)", c: "bad" },
      { t: "               proof verified : true  -> eligible=true", c: "ok" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    buy $1,000 of USDC RWA", c: "tag" },
      { t: "               TEE decision = APPROVED", c: "ok" },
      { t: `[4] AUDIT      {"ts":${NOW},"eligibility":"bbs+ selective-disclosure","disclosed":{"accreditedInvestor":true},"decision":"approved","reasons":[]}`, c: "json" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    buy $9,000 of USDC RWA (over mandate)", c: "tag" },
      { t: '               TEE decision = REJECTED  reasons=["amount 900000 exceeds mandate max 500000"]', c: "bad" },
      { t: "", c: "plain" },
      { t: "✅ Gatekeeper Agent (SD): identity + selective-disclosure gate + hardware mandate + audit.", c: "ok" },
    ],
  },
  {
    id: "11-velocity", wav: "11-velocity.wav", est: 26,
    kind: "term", title: "npm run demo:velocity — hardware spend cap", clear: true,
    cmd: "npm run demo:velocity",
    lines: [
      { t: `window=demo-${NOW}  daily_limit=$5000`, c: "plain" },
      { t: "  spend $2000 -> APPROVED  (before=0 after=200000 remaining=300000)", c: "ok" },
      { t: "  spend $2000 -> APPROVED  (before=200000 after=400000 remaining=100000)", c: "ok" },
      { t: "  spend $2000 -> REJECTED  (before=400000 after=400000 remaining=100000)", c: "bad" },
      { t: "", c: "plain" },
      { t: "RESULT: hardware velocity limit WORKS ✅ (running total held in the TEE across calls)", c: "ok" },
    ],
  },
  {
    id: "12-why-it-matters", wav: "12-why-it-matters.wav", est: 37,
    kind: "diagram", title: "Why it matters", html: WHY_HTML,
  },
];

// Convenience for the recorder: ordered wav list + fallback durations.
export const wavOrder = scenes.filter((s) => s.wav).map((s) => ({ wav: s.wav, est: s.est }));
