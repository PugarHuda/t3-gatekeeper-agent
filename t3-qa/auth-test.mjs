// Live testnet auth smoke test: handshake -> authenticate -> getUsage
import { readFileSync } from "node:fs";
import {
  T3nClient, loadWasmComponent, setEnvironment, getEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign,
} from "@terminal3/t3n-sdk";

// minimal .env loader (no dep)
for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

(async () => {
  try {
    setEnvironment("testnet");
    console.log("environment:", JSON.stringify(getEnvironment?.() ?? "testnet"));

    const key = process.env.T3N_API_KEY;
    if (!key) throw new Error("T3N_API_KEY missing");
    const address = eth_get_address(key);
    console.log("derived eth address:", address);

    console.log("loading WASM component...");
    const wasmComponent = await loadWasmComponent();
    console.log("WASM loaded ✅");

    const client = new T3nClient({
      wasmComponent,
      handlers: { EthSign: metamask_sign(address, undefined, key) },
    });

    console.log("handshake...");
    await client.handshake();
    console.log("handshake ✅");

    console.log("authenticate...");
    const auth = await client.authenticate(createEthAuthInput(address));
    console.log("authenticate ✅", JSON.stringify(auth)?.slice(0, 300));

    const usage = await client.getUsage();
    console.log("getUsage ✅:", JSON.stringify(usage));

    console.log("\nRESULT: live testnet auth WORKS ✅");
  } catch (e) {
    console.error("RESULT: FAILED ❌\n", e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
