# COVCOM Security Policy

> ### Table of Contents
> - [Supported Versions]
> - [Reporting a Vulnerability]
>   - [Scope]
> - [Cryptographic Foundations]
> - [Threat Model]
> - [Deployment Hardening]

---

## Supported Versions

This policy covers COVCOM and its cryptographic dependency [leviathan-crypto],
both maintained by the same author and released in tandem. Support is rolling,
so only the current release is supported. A vulnerability in either project
triggers a coordinated release that immediately deprecates the previous
version.

| Version | Status       | Reason         |
|---------|--------------|----------------|
| [v3.0.0](https://github.com/xero/covcom/blob/main/CHANGELOG.md#v300) | ✓ supported  | Latest version |
| [v1.0.0](https://github.com/xero/covcom/blob/main/CHANGELOG.md#v100) | ✗ deprecated | XChaCha20 seal wasn't key-committing, thus vulnerable to salamander style partitioning-oracle attacks |
| v0.0.1 | ✗ deprecated | public beta |


> [!CAUTION]
> Deprecated versions receive no patches. Upgrade promptly.

---

## Reporting a Vulnerability

> [!IMPORTANT]
> **_Please do not open a public issue for security vulnerabilities._**

### Private Advisory (preferred)

Use GitHub's private vulnerability reporting form:
[https://github.com/xero/covcom/security/advisories/new][advisory]

This opens a private channel between you and me, and you will
receive a response promptly. If the vulnerability is confirmed, we will
collaborate to fully understand the issue, including a review of proposed
fixes, so you can track and validate firsthand. Before any public advisory
is published, we will agree on a coordinated disclosure timeline. After
disclosure, you are encouraged to publish your own write-up, blog post, or
research notes, for full hacker scene credit.

### Direct Contact

If you prefer to contact me directly:

- **Email:** x﹫xero.style · PGP: [`0xAC1D0000`][pgp]
- **Matrix:** x0﹫rx.haunted.computer

> [!NOTE]
> Encrypted communication is welcome and _preferred_ for sensitive reports.

### Scope

**In scope:**

- Vulnerabilities in COVCOM's web client, CLI, or server
- Vulnerabilities in the COVCOM wire protocol or session handshake
- Cryptographic weaknesses in the ratchet implementation or key derivation
- Vulnerabilities in leviathan-crypto primitives or the WASM layer
- Protocol design flaws (an unsound design itself counts)
- Dependency vulnerabilities that affect COVCOM's security properties
- Invite format weaknesses (enumeration, forgery, replay)

**Out of scope:**

- Bugs in leviathan-crypto unrelated to COVCOM's use of it. Please report those
  in the [leviathan-crypto repository][leviathan-crypto]
- The non-goals listed in the threat model: endpoint security, traffic
  analysis, server availability attacks, multi-session correlation
- Attacks requiring physical access to a participant's device
- Social engineering attacks against participants
- APT-level nation-state adversaries with quantum computing capability
  today (ML-KEM-768 addresses future quantum, not present-day state actors
  with unlimited classical resources)
- Spam or denial-of-service against publicly hosted instances

---

## Cryptographic Foundations

All cryptographic operations in COVCOM are provided by [leviathan-crypto], a
zero-dependency TypeScript/WASM library by the same author. There are no
third-party cryptographic dependencies.

The active primitive set:

| Primitive                             | Purpose                                            |
|---------------------------------------|----------------------------------------------------|
| [XChaCha20-Poly1305][chacha20]        | Message and file encryption                        |
| [ML-KEM-768][mlkem] (FIPS 203)        | Post-quantum key encapsulation                     |
| [HKDF-SHA-256][sha2]                  | Key derivation throughout                          |
| [Seal+MlKemSuite][aead]               | Chain seed distribution                            |
| [Ed25519PreHashSuite][signaturesuite] | Identity-claim and per-message signing             |
| [BLAKE3][blake3]                      | Identity-log chain hash and fingerprint derivation |
| [SHA-256 Merkle][merkle]              | Per-sender transcript log                          |

The protocol implements the Sparse Post-Quantum Ratchet from the
[Signal Double Ratchet spec][doubleratchet] (§5, Revision 4) with a Sender
Keys group messaging model.

> [!TIP]
> The [cryptography reference][crypto-doc] documents how each primitive is
> constructed and composed. The [protocol specification][protocol-doc] covers
> the wire format, session handshake, and ratchet flow.

---

## Threat Model

### The protocol provides

**Message confidentiality.** Passive and active network adversaries learn nothing from the wire.

**Forward secrecy.** Past messages stay unrecoverable from current state.

**Post-compromise security.** State heals at every KEM ratchet boundary.

**Harvest-now-decrypt-later resistance.** ML-KEM-768 guards against future quantum decryption.

**Enumeration resistance.** A 2^128 room secret space defeats guessing.

**Session anonymity.** No persistent identity keys are visible to the server.

**Per-message provenance.** Every broadcast carries a detached Ed25519 signature, verified before AEAD, over the signed bytes `counter || epoch || sender || ts || ciphertext`.

**Split-view detection.** Each peer's identity claims form a BLAKE3-chained log, surfaced as an 8-colour fingerprint for out-of-band comparison.

**Untrusted-content rendering.** Peer-controlled display text (usernames, message bodies, filenames) never becomes markup in the web client or terminal escapes in the CLI. This defeats XSS, terminal escape injection, and bidi or homoglyph display-name spoofing.

### The protocol does not protect against

**Endpoint compromise.** Malware or physical device access defeats any transport security.

**Traffic analysis.** Timing, message volume, and session duration stay observable.

**Membership lies.** A malicious server can misreport who is in a room.

**Cryptographic deniability.** Signatures bind authorship, so messages are not deniable.

**Multi-session correlation.** Out-of-band means can still link separate sessions.

> [!NOTE]
> See the full Dolev-Yao style adversary analysis in [THREAT-MODEL.md][threat-model-doc].

---

## Deployment Hardening

The protocol's guarantees are cryptographic and hold against the network. The
Docker image adds a hardened transport and delivery layer on top, so a default
deployment does not weaken them.

**Automatic TLS.** Caddy terminates TLS and provisions a certificate over ACME
for `$DOMAIN` on first start. Plain HTTP on port 80 redirects to HTTPS. The
certificate and ACME account live on the `covcom_caddy_data` volume, so a
restart reuses them instead of re-provisioning and tripping Let's Encrypt rate
limits.

**Single-origin relay.** The container serves the web client and proxies the
WebSocket relay on one origin. The client derives the socket scheme from the
page it loaded, so an HTTPS page always connects over `wss://` and never falls
back to plaintext `ws://`.

**Strict Content Security Policy.** The built client ships `default-src 'none'`
with no `worker-src`, a hashed inline script instead of `'unsafe-inline'`, and a
`connect-src` confined to the same origin, `wss:`, and loopback `ws://`. All
cryptography runs as main-thread WASM under `wasm-unsafe-eval`; no worker is
spawned. COVCOM is the [single-file SPA worked example][csp-spa-example] in
leviathan-crypto's [CSP reference][csp-doc], which covers the full policy and
its rationale.

**Clickjacking protection.** Caddy sends `X-Frame-Options: DENY`. The equivalent
`frame-ancestors` directive is silently ignored when delivered in a `<meta>`
CSP, so the protection is enforced as a real response header.

**Runtime-only configuration.** The image takes no build arguments. Secrets such
as `ADMIN_TOKEN` are passed as runtime environment variables and are never baked
into an image layer. The runtime image carries no build or development tooling.

> [!WARNING]
> The TLS termination and the `X-Frame-Options` header come from the bundled
> Caddy, not the Bun server. If you run the server directly behind your own
> reverse proxy (the no-docker path), you must terminate TLS and set the
> equivalent security headers yourself.

[supported versions]:         #supported-versions
[reporting a vulnerability]:  #reporting-a-vulnerability
[scope]:                      #scope
[cryptographic foundations]:  #cryptographic-foundations
[threat model]:               #threat-model
[deployment hardening]:       #deployment-hardening
[advisory]:                   https://github.com/xero/covcom/security/advisories/new
[pgp]:                        https://0w.nz/pgp.pub
[leviathan-crypto]:           https://github.com/xero/leviathan-crypto
[chacha20]:                   https://github.com/xero/leviathan-crypto/wiki/chacha20
[mlkem]:                      https://github.com/xero/leviathan-crypto/wiki/mlkem
[sha2]:                       https://github.com/xero/leviathan-crypto/wiki/sha2
[aead]:                       https://github.com/xero/leviathan-crypto/wiki/aead
[signaturesuite]:             https://github.com/xero/leviathan-crypto/wiki/signaturesuite
[blake3]:                     https://github.com/xero/leviathan-crypto/wiki/blake3
[merkle]:                     https://github.com/xero/leviathan-crypto/wiki/merkle
[doubleratchet]:              https://signal.org/docs/specifications/doubleratchet/
[crypto-doc]:                 ./docs/CRYPTOGRAPHY.md
[protocol-doc]:               ./docs/PROTOCOL.md
[threat-model-doc]:           ./docs/THREAT-MODEL.md
[csp-doc]:                    https://github.com/xero/leviathan-crypto/blob/main/docs/csp.md
[csp-spa-example]:            https://github.com/xero/leviathan-crypto/blob/main/docs/csp.md#single-file-spa-no-pool
