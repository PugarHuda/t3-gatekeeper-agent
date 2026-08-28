// The enclave's own component, hosted in JavaScript.
//
// `gate-wasm/` is jco's transpilation of gate_contract.wasm — the artifact
// registered on the node — and this file is the host it runs against: a clock,
// a tenant id, an in-memory KV store, and an outbound-HTTP import that refuses.
// `evaluate` and `spend` therefore run the contract's real code paths, KV read
// and all, with no Rust toolchain, no enclave and no account.
//
// What this is NOT: the enclave. The clock and the KV map here are whatever the
// caller provides, so a decision from this host proves what the contract WOULD
// decide for a given mandate — it is not the tenant-provisioned mandate held in
// hardware. `execute_action` (decide + dispatch in one call) is deliberately
// not exposed: its outbound call belongs inside the TEE, and this host's http
// import throws to make sure the component cannot dial out from here.
import { readFileSync } from "node:fs";
import { readFile as readFileP } from "node:fs/promises";
import * as cli from "@bytecodealliance/preview2-shim/cli";
import * as io from "@bytecodealliance/preview2-shim/io";

const DIR = new URL("../gate-wasm/", import.meta.url);

/** What was transpiled: component path, sha256, byte length, version. */
export const SOURCE = JSON.parse(readFileSync(new URL("source.json", DIR), "utf8"));

const enc = new TextEncoder();
const dec = new TextDecoder();

/** `did:t3n:<40 hex>` → the 20 raw bytes the node hands a contract as its tenant id. */
export function tenantIdBytes(did) {
  const m = /^did:t3n:([0-9a-f]{40})$/i.exec(did ?? "");
  if (!m) throw new Error(`not a tenant DID: ${JSON.stringify(did)} (expected did:t3n:<40 hex>)`);
  return Uint8Array.from(Buffer.from(m[1], "hex"));
}

/** The DID a host is given when the caller does not care which tenant it is. */
export const LOCAL_TENANT = "did:t3n:" + "0".repeat(40);

export class GateError extends Error {}

let glue;
async function instantiateGlue(imports) {
  glue ??= await import(new URL("gate_contract.js", DIR));
  return glue.instantiate(
    (name) => readFileP(new URL(name, DIR)).then((b) => WebAssembly.compile(b)),
    imports,
  );
}

/**
 * Instantiate the component against a JavaScript host.
 *
 * @param {object} [opts]
 * @param {string} [opts.tenantDid]  the tenant the contract believes it runs for (map names derive from it)
 * @param {() => number} [opts.now]  cluster clock, unix seconds
 * @param {Map<string, Map<string, Uint8Array>>} [opts.kv]  backing store, map name → key → value
 */
export async function loadGate({ tenantDid = LOCAL_TENANT, now = () => Math.floor(Date.now() / 1000), kv = new Map() } = {}) {
  const tid = tenantIdBytes(tenantDid);
  const tidHex = Buffer.from(tid).toString("hex");
  const logs = [];
  const calls = { kvGet: 0, kvPut: 0, http: 0, httpWithPlaceholders: 0 };
  let nowOverride = null;

  const refuse = (what) => () => {
    calls[what]++;
    throw new Error(`gate-wasm host: ${what} refused — outbound HTTP is the enclave's job, this host never dials out`);
  };

  const world = await instantiateGlue({
    "wasi:cli/environment": cli.environment, "wasi:cli/exit": cli.exit,
    "wasi:cli/stdin": cli.stdin, "wasi:cli/stdout": cli.stdout, "wasi:cli/stderr": cli.stderr,
    "wasi:cli/terminal-input": cli.terminalInput, "wasi:cli/terminal-output": cli.terminalOutput,
    "wasi:cli/terminal-stdin": cli.terminalStdin, "wasi:cli/terminal-stdout": cli.terminalStdout,
    "wasi:cli/terminal-stderr": cli.terminalStderr,
    "wasi:io/error": io.error, "wasi:io/poll": io.poll, "wasi:io/streams": io.streams,
    "host:tenant/tenant-context": {
      tenantDid: () => tid,
      clusterTimestampSecs: () => BigInt(nowOverride ?? now()),
    },
    "host:interfaces/logging": { info: (line) => { logs.push(String(line)); } },
    "host:interfaces/kv-store": {
      get: (map, key) => { calls.kvGet++; return kv.get(map)?.get(dec.decode(key)); },
      put: (map, key, value) => {
        calls.kvPut++;
        if (!kv.has(map)) kv.set(map, new Map());
        kv.get(map).set(dec.decode(key), Uint8Array.from(value));
      },
    },
    "host:interfaces/http": { call: refuse("http") },
    "host:interfaces/http-with-placeholders": { call: refuse("httpWithPlaceholders") },
  });

  const contracts = world.contracts;

  /** Call an export with a JSON input; a component `err` becomes a GateError. */
  function invoke(fn, body, { now_secs } = {}) {
    nowOverride = now_secs ?? null;
    try {
      return JSON.parse(dec.decode(contracts[fn]({ input: enc.encode(JSON.stringify(body)) })));
    } catch (e) {
      if (e && typeof e === "object" && "payload" in e) throw new GateError(String(e.payload));
      throw e;
    } finally {
      nowOverride = null;
    }
  }

  const mapName = (suffix) => `z:${tidHex}:${suffix}`;

  return {
    tenantDid, tidHex, mapName, kv, logs, calls,
    /** Write a mandate where the contract's KV read will find it. */
    provisionMandate(mandate, key = "default") {
      if (!kv.has(mapName("mandate"))) kv.set(mapName("mandate"), new Map());
      kv.get(mapName("mandate")).set(key, enc.encode(JSON.stringify(mandate)));
    },
    /** `mandate` omitted → the contract reads the provisioned one, exactly as on the node. */
    evaluate(action, mandate, opts) {
      return invoke("evaluate", mandate ? { action, mandate } : { action }, opts);
    },
    /** Cumulative spend, bucketed by the host clock's day — never by the caller's window. */
    spend(action, daily_limit_cents, opts) {
      return invoke("spend", { action, daily_limit_cents, window: "ignored-by-contract" }, opts);
    },
  };
}

let shared;
/** One instance for callers that just want a verdict (the MCP server). */
export function sharedGate() {
  shared ??= loadGate();
  return shared;
}
