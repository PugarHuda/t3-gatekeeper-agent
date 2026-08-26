// Shared helpers: env loading, authenticated client + tenant client.
import { readFileSync } from "node:fs";
import {
  T3nClient, TenantClient, loadWasmComponent, setEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign, fetchTrustedManifest,
} from "@terminal3/t3n-sdk";

export const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
export const CONTRACT_TAIL = "gate";
// Source of truth for what `npm run setup` registers. 0.9.0 (trusted issuers,
// per-counterparty sub-limits, and the enclave-held broker credential) is built
// and unit-tested but NOT yet registered — the account ran out of credits. The
// last version actually on the network is 0.7.0 (contract_id 479). Re-run
// `npm run setup` once topped up.
export const CONTRACT_VERSION = "0.9.0";

// Name of the entry in z:<tid>:secrets holding the broker's bearer token.
// Only meaningful when BROKER_API_KEY is set — see setup.mjs.
export const CREDENTIAL_KEY = "broker_api_key";

// Destination of an APPROVED action. The enclave may only reach it once the
// caller holds an agent-auth grant for its host — see src/grant-egress.mjs.
// Override with ACTION_ENDPOINT to point at a real endpoint you control.
// A function, not a const: .env is only loaded once connect() runs.
export const actionEndpoint = () => process.env.ACTION_ENDPOINT || "https://broker.example/v1/orders";

// A user's spending mandate — provisioned by the tenant admin, enforced in the TEE.
//
// `allowed_issuers` is the control that stops the agent minting its own
// eligibility credential: a valid BBS+ signature proves the issuer signed the
// claim, never that the issuer is anyone the fund trusts. Empty = NOT enforced,
// so production configs must list the KYC providers they accept. It is left
// empty here only because the demo issues from a fresh key on every run — the
// runtime pins it to that run's issuer (see agent.mjs) and shows the rogue case.
export const MANDATE = {
  max_amount_cents: 500_000, // $5,000
  allowed_assets: ["USDC", "USD"],
  allowed_kinds: ["rwa.buy"],
  allowed_issuers: (process.env.TRUSTED_ISSUERS ?? "").split(",").filter(Boolean),
  expires_at_secs: 0, // 0 = no expiry
  // Which secret the enclave authenticates the outbound call with. Named here
  // rather than in the request so the agent cannot choose which credential it
  // spends. Empty unless a key was actually sealed in, because the contract
  // fails closed on a mandate that names a credential the map does not hold.
  credential_key: process.env.BROKER_API_KEY ? CREDENTIAL_KEY : "",
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
    // Required since SDK 5.x: pins the node's attestation so a failed handshake
    // is a trust failure, not a silent downgrade. 3.x built the client without it.
    trustAnchor: await fetchTrustedManifest("testnet"),
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, key) },
  });
  await client.handshake();
  const auth = await client.authenticate(createEthAuthInput(address));
  const agentDid = auth?.value ?? did;
  const tenant = new TenantClient({ environment: "testnet", t3n: client, tenantDid: did, baseUrl: BASE_URL });
  return { client, tenant, agentDid };
}
