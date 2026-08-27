// The node survey, checked where it can be checked offline.
//
// `survey()` is mostly four SDK reads, and a test that faked those would prove
// nothing about the node. What IS worth pinning is how it behaves when things
// are wrong, because that is when someone reads its output: a missing key, and a
// node that is not answering. Both are exercised against a real closed port
// rather than a stub, so no network leaves this machine.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { survey, WATCHED } from "../src/discover.mjs";

/** A port nothing is listening on — bound then released, so it is really dead. */
async function deadPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

describe("node survey", () => {
  test("it refuses without an agent key rather than trying the tenant key", async () => {
    await assert.rejects(() => survey({}), /agent API key is required/);
  });

  test("an unreachable node is an error, never an empty inventory", async () => {
    // The failure that matters: reporting "0 core contracts" would read as a
    // node that runs nothing, which is a very different fact from "no answer".
    const port = await deadPort();
    await assert.rejects(
      () => survey({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "t3n_key_test.test" }),
      (e) => {
        assert.doesNotMatch(String(e.message), /t3n_key_test\.test/, "the key must never reach an error message");
        return true;
      },
    );
  });

  test("every watched contract says why it is watched", () => {
    // A version list nobody can interpret is a version list nobody reads. If a
    // name is added here without a reason, this fails.
    for (const [name, why] of Object.entries(WATCHED)) {
      assert.match(name, /^tee:/, `${name} is not a core contract name`);
      assert.ok(why && why.length > 15, `${name} has no usable reason`);
    }
    // The two the node serves but nobody documents must stay called out.
    assert.ok(WATCHED["tee:vc"]);
    assert.ok(WATCHED["tee:agent-connect"]);
  });
});
