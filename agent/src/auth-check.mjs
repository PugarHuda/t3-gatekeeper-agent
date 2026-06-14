// Quick connectivity check: authenticate and print token balance.
import { connect } from "./lib.mjs";

const { client, agentDid } = await connect(new URL("../.env", import.meta.url));
console.log("Authenticated as", agentDid);
const usage = await client.getUsage();
console.log("Credits available:", usage.balance.available);
