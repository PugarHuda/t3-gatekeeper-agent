// Verify the rendered demo, rather than trusting the renderer's exit code —
// a file that exists is not a file that decodes, and a video that decodes is
// not necessarily one with sound.
//
// Uses ffmpeg, not a browser: Playwright's bundled Chromium ships without the
// proprietary H.264/AAC decoders, so it cannot open this file at all.
//
//   node --test video.test.mjs
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import timing from "../video/src/timing.json" with { type: "json" };

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MP4 = path.resolve(HERE, "..", "video", "out", "gatekeeper-demo.mp4");
const SRT = path.resolve(HERE, "..", "video", "out", "gatekeeper-demo.srt");
const FFMPEG = path.resolve(HERE, "..", "submission", "demo-web",
  "node_modules", "ffmpeg-static", "ffmpeg.exe");

let probe = "";
before(async () => {
  if (!existsSync(MP4)) return;
  // ffmpeg reports to stderr and exits non-zero when given no output target.
  try {
    const r = await execFileP(FFMPEG, ["-hide_banner", "-i", MP4]);
    probe = r.stderr;
  } catch (e) {
    probe = String(e.stderr ?? "");
  }
});

describe("rendered demo video", () => {
  test("exists and is a plausible size", () => {
    assert.ok(existsSync(MP4), "render produced no file");
    const mb = statSync(MP4).size / 1024 / 1024;
    assert.ok(mb > 1, `suspiciously small: ${mb.toFixed(2)} MB`);
    assert.ok(mb < 90, `too large to deploy as a static asset: ${mb.toFixed(2)} MB`);
  });

  test("is 1920x1080 H.264", () => {
    assert.match(probe, /Video: h264/, "not H.264 — will not play in Safari/iOS");
    assert.match(probe, /1920x1080/);
  });

  test("has an audio track", () => {
    // Remotion produces a silent file if the Audio tags resolve to nothing, and
    // a muted demo looks correct right up until someone presses play.
    assert.match(probe, /Audio: aac/, "no AAC audio track — the narration is missing");
  });

  test("its length matches the measured narration", () => {
    const m = probe.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    assert.ok(m, "ffmpeg reported no duration");
    const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const expected = timing.totalFrames / timing.fps;
    // If a scene collapsed or the audio were dropped, duration is where it shows.
    assert.ok(Math.abs(seconds - expected) < 1.5,
      `duration ${seconds.toFixed(1)}s vs expected ${expected.toFixed(1)}s`);
  });

  test("subtitles were emitted and are well-formed", () => {
    assert.ok(existsSync(SRT), "no .srt — YouTube would have to auto-transcribe");
    const srt = statSync(SRT).size;
    assert.ok(srt > 500, "subtitle file looks empty");
  });
});
