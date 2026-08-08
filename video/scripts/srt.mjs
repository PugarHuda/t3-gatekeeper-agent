// Emit a standalone .srt from the same timing the video burns in, so YouTube
// (or any player) gets real captions rather than auto-transcribed guesses.
//
//   node scripts/srt.mjs   ->  out/gatekeeper-demo.srt
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import timing from "../src/timing.json" with { type: "json" };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(path.join(ROOT, "out"), { recursive: true });

const stamp = (frames) => {
  const total = frames / timing.fps;
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(total % 60)).padStart(2, "0");
  const ms = String(Math.round((total % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
};

const out = [];
let sceneStart = 0, n = 0;

for (const scene of timing.scenes) {
  for (const cue of scene.captions) {
    const from = sceneStart + cue.from;
    out.push(`${++n}\n${stamp(from)} --> ${stamp(from + cue.durationInFrames)}\n${cue.text}\n`);
  }
  sceneStart += scene.durationInFrames;
}

const file = path.join(ROOT, "out", "gatekeeper-demo.srt");
writeFileSync(file, out.join("\n"), "utf8");
console.log(`wrote ${file} — ${n} cues, ${(sceneStart / timing.fps).toFixed(1)}s`);
