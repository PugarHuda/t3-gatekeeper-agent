# Demo voice-over (auto-generated)

The `*.wav` files here are the demo narration, generated from the script by
Windows' built-in text-to-speech — no human recording, no installs. They are
**git-ignored** (binary, ~10 MB); regenerate any time:

```powershell
powershell -ExecutionPolicy Bypass -File generate-vo.ps1
# options:  -Voice "Microsoft David Desktop"   (male)   default: Zira (female)
#           -Rate -2                            (slower)  default: -1
```

> These are robotic TTS voices — perfect as a **timing/placeholder track**, and
> usable as-is. For the final cut you may prefer to re-record in your own voice
> (the text below is your script).

## Total runtime ≈ 4.0 min — segment map
Drop each clip onto the matching moment in your editor (or just play them in order
while the terminal runs with `DEMO_PAUSE_MS` pacing).

| WAV | ≈ sec | Scene / cue — line it lands on |
| --- | --- | --- |
| `01-hook.wav` | 19 | Scene 0 — hook (over the architecture diagram) |
| `02-contract.wav` | 22 | Scene 1 — the Rust contract + "15 gate tests, green" |
| `03-deploy.wav` | 9 | Scene 2 — over `Registered ✅ … contract_id …` |
| `04-run-identity.wav` | 7 | `[1] IDENTITY …` |
| `05-run-vcgate.wav` | 14 | `[2] VC GATE … eligible=true` |
| `06-run-revocation.wav` | 10 | `[2b] REVOCATION skipped …` |
| `07-run-approved.wav` | 9 | `[3] MANDATE buy $1,000 … APPROVED` |
| `08-run-dispatch.wav` | 16 | `[5] DISPATCH … signed …` + `in-TEE call -> egress gated` |
| `09-run-rejections.wav` | 26 | the four REJECTED scenarios ($9k / DOGE / unknown payee / future-dated) |
| `10-selective-disclosure.wav` | 45 | Scene 3.5 — `npm run demo:sd`, the `[2] VC GATE` block |
| `11-velocity.wav` | 26 | Scene 3.6 — `npm run demo:velocity`, the 3 spend lines |
| `12-why-it-matters.wav` | 37 | Scene 4 — closing (over the SDK-layer table) |

## Recording flow
1. In `agent/`, pace the demos so audio lands on each line:
   ```powershell
   $env:DEMO_PAUSE_MS = "2500"
   npm run demo ; npm run demo:sd ; npm run demo:velocity
   ```
   (Skip `npm run setup` — the contract is already deployed; re-deploying is the
   only expensive op.)
2. Screen-record the terminal (OBS / Xbox Game Bar / any recorder).
3. In your editor, lay the WAVs above onto the matching lines. Trim the two long
   clips (`10`, `12`) if you need to hit a 3-minute target.

Full narration text + the cue sheet: see `../DEMO_SCRIPT.md`.
