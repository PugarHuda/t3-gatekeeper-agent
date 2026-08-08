# Demo video — Remotion + neural TTS

A 2½-minute demo rendered programmatically. No screen recording, no manual
editing, no timeline to nudge.

```bash
npm install
npm run tts       # synthesise narration, measure it, write src/timing.json
npm run srt       # standalone subtitle file (for YouTube)
npm run render    # out/gatekeeper-demo.mp4
npm run studio    # live preview while editing scenes
```

## How it stays in sync

`src/script.mjs` is the single source of truth: narration, on-screen content and
captions all come from it.

`scripts/tts.mjs` speaks each scene with a Microsoft neural voice (`msedge-tts`
— no API key), then **measures the rendered audio with ffmpeg** and writes
`src/timing.json`. Remotion derives every scene's `durationInFrames` from that
measurement.

The consequence: change a sentence, re-run `npm run tts`, and the picture
re-times itself. Nothing is hand-tuned, so nothing can drift out of sync — which
is exactly what went wrong with the previous video, where the narration was
recorded against a flow that later changed.

## Captions

Burned in, and timed by splitting each scene's measured audio across its
sentences proportionally to their length.

Where narration has to be spelled phonetically to be pronounced correctly —
`"H T T P two hundred"`, `"A I agent"` — the scene carries a separate
`captionText` with the readable form (`HTTP 200`, `AI agent`). Otherwise the
viewer reads the phonetics, which looks like a mistake.

`npm run srt` emits the same cues as a standalone `.srt` for YouTube, so the
captions there are real rather than auto-transcribed.

## Accuracy

Every claim in the script is one there is evidence for, and the script
deliberately does **not** say v0.8.0 is live — it is built and tested but not
registered. The live contract is v0.7.0. The `HTTP 200` shown in the run scene
was captured on 7 August.

If the contract changes, update `src/script.mjs` and re-render; do not edit the
MP4.
