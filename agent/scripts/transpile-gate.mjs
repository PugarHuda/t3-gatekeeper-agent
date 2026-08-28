// Transpile the enclave's component into JavaScript the agent can host itself.
//
//   npm run gate:transpile
//
// `gate_contract.wasm` is the exact artifact `npm run setup` registers on the
// node. jco splits it into its core modules and generates the glue that wires
// the component's imports (tenant-context, kv-store, logging, http) to whatever
// host we hand it — src/gate-wasm.mjs is that host. The result is the same
// decision logic, byte for byte, running in Node with no Rust toolchain, no
// enclave and no account. A JavaScript copy of the rules would drift; this
// cannot, because there is no copy.
//
// source.json records which component was transpiled, so a test can refuse to
// pass when the release build on disk is not the one the glue was made from.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "../src/gate-cli.mjs";

const COMPONENT = fileURLToPath(new URL("../../gate-contract/target/wasm32-wasip2/release/gate_contract.wasm", import.meta.url));
const OUT = fileURLToPath(new URL("../gate-wasm", import.meta.url));
const JCO = fileURLToPath(new URL("../node_modules/@bytecodealliance/jco/dist/jco.js", import.meta.url));

let bytes;
try {
  bytes = readFileSync(COMPONENT);
} catch {
  console.error(`no component at ${COMPONENT}\nbuild it first:  cd gate-contract && cargo build --lib --target wasm32-wasip2 --release`);
  process.exit(2);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// --instantiation async: we supply the imports object ourselves instead of
// letting the module `import` them, which is what makes the host swappable.
execFileSync(process.execPath, [JCO, "transpile", COMPONENT, "-o", OUT, "--instantiation", "async", "--no-typescript", "--quiet"], { stdio: "inherit" });

// jco emits .d.ts and interfaces/ even with --no-typescript on some versions;
// the host never reads them, so they do not ship.
rmSync(`${OUT}/interfaces`, { recursive: true, force: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".d.ts")) rmSync(`${OUT}/${f}`);

const sha256 = createHash("sha256").update(bytes).digest("hex");
const source = {
  component: "gate-contract/target/wasm32-wasip2/release/gate_contract.wasm",
  sha256,
  bytes: bytes.length,
  version: CONTRACT_VERSION,
  files: readdirSync(OUT).filter((f) => f !== "source.json").sort(),
};
writeFileSync(`${OUT}/source.json`, JSON.stringify(source, null, 2) + "\n");
console.log(`transpiled gate@${CONTRACT_VERSION} (${bytes.length} bytes, sha256 ${sha256.slice(0, 16)}…) -> agent/gate-wasm/`);
for (const f of source.files) console.log(`  ${f}`);
