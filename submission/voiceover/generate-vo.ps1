# Generate demo voice-over WAVs from the narration, using Windows' built-in SAPI
# text-to-speech (no installs). One WAV per scene, plus a combined full track.
#
#   powershell -ExecutionPolicy Bypass -File generate-vo.ps1
#   powershell -File generate-vo.ps1 -Voice "Microsoft David Desktop" -Rate -1
#
# Voices available here: "Microsoft Zira Desktop" (F), "Microsoft David Desktop" (M).
# Rate is -10..10 (0 = normal; -1/-2 reads a little slower for clarity).
# These are robotic TTS voices — fine as a timing track or placeholder; re-record
# in your own voice for the final cut if you prefer.
param(
  [string]$Voice = "Microsoft Zira Desktop",
  [int]$Rate = -1
)
Add-Type -AssemblyName System.Speech
$out = $PSScriptRoot

# Spoken-friendly narration (symbols/IDs removed so TTS reads naturally).
$scenes = [ordered]@{
  "01-hook" = "A I agents that act on your money usually need your credentials and your data. The Gatekeeper Agent never holds either. It proves you are eligible with a verifiable credential, and a hardware trusted execution environment enforces how much it can spend, on Terminal 3."
  "02-contract" = "The mandate is enforced by a Rust contract, compiled to a wasm component and run inside Terminal 3's enclave. It checks amount, asset, kind, counterparty and expiry, reading the mandate from a tenant key value map the agent itself cannot forge. Fifteen gate tests, green."
  "03-deploy" = "We compile to a wasm component and register it to our tenant on testnet. That is a real on chain contract id."
  "04-run-identity" = "The agent authenticates over an encrypted session. That is its decentralized identity."
  "05-run-vcgate" = "A trusted issuer signed a B B S plus credential proving accredited investor. No net worth, no name, no date of birth. And we verify it cryptographically."
  "06-run-revocation" = "Before acting, it checks an on chain revocation registry. A revoked credential is a kill switch, even if the proof still verifies."
  "07-run-approved" = "Now the enclave contract judges the action. A one thousand dollar real world asset buy. Approved."
  "08-run-dispatch" = "On approval it signs the request with Web Bot Auth, body and all, and executes it from inside the enclave. The call really left the trusted execution environment. The host just has not allowlisted this merchant yet."
  "09-run-rejections" = "Nine thousand dollars. Rejected, over the cap. A Dogecoin swap. Rejected. Wrong asset and wrong action kind. An unknown payee. Blocked by the counterparty allow list. A future dated mandate. Not active yet. Every one is decided in hardware, with an audit row."
  "10-selective-disclosure" = "Same flow, but watch the credential gate. The issuer signed the user's full K Y C record. Full name, date of birth, a net worth of five million dollars, and the accredited flag. The holder derives a zero knowledge proof revealing only the accredited flag. The agent sees just accredited investor, true. Name, birth date, net worth. Never revealed, mathematically hidden, yet provably issuer signed. That is B B S plus selective disclosure. We built the holder side derivation ourselves, because the S D K ships the primitive but does not wrap it."
  "11-velocity" = "One more guarantee. A cumulative spend cap, enforced in the enclave. Limit five thousand. Two thousand, then two thousand, both approved. The third would hit six thousand, so the contract rejects it. That running total lives in the enclave's key value store. The agent cannot reset its own budget between calls."
  "12-why-it-matters" = "Identity, verifiable credentials, revocation, a hardware enforced mandate contract, audit, and an action that is both signed and executed inside the enclave. The full Terminal 3 stack, in one agent. It also speaks the ecosystem's languages. Web Bot Auth on the way out, and A2A capability exchange agent to agent. This is the pattern a bank's trading desk or a permissioned dee fye venue needs. Delegate to an agent without handing over data or trust. Thanks for watching."
}

$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice($Voice) } catch { Write-Output "Voice '$Voice' not found, using default." }
$s.Rate = $Rate

foreach ($k in $scenes.Keys) {
  $path = Join-Path $out "$k.wav"
  $s.SetOutputToWaveFile($path)
  $s.Speak($scenes[$k])
  $kb = [math]::Round((Get-Item $path).Length / 1KB)
  Write-Output ("wrote {0,-26} {1} KB" -f "$k.wav", $kb)
}
$s.Dispose()
Write-Output "Done. WAVs are in $out - drop each onto the matching scene in your editor."
