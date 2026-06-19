# demo-web — automated demo-video recorder

Produces the finished Gatekeeper Agent demo video **without screen-recording by
hand and without spending testnet credits**. An HTML terminal player replays the
demo transcript; Playwright captures it to video; ffmpeg muxes the existing
voice-over track on top — picture and narration stay in sync because both are
driven by the same audio clips.

```
scenes.mjs    one source of truth: 12 scenes ↔ ../voiceover/*.wav, with the
              transcript reconstructed verbatim from the demo sources
player.html   terminal player — types each scene, paced to its voice-over clip
record.mjs    Playwright records player.html → .webm, then ffmpeg → final .mp4
```

## Make the video

```powershell
cd submission/demo-web
npm install                 # playwright + ffmpeg-static (already vendored here)
npm run browser             # one-time: download the Chromium build Playwright drives
npm run record              # → out/gatekeeper-demo.mp4   (~4 min, 1280×720, h264+aac)
```

Then upload `out/gatekeeper-demo.mp4` (YouTube, unlisted) and paste the link into
`../BUIDL_DESCRIPTION.md` and the DoraHacks form (see `../FORM_ANSWERS_FILLED.md`).

## Preview the visuals (no recording)

Open `player.html` in Chrome/Edge and click ▶. (It loads ES modules + audio over
`file://`, which Chromium allows.)

## Requirements

- The 12 voice-over WAVs in `../voiceover/` (git-ignored; regenerate with
  `../voiceover/generate-vo.ps1`). `record.mjs` checks for them and refuses to run
  if any are missing.
- Node 18+. ffmpeg ships via `ffmpeg-static`; no system install needed.

## Editing the demo

Everything is in `scenes.mjs`. Each scene declares its `wav`, an `est` fallback
duration, and either terminal `lines` or diagram `html`. To change a line, edit
it there and re-run `npm run record` — `player.html` and `record.mjs` both read
the same file, so they never drift.

> The transcript mirrors a real `npm run demo` / `demo:sd` / `demo:velocity` run
> (see `../DEMO_SCRIPT.md`). If you re-run the live agent and want the exact
> on-chain ids/DIDs from that run, paste them into `scenes.mjs`.
