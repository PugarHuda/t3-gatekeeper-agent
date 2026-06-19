// Record the Gatekeeper Agent demo to a finished MP4 — no manual screen capture.
//
//   1. Playwright opens player.html?auto=1 and records the page to a silent .webm
//      (the page plays the voice-over clips only to drive on-screen timing).
//   2. ffmpeg concatenates the 12 voice-over WAVs into one track and muxes it
//      onto the video, so picture and narration line up by construction.
//
// Usage:  npm run record        (from submission/demo-web)
// Output: submission/demo-web/out/gatekeeper-demo.mp4
import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, rm, access, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { wavOrder } from "./scenes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");          // submission/ — serves demo-web/ + voiceover/
const VO_DIR = path.resolve(HERE, "..", "voiceover");
const OUT_DIR = path.join(HERE, "out");
const VIDEO_DIR = path.join(OUT_DIR, "raw");
const FINAL = path.join(OUT_DIR, "gatekeeper-demo.mp4");
const W = 1280, H = 720;

const log = (...a) => console.log("[record]", ...a);

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function preflight() {
  if (!ffmpegPath) throw new Error("ffmpeg-static did not resolve a binary path.");
  const missing = [];
  for (const { wav } of wavOrder) {
    if (!(await exists(path.join(VO_DIR, wav)))) missing.push(wav);
  }
  if (missing.length) {
    throw new Error(
      `Missing voice-over WAVs in ${VO_DIR}:\n  ${missing.join("\n  ")}\n` +
      `Generate them first:  cd ../voiceover && powershell -ExecutionPolicy Bypass -File generate-vo.ps1`
    );
  }
}

const MIME = {
  ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
  ".wav": "audio/wav", ".png": "image/png", ".css": "text/css", ".json": "application/json",
};

// Serve submission/ over http so the player's ES modules + audio load (file://
// blocks module imports via CORS).
function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const buf = await readFile(file);
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(buf);
      } catch { res.writeHead(404).end("not found"); }
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function capture(port) {
  await rm(VIDEO_DIR, { recursive: true, force: true });
  await mkdir(VIDEO_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => log("PAGE ERROR:", e.message));
  const url = `http://127.0.0.1:${port}/demo-web/player.html?auto=1`;
  log("opening", url);
  await page.goto(url);

  log("recording — waiting for the demo to finish…");
  let last = null;
  const ticker = setInterval(async () => {
    try {
      const s = await page.evaluate("window.__SCENE__ || null");
      if (s && s !== last) { last = s; log("scene:", s); }
    } catch { /* page closing */ }
  }, 1500);
  await page.waitForFunction("window.__DEMO_DONE__ === true", null, { timeout: 6 * 60 * 1000 });
  clearInterval(ticker);
  log("demo finished; finalizing video");

  await page.close();
  await context.close();
  await browser.close();

  // The recorded webm has an auto-generated name; grab the newest .webm.
  const files = (await readdir(VIDEO_DIR)).filter((f) => f.endsWith(".webm"));
  if (!files.length) throw new Error("Playwright produced no video file.");
  const webm = path.join(VIDEO_DIR, files[0]);
  log("captured", path.relative(HERE, webm));
  return webm;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    log("ffmpeg", args.join(" "));
    const p = spawn(ffmpegPath, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exited " + code))));
  });
}

async function mux(webm) {
  // inputs: [0]=video, [1..N]=the voice-over wavs in scene order
  const inputs = ["-y", "-i", webm];
  for (const { wav } of wavOrder) inputs.push("-i", path.join(VO_DIR, wav));

  const n = wavOrder.length;
  const concat = Array.from({ length: n }, (_, i) => `[${i + 1}:a]`).join("") +
    `concat=n=${n}:v=0:a=1[a]`;

  const args = [
    ...inputs,
    "-filter_complex", concat,
    "-map", "0:v:0", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    "-shortest", "-movflags", "+faststart",
    FINAL,
  ];
  await runFfmpeg(args);
}

(async () => {
  await preflight();
  await mkdir(OUT_DIR, { recursive: true });
  const { server, port } = await startServer();
  log("static server on 127.0.0.1:" + port);
  let webm;
  try {
    webm = await capture(port);
  } finally {
    server.close();
  }
  await mux(webm);
  log("✅ done →", path.relative(HERE, FINAL));
  log("   upload this MP4 (YouTube unlisted) and paste the link into BUIDL_DESCRIPTION.md");
})().catch((e) => { console.error("[record] FAILED:", e.message); process.exit(1); });
