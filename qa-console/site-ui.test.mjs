// The evidence page as a thing people use — offline, against the static
// files Vercel deploys: the copy buttons put the command on the clipboard,
// the navigation lands on its sections, the evidence index counts are true,
// and the scrolling screenshot frames can be reached and moved by keyboard.
//
//   node --test site-ui.test.mjs
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { serveSite } from "./helpers/static-site.mjs";

let browser, ctx, page, site;

before(async () => {
  site = serveSite();
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await ctx.newPage();
  await page.goto(`${site.url}/`, { waitUntil: "load" });
  // Smooth scrolling is a nicety for people; for a test it is a race.
  await page.addStyleTag({ content: "html{scroll-behavior:auto!important}" });
});
after(async () => { await browser?.close(); site?.close(); });

describe("evidence page — interaction", () => {
  test("every Copy button copies exactly the code beside it, and says so", async () => {
    const buttons = page.locator("button.copy");
    const n = await buttons.count();
    assert.ok(n >= 6, `expected the Use-it and Verify code blocks to have copy buttons, found ${n}`);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const expected = await b.evaluate((el) => el.parentElement.querySelector("pre").textContent);
      await b.click();
      // The label flips after the clipboard promise resolves — wait for it.
      await page.waitForFunction((i) => document.querySelectorAll("button.copy")[i].textContent === "Copied", i, { timeout: 2000 });
      // Windows normalises clipboard text to CRLF; the terminal does not care.
      const clip = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
      assert.equal(clip, expected, `copy button ${i}`);
    }
    // The label restores itself: a button that stays "Copied" lies on the next click.
    await page.waitForFunction(() => [...document.querySelectorAll("button.copy")].every((b) => b.textContent === "Copy"), null, { timeout: 4000 });
  });

  test("the top navigation reaches every section, and the sticky bar does not cover the heading", async () => {
    const links = await page.$$eval(".bar nav a[href^='#']", (as) => as.map((a) => a.getAttribute("href").slice(1)));
    assert.ok(links.length >= 5);
    for (const id of links) {
      await page.click(`.bar nav a[href='#${id}']`);
      await page.waitForFunction((id) => location.hash === `#${id}`, id);
      const inView = await page.evaluate((id) => {
        const el = document.getElementById(id);
        const bar = document.querySelector(".bar").getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.top >= bar.bottom - 1 && r.top < window.innerHeight;
      }, id);
      assert.ok(inView, `#${id} should land below the sticky bar and inside the viewport`);
    }
  });

  test("the evidence index counts match the figures under each group", async () => {
    const counts = await page.$$eval(".toc a", (as) => as.map((a) => [a.getAttribute("href").slice(1), Number(a.querySelector("small").textContent)]));
    assert.equal(counts.length, 4);
    let total = 0;
    for (const [id, claimed] of counts) {
      const actual = await page.locator(`#${id} figure`).count();
      assert.equal(actual, claimed, `${id}: index says ${claimed}, page has ${actual}`);
      total += actual;
    }
    assert.equal(total, 32);
  });

  test("a tall screenshot frame is reachable by keyboard and scrolls with the arrow keys", async () => {
    const frame = page.locator(".shot.tall").first();
    await frame.scrollIntoViewIfNeeded();
    // The image is lazy: until it has loaded there is nothing to scroll.
    await frame.locator("img").evaluate((img) => img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }));
    await page.waitForFunction((el) => el.scrollHeight > el.clientHeight, await frame.elementHandle());
    await frame.evaluate((el) => { el.scrollTop = 0; });
    await frame.focus();
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("tall")), true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction((el) => el.scrollTop > 0, await frame.elementHandle(), { timeout: 2000 });
    // The full-size link opens the same file the frame shows.
    const src = await frame.locator("img").getAttribute("src");
    const href = await frame.locator("xpath=following-sibling::figcaption").locator("a.open").getAttribute("href");
    assert.equal(href, src);
  });

  test("the page works without JavaScript for everything but the copy buttons", async () => {
    const nojs = await browser.newContext({ javaScriptEnabled: false });
    const p = await nojs.newPage();
    await p.goto(`${site.url}/`, { waitUntil: "load" });
    assert.equal(await p.locator("figure").count(), 32);
    assert.equal(await p.locator("a[href='/.well-known/agent-card.json']").count(), 1);
    await nojs.close();
  });
});
