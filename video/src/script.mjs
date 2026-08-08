// Single source of truth for the video: narration, visuals and captions.
//
// `narration` is what the TTS speaks. Where it has to be spelled phonetically
// to be pronounced correctly ("H T T P two hundred"), `captionText` carries the
// readable form for the subtitles — otherwise the viewer reads the phonetics.
// Keep the two sentence-for-sentence aligned: captions are timed by splitting
// the measured audio across sentences.
//
// Scene durations come from the rendered audio (scripts/tts.mjs writes
// timing.json), never guessed — a hand-tuned timeline desynchronises the moment
// a single word changes.
//
// Every claim here is one I can point at evidence for. The live HTTP 200 was
// captured on 7 Aug; v0.8.0 is built and tested but not registered, so the
// video does not say it is live.

export const scenes = [
  {
    id: "hook",
    kind: "title",
    narration:
      "A private credit fund can only sell to accredited investors. " +
      "So today, every buyer uploads a passport, bank statements, and a net worth letter. " +
      "And the fund stores all of it.",
    title: "An agent that can spend your money —\nwithout being trusted with it.",
    subtitle: "Gatekeeper · built on the Terminal 3 Agent Developer Kit",
  },
  {
    id: "problem",
    kind: "bullets",
    narration:
      "That is a compliance cost on the way in, and a breach liability forever after. " +
      "They become custodians of a data set they never wanted, just to answer one yes or no question.",
    heading: "The cost of proving one fact",
    bullets: [
      "Passports, statements, net-worth letters — collected and stored",
      "A breach liability that grows with every new client",
      "All to answer: is this buyer accredited?",
    ],
  },
  {
    id: "agent",
    kind: "bullets",
    narration:
      "Now the investor delegates buying to an A I agent, and two things break at once. " +
      "The agent needs their account credentials. And the limits live in the agent's own prompt — " +
      "which is exactly the thing that cannot be trusted to enforce them.",
    captionText:
      "Now the investor delegates buying to an AI agent, and two things break at once. " +
      "The agent needs their account credentials. And the limits live in the agent's own prompt — " +
      "which is exactly the thing that cannot be trusted to enforce them.",
    heading: "Then you add an AI agent",
    bullets: [
      "It holds the credentials — a prompt injection spends real money",
      "Its limits live in its own prompt or code",
      "The thing being constrained is enforcing the constraint",
    ],
    tone: "bad",
  },
  {
    id: "solution",
    kind: "flow",
    narration:
      "Gatekeeper answers both. The fund learns exactly one fact — this buyer is accredited — " +
      "proven by a zero knowledge proof, never the net worth behind it. " +
      "And the mandate lives inside the enclave, so the agent cannot widen its own ceiling.",
    heading: "Two independent gates",
    steps: [
      "Investor delegates a mandate",
      "Agent proves eligibility · BBS+ ZK proof",
      "Enclave enforces the mandate",
      "Order leaves the TEE, signed",
    ],
  },
  {
    id: "run",
    kind: "terminal",
    narration:
      "Here is a real run against the live network. The credential verifies. " +
      "A one thousand dollar purchase is inside the mandate, so the enclave approves it " +
      "and makes the outbound call itself. H T T P two hundred, from inside the hardware.",
    captionText:
      "Here is a real run against the live network. The credential verifies. " +
      "A $1,000 purchase is inside the mandate, so the enclave approves it " +
      "and makes the outbound call itself. HTTP 200, from inside the hardware.",
    title: "npm run demo — live on T3N testnet",
    lines: [
      { t: "[1] IDENTITY   did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f", c: "tag" },
      { t: "[2] VC GATE    verify=true  predicate=true  -> eligible=true", c: "ok" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    buy $1,000 of USDC RWA", c: "tag" },
      { t: "               TEE decision = APPROVED", c: "ok" },
      { t: "[4] AUDIT      {\"decision\":\"approved\",\"reasons\":[]}", c: "dim" },
      { t: "[5] DISPATCH   signed (web-bot-auth, body digest)", c: "plain" },
      { t: "               in-TEE call -> executed in TEE (HTTP 200)", c: "ok" },
    ],
  },
  {
    id: "reject",
    kind: "terminal",
    narration:
      "Nine thousand dollars is over the cap. Same entry point, same code path — " +
      "but the decision and the network call are the same enclave invocation, " +
      "so a rejected action never reaches the network at all.",
    title: "The wrong path matters more",
    lines: [
      { t: "[3] MANDATE    buy $9,000 of USDC RWA (over mandate)", c: "tag" },
      { t: "               TEE decision = REJECTED", c: "bad" },
      { t: "               reasons=[\"amount 900000 exceeds mandate max 500000\"]", c: "bad" },
      { t: "               dispatched=false — the enclave never made the call", c: "bad" },
      { t: "", c: "plain" },
      { t: "[3] MANDATE    pay UNKNOWN counterparty", c: "tag" },
      { t: "               REJECTED  counterparty not permitted", c: "bad" },
      { t: "[3] MANDATE    unconfigured mandate", c: "tag" },
      { t: "               REJECTED  deny by default", c: "bad" },
    ],
  },
  {
    id: "audit",
    kind: "bullets",
    narration:
      "Then I audited my own contract, and found three ways the gate could be bypassed. " +
      "It accepted a mandate supplied by the caller. " +
      "Decide and dispatch were separate calls, so the agent could skip the first. " +
      "And the velocity window was caller supplied, so renaming it reset the counter.",
    heading: "Three holes I found in my own contract",
    bullets: [
      "It accepted an inline mandate — the agent supplied its own limits",
      "Decide and dispatch were separate calls — the gate was skippable",
      "The velocity window was caller-supplied — rename it, counter resets",
    ],
    tone: "bad",
    footer: "All three fixed in v0.7.0",
  },
  {
    id: "issuer",
    kind: "bullets",
    narration:
      "And a fourth. The gate trusted any credential issuer. " +
      "A signature proves the issuer signed the claim. It says nothing about whether " +
      "that issuer is anyone the fund trusts — and the agent generates its own issuer key. " +
      "So it could mint its own accredited investor credential.",
    heading: "A fourth: it trusted any issuer",
    bullets: [
      "A BBS+ signature proves the issuer signed — not that the issuer is trusted",
      "The agent generates its own issuer key",
      "So it could mint its own “accredited investor” credential",
    ],
    tone: "bad",
    footer: "Mandates now carry allowed_issuers — self-issued credentials are refused",
  },
  {
    id: "numbers",
    kind: "stats",
    narration:
      "Eighty two automated tests, mostly wrong paths. A gate that only proves it says yes is worthless. " +
      "Nineteen bugs and documentation gaps reported, with repro steps. " +
      "Everything is public.",
    captionText:
      "82 automated tests, mostly wrong paths. A gate that only proves it says yes is worthless. " +
      "19 bugs and documentation gaps reported, with repro steps. " +
      "Everything is public.",
    heading: "What shipped",
    stats: [
      { n: "82", label: "automated tests\n28 Rust · 33 Node · 21 Playwright" },
      { n: "19", label: "bugs & doc gaps\nreported with repro steps" },
      { n: "8", label: "mandate dimensions\nenforced in hardware" },
    ],
  },
  {
    id: "outro",
    kind: "title",
    narration:
      "Code, screenshots, and every command run for real are at gatekeeper evidence dot vercel dot app.",
    captionText:
      "Code, screenshots, and every command run for real are at gatekeeper-evidence.vercel.app",
    title: "gatekeeper-evidence.vercel.app",
    subtitle: "github.com/PugarHuda/t3-gatekeeper-agent",
    outro: true,
  },
];
