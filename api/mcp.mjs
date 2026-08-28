// MCP over Streamable HTTP, hosted: https://gatekeeper-evidence.vercel.app/api/mcp
// The same signed, stateless /mcp route createApp() serves locally.
import { mounted } from "../agent/src/hosted.mjs";
export default mounted("/api");
