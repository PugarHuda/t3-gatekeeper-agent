// Accessibility, measured — axe-core driven by Playwright over the evidence
// site and the QA console, offline. Serious and critical violations fail;
// everything axe reports is printed so a regression is visible before it is a
// failure.
//
//   node --test a11y.test.mjs
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { start } from "./server.mjs";
import { serveSite } from "./helpers/static-site.mjs";

let browser, site, console_;

before(async () => {
  browser = await chromium.launch();
  site = serveSite();
  console_ = await start(0);
});
after(async () => { await browser?.close(); site?.close(); console_?.close(); });

async function audit(url, { setup } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load" });
  if (setup) await setup(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"]).analyze();
  await ctx.close();
  const rows = results.violations.map((v) => `${v.impact}: ${v.id} — ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")})`);
  if (rows.length) console.log(`  axe @ ${url}\n    ${rows.join("\n    ")}`);
  return results;
}

function blocking(results) {
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
}

describe("accessibility (axe-core)", () => {
  test("the evidence site has no serious or critical violations", async () => {
    const r = await audit(`${site.url}/`);
    assert.deepEqual(blocking(r), []);
    assert.ok(r.passes.length > 20, `axe ran ${r.passes.length} passing rules — too few to mean anything`);
  });

  test("the QA console, idle and after a verdict, has no serious or critical violations", async () => {
    const idle = await audit(`http://localhost:${console_.address().port}/`);
    assert.deepEqual(blocking(idle), []);
    const decided = await audit(`http://localhost:${console_.address().port}/`, {
      setup: async (page) => {
        await page.getByTestId("s-bind-moved").click();
        await page.waitForFunction(() => document.body.dataset.decision !== undefined);
      },
    });
    assert.deepEqual(blocking(decided), []);
  });

  test("every scenario button has an accessible name that says what it tries", async () => {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${console_.address().port}/`);
    const names = await page.$$eval("button[data-testid]", (bs) => bs.map((b) => (b.getAttribute("aria-label") ?? b.textContent).trim()));
    assert.equal(names.length, 18);
    for (const n of names) assert.ok(n.length > 12, `too short to be a name: ${JSON.stringify(n)}`);
    await page.close();
  });
});
