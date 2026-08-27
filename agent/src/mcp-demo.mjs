// `npm run demo:mcp` — be the host for a moment.
//
// Spawns the MCP server as a subprocess and talks to it with the official
// client, exactly as Claude Code or any other MCP host would: list the tools,
// read a resource, then ask it to judge two actions. Nothing here is a
// shortcut — the decisions come back over JSON-RPC from a separate process,
// which got them from the compiled contract logic.
//
// It exists so that "we ship an MCP server" can be checked in ten seconds
// without a test runner.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: "inherit", // the server's readiness line, and any quota notice
});
const client = new Client({ name: "gatekeeper-demo-host", version: "1.0.0" });
await client.connect(transport);

const info = client.getServerVersion();
console.log(`\nconnected to MCP server "${info.name}" v${info.version} over stdio\n`);

const { tools } = await client.listTools();
console.log(`tools it offers (${tools.length}):`);
for (const t of tools) {
  const ro = t.annotations?.readOnlyHint;
  console.log(`  ${ro === false ? "!" : " "} ${t.name.padEnd(24)} ${t.title ?? ""}`);
}
console.log(`  ("!" marks the ones that can move money or reach the network)\n`);

const status = JSON.parse((await client.readResource({ uri: "gatekeeper://status" })).contents[0].text);
console.log(`resource gatekeeper://status`);
console.log(`  contract ${status.contractVersion} · offline decisions ${status.offlineDecisions}`);
console.log(`  live dispatch: ${status.liveDispatch}\n`);

const MANDATE = {
  max_amount_cents: 500_000,
  allowed_assets: ["USDC", "USD"],
  allowed_kinds: ["rwa.buy"],
  allowed_counterparties: ["did:t3n:meridian-fund"],
  expires_at_secs: 0,
};

for (const [label, action] of [
  ["buy $1,000 of USDC from the approved fund", { kind: "rwa.buy", asset: "USDC", amount_cents: 100_000, counterparty: "did:t3n:meridian-fund" }],
  ["buy $9,000 — over the mandate", { kind: "rwa.buy", asset: "USDC", amount_cents: 900_000, counterparty: "did:t3n:meridian-fund" }],
  ["pay someone the mandate never listed", { kind: "rwa.buy", asset: "USDC", amount_cents: 1_000, counterparty: "did:t3n:unknown-payee" }],
]) {
  const r = await client.callTool({ name: "gate_evaluate", arguments: { action, mandate: MANDATE } });
  console.log(`▸ ${label}`);
  console.log(`    ${r.content[0].text}`);
}

console.log(`\nThose verdicts came from gate_cli — the host build of the same Rust the`);
console.log(`enclave runs — over JSON-RPC, with no Terminal 3 account and no credits spent.`);

await client.close();
