// Shared helpers: env loading, authenticated client + tenant client.
import { readFileSync } from "node:fs";
import {
  T3nClient, TenantClient, loadWasmComponent, setEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign,
} from "@terminal3/t3n-sdk";

export const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
export const CONTRACT_TAIL = "gate";
export const CONTRACT_VERSION = "0.2.0";

// A user's spending mandate — provisioned by the tenant admin, enforced in the TEE.
export const MANDATE = {
  max_amount_cents: 500_000, // $5,000
  allowed_assets: ["USDC", "USD"],
  allowed_kinds: ["rwa.buy"],
  expires_at_secs: 0, // 0 = no expiry
};

export function loadEnv(url) {
  for (const line of readFileSync(url, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  const key = process.env.T3N_API_KEY, did = process.env.DID;
  if (!key || !did) throw new Error("Set T3N_API_KEY and DID in agent/.env (see .env.example)");
  return { key, did };
}

/** Open an encrypted TEE session and authenticate -> returns { client, tenant, agentDid }. */
export async function connect(envUrl) {
  const { key, did } = loadEnv(envUrl);
  setEnvironment("testnet");
  const address = eth_get_address(key);
  const wasmComponent = await loadWasmComponent();
  const client = new T3nClient({
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, key) },
  });
  await client.handshake();
  const auth = await client.authenticate(createEthAuthInput(address));
  const agentDid = auth?.value ?? did;
  const tenant = new TenantClient({ environment: "testnet", t3n: client, tenantDid: did, baseUrl: BASE_URL });
  return { client, tenant, agentDid };
}
