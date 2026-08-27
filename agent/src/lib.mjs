// Shared helpers: env loading, authenticated client + tenant client.
import { readFileSync } from "node:fs";
import {
  T3nClient, TenantClient, loadWasmComponent, setEnvironment,
  createEthAuthInput, eth_get_address, metamask_sign, fetchTrustedManifest,
} from "@terminal3/t3n-sdk";

export const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
export const CONTRACT_TAIL = "gate";
// What `npm run setup` registers. Single-sourced from the contract's Cargo.toml
// via gate-cli.mjs — see the note there.
//
// The last version actually ON the network is 0.7.0 (contract_id 479); later
// versions are built and unit-tested but unregistered, because the account is
// out of credits.
export { CONTRACT_VERSION } from "./gate-cli.mjs";

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
  // Demand that every action carry a credential binding matching it. Without
  // this, `allowed_issuers` is only as good as the caller's honesty: the agent
  // could name a trusted issuer it never actually verified against.
  require_credential: true,
  // Every action here moves money, so a retry must be safe. Without a key a
  // timed-out dispatch is ambiguous and both choices are bad: retry risks a
  // second order, giving up risks none.
  require_idempotency_key: true,
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

/**
 * `tenant.contracts.execute`, with the node's per-minute fuel quota handled.
 *
 * The testnet node caps a tenant at ten contract executions per minute. Nothing
 * documents it, and it is not a small limit in practice: `npm run demo` makes
 * eleven, so the last scenario in the demo failed every time until this existed.
 * Measured 2026-08-27 — ten succeed in ~3s, the eleventh returns
 * `quota exceeded (fuel_per_minute)`.
 *
 * Backoff, not failure, because a quota is a "later", not a "no". Every wait is
 * announced: a script that silently pauses for a minute looks hung, and the next
 * person to run it should know why rather than reaching for Ctrl-C.
 *
 * Only the quota is retried. A rejected mandate, a bad input or a missing
 * function are answers, and retrying an answer just spends credits to hear it
 * again.
 */
export async function executeContract(tenant, tail, opts, { retries = 3, log = console.log } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tenant.contracts.execute(tail, opts);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/fuel_per_minute|quota exceeded/i.test(msg) || attempt >= retries) throw e;
      // The window is a minute; wait out the remainder rather than hammering it.
      const waitMs = 20_000 * (attempt + 1);
      log(`       node fuel quota reached (10 executes/minute) — waiting ${waitMs / 1000}s, attempt ${attempt + 1}/${retries}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}
