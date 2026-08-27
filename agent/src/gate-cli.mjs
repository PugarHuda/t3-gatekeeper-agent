// One way to run the contract's real decision logic off-chain.
//
// `gate_cli` is a host build of the SAME Rust `gate::decide()` the enclave runs
// (gate-contract/src/bin/gate_cli.rs pulls in gate.rs with #[path]). Anything
// that wants a decision without spending credits — the QA console, the MCP
// server, the conformance tests — goes through here, so there is exactly one
// place that knows where the binary lives and how to talk to it.
//
// The alternative, a JS reimplementation of the rules, would agree with itself
// and prove nothing. This one disagrees loudly when the Rust changes.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = new URL("../../", import.meta.url);

// The contract's version, read from the contract's own Cargo.toml. Everything
// that names a version — the client, the MCP server, the agent card — reads it
// from here, because a version typed in two files is a version that will
// eventually disagree with itself, and the failure mode is a contract
// registered under a number that is not the code inside it.
export const CONTRACT_VERSION = readFileSync(new URL("gate-contract/Cargo.toml", REPO), "utf8")
  .match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "0.0.0";

// Windows has no native linker for the host target unless MSVC build tools are
// installed, so the GNU toolchain is what works there; Linux uses the explicit
// host triple .cargo/config.toml forces us off; macOS builds untargeted. Same
// rule as verify.mjs — if that changes, change it in both or the binary this
// finds is not the one CI built.
const HOST_TARGETS = process.platform === "win32"
  ? ["x86_64-pc-windows-gnu", "x86_64-pc-windows-msvc"]
  : process.platform === "darwin"
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    : ["x86_64-unknown-linux-gnu"];

const BIN = process.platform === "win32" ? "gate_cli.exe" : "gate_cli";

/** Candidate paths, in the order cargo would have written them. */
export function candidates() {
  const paths = HOST_TARGETS.map((t) => new URL(`gate-contract/target/${t}/release/${BIN}`, REPO));
  // `cargo build --release` with no --target (macOS, and anyone who removed the
  // .cargo default) lands here instead.
  paths.push(new URL(`gate-contract/target/release/${BIN}`, REPO));
  return paths.map(fileURLToPath);
}

/** The built binary, or null if it has not been built yet. */
export function gateCliPath() {
  return candidates().find((p) => existsSync(p)) ?? null;
}

export const BUILD_HINT =
  "cargo build --bin gate_cli --release" +
  (process.platform === "darwin" ? "" : ` --target ${HOST_TARGETS[0]}`) +
  "   (run it in gate-contract/)";

/**
 * Ask the compiled contract logic to decide.
 *
 * Returns whatever gate_cli prints — the same struct the enclave returns from
 * `evaluate`. A non-zero exit with JSON on stdout is a *decision* about bad
 * input, not a crash, so the JSON wins over the exit code.
 */
export function decide(
  { action, mandate, now_secs = Math.floor(Date.now() / 1000), credential = null, idempotency_key = null },
  { timeoutMs = 10_000, exe = gateCliPath() } = {},
) {
  if (!exe) {
    return Promise.reject(new Error(`gate_cli is not built. Build it with: ${BUILD_HINT}`));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(exe, { timeout: timeoutMs }, (err, stdout) => {
      const text = (stdout || "").trim();
      if (text) { try { return resolve(JSON.parse(text)); } catch { /* fall through to err */ } }
      reject(err ?? new Error("gate_cli produced no output"));
    });
    child.stdin.end(JSON.stringify({ action, mandate, now_secs, credential, idempotency_key }));
  });
}
