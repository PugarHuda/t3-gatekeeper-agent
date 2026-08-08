// Capture submission screenshots from REAL command output.
//
// Each entry below is executed for real; its combined stdout+stderr is written to
// <name>.txt and rendered to <name>.png in a terminal-styled page via Playwright.
// Nothing here is hand-written transcript — if a command fails, the failure is
// what gets captured (several of these ARE the bug evidence).
//
// Usage:  node capture.mjs            (from submission/screenshots)
//         node capture.mjs 03         (only shots whose name starts with "03")
import { execSync } from "node:child_process";
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const AGENT = path.join(REPO, "agent");
const QA = path.join(REPO, "t3-qa");
// npx must NOT run from a dir whose node_modules pins the old SDK (it then
// resolves the local, bin-less 3.5.2 and dies with "could not determine
// executable to run") — so CLI shots run from this empty output dir.
const OUT = path.join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const KEY = readFileSync(path.join(AGENT, ".env"), "utf8").match(/^T3N_API_KEY=(.*)$/m)?.[1]?.trim();
if (!KEY) throw new Error("T3N_API_KEY not found in agent/.env");
const DID = readFileSync(path.join(AGENT, ".env"), "utf8").match(/^DID=(.*)$/m)?.[1]?.trim();

const t3n = (args) => `npx --yes @terminal3/t3n-sdk ${args} --env testnet`;

const SHOTS = [
  { name: "01-quickstart-auth", title: "Quickstart — handshake → authenticate → getUsage (live testnet)",
    cmd: "node auth-test.mjs", cwd: QA },
  { name: "02-cli-whoami", title: "t3n whoami — the network returns our Agent DID", cmd: t3n("whoami"), cwd: OUT },
  { name: "03-contract-deployed", title: "Walkthrough — our Rust TEE contract, live on the network",
    cmd: t3n(`contract get z:${DID.replace("did:t3n:", "")}:gate`), cwd: OUT },
  { name: "04-agent-registered", title: "Agent ID registered on-network (agent registry --full)",
    cmd: t3n(`agent registry ${DID} --full`), cwd: OUT },
  { name: "05-full-flow", title: "The agent: identity → VC gate → TEE mandate → audit → in-TEE dispatch (HTTP 200)",
    cmd: "npm run demo", cwd: AGENT, env: { ACTION_ENDPOINT: "https://postman-echo.com/post", DEMO_PAUSE_MS: "0" } },
  { name: "06-egress-grant", title: "agent-auth-update — the caller authorises what the enclave may reach",
    cmd: "npm run grant:egress", cwd: AGENT, env: { ACTION_ENDPOINT: "https://postman-echo.com/post" } },
  { name: "07-tests", title: "Offline test suite (27 tests)", cmd: "npm test", cwd: AGENT },
  // ── bug evidence ────────────────────────────────────────────────────────
  { name: "08-bug-token-balance", title: "BUG — CLI `token balance` / `token usage` fail (SDK getUsage works)",
    cmd: t3n("token balance"), cwd: OUT },
  { name: "09-bug-host-card", title: "BUG — documented public-agent step `agent host-card` fails (NotScopeWriter)",
    cmd: t3n(`agent host-card --file "${path.join(AGENT, "agent-card.json")}"`), cwd: OUT },
  { name: "10-bug-node-version", title: "BUG — CLI 4.30.0 needs tee:organisation/contracts >= 0.6.0; testnet node runs 0.4.1",
    cmd: t3n("contract get tee:organisation/contracts"), cwd: OUT },
];

const only = process.argv[2];
const shots = only ? SHOTS.filter((s) => s.name.startsWith(only)) : SHOTS;

function run({ cmd, cwd, env }) {
  try {
    return execSync(cmd, {
      cwd, encoding: "utf8", stdio: "pipe", timeout: 300_000,
      env: { ...process.env, ...env, T3N_API_KEY: KEY },
    });
  } catch (e) {
    // A non-zero exit is expected for the bug shots — capture what it printed.
    return `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message);
  }
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Colour the output the way the terminal does, so the PNG reads like a screen.
function colourise(text) {
  return esc(text).split(/\r?\n/).map((line) => {
    let cls = "plain";
    if (/^\s*(✅|✔|RESULT: live|pass \d)/.test(line) || /HTTP 200|APPROVED|verify=true/.test(line)) cls = "ok";
    else if (/error|Error|BUG|FAILED|denied|REJECTED|not in the|fail \d/.test(line)) cls = "bad";
    else if (/^\[\d\w?\]/.test(line)) cls = "tag";
    else if (/^[>$]/.test(line) || /^\s*npm |^\s*node /.test(line)) cls = "cmd";
    else if (/^\s*[ℹ#]/.test(line)) cls = "dim";
    return `<span class="${cls}">${line || "&nbsp;"}</span>`;
  }).join("\n");
}

const page_html = (title, body) => `<!doctype html><meta charset="utf-8"><style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0f14; font:13px/1.55 "Cascadia Code","Consolas",monospace; }
  .win { margin:18px; border:1px solid #1e2b3a; border-radius:9px; overflow:hidden; background:#0e141b; }
  .bar { display:flex; align-items:center; gap:8px; padding:9px 13px; background:#141c26; border-bottom:1px solid #1e2b3a; }
  .dot { width:11px; height:11px; border-radius:50%; }
  .t { color:#9fb3c8; font-size:12.5px; margin-left:7px; }
  pre { margin:0; padding:15px 17px; white-space:pre-wrap; word-break:break-word; }
  span { display:block; }
  .plain{color:#c8d6e5} .ok{color:#5ddba4} .bad{color:#ff7b72} .tag{color:#79c0ff}
  .cmd{color:#e3b341} .dim{color:#6b7f95}
</style><div class="win">
  <div class="bar"><i class="dot" style="background:#ff5f57"></i><i class="dot" style="background:#febc2e"></i>
  <i class="dot" style="background:#28c840"></i><span class="t">${esc(title)}</span></div>
  <pre>${body}</pre></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, deviceScaleFactor: 2 });

for (const shot of shots) {
  process.stdout.write(`[capture] ${shot.name} … `);
  // Redact the API key in case a tool ever echoes it back.
  const raw = run(shot).replaceAll(KEY, "0x<redacted>").trimEnd();
  writeFileSync(path.join(OUT, `${shot.name}.txt`), raw);
  await page.setContent(page_html(shot.title, colourise(raw)));
  await page.locator(".win").screenshot({ path: path.join(OUT, `${shot.name}.png`) });
  console.log(`${raw.split("\n").length} lines -> ${shot.name}.png`);
}

await browser.close();
console.log(`\nDone. ${shots.length} screenshots in ${OUT}`);
