// Generate what the evidence site publishes on the agent's behalf: the
// revocation status list, and the copy of the agent card that A2A peers fetch.
//
//   npm run status-list            regenerate site/status/revocation.json + the card copy
//   REVOKED_INDICES=7,42 npm run status-list
//
// The card is copied rather than hand-maintained because Vercel deploys only
// `site/`, so the served card has to physically live there — and two files
// nobody imports are two files that drift. A test asserts they are identical.
//
// This is the issuer's side of revocation. The list is a real, standards-shaped
// BitstringStatusListCredential served over HTTPS — no chain and no gas, which
// is why it works today where the on-chain registry path does not.
//
// Index 7 is revoked on purpose: a verifier needs something that comes back
// REVOKED, or the check has never been shown to do anything. The demo issues one
// credential at that index for exactly that reason.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildStatusList, decodeList, getBit, STATUS_LIST_URL, DEMO_REVOKED_INDEX } from "./status-list.mjs";
import { buildRegistrationFile, validateRegistrationFile, REGISTRATION_URL } from "./erc8004-registration.mjs";

const revoked = (process.env.REVOKED_INDICES ?? String(DEMO_REVOKED_INDEX))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);

const doc = buildStatusList({
  id: STATUS_LIST_URL,
  issuer: process.env.STATUS_LIST_ISSUER ?? "did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f",
  revoked,
  // No validFrom: it would change on every regeneration and make the file churn
  // in git for no reason. A real issuer stamps and re-signs on each publish.
});

const out = fileURLToPath(new URL("../../site/status/revocation.json", import.meta.url));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");

// Read it straight back rather than trusting the write — a status list that
// decodes to the wrong bits is worse than none, because it answers.
const bytes = decodeList(doc.credentialSubject.encodedList);
console.log(`Wrote ${path.relative(process.cwd(), out)}`);
console.log(`  ${STATUS_LIST_URL}`);
console.log(`  entries  ${bytes.length * 8}`);
console.log(`  revoked  ${revoked.join(", ") || "(none)"}`);
for (const i of revoked) {
  if (getBit(bytes, i) !== 1) throw new Error(`index ${i} did not survive the round trip`);
}
console.log(`  verified: every revoked index reads back as revoked`);

// The published A2A card is the v1.0 card the server itself serves, pointing
// at the hosted endpoint — generated from agent/agent-card.json by the same
// buildAgentCard() `npm run a2a` uses, so what a peer discovers at
// /.well-known/agent-card.json is exactly what answers at /api/a2a. A test in
// agent/test/a2a.test.mjs fails if the published file drifts from that.
const { buildAgentCard } = await import("./a2a-server.mjs");
const { PUBLIC_A2A_URL } = await import("./hosted.mjs");
const cardOut = fileURLToPath(new URL("../../site/.well-known/agent-card.json", import.meta.url));
mkdirSync(path.dirname(cardOut), { recursive: true });
const card = buildAgentCard(PUBLIC_A2A_URL);
writeFileSync(cardOut, JSON.stringify(card, null, 2) + "\n");
console.log(`\nWrote ${path.relative(process.cwd(), cardOut)}  (v${card.version}, A2A ${card.supportedInterfaces[0].protocolVersion} at ${PUBLIC_A2A_URL})`);

// The ERC-8004 registration file — what the on-chain agentURI resolves to.
// `registrations` is filled from agent/erc8004-minted.json once a mint has
// happened; before that it is an honest empty list.
let minted = null;
try {
  minted = JSON.parse(readFileSync(new URL("../erc8004-minted.json", import.meta.url), "utf8"));
} catch { /* not minted yet */ }
const reg = buildRegistrationFile({ minted, a2aEndpoint: process.env.A2A_BASE_URL || PUBLIC_A2A_URL });
const check = validateRegistrationFile(reg);
if (!check.valid) throw new Error(`registration file is not conformant: ${check.problems.join("; ")}`);
const regOut = fileURLToPath(new URL("../../site/.well-known/erc8004-registration.json", import.meta.url));
writeFileSync(regOut, JSON.stringify(reg, null, 2) + "\n");
console.log(`\nWrote ${path.relative(process.cwd(), regOut)}  (${REGISTRATION_URL})`);
console.log(`  registrations: ${reg.registrations.length ? JSON.stringify(reg.registrations) : "(not minted yet)"}`);

console.log(`\nDeploy with: npx vercel deploy --prod --yes   (repo root — site/ is the output, api/ the functions)`);
