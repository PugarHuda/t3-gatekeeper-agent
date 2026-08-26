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
    name: "QA console end-to-end (Playwright, drives the real Rust decide())",
    cmd: ["node", "--test", "e2e.test.mjs"],
    cwd: "qa-console",
    // Needs the host build of gate_cli, which the Rust step above does not produce.
    pre: [...cargo, "build", "--bin", "gate_cli", "--release", ...hostArgs],
    preCwd: "gate-contract",
    skipIf: () => !existsSync("qa-console/node_modules"),
    skipWhy: "qa-console/node_modules is missing (it is a junction to submission/demo-web)",
  },
];

const run = (cmd, cwd) =>
  spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit", shell: win }).status === 0;

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
    ? "\nAll checks passed. No credits spent."
    : `\n${failed} check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
