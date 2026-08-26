// Repro for bug #20 — `trustAnchor` became a required T3nClient field with no
// migration path from the form the previous docs taught.
//
// Both constructions below are attempted against the SAME installed SDK, so the
// difference is the SDK's contract, not the environment. Offline: neither call
// reaches the network — the old form throws during construction.
//
//   node trust-anchor-probe.mjs
import {
  T3nClient, setEnvironment, loadWasmComponent, eth_get_address,
  metamask_sign, fetchTrustedManifest,
} from "@terminal3/t3n-sdk";
import { readFileSync } from "node:fs";

// The package's exports map does not expose ./package.json, so read it directly.
const sdkVersion = JSON.parse(
  readFileSync(new URL("./node_modules/@terminal3/t3n-sdk/package.json", import.meta.url), "utf8"),
).version;
console.log(`@terminal3/t3n-sdk ${sdkVersion}\n`);

for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

setEnvironment("testnet");
const key = process.env.T3N_API_KEY;
const address = eth_get_address(key);
const wasmComponent = await loadWasmComponent();
const handlers = { EthSign: metamask_sign(address, undefined, key) };

// 1. The form the PREVIOUS docs taught, and every 3.x integration uses.
console.log("[old] new T3nClient({ wasmComponent, handlers })");
try {
  new T3nClient({ wasmComponent, handlers });
  console.log("      constructed — no trustAnchor required\n");
} catch (e) {
  console.log(`      ${e.constructor.name}: ${e.message}`);
  console.log(`      code=${e.code} field=${e.field}`);
  console.log("      The message is good — it explains what a TrustAnchor is and names the");
  console.log("      unsafe opt-out. What is missing is the migration: it does not name");
  console.log("      fetchTrustedManifest (the one-line fix), does not say which version");
  console.log("      introduced the requirement, and the docs changelog has no SDK history");
  console.log("      to look it up in.\n");
}

// 2. The form the REFRESHED docs teach.
console.log('[new] new T3nClient({ trustAnchor: await fetchTrustedManifest("testnet"), … })');
try {
  new T3nClient({ trustAnchor: await fetchTrustedManifest("testnet"), wasmComponent, handlers });
  console.log("      constructed ✅");
} catch (e) {
  console.log(`      unexpectedly failed: ${e.message}`);
}
