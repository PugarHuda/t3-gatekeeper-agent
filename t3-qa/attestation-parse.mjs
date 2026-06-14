// Fetch a real TDX DKG attestation from testnet and parse one quote byte-by-byte.
import { fetchDkgAttestation, verifyTdxQuote } from "@terminal3/t3n-sdk";
import { keccak_512 } from "@noble/hashes/sha3";

const BASE_URL = "https://cn-api.sg.testnet.t3n.terminal3.io";
const hex = (b) => Buffer.from(b).toString("hex");

const att = await fetchDkgAttestation(BASE_URL);
if (!att) { console.log("no DKG attestation available"); process.exit(0); }

console.log("DKG peers:", att.peer_ids.length, "→", att.peer_ids.map(p => p.slice(0, 10) + "…"));
console.log("quotes:", Object.keys(att.quotes).length);

// --- report_data binding: report_data == keccak512(attestation_msg) ---
const attMsg = Buffer.from(att.attestation_msg, "base64");
const expectedReportData = keccak_512(attMsg);            // 64 bytes
console.log(`\nattestation_msg = encaps_key || sorted_peer_ids  (${attMsg.length} bytes)`);
console.log("keccak512(attestation_msg) =", hex(expectedReportData).slice(0, 32), "…");

// --- parse the first peer's TDX quote (v4) ---
const peer0 = att.peer_ids[0];
const q = Buffer.from(att.quotes[peer0], "base64");
console.log(`\n=== TDX quote for ${peer0.slice(0,12)}…  (${q.length} bytes) ===`);

// Quote header (48 bytes)
const version  = q.readUInt16LE(0);
const akType   = q.readUInt16LE(2);
const teeType  = q.readUInt32LE(4);            // 0x81 = TDX, 0x0 = SGX
console.log(`header: version=${version}  ak_type=${akType}  tee_type=0x${teeType.toString(16)} (${teeType === 0x81 ? "TDX" : "SGX/other"})`);

// TD report body starts at offset 48. Field offsets within the v4 TD quote:
const B = 48;
const mrTd       = q.subarray(B + 136, B + 184);   // MRTD (image measurement)
const rtmr3      = q.subarray(B + 472, B + 520);   // RTMR3 (runtime measurement)
const reportData = q.subarray(B + 520, B + 584);   // REPORT_DATA (64 bytes)

console.log("\nMeasured registers:");
console.log("  MRTD       =", hex(mrTd).slice(0, 32), "…");
console.log("  RTMR3      =", hex(rtmr3).slice(0, 32), "…");
console.log("  REPORT_DATA=", hex(reportData).slice(0, 32), "…");

// --- the binding check: does REPORT_DATA in the quote equal keccak512(attestation_msg)? ---
const match = hex(reportData) === hex(expectedReportData);
console.log(`\nREPORT_DATA == keccak512(attestation_msg)?  ${match ? "✅ YES — quote is bound to this session's key" : "❌ NO"}`);

// --- Intel PCK certificate chain present in the quote tail? ---
const tail = q.toString("latin1");
const certs = (tail.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
console.log(`Intel PCK cert chain: ${certs} X.509 certs embedded (leaf → SGX Processor CA → SGX Root CA)`);

// --- cross-check with the SDK's own verifier ---
console.log("\n=== SDK verifyTdxQuote() ===");
const res = await verifyTdxQuote(att.quotes[peer0], att.attestation_msg);
console.log(JSON.stringify({ valid: res.valid, error: res.error, rtmr3: res.rtmr3?.slice(0,16) + "…", report_data: res.report_data?.slice(0,16) + "…" }));
