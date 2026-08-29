#!/usr/bin/env node
// One command that tells you whether this repo still works: `node verify.mjs`.
//
// Everything here runs offline and spends zero testnet credits, which is the
// point — whoever maintains this next should be able to prove the thing is
// healthy without an API key, a funded account, or a network round trip.
//
// Live checks are deliberately NOT here. They cost credits and they fail for
// reasons that have nothing to do with the code (an empty balance, a node
// upgrade). Run `npm --prefix agent run auth` for those, separately.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Windows has no native linker for the host target unless MSVC build tools are
// installed, so the GNU toolchain is the one that works here. Everywhere else
// the default toolchain is fine. See gate-contract/README.md.
const win = process.platform === "win32";
const hostTarget = win ? "x86_64-pc-windows-gnu" : process.platform === "darwin" ? null : "x86_64-unknown-linux-gnu";
const cargo = ["cargo", win ? ["+stable-x86_64-pc-windows-gnu"] : []].flat();
// .cargo/config.toml defaults every build to wasm32-wasip2; host tests must opt out.
const hostArgs = hostTarget ? ["--target", hostTarget] : [];

const steps = [
  {
    name: "contract unit tests (Rust, host)",
    cmd: [...cargo, "test", ...hostArgs],
    cwd: "gate-contract",
  },
  {
    name: "contract builds as a wasm component",
    cmd: [...cargo, "build", "--lib", "--target", "wasm32-wasip2", "--release"],
    cwd: "gate-contract",
  },
  {
    name: "agent unit tests (Node)",
    cmd: ["npm", "test"],
    cwd: "agent",
  },
  {
    name: "QA console + evidence page (Playwright: real Rust decide(), axe-core, page interaction)",
    cmd: ["node", "--test", "e2e.test.mjs", "a11y.test.mjs", "site-ui.test.mjs"],
    cwd: "qa-console",
    // Needs the host build of gate_cli, which the Rust step above does not produce.
    pre: [...cargo, "build", "--bin", "gate_cli", "--release", ...hostArgs],
    preCwd: "gate-contract",
    skipIf: () => !existsSync("qa-console/node_modules"),
    skipWhy: "qa-console/node_modules is missing — run `npm ci` in qa-console/ (and `npx playwright install chromium`)",
  },
];

// Echo output live AND keep it, so the run can report its own total instead of
// a number written into a README that nobody re-checks.
let transcript = "";
const run = (cmd, cwd) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", shell: win });
  const text = (r.stdout ?? "") + (r.stderr ?? "");
  process.stdout.write(text);
  transcript += text;
  return r.status === 0;
};

/** Sum the totals each runner prints, so the count cannot drift from reality. */
function countChecks(text) {
  let n = 0;

  // Cargo runs the test suite once per target. `gate_cli` pulls in gate.rs with
  // #[path], so the bin target re-runs almost the same tests as the lib — adding
  // both would inflate the number by ~40. Attribute each "test result" line to
  // the target header above it and skip the bin.
  //
  //   Running unittests src/lib.rs (…)        <- counted
  //   Running unittests src/bin/gate_cli.rs   <- same tests again, skipped
  //   Doc-tests gate-contract                 <- counted, genuinely separate
  // Cargo writes the headers to stderr and the results to stdout, so they cannot
  // be paired by reading line by line — captured output has all of one stream
  // then all of the other. Both sequences are complete and in the same order,
  // though, so pair them by position.
  const targets = [...text.matchAll(/^\s*(?:Running unittests|Doc-tests)\s+(.*)$/gm)].map((m) => m[1]);
  const results = [...text.matchAll(/test result: ok\. (\d+) passed/g)].map((m) => Number(m[1]));
  results.forEach((count, i) => {
    if (/bin[\\/]gate_cli/.test(targets[i] ?? "")) return;
    n += count;
  });

  // node:test prints one tally per run: "ℹ pass 52"
  for (const m of text.matchAll(/^ℹ pass (\d+)$/gm)) n += Number(m[1]);
  return n;
}

let failed = 0;
for (const step of steps) {
  if (step.skipIf?.()) {
    console.log(`\n— SKIP  ${step.name}\n  ${step.skipWhy}`);
    continue;
  }
  console.log(`\n─── ${step.name} ${"─".repeat(Math.max(0, 60 - step.name.length))}`);
  if (step.pre && !run(step.pre, step.preCwd)) {
    console.log(`FAIL  ${step.name} (setup step)`);
    failed++;
    continue;
  }
  if (!run(step.cmd, step.cwd)) {
    console.log(`FAIL  ${step.name}`);
    failed++;
  }
}

console.log(
  failed === 0
    ? `\nAll ${countChecks(transcript)} checks passed. No credits spent.`
    : `\n${failed} step(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
