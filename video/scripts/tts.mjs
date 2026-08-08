// Synthesise the narration with a neural voice and measure it.
//
// The old video used Windows SAPI, which sounds like a 1998 screen reader.
// msedge-tts speaks to the same neural endpoint Edge's Read Aloud uses — no API
// key, no account.
//
// Durations are MEASURED from the rendered audio, never estimated: Remotion
// derives every scene length from durations.json, so picture and narration stay
// in sync by construction rather than by hand-tuning a timeline.
//
//   node scripts/tts.mjs        ->  public/audio/*.mp3, src/timing.json
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scenes } from "../src/script.mjs";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const AUDIO = path.join(ROOT, "public", "audio");
const FFMPEG = path.resolve(ROOT, "..", "submission", "demo-web", "node_modules",
  "ffmpeg-static", "ffmpeg.exe");

const VOICE = process.env.TTS_VOICE ?? "en-US-AndrewMultilingualNeural";
const RATE = process.env.TTS_RATE ?? "-4%";   // a touch slower reads as considered
const FPS = 30;

mkdirSync(AUDIO, { recursive: true });

/** Duration in seconds, read from ffmpeg's own report rather than guessed. */
async function durationOf(file) {
  // ffmpeg writes its report to stderr and exits 0 for `-f null -`, so the
  // duration has to be parsed on success as well as on failure.
  let stderr = "";
  try {
    ({ stderr } = await execFileP(FFMPEG, ["-i", file, "-f", "null", "-"]));
  } catch (e) {
    stderr = String(e.stderr ?? "");
  }
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (dur) return Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  const times = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
  if (times?.length) {
    const [h, mnt, s] = times.at(-1).replace("time=", "").split(":").map(Number);
    return h * 3600 + mnt * 60 + s;
  }
  throw new Error(`could not measure ${file}`);
}

/**
 * Split narration into caption chunks. Sentences are the natural unit; long ones
 * are broken at a clause so a caption never becomes a wall of text.
 */
function chunk(text) {
  const out = [];
  for (const sentence of text.split(/(?<=[.?!])\s+/).filter(Boolean)) {
    if (sentence.length <= 90) { out.push(sentence.trim()); continue; }
    let buf = "";
    for (const part of sentence.split(/(?<=,|—)\s+/)) {
      if ((buf + " " + part).trim().length > 90 && buf) { out.push(buf.trim()); buf = part; }
      else buf = (buf + " " + part).trim();
    }
    if (buf) out.push(buf.trim());
  }
  return out;
}

if (!existsSync(FFMPEG)) throw new Error(`ffmpeg not found at ${FFMPEG}`);

const timing = { fps: FPS, voice: VOICE, scenes: [] };

for (const scene of scenes) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const target = path.join(AUDIO, `${scene.id}.mp3`);
  rmSync(target, { force: true });

  // toFile writes into a directory with a generated name; normalise it.
  const tmp = path.join(AUDIO, `_tmp_${scene.id}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const res = await tts.toFile(tmp, scene.narration, { rate: RATE });
  const produced = res?.audioFilePath && existsSync(res.audioFilePath)
    ? res.audioFilePath
    : path.join(tmp, readdirSync(tmp).find((f) => f.endsWith(".mp3")));
  renameSync(produced, target);
  rmSync(tmp, { recursive: true, force: true });

  const seconds = await durationOf(target);
  // A beat of silence after each line so scenes do not slam into each other.
  const padded = seconds + 0.55;
  // Captions show the readable text; the TTS spoke the phonetic one.
  const chunks = chunk(scene.captionText ?? scene.narration);
  const totalChars = chunks.reduce((a, c) => a + c.length, 0);

  let at = 0;
  const captions = chunks.map((text) => {
    const share = (text.length / totalChars) * seconds;
    const cue = { text, from: Math.round(at * FPS), durationInFrames: Math.max(1, Math.round(share * FPS)) };
    at += share;
    return cue;
  });

  timing.scenes.push({
    id: scene.id,
    audio: `audio/${scene.id}.mp3`,
    seconds: padded,
    durationInFrames: Math.ceil(padded * FPS),
    captions,
  });
  console.log(`  ${scene.id.padEnd(9)} ${seconds.toFixed(2)}s  ${chunks.length} caption(s)`);
}

const total = timing.scenes.reduce((a, s) => a + s.durationInFrames, 0);
timing.totalFrames = total;
writeFileSync(path.join(ROOT, "src", "timing.json"), JSON.stringify(timing, null, 2));
console.log(`\ntotal ${(total / FPS).toFixed(1)}s (${total} frames @ ${FPS}fps) — wrote src/timing.json`);
