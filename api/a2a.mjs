// The A2A v1.0 endpoint, hosted: https://gatekeeper-evidence.vercel.app/api/a2a
// Same createApp() as `npm run a2a`; decisions come from the registered wasm
// component (agent/gate-wasm) because there is no Rust toolchain here, and
// engine.mjs names that in every answer.
import { mounted } from "../agent/src/hosted.mjs";
export default mounted("/api/a2a");
