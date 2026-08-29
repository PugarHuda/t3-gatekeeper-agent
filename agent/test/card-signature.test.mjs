// The signed card and the did:web document it verifies against — offline,
// then the published pair in site/.well-known.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalize, signCard, verifyCard, cardPayload, jwkFromPublicKey, publicKeyFromJwk,
  buildDidDocument, didWebFromOrigin, didWebDocumentUrl, didWebResolver,
} from "../src/card-signature.mjs";
import { keyFromDirectory } from "../src/web-bot-auth.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const ORIGIN = "https://agent.example";
const DID = "did:web:agent.example";
const KID = `${DID}#wba`;
const card = { name: "Test", version: "1", skills: [{ id: "b" }, { id: "a" }], supportedInterfaces: [{ url: `${ORIGIN}/a2a`, protocolVersion: "1.0" }], signatures: [] };
const resolver = () => jwkFromPublicKey(publicKey);

describe("JCS canonicalization", () => {
  test("sorts keys at every depth and drops undefined, so two orderings sign identically", () => {
    assert.equal(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, u: undefined }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    assert.equal(cardPayload({ z: 1, a: 2, signatures: [{ protected: "x" }] }), cardPayload({ a: 2, z: 1 }));
  });
  test("escapes and numbers follow JSON.stringify, as RFC 8785 requires", () => {
    assert.equal(canonicalize({ s: "a\"b\n", n: 1e21, f: 0.5, t: true, z: null }), '{"f":0.5,"n":1e+21,"s":"a\\"b\\n","t":true,"z":null}');
  });
});

describe("signed agent card", () => {
  test("signs with a detached EdDSA JWS whose kid is the did:web verification method", async () => {
    const signed = signCard(card, { privateKey, kid: KID });
    assert.equal(signed.signatures.length, 1);
    const header = JSON.parse(Buffer.from(signed.signatures[0].protected, "base64url").toString());
    assert.deepEqual(header, { alg: "EdDSA", kid: KID, typ: "a2a-agent-card+jws" });
    assert.deepEqual(await verifyCard(signed, resolver), { verified: 1, problems: [] });
  });

  test("any change to the card breaks the signature — a skill, the endpoint, the security scheme", async () => {
    const signed = signCard(card, { privateKey, kid: KID });
    for (const mutate of [
      (c) => ({ ...c, skills: [...c.skills, { id: "extra" }] }),
      (c) => ({ ...c, supportedInterfaces: [{ ...c.supportedInterfaces[0], url: "https://evil.example/a2a" }] }),
      (c) => ({ ...c, securitySchemes: {} }),
    ]) {
      const r = await verifyCard(mutate(signed), resolver);
      assert.equal(r.verified, 0);
      assert.match(r.problems[0], /does not verify/);
    }
  });

  test("key order in the received JSON does not matter", async () => {
    const signed = signCard(card, { privateKey, kid: KID });
    const reordered = JSON.parse(JSON.stringify({ supportedInterfaces: signed.supportedInterfaces, signatures: signed.signatures, skills: signed.skills, version: signed.version, name: signed.name }));
    assert.equal((await verifyCard(reordered, resolver)).verified, 1);
  });

  test("a signature by a different key, an unknown kid, or no signature at all are each named", async () => {
    const other = generateKeyPairSync("ed25519");
    const bad = signCard(card, { privateKey: other.privateKey, kid: KID });
    assert.match((await verifyCard(bad, resolver)).problems[0], /does not verify/);
    assert.match((await verifyCard(signCard(card, { privateKey, kid: "did:web:nowhere#k" }), () => null)).problems[0], /did not resolve/);
    assert.deepEqual(await verifyCard(card, resolver), { verified: 0, problems: ["card carries no signatures"] });
  });
});

describe("did:web", () => {
  test("origin ↔ DID ↔ document URL follow the method spec, ports and paths included", () => {
    assert.equal(didWebFromOrigin("https://agent.example"), "did:web:agent.example");
    assert.equal(didWebDocumentUrl("did:web:agent.example"), "https://agent.example/.well-known/did.json");
    assert.equal(didWebFromOrigin("https://agent.example:8443/agents/gate"), "did:web:agent.example%3A8443:agents:gate");
    assert.equal(didWebDocumentUrl("did:web:agent.example%3A8443:agents:gate"), "https://agent.example:8443/agents/gate/did.json");
    assert.throws(() => didWebDocumentUrl("did:key:z6Mk"), /not a did:web/);
  });

  test("the document carries the key as JsonWebKey2020, usable for authentication and assertion", () => {
    const doc = buildDidDocument({ origin: ORIGIN, publicKey, services: [{ id: `${DID}#a2a`, type: "A2A", serviceEndpoint: `${ORIGIN}/a2a` }] });
    assert.equal(doc.id, DID);
    assert.equal(doc.verificationMethod[0].id, KID);
    assert.equal(doc.verificationMethod[0].type, "JsonWebKey2020");
    assert.deepEqual(doc.authentication, [KID]);
    assert.deepEqual(doc.assertionMethod, [KID]);
    // The JWK round-trips to the same key.
    assert.equal(publicKeyFromJwk(doc.verificationMethod[0].publicKeyJwk).export({ format: "der", type: "spki" }).toString("hex"),
      publicKey.export({ format: "der", type: "spki" }).toString("hex"));
  });

  test("the resolver fetches the document once and answers by verification method id", async () => {
    const doc = buildDidDocument({ origin: ORIGIN, publicKey });
    let fetches = 0;
    const fetchImpl = async (url) => { fetches++; assert.equal(url, "https://agent.example/.well-known/did.json"); return { ok: true, json: async () => doc }; };
    const resolve = didWebResolver({ fetchImpl });
    assert.deepEqual(await resolve(KID), doc.verificationMethod[0].publicKeyJwk);
    assert.equal(await resolve(`${DID}#other`), null);
    assert.equal(await resolve("did:key:z6Mk#x"), null);
    assert.equal(fetches, 1);
  });
});

describe("the published card and DID document", () => {
  const site = new URL("../../site/.well-known/", import.meta.url);
  const published = JSON.parse(readFileSync(new URL("agent-card.json", site), "utf8"));
  const didDoc = JSON.parse(readFileSync(new URL("did.json", site), "utf8"));
  const directory = JSON.parse(readFileSync(new URL("http-message-signatures-directory", site), "utf8"));

  test("the card is signed, and did.json verifies it", async () => {
    assert.equal(published.signatures?.length, 1, "run `npm run status-list` with WBA_PRIVATE_KEY set");
    const resolve = (kid) => didDoc.verificationMethod.find((m) => m.id === kid)?.publicKeyJwk ?? null;
    assert.deepEqual(await verifyCard(published, resolve), { verified: 1, problems: [] });
  });

  test("did.json is did:web:gatekeeper-evidence.vercel.app and its key is the Web Bot Auth key", () => {
    assert.equal(didDoc.id, "did:web:gatekeeper-evidence.vercel.app");
    const vm = didDoc.verificationMethod[0];
    assert.equal(vm.id, `${didDoc.id}#wba`);
    const wba = keyFromDirectory(directory, directory.keys[0].kid);
    assert.equal(publicKeyFromJwk(vm.publicKeyJwk).export({ format: "der", type: "spki" }).toString("hex"),
      wba.export({ format: "der", type: "spki" }).toString("hex"),
      "one key, two directories — they must agree");
    const types = didDoc.service.map((s) => s.type);
    for (const t of ["A2A", "ERC8004Registration", "WebBotAuthKeyDirectory"]) assert.ok(types.includes(t), `service ${t}`);
  });
});
