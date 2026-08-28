// The MCP Registry listing, validated against the registry's own schema —
// the same file `mcp-publisher publish` uploads. A listing that fails the
// schema is refused at publish time; this catches it before then, offline.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const schema = JSON.parse(readFileSync(new URL("./fixtures/mcp-server.schema.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("MCP Registry server.json", () => {
  test("validates against the registry schema it declares", () => {
    assert.equal(server.$schema, schema.$id ?? server.$schema);
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const ok = ajv.validate(schema, server);
    assert.ok(ok, JSON.stringify(ajv.errors, null, 1));
  });

  test("names the npm package this directory publishes, at this version", () => {
    const npm = server.packages.find((p) => p.registryType === "npm");
    assert.equal(npm.identifier, pkg.name);
    assert.equal(npm.version, pkg.version);
    assert.equal(server.version, pkg.version);
    // The registry checks npm ownership through this field in the published
    // package.json; the two must agree or the publish is refused.
    assert.equal(pkg.mcpName, server.name);
    assert.match(server.name, /^io\.github\.[^/]+\/[^/]+$/, "GitHub-verified namespace");
  });

  test("the stdio entry point is a real bin that the MCP main guard recognises", () => {
    const bin = Object.values(pkg.bin)[0];
    assert.equal(bin, "src/mcp-server.mjs");
    const src = readFileSync(new URL(`../${bin}`, import.meta.url), "utf8");
    assert.ok(src.startsWith("#!/usr/bin/env node"), "npx needs a shebang");
    assert.match(src, /endsWith\("mcp-server\.mjs"\)/, "main guard must match the bin filename");
    for (const f of ["src", "gate-wasm", "agent-card.json"]) assert.ok(pkg.files.includes(f), `package must ship ${f}`);
    assert.ok(!pkg.files.some((f) => f === ".env"), "never ship .env");
  });

  test("every environment variable it documents is one the code reads", () => {
    const code = ["lib.mjs", "mcp-server.mjs", "x402.mjs"].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
    for (const v of server.packages[0].environmentVariables) {
      assert.ok(code.includes(v.name), `${v.name} is documented but nothing reads it`);
    }
  });
});
