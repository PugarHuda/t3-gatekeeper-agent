// QA console — drives the contract's REAL decision logic from a browser.
//
// POST /api/decide spawns `gate_cli`, the host build of the same Rust
// `gate::decide()` the enclave runs. The rules are never reimplemented in JS,
// so a passing test here is evidence about the contract, not about a mock.
//
// This is the offline half of QA: mandate logic, every branch, no credits.
// The enclave-only properties (KV mandate, atomic dispatch, TEE attestation)
// are proven separately against testnet — see submission/VERIFICATION.md.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
// The agent's own binding implementation — not a copy. If this drifts, the
// cross-language conformance test in agent/test catches it.
import { bindCredential } from "../agent/src/credential-binding.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.resolve(
  HERE, "..", "gate-contract", "target", "x86_64-pc-windows-gnu", "release",
  process.platform === "win32" ? "gate_cli.exe" : "gate_cli",
);

// The mandate the platform provisioned for this investor. In production the
// enclave reads this from KV; here it is the fixture the rules are applied to.
export const MANDATE = {
  max_amount_cents: 500_000,
  allowed_assets: ["USDC", "USD"],
  allowed_kinds: ["rwa.buy"],
  allowed_counterparties: ["did:t3n:meridian-fund"],
  expires_at_secs: 0,
  valid_after_secs: 0,
};

function decide({ action, mandate = MANDATE, now_secs = 1_786_000_000, credential = null }) {
  return new Promise((resolve, reject) => {
    const child = execFile(EXE, { timeout: 10_000 }, (err, stdout) => {
      // gate_cli exits non-zero on bad input but still prints JSON — prefer it.
      const text = (stdout || "").trim();
      if (text) { try { return resolve(JSON.parse(text)); } catch { /* fall through */ } }
      reject(err ?? new Error("gate_cli produced no output"));
    });
    child.stdin.end(JSON.stringify({ action, mandate, now_secs, credential }));
  });
}

const server = createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const body = async (r) => { let raw = ""; for await (const c of r) raw += c; return raw; };

  if (req.method === "POST" && req.url === "/api/decide") {
    try {
      const parsed = JSON.parse(await body(req));
      if (!parsed?.action?.kind) return send(400, { error: "action.kind is required" });
      return send(200, await decide(parsed));
    } catch (e) {
      return send(400, { error: String(e.message ?? e) });
    }
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    return send(200, await readFile(path.join(HERE, "index.html"), "utf8"), "text/html");
  }
  // The console plays the agent's part here: it binds a credential to an action
  // using the agent's OWN module, so the page never reimplements the commitment.
  // That is the same rule as the decision logic — one implementation, exercised,
  // not a copy that agrees with itself.
  if (req.method === "POST" && req.url === "/api/bind") {
    try {
      const parsed = JSON.parse(await body(req));
      return send(200, bindCredential(
        {
          issuer: parsed.issuer ?? "did:key:kyc-provider",
          subject: parsed.subject ?? "did:t3n:investor",
          claims: parsed.claims ?? { accreditedInvestor: true },
          verified: true,
        },
        parsed.action,
      ));
    } catch (e) {
      return send(400, { error: String(e.message ?? e) });
    }
  }

  if (req.method === "GET" && req.url === "/api/mandate") return send(200, MANDATE);

  send(404, { error: "not found" });
});

export function start(port = 0) {
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// `node server.mjs` runs it; importing it (the tests) does not.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const s = await start(4173);
  console.log(`QA console on http://localhost:${s.address().port}`);
}
