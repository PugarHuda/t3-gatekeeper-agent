// Screenshot the QA console in a passing and a failing state, for the submission.
//   node shots.mjs   ->  ../submission/screenshots/out/11-qa-*.png
import { chromium } from "playwright";
import { start } from "./server.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "submission", "screenshots", "out");

const server = await start(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 720 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${server.address().port}`);

for (const [id, file] of [
  ["s-happy", "11-qa-console-approved.png"],
  ["s-payee", "12-qa-console-rejected.png"],
  ["s-issuer-bad", "13-qa-console-self-issued.png"],
  // The attack the credential binding exists to stop: a real verification,
  // moved onto a bigger action.
  ["s-bind-moved", "19-qa-console-binding-moved.png"],
]) {
  await page.getByTestId(id).click();
  await page.waitForFunction(() => document.body.dataset.decision !== undefined);
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`wrote ${file}`);
  await page.evaluate(() => { delete document.body.dataset.decision; });
}

await browser.close();
server.close();
