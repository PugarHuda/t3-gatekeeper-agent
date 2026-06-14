# DoraHacks Registration — Organizer Question Answers

**What is the problem your agent is solving?**
> AI agents that transact on a user's behalf normally need the user's
> credentials and personal data in memory — an exploitable surface and a
> non-starter for banks and institutions. The Gatekeeper Agent executes
> permissioned actions (e.g. an RWA / permissioned-DeFi purchase) on behalf of a
> user while holding **neither** their credentials **nor** their sensitive data:
> eligibility is proven by a verifiable credential and the spending bound is
> enforced in a hardware TEE.

**Why is verifiable identity important for your agent?**
> The agent must prove two things before acting: that the user is *eligible*
> (e.g. an accredited investor) and that the agent is acting *within a mandate*.
> A BBS+ verifiable credential lets a trusted issuer attest the eligibility
> predicate cryptographically — without exposing net worth, name, or DOB — and
> the did:t3n identity binds the agent's session and the on-chain audit trail.
> Eligibility becomes a verifiable fact, not the agent's unverifiable claim.

**What is one thing we can improve in your documentation?**
> The "Smart VCs" page advertises ZK selective-disclosure VPs, but the published
> `@terminal3/bbs_vc` package exposes only issuance + verification (no holder-side
> derive-presentation function) and the docs give no function names or code
> example for the selective-disclosure flow. Please add an end-to-end
> issue→derive→verify VC sample, or document that derivation isn't yet exposed.
> (See Track B Report 3.) — Secondary: the Windows dev-env docs omit the native
> host-linker prerequisite for `cargo build --target wasm32-wasip2` (Track B
> Report 5).

**Which of these describes you best?** → Developer / solo builder.

**Who referred you?** → (optional — leave blank or add referrer email.)
