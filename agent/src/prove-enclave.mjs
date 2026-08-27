// `npm run prove:enclave` — the three enclave paths that had never run.
//
// Three claims in this repo were written while the account had no credits, and
// each was covered by unit tests of the Rust and by nothing on a node:
//
//   1. the broker credential is held in the enclave's secrets map and injected
//      into the outbound request — the agent never sees it
//   2. a body carrying `{{profile.*}}` goes through http-with-placeholders, and
//      the HOST substitutes the investor's data
//   3. a retry under the same idempotency key replays the recorded outcome
//      instead of placing a second order
//
// The status-list work was written the same way and turned out to be broken
// the first time it ran (bug #22). So each of these is proven here against
// live testnet, with a control case beside it, and every verdict comes from a
// deterministic signal — an HTTP status, a typed error, a boolean the enclave
// returns — never from reading a response body back. The enclave deliberately
// does not return bodies: on the placeholder path that body may carry the very
// PII this design keeps out of the agent.
//
// Destinations are public echo services chosen for one property each:
//   httpbin.org/bearer     401 without an Authorization header, 200 with one
//   postman-echo.com/post  accepts any POST — the placeholder path only needs
//                          the host to attempt substitution, and it answers
//                          with a typed error when a field does not exist
//
// Costs ~8 contract executions. Leaves the mandate as it found it.
import { randomUUID, randomBytes } from "node:crypto";
import {
  connect, executeContract, seedEntry, grantEgress,
  CONTRACT_TAIL, CONTRACT_VERSION, MANDATE, CREDENTIAL_KEY,
} from "./lib.mjs";
import { bindCredential } from "./credential-binding.mjs";

const { client, tenant, agentDid } = await connect(new URL("../.env", import.meta.url));

let failed = 0;
const check = (label, pass, detail = "") => {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
};
const brief = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 200);

// The action every call here uses. Identical, so the only variable in each
// pair is the thing being proven.
const ACTION = { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000 };
const credential = () => bindCredential({
  issuer: "did:key:kyc-provider", subject: agentDid,
  claims: { accreditedInvestor: true }, verified: true,
}, ACTION);

const run = (functionName, input) =>
  executeContract(tenant, CONTRACT_TAIL, { version: CONTRACT_VERSION, functionName, input });

// ── provisioning: what the tenant admin does once ──────────────────────────
console.log("provisioning");

// A profile, so the host has something to substitute. Synthetic — this is a
// test tenant, and the point of the placeholder path is that this value never
// reaches the agent process, so what it is does not matter.
await client.submitUserInput({ profile: { first_name: "Gatekeeper", last_name: "TestInvestor", role: "agent" } });
console.log("  profile written (first_name=Gatekeeper)");

// A broker credential the agent never holds. Random, single-use, sealed into
// z:<tid>:secrets — after this line it exists only inside the enclave.
const secret = `sk-test-${randomBytes(12).toString("hex")}`;
await seedEntry(tenant, "secrets", CREDENTIAL_KEY, secret);
console.log(`  credential sealed into z:<tid>:secrets[${CREDENTIAL_KEY}] (never printed again)`);

// The mandate names that credential, and demands a binding + idempotency key.
const mandate = { ...MANDATE, credential_key: CREDENTIAL_KEY, require_credential: true, require_idempotency_key: true };
await seedEntry(tenant, "mandate", "default", mandate);
console.log(`  mandate seeded with credential_key=${CREDENTIAL_KEY}`);

await grantEgress(client, tenant, agentDid, ["httpbin.org", "postman-echo.com"]);
console.log("  egress granted for httpbin.org, postman-echo.com\n");

try {
  // ── 1. the credential is injected inside the enclave ─────────────────────
  console.log("1. credential held in the enclave, injected on dispatch");

  // Control: dispatch_action is the diagnostic path. It sends no headers, and
  // nothing in it reads the secrets map — same enclave, same destination.
  const bare = await run("dispatch_action", { url: "https://httpbin.org/bearer", method: "GET" });
  check("without the credential path, the destination refuses: HTTP 401",
    bare.ok === true && bare.code === 401, JSON.stringify(bare));

  // The real path: the enclave reads the mandate, reads the secret it names,
  // and puts `Authorization: Bearer …` on the request. The agent supplied none
  // of that — look at the input.
  const authed = await run("execute_action", {
    action: ACTION, url: "https://httpbin.org/bearer", method: "GET", body: "",
    credential: credential(), idempotency_key: `cred-${randomUUID()}`,
  });
  check("through execute_action, the same destination accepts: HTTP 200",
    authed.decision === "approved" && authed.dispatched === true && authed.response?.code === 200,
    `decision=${authed.decision} dispatched=${authed.dispatched} response=${JSON.stringify(authed.response)}`);
  console.log(`        the bearer token was read from z:<tid>:secrets inside the enclave;`);
  console.log(`        this process sealed it and never sent it — the request input carried no header.\n`);

  // ── 2. the host substitutes profile data the agent never sees ────────────
  console.log("2. {{profile.*}} substituted by the host, not by this process");

  const substituted = await run("execute_action", {
    action: ACTION, url: "https://postman-echo.com/post", method: "POST",
    body: JSON.stringify({ investor: "{{profile.first_name}}", order: ACTION }),
    credential: credential(), idempotency_key: `ph-${randomUUID()}`,
  });
  check("a body with a real profile field is routed via http-with-placeholders and delivered",
    substituted.dispatch_via === "http-with-placeholders" && substituted.response?.ok === true && substituted.response?.code === 200,
    `dispatch_via=${substituted.dispatch_via} response=${JSON.stringify(substituted.response)}`);

  // Control: a field the profile does not have. If the host were not really
  // consulting the profile, this would go out as literal marker text and
  // succeed exactly like the one above.
  const unknown = await run("execute_action", {
    action: ACTION, url: "https://postman-echo.com/post", method: "POST",
    body: JSON.stringify({ investor: "{{profile.no_such_field_xyz}}" }),
    credential: credential(), idempotency_key: `ph-bad-${randomUUID()}`,
  });
  check("a field the profile lacks is refused by the host with a typed error, not sent as text",
    unknown.dispatch_via === "http-with-placeholders" && unknown.response?.ok === false
      && /placeholder_(unknown|denied)/.test(String(unknown.response?.error)),
    `response=${JSON.stringify(unknown.response)}`);
  console.log(`        the enclave returns only the status — never the body. On this path the body`);
  console.log(`        carries the investor's data, and returning it would hand that to the agent.\n`);

  // ── 3. a retry replays; it does not re-order ─────────────────────────────
  console.log("3. idempotent dispatch — the same key twice");

  const key = `order-${randomUUID()}`;
  const first = await run("execute_action", {
    action: ACTION, url: "https://postman-echo.com/post", method: "POST", body: JSON.stringify(ACTION),
    credential: credential(), idempotency_key: key,
  });
  check("first call under the key is dispatched",
    first.dispatched === true && first.replayed !== true && first.response?.code === 200,
    `dispatched=${first.dispatched} response=${JSON.stringify(first.response)}`);

  const retry = await run("execute_action", {
    action: ACTION, url: "https://postman-echo.com/post", method: "POST", body: JSON.stringify(ACTION),
    credential: credential(), idempotency_key: key,
  });
  check("the retry is NOT dispatched — the enclave replays the recorded outcome",
    retry.dispatched === false && retry.replayed === true,
    `dispatched=${retry.dispatched} replayed=${retry.replayed} idempotency_key=${retry.idempotency_key}`);
  check("and the outcome it replays is the first call's, byte for byte",
    JSON.stringify(retry.response) === JSON.stringify(first.response),
    `first=${JSON.stringify(first.response)} retry=${JSON.stringify(retry.response)}`);
  console.log(`        the record lives in z:<tid>:dispatched, readable and writable by the contract only —`);
  console.log(`        an agent cannot make a duplicate look like a replay, or a replay look new.\n`);
} catch (e) {
  failed++;
  console.log(`  FAIL  ${brief(e)}`);
} finally {
  // Leave the mandate as `npm run setup` would have written it. The secret
  // stays sealed; nothing reads it unless a mandate names it.
  await seedEntry(tenant, "mandate", "default", MANDATE);
  console.log("mandate restored to the setup default");
}

console.log(
  failed === 0
    ? "\nAll three enclave paths proven on testnet. None of them was a unit test until now."
    : `\n${failed} check(s) failed — the claim this covers is NOT proven. Do not describe it as shipped.`,
);
process.exit(failed === 0 ? 0 : 1);
