// Smoke-test the deployed evidence site: it is the submission artifact, so a
// broken image or a dead link is a real defect, not a cosmetic one.
//
//   node --test site.test.mjs        (override with SITE_URL=…)
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAgentKey, signRequest, verifyRequest, keyFromDirectory, generateAgentKey,
} from "../agent/src/web-bot-auth.mjs";

const SITE = process.env.SITE_URL ?? "https://gatekeeper-evidence.vercel.app";

/** Read one key out of agent/.env without pulling in a dotenv dependency. */
function readEnv(name) {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", ".env");
  try {
    return readFileSync(file, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  } catch {
    return undefined;
  }
}
let browser, page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });

describe("evidence site", () => {
  test("loads over https with the right title", async () => {
    const res = await page.goto(SITE, { waitUntil: "networkidle" });
    assert.equal(res.status(), 200);
    assert.match(await page.title(), /Gatekeeper/i);
  });

  test("every screenshot actually renders", async () => {
    // naturalWidth is 0 for an <img> whose file 404s — the failure mode that
    // silently turns an evidence page into a page of empty boxes.
    const broken = await page.$$eval("img", (imgs) =>
      imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src")));
    assert.deepEqual(broken, [], `broken images: ${broken.join(", ")}`);
    const count = await page.locator("img").count();
    assert.ok(count >= 10, `expected the full evidence set, found ${count}`);
  });

  test("states the use case, not just the tech", async () => {
    const body = await page.textContent("body");
    for (const phrase of ["accredited", "Meridian", "mandate"]) {
      assert.ok(body.includes(phrase), `missing "${phrase}" — the positioning fix regressed`);
    }
  });

  test("the repo link points at the public repo", async () => {
    const href = await page.getAttribute('a[href*="github.com"]', "href");
    assert.match(href, /PugarHuda\/t3-gatekeeper-agent/);
  });

  test("an unknown path does not return a 200", async () => {
    const res = await page.request.get(`${SITE}/definitely-not-a-page`);
    assert.notEqual(res.status(), 200);
  });

  test("the demo video is embedded and served seekably", async () => {
    assert.equal(await page.locator("video source[type='video/mp4']").count(), 1);
    // Range support is what lets a viewer scrub instead of waiting for the whole
    // file; a 200 here means the CDN is streaming it whole.
    const res = await page.request.get(`${SITE}/gatekeeper-demo.mp4`, {
      headers: { Range: "bytes=0-1023" },
    });
    assert.equal(res.status(), 206, "video is not served with range support");
    assert.match(res.headers()["content-type"], /video\/mp4/);
  });

  test("the subtitle file is published", async () => {
    const res = await page.request.get(`${SITE}/gatekeeper-demo.srt`);
    assert.equal(res.status(), 200);
    assert.match(await res.text(), /^1\r?\n00:00:00,000 --> /);
  });
});

describe("web bot auth key directory (live)", () => {
  const DIR = "/.well-known/http-message-signatures-directory";

  test("is served with the RFC media type", async () => {
    const res = await page.request.get(`${SITE}${DIR}`);
    assert.equal(res.status(), 200);
    assert.match(res.headers()["content-type"], /http-message-signatures-directory\+json/);
  });

  test("a real destination can verify our signature using only the published key", async () => {
    // The whole point of a key directory, exercised over the public internet:
    // sign here, fetch the key from the web, verify with nothing shared.
    const res = await page.request.get(`${SITE}${DIR}`);
    const directory = JSON.parse(await res.text());
    const keyid = `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f#wba`;

    const priv = process.env.WBA_PRIVATE_KEY ?? readEnv("WBA_PRIVATE_KEY");
    if (!priv) return; // key not configured locally — nothing to assert against
    const { privateKey } = loadAgentKey({ WBA_PRIVATE_KEY: priv });

    const req = { method: "POST", url: "https://broker.example/v1/orders", body: '{"amount_cents":100000}' };
    const headers = signRequest(req, { privateKey, keyid });
    const published = keyFromDirectory(directory, keyid);
    assert.ok(published, "our keyid must be resolvable in the live directory");
    assert.equal(verifyRequest(req, headers, published), true,
      "the published key must verify a signature made by the configured private key");
  });

  test("the published key rejects a signature from a different key", async () => {
    const res = await page.request.get(`${SITE}${DIR}`);
    const directory = JSON.parse(await res.text());
    const keyid = `did:t3n:3d7dd668ccf58ff2ac0fa8662572e12d35aad05f#wba`;
    const impostor = generateAgentKey();
    const req = { method: "POST", url: "https://broker.example/v1/orders" };
    const headers = signRequest(req, { privateKey: impostor.privateKey, keyid });
    assert.equal(verifyRequest(req, headers, keyFromDirectory(directory, keyid)), false);
  });
});
