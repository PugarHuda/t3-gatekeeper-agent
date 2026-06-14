# Technical Deep-Dive — the cryptography behind the Gatekeeper Agent

Two primitives carry the whole trust story. This document traces both down to the
real implementation, with values captured live from T3N testnet
(`t3-qa/attestation-parse.mjs`, `t3-qa/smoke-vc*.cjs`).

---

## Part 1 — BBS+ selective-disclosure signatures (the VC gate)

### The pairing identity
A BBS signature on messages `m₁…m_L` is a pair `(A, e)`:

```
B = P₁ + Q₁·domain + Σ Hᵢ·mᵢ          (commitment in G₁)
A = (1/(x+e))·B                        (signature point in G₁), with SK = x, PK = W = x·P₂
```

Verification is a single bilinear-pairing equation:

```
e(A, W + e·P₂) ?= e(B, P₂)
   = e( (1/(x+e))·B , (x+e)·P₂ )       since W = x·P₂
   = e(B, P₂)^((x+e)/(x+e)) = e(B, P₂) ✓   (bilinearity cancels the factor in the exponent)
```

Security rests on the **q-SDH** assumption: without `x`, forging a valid `(A, e)`
is infeasible. Curve: **BLS12-381** (G₁ 48 B, G₂ 96 B, scalar field `r` 255-bit,
base field `p` 381-bit, embedding degree 12).

### Where it actually runs (call chain, verified in source)
```
agent.mjs
  └─ @terminal3/bbs_vc  verifyBbsVCW3c(vc)                 [dist/verifyBbsVC.js]
       1. base64url-decode proofValue; CBOR header 0xd9 0x5d 0x02 (tag 0x5d02)
       2. CBOR-decode → { bbsSignature, bbsHeader, publicKey, hmacKey, mandatoryPointers }
       3. getMessagesW3c(): RDF-canonicalize the JSON-LD, HMAC-relabel blank nodes
          (deterministic, leaks no claim order), rebuild messages = [bbsHeader, …claims]
       4. blsVerify({ publicKey, messages, signature })   ← the pairing check
            └─ @mattrglobal/bbs-signatures  [tries native addon, else embedded WASM]
                 • @mattrglobal/node-bbs-signatures (Rust N-API addon), OR
                 • lib/wasm_bs64.js  (546 KB base64-embedded WASM, Rust pairing_crypto)
                 → computes e(A, W+e·P₂) == e(B, P₂) on BLS12-381
```

Key facts established by reading the installed packages:
- The pairing + BLS12-381 arithmetic are **Rust**, shipped as a native Node addon
  with an **embedded-WASM fallback** (what our Windows tests used — no `.node`
  binary present, so `require("@mattrglobal/node-bbs-signatures")` throws and the
  code falls back to `./wasm_module`).
- `@noble/curves` (pure-JS BLS12-381) is present in the stack but used for **key
  generation / `did:key` public-key extraction**, *not* the signature pairing.

### The selective-disclosure gap (and our design response)
`@mattrglobal/bbs-signatures` exports `createProof` (holder derives a
reduced-claims proof) and `verifyProof` (verify a derived proof) — the actual
zero-knowledge selective-disclosure step. **Terminal 3's `@terminal3/bbs_vc`
wraps only base issuance (`createBbsCredential`) and base verification
(`verifyBbsVCW3c` → `blsVerify`); it does not wrap `createProof`/`verifyProof`.**
So a holder cannot, via the T3 API, derive a VP that reveals a subset of claims.

Our design response is the **predicate credential**: the trusted issuer signs only
the fact the action needs — `{ accreditedInvestor: true }` — so the raw figure
never enters the credential and base issue+verify (which the SDK *does* support)
is sufficient. (See Track B Report 3 for the docs/API gap.)

### Verified live
- Issue → `bbs-2023` DataIntegrityProof; `verifyBbsVCW3c` → `{isValid:true}`.
- Tamper a claim post-signature → `{isValid:false}` — the q-SDH/pairing check
  rejects it (not a stub). Root-cause of the `undefined` message: see Report 1.

---

## Part 2 — Intel TDX remote attestation (the TEE handshake)

`@terminal3/t3n-sdk` exports `fetchDkgAttestation`, `verifyTdxQuote`,
`verifyDkgAttestation`, `fetchMlKemPublicKey` — Terminal 3 runs a **network of
Intel TDX nodes** doing distributed key generation, with **post-quantum (ML-KEM)**
session key encapsulation.

### TDX quote v4 byte layout (parsed live; 8000 B quote, `tee_type=0x81`)
```
 offset  size  field
 ┌──────────────────────────────────────────── HEADER (48 B) ───────────────┐
   0      2    version            = 4
   2      2    att_key_type       = 2   (ECDSA-P256)
   4      4    tee_type           = 0x00000081  → TDX  (0x0 would be SGX)
   8      2    reserved (qe_svn)
  10      2    reserved (pce_svn)
  12     16    qe_vendor_id
  28     20    user_data
 ├────────────────────────────────── TD REPORT BODY (584 B) ────────────────┤
  48     16    tee_tcb_svn
  64     48    mr_seam            (TDX module measurement)
 112     48    mrsigner_seam
 160      8    seam_attributes
 168      8    td_attributes
 176      8    xfam
 184     48    MR_TD              ◄── image measurement (the contract runtime)
 232     48    mr_config_id
 280     48    mr_owner
 328     48    mr_owner_config
 376     48    RTMR0
 424     48    RTMR1
 472     48    RTMR2
 520     48    RTMR3              ◄── runtime-extended measurement
 568     64    REPORT_DATA        ◄── = keccak512(attestation_msg)  ← session binding
 ├──────────────────────────── SIGNATURE SECTION (rest) ───────────────────┤
 632      4    sig_data_len
 636     64    ECDSA-P256 signature over header+body (by the Attestation Key)
 700     64    attestation public key
 …            QE report + QE report sig + auth data
 …            PCK cert chain  (3 × X.509 PEM: leaf → SGX Processor CA → SGX Root CA)
 └──────────────────────────────────────────────────────────────────────────┘
```

### The anti-MITM binding (the crux of `handshake()`)
`attestation_msg = encaps_key ‖ sorted_peer_ids` (1286 B observed), and each
quote's `REPORT_DATA` must equal `keccak512(attestation_msg)`. Verified live:

```
keccak512(attestation_msg) = d8cb7e4363b24a80 3c90a343514c14b8 …
quote REPORT_DATA          = d8cb7e4363b24a80 3c90a343514c14b8 …   ✅ match
```

So the quote — signed by the CPU's Attestation Key, chained to Intel's SGX Root
CA — cryptographically commits to **this session's ML-KEM encapsulation key**. An
attacker cannot substitute their own key without breaking the quote signature.
That is what makes "open an encrypted session *in the TEE*" trustworthy.

### What `verifyTdxQuote` checks (and returned live)
1. PCK cert chain → Intel SGX Root CA (genuine Intel silicon).
2. TCB status vs Intel collateral (microcode not a revoked/vulnerable version).
3. Attestation-Key signature over header+body (integrity).
4. `RTMR3` / measurements vs expected (right code running).
5. `REPORT_DATA` binding (step above).

```
SDK verifyTdxQuote(quote, attestation_msg) → { valid: true,
   rtmr3: "ghpLtyXzukbEwb//…" (=821a4bb7…), report_data: "2Mt+Q2OySoA…" (=d8cb7e43…) }
```

### DKG / threshold
`fetchDkgAttestation` returned **3 peers**, each with its own TDX quote over the
same `attestation_msg`. The cluster key is generated across the quorum, so no
single node holds the full key — `verifyDkgAttestation` checks all peer quotes.

---

## One-line mapping
| Concept | Live evidence |
| --- | --- |
| `e(A,W+eP₂)=e(B,P₂)` on BLS12-381 | `blsVerify` → Rust WASM; tamper → invalid |
| selective-disclosure derive exists but unwrapped | `createProof`/`verifyProof` in MATTR, not in `bbs_vc` |
| Intel TDX | `tee_type=0x81`, ECDSA-P256 AK |
| session binding | `REPORT_DATA == keccak512(encaps_key‖peer_ids)` ✅ |
| Intel root of trust | 3× X.509 PCK chain in quote |
| threshold network + PQ | 3 DKG peers, ML-KEM encaps key |
