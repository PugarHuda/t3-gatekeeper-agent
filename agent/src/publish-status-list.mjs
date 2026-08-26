// Generate the revocation status list the evidence site publishes.
//
//   npm run status-list            regenerate site/status/revocation.json
//   REVOKED_INDICES=7,42 npm run status-list
//
// This is the issuer's side of revocation. The list is a real, standards-shaped
// BitstringStatusListCredential served over HTTPS — no chain and no gas, which
// is why it works today where the on-chain registry path does not.
//
// Index 7 is revoked on purpose: a verifier needs something that comes back
// REVOKED, or the check has never been shown to do anything. The demo issues one
// credential at that index for exactly that reason.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildStatusList, decodeList, getBit, STATUS_LIST_URL, DEMO_REVOKED_INDEX } from "./status-list.mjs";

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
console.log(`\nDeploy with: cd site && npx vercel deploy --prod --yes`);
