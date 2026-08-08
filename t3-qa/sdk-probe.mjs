// Offline probe of @terminal3/t3n-sdk pure functions. No network, no credits.
// Looking for: helpers that do not do what their name promises, functions that
// accept what they should reject, and misleading return values.
import * as sdk from "@terminal3/t3n-sdk";

const show = async (label, fn) => {
  try { console.log(`${label} => ${JSON.stringify(await fn())}`); }
  catch (e) { console.log(`${label} => THROWS: ${String(e.message).slice(0, 100)}`); }
};

console.log("### redactSecrets — which key names are actually covered?");
const KEYS = [
  "apiKey", "api_key", "T3N_API_KEY", "password", "passwd", "secret", "secretKey",
  "token", "accessToken", "authorization", "auth", "privateKey", "private_key",
  "PRIVATE_KEY", "privkey", "priv_key", "signingKey", "mnemonic", "seed",
  "seedPhrase", "credential", "sessionKey", "cookie", "WBA_PRIVATE_KEY",
];
const leaked = [];
for (const k of KEYS) {
  const redacted = JSON.stringify(sdk.redactSecrets({ [k]: "SENSITIVE-VALUE" })).includes("REDACTED");
  if (!redacted) leaked.push(k);
  console.log(`  ${redacted ? "redacted " : "LEAKED   "} ${k}`);
}
console.log(`\n  >>> NOT redacted: ${leaked.join(", ") || "(none)"}`);

console.log("\n### getNodeUrl");
for (const e of [undefined, "testnet", "production", "sandbox", ""])
  await show(`  getNodeUrl(${JSON.stringify(e)})`, () => sdk.getNodeUrl(e));
await show("  NODE_URLS", () => sdk.NODE_URLS);

// Correct arity: verifyTdxQuote(quoteB64, attestationMsgB64, expectedRtmr3B64?)
console.log("\n### verifyTdxQuote — malformed input handling (both args supplied)");
for (const [q, m] of [["", ""], ["AAAA", "AAAA"], ["not-base64!!", "AAAA"],
                      ["A".repeat(5000), "AAAA"]])
  await show(`  verifyTdxQuote(${JSON.stringify(q.slice(0, 14))}, ${JSON.stringify(m)})`,
    () => sdk.verifyTdxQuote(q, m));
console.log("  (missing 2nd arg — the documented-required one):");
await show(`  verifyTdxQuote("AAAA")`, () => sdk.verifyTdxQuote("AAAA"));

console.log("\n### randomness sanity");
console.log(`  5000 generateUUID -> ${new Set(Array.from({ length: 5000 }, () => sdk.generateUUID())).size} unique`);
