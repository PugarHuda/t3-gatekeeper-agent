// Bitstring Status List. The dangerous failure here is a check that answers
// confidently and wrongly — a reversed bit order or a swallowed fetch error both
// produce "not revoked" for a revoked credential, which is the exact outcome the
// gate exists to prevent. So most of these tests are about being wrong loudly.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import {
  buildStatusList, encodeList, decodeList, getBit, setBit,
  checkStatus, statusEntry, MINIMUM_ENTRIES,
} from "../src/status-list.mjs";

const LIST_URL = "https://example.test/status/1";

async function serving(doc, fn, { status = 200, body } = {}) {
  const srv = createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body ?? JSON.stringify(doc));
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    return await fn(`http://localhost:${srv.address().port}/status/1`);
  } finally {
    srv.close();
  }
}

describe("bitstring encoding", () => {
  test("round-trips through gzip and multibase", () => {
    const bytes = new Uint8Array(64);
    setBit(bytes, 0); setBit(bytes, 7); setBit(bytes, 8); setBit(bytes, 511);
    const back = decodeList(encodeList(bytes));
    assert.deepEqual([...back], [...bytes]);
  });

  test("index 0 is the most significant bit of byte 0", () => {
    // Reversing this yields a list that reads the wrong holder's status.
    const bytes = new Uint8Array(2);
    setBit(bytes, 0);
    assert.equal(bytes[0], 0b1000_0000);
    setBit(bytes, 7);
    assert.equal(bytes[0], 0b1000_0001);
    setBit(bytes, 8);
    assert.equal(bytes[1], 0b1000_0000);
  });

  test("a bit can be cleared again", () => {
    const bytes = new Uint8Array(1);
    setBit(bytes, 3, true);
    assert.equal(getBit(bytes, 3), 1);
    setBit(bytes, 3, false);
    assert.equal(getBit(bytes, 3), 0);
  });

  test("reading past the end throws rather than returning zero", () => {
    // Returning 0 would read as "not revoked" for every out-of-range index.
    assert.throws(() => getBit(new Uint8Array(1), 8), /past the end/);
    assert.throws(() => getBit(new Uint8Array(1), -1), /invalid status index/);
  });

  test("an unsupported multibase prefix is refused, not guessed", () => {
    const b64 = gzipSync(Buffer.from([0])).toString("base64url");
    assert.throws(() => decodeList("z" + b64), /unsupported multibase prefix/);
    assert.throws(() => decodeList(""), /empty/);
  });
});

describe("building a list", () => {
  test("marks exactly the revoked indices and nothing else", () => {
    const doc = buildStatusList({ id: LIST_URL, issuer: "did:key:issuer", revoked: [3, 99, 131_071] });
    const bytes = decodeList(doc.credentialSubject.encodedList);
    for (const i of [3, 99, 131_071]) assert.equal(getBit(bytes, i), 1, `index ${i} should be revoked`);
    for (const i of [0, 2, 4, 98, 100, 131_070]) assert.equal(getBit(bytes, i), 0, `index ${i} should be clear`);
  });

  test("refuses a list short enough to identify its holders", () => {
    assert.throws(() => buildStatusList({ id: LIST_URL, issuer: "x", length: 1024 }), /at least 131072/);
  });

  test("refuses to revoke an index outside the list", () => {
    assert.throws(() => buildStatusList({ id: LIST_URL, issuer: "x", revoked: [999_999] }), /outside a list/);
  });

  test("compresses to something small enough to serve", () => {
    // 131,072 mostly-zero bits gzip to a few hundred bytes; if this ever becomes
    // large the privacy argument stops being free.
    const doc = buildStatusList({ id: LIST_URL, issuer: "x", revoked: [42] });
    assert.ok(doc.credentialSubject.encodedList.length < 2000, doc.credentialSubject.encodedList.length);
  });

  test("declares the shape a verifier looks for", () => {
    const doc = buildStatusList({ id: LIST_URL, issuer: "did:key:issuer" });
    assert.ok(doc.type.includes("BitstringStatusListCredential"));
    assert.equal(doc.credentialSubject.type, "BitstringStatusList");
    assert.equal(doc.credentialSubject.statusPurpose, "revocation");
  });
});

describe("checking a credential's status over HTTP", () => {
  const doc = buildStatusList({ id: LIST_URL, issuer: "did:key:issuer", revoked: [7] });

  test("a revoked index reads as revoked", async () => {
    const r = await serving(doc, (url) => checkStatus(statusEntry({ statusListCredential: url, statusListIndex: 7 })));
    assert.equal(r.checked, true);
    assert.equal(r.revoked, true);
    assert.equal(r.listEntries, MINIMUM_ENTRIES);
  });

  test("an untouched index reads as not revoked", async () => {
    const r = await serving(doc, (url) => checkStatus(statusEntry({ statusListCredential: url, statusListIndex: 8 })));
    assert.equal(r.checked, true);
    assert.equal(r.revoked, false);
  });

  test("an unreachable list is 'not checked', never 'not revoked'", async () => {
    // The whole point. A verifier that cannot reach the list must know that.
    const r = await checkStatus(statusEntry({ statusListCredential: "http://127.0.0.1:1/status", statusListIndex: 1 }));
    assert.equal(r.checked, false);
    assert.equal(r.revoked, false);
    assert.match(r.reason, /status list/);
  });

  test("an HTTP error is not checked", async () => {
    const r = await serving(doc, (url) => checkStatus(statusEntry({ statusListCredential: url, statusListIndex: 7 })), { status: 500 });
    assert.equal(r.checked, false);
    assert.match(r.reason, /HTTP 500/);
  });

  test("a document that is not a status list is not checked", async () => {
    const r = await serving({ hello: "world" }, (url) => checkStatus(statusEntry({ statusListCredential: url, statusListIndex: 7 })));
    assert.equal(r.checked, false);
    assert.match(r.reason, /not a BitstringStatusList/);
  });

  test("a suspension list does not answer a revocation question", async () => {
    const suspension = buildStatusList({ id: LIST_URL, issuer: "x", revoked: [7], statusPurpose: "suspension" });
    const r = await serving(suspension, (url) =>
      checkStatus(statusEntry({ statusListCredential: url, statusListIndex: 7, statusPurpose: "revocation" })));
    assert.equal(r.checked, false);
    assert.match(r.reason, /statusPurpose mismatch/);
  });

  test("a credential with no status entry is reported, not assumed good", async () => {
    const r = await checkStatus(undefined);
    assert.equal(r.checked, false);
    assert.match(r.reason, /no credentialStatus/);
  });

  test("an unknown credentialStatus type is not silently accepted", async () => {
    const r = await checkStatus({ type: "SomeOtherStatusMethod", statusListIndex: "1" });
    assert.equal(r.checked, false);
    assert.match(r.reason, /unsupported credentialStatus type/);
  });

  test("a malformed entry is reported", async () => {
    const r = await checkStatus({ type: "BitstringStatusListEntry", statusListIndex: "not-a-number" });
    assert.equal(r.checked, false);
    assert.match(r.reason, /missing statusListCredential or statusListIndex/);
  });
});
