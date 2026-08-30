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

Every claim in the script was one there was evidence for **when it was
rendered**, on 8 August 2026. It deliberately did not say v0.8.0 was live,
because it was not: the live contract at the time was v0.7.0, and the `HTTP 200`
in the run scene was captured on 7 August.

> **The render is now behind the repo.** Since 27 August the live contract is
> **v0.10.0, `contract_id 749`**, and the agent has gained the hosted A2A and
> MCP doors, a signed card over did:web, an ERC-8004 identity (#201) and a
> settled x402 payment — none of which the video mentions. Nothing it says has
> become *false*, but it is no longer the whole picture. The current account is
> the evidence site and [`submission/SUBMISSION.md`](../submission/SUBMISSION.md).
> Re-rendering is a `npm run tts && npm run render` away once `src/script.mjs`
> is updated.

If the contract changes, update `src/script.mjs` and re-render; do not edit the
MP4.
