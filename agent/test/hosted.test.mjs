// The hosted entry (Vercel functions) must stay free of the credential stack
// at import time: that chain ends in an ESM-only module the function runtime
// cannot `require`, and the hosted gate decides with the wasm component
// anyway. This walks the STATIC import graph from hosted.mjs — dynamic
// `await import(...)` inside a handler is fine, a top-level import is not —
// so the failure shows up here rather than as FUNCTION_INVOCATION_FAILED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FORBIDDEN = /^(@terminal3\/|@mattrglobal\/|did-jwt)/;
const FORBIDDEN_LOCAL = /\/(selective-disclosure|revocation|lib)\.mjs$/;

function staticImports(url) {
  const src = readFileSync(url, "utf8");
  return [...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);
}

test("hosted.mjs's static import graph contains no Terminal 3 SDK, BBS+, or did-jwt", () => {
  const seen = new Set();
  const offenders = [];
  const walk = (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    for (const spec of staticImports(url)) {
      if (FORBIDDEN.test(spec)) { offenders.push(`${url.pathname.split("/").pop()} -> ${spec}`); continue; }
      if (!spec.startsWith(".")) continue;
      const next = new URL(spec, url);
      if (FORBIDDEN_LOCAL.test(next.pathname)) { offenders.push(`${url.pathname.split("/").pop()} -> ${spec}`); continue; }
      walk(next);
    }
  };
  walk(new URL("../src/hosted.mjs", import.meta.url));
  assert.ok(seen.size >= 8, `walked only ${seen.size} modules — the graph walk is broken`);
  assert.deepEqual(offenders, []);
});

test("the deploy root mirrors agent/: same dependencies, same lockfile", () => {
  // Vercel installs from the repo root; the functions import agent/src. If the
  // two trees resolve different versions, the hosted gate is not the tested
  // one (this is how an ESM-only @scure/base once got in).
  const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const agent = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(root.dependencies, agent.dependencies, "copy agent/package.json dependencies to the root");
  assert.deepEqual(root.devDependencies, agent.devDependencies);
  assert.equal(
    readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    "copy agent/package-lock.json to the root",
  );
});
