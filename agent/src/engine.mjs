// One place that answers "which compiled contract logic decides this?"
//
// Two engines, both the contract's own code, neither a JavaScript copy:
//   gate_cli    the Rust host build of decide(); also checks credential
//               bindings and idempotency keys, exactly as execute_action does
//               in the enclave.
//   component   the registered wasm component itself, hosted by gate-wasm.mjs;
//               needs no Rust toolchain, so it is what a fresh `npm ci` has.
// `auto` prefers gate_cli when it is built. Whichever answered is named in the
// result, and what the component host cannot check it refuses to pretend to.
import { decide, gateCliPath, BUILD_HINT } from "./gate-cli.mjs";
import { sharedGate, GateError } from "./gate-wasm.mjs";

export const ENGINES = ["auto", "gate_cli", "component"];

export function enginesAvailable() {
  return { gate_cli: Boolean(gateCliPath()), component: true };
}

export async function decideWith({ engine = "auto", ...args }) {
  const cli = gateCliPath();
  if (engine === "gate_cli" || (engine === "auto" && cli)) {
    if (!cli) throw new Error(`gate_cli is not built. Build it with: ${BUILD_HINT}, or pass engine: "component"`);
    return { ...(await decide(args)), engine: "gate_cli" };
  }
  if (engine !== "component" && engine !== "auto") throw new Error(`unknown engine '${engine}' (one of ${ENGINES.join(", ")})`);
  if (args.credential || args.idempotency_key) {
    throw new Error("credential bindings and idempotency keys are checked by execute_action, which the " +
      `component host does not expose; use engine "gate_cli" (${BUILD_HINT})`);
  }
  const gate = await sharedGate();
  try {
    const out = gate.evaluate(args.action, args.mandate, { now_secs: args.now_secs });
    return { decision: out.decision, reasons: out.reasons, now_secs: out.evaluated_at_secs, engine: "component" };
  } catch (e) {
    if (e instanceof GateError) throw new Error(`the contract refused the input: ${e.message}`);
    throw e;
  }
}
