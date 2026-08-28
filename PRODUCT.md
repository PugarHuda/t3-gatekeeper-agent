# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: developers who want to reuse Gatekeeper — adopt the gate over MCP or
A2A, run the offline suite, or take the agent over and host it (Terminal 3's
own stated intent for the bounty). They arrive from the repo README, the
Superteam listing, or an agent card, usually on a desktop browser, and want to
know within a minute what it does, how to run it, and whether the claims hold.

Secondary (confirmed, not primary): bounty judges and the Terminal 3 team,
reading the same page as evidence — screenshots, transaction hashes, test
counts — before opening the repo.

## Product Purpose

Gatekeeper is an enterprise agent for tokenised private-credit distribution
that cannot act outside its owner's mandate. Eligibility is proven with a BBS+
zero-knowledge credential (the fund learns "accredited", never the net worth);
the spending mandate is enforced inside a TDX enclave by a Rust contract the
agent cannot write to; the decision and the outbound order are one enclave
call, so a rejected trade never dials out.

Success: a developer adopts the gate (MCP/A2A/ERC-8004) without cloning it, or
reproduces the evidence with one command and no API key.

## Positioning

Distributable, not cloned: one compiled Rust `decide()` serves the CLI, the
QA console, the MCP server, the A2A endpoint, and the TEE contract, so every
surface gives the same verdict. Every claim on the evidence page is the output
of a command in the repo, and every integration is real — a settled x402
payment on Base Sepolia, an ERC-8004 identity minted on Sepolia, Web Bot Auth
verified both ways against Cloudflare's reference implementation.

## Operating Context

- Evidence site: `site/index.html`, deployed at
  https://gatekeeper-evidence.vercel.app (Vercel, static). Serves the A2A agent
  card, the ERC-8004 registration file, the Web Bot Auth key directory, and
  the revocation status list from `/.well-known/` and `/status/`.
- QA console: `qa-console/index.html`, served by `qa-console/server.mjs`;
  driven by Playwright (`qa-console/e2e.test.mjs`, 38 checks) and screenshotted
  by `qa-console/shots.mjs` into the submission.
- Offline suite: `node verify.mjs` — 277 checks (47 Rust, 191 Node,
  38 Playwright), no API key, no credits.
- Submission artefacts (`submission/SUBMISSION.md`, Google Doc, docx) embed
  the same screenshots the site shows.

## Capabilities and Constraints

- Mandate has eleven rules enforced in the enclave: `max_amount_cents`,
  `allowed_assets`, `allowed_kinds`, `allowed_counterparties`,
  `allowed_issuers`, `counterparty_limits`, `expires_at_secs`,
  `valid_after_secs`, `credential_key`, `require_credential`,
  `require_idempotency_key` (`gate-contract/src/gate.rs`).
- Contract `gate@0.10.0`, contract_id 749, T3N testnet; agent DID
  `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f`.
- Distribution: MCP (stdio + Streamable HTTP, 8 tools), A2A v1.0 on
  `@a2a-js/sdk`, ERC-8004 agent #201 on Sepolia; x402 payments through the
  mandate.
- Site constraints that future work must keep: `qa-console/site.test.mjs`
  requires the title to match /Gatekeeper/, ≥10 rendering `<img>`, the words
  "accredited", "Meridian", "mandate", the first `a[href*="github.com"]` to be
  the public repo, one `video source[type='video/mp4']`, and every PNG in
  `site/shots/` (except `.pN.png` page chunks) referenced from the page.
- QA console constraints: `data-testid` `verdict` (text exactly APPROVED /
  REJECTED / PAID / NOT PAID), `reasons` (one `<li>` per reason), `raw` (JSON),
  the `s-*` / `x-*` button ids, and `document.body.dataset.decision|paid|payer`.
- Static hosting, no build step, no framework; nothing personal in the running
  path.

## Brand Commitments

Name: Gatekeeper (Gatekeeper Agent). Voice: plain, evidence-first, no hype —
claims are printed by commands, not typed from memory. Incumbent visual world:
dark, terminal-adjacent (existing tokens in `site/index.html`); confirmed
scope for this round is polish, not redesign.

## Evidence on Hand

- 32 screenshots in `site/shots/` (all from real command output; `capture.mjs`).
- Demo video `site/gatekeeper-demo.mp4` + `gatekeeper-demo.srt`.
- On-chain: ERC-8004 mint tx
  `0x37965ccd3e68dfa848f94cde4f01f07b3aaf61ca25fc48e5d56db861c634bebb`
  (Sepolia, agent #201); x402 settlement tx
  `0x52b164d133b4f9873947458c45615287177a8471fc621a6caf34aae8c5c97671`
  (Base Sepolia, 0.01 USDC).
- 29 bug reports with repros in `submission/BUGS.md`.
- No testimonials, customers, or benchmarks exist; do not invent them.

## Product Principles

1. Every number on a page is printed by a command in the repo.
2. One `decide()`; every surface must agree with it.
3. Nothing personal in the running path — handover is claiming a tenant and
   re-running setup.
4. Adoption without cloning: MCP, A2A, and ERC-8004 before "git clone".
5. Refuse by default; a missing rule permits nothing.

## Accessibility & Inclusion

Keyboard-operable console (native buttons), visible focus, ≥4.5:1 body
contrast on the dark surfaces, alt text on every screenshot, captions on the
video (burned in + `.srt`).
