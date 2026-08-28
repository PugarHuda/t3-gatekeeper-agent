// The ERC-8004 registration file: the shape a resolver expects, checked before
// anything is written on chain.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildRegistrationFile, validateRegistrationFile, agentRegistryRef, REGISTRATION_TYPE, REGISTRATION_URL,
} from "../src/erc8004-registration.mjs";
import { REGISTRIES } from "../src/erc8004.mjs";

describe("registration file", () => {
  test("the unminted document is conformant, with an honest empty registrations list", () => {
    const doc = buildRegistrationFile();
    const r = validateRegistrationFile(doc);
    assert.deepEqual(r.problems, []);
    assert.equal(doc.type, REGISTRATION_TYPE);
    assert.deepEqual(doc.registrations, []);
    assert.equal(doc.active, true);
    assert.equal(doc.x402Support, true);
  });

  test("it names the same agent as the A2A card, and points the A2A service at it", async () => {
    const { readFile } = await import("node:fs/promises");
    const card = JSON.parse(await readFile(new URL("../agent-card.json", import.meta.url), "utf8"));
    const doc = buildRegistrationFile();
    assert.equal(doc.name, card.name);
    assert.equal(doc.description, card.description);
    const a2a = doc.services.find((s) => s.name === "A2A");
    assert.match(a2a.endpoint, /\/\.well-known\/agent-card\.json$/);
    const did = doc.services.find((s) => s.name === "DID");
    assert.equal(did.endpoint, card.did);
  });

  test("a mint fills registrations with the spec's registry reference", () => {
    const doc = buildRegistrationFile({ minted: { agentId: 42, network: "ethereum-sepolia" } });
    assert.deepEqual(doc.registrations, [{
      agentId: 42,
      agentRegistry: `eip155:${REGISTRIES["ethereum-sepolia"].chainId}:${REGISTRIES["ethereum-sepolia"].identity}`,
    }]);
    assert.equal(agentRegistryRef("ethereum-sepolia"), doc.registrations[0].agentRegistry);
    assert.deepEqual(validateRegistrationFile(doc).problems, []);
  });

  test("the served copy is what the builder produces", async () => {
    const { readFile } = await import("node:fs/promises");
    let served;
    try {
      served = JSON.parse(await readFile(new URL("../../site/.well-known/erc8004-registration.json", import.meta.url), "utf8"));
    } catch {
      assert.fail("site/.well-known/erc8004-registration.json is missing — run `npm run status-list`");
    }
    assert.deepEqual(validateRegistrationFile(served).problems, []);
    assert.equal(served.name, buildRegistrationFile().name);
    assert.equal(REGISTRATION_URL, "https://gatekeeper-evidence.vercel.app/.well-known/erc8004-registration.json");
  });

  test("the validator refuses what a resolver would refuse", () => {
    const good = buildRegistrationFile();
    assert.ok(validateRegistrationFile({ ...good, type: "something-else" }).problems.some((p) => /type must be/.test(p)));
    assert.ok(validateRegistrationFile({ ...good, image: "" }).problems.some((p) => /image is required/.test(p)));
    assert.ok(validateRegistrationFile({ ...good, services: [] }).problems.some((p) => /non-empty/.test(p)));
    assert.ok(validateRegistrationFile({ ...good, services: [{ name: "x" }] }).problems.some((p) => /no endpoint/.test(p)));
    assert.ok(validateRegistrationFile({ ...good, active: "yes" }).problems.some((p) => /active must be a boolean/.test(p)));
    assert.ok(validateRegistrationFile({ ...good, registrations: [{ agentId: "1", agentRegistry: "sepolia" }] }).problems.length >= 2);
    // Our own A2A card is exactly the document a naive mint would have pointed at.
    assert.equal(validateRegistrationFile({ name: "Gatekeeper Agent", skills: [] }).valid, false);
  });
});

describe("the mint, as recorded", () => {
  test("erc8004-minted.json agrees with the registration file the site serves", async () => {
    const { readFile } = await import("node:fs/promises");
    let minted;
    try {
      minted = JSON.parse(await readFile(new URL("../erc8004-minted.json", import.meta.url), "utf8"));
    } catch {
      return; // not minted in this checkout — nothing to be inconsistent with
    }
    const served = JSON.parse(await readFile(new URL("../../site/.well-known/erc8004-registration.json", import.meta.url), "utf8"));
    assert.deepEqual(served.registrations, [{ agentId: minted.agentId, agentRegistry: agentRegistryRef(minted.network) }]);
    // The URI written on chain is the file that carries this registration.
    assert.equal(minted.agentURI, REGISTRATION_URL);
    assert.equal(minted.registry, REGISTRIES[minted.network].identity);
    assert.match(minted.tx, /^0x[0-9a-f]{64}$/);
  });

  test("the card's ERC-8004 registration names the same token", async () => {
    const { readFile } = await import("node:fs/promises");
    let minted;
    try {
      minted = JSON.parse(await readFile(new URL("../erc8004-minted.json", import.meta.url), "utf8"));
    } catch { return; }
    const card = JSON.parse(await readFile(new URL("../agent-card.json", import.meta.url), "utf8"));
    const reg = card.registrations.find((r) => r.protocol === "ERC-8004");
    assert.equal(reg.status, "active");
    assert.equal(reg.agentId, minted.agentId);
    assert.equal(reg.agentRegistry, agentRegistryRef(minted.network));
    assert.equal(reg.owner, minted.owner);
  });
});
