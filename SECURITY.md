# Security Policy

> [!NOTE]
> This policy covers COVCOM and its cryptographic dependency
> [leviathan-crypto](https://github.com/xero/leviathan-crypto), both
> maintained by the same author and release in tandem.

> ### Table of Contents
> - [supported versions](#supported-versions)
> - [cryptographic foundation](#cryptographic-foundation)
> - [threat model](#threat-model)
> - [reporting a vulnerability](#reporting-a-vulnerability)
> - [scope](#scope)

---

## supported versions

COVCOM follows a rolling support policy. When a security fix ships, the
previous version is deprecated immediately. Only the current release is
supported.

| Version | Status      |
|---------|-------------|
| v1.0.0  | ✓ supported |

Deprecated versions receive no patches. Upgrade promptly.

COVCOM releases in tandem with leviathan-crypto. The ratchet module
([PR #12](https://github.com/xero/leviathan-crypto/pull/12)) ships
alongside COVCOM v1.0.0. A vulnerability in either project triggers a
coordinated release of both.

---

## cryptographic foundation

All cryptographic operations in COVCOM are provided by
[leviathan-crypto](https://github.com/xero/leviathan-crypto), a
zero-dependency TypeScript/WASM library by the same author. There are no
third-party cryptographic dependencies.

The active primitive set:

| Primitive | Purpose |
|---|---|
| XChaCha20-Poly1305 | Message and file encryption |
| ML-KEM-768 (FIPS 203) | Post-quantum key encapsulation |
| HKDF-SHA-256 | Key derivation throughout |
| Seal+MlKemSuite | Chain seed distribution |

The protocol implements the Sparse Post-Quantum Ratchet from the
[Signal Double Ratchet spec](https://signal.org/docs/specifications/doubleratchet/)
(§5, Revision 4) with a Sender Keys group messaging model.

---

## threat model

**The protocol provides:**
- Message confidentiality against passive and active network adversaries
- Forward secrecy, so past messages are unrecoverable from current state
- Post-compromise security at every KEM ratchet boundary
- Harvest-now-decrypt-later resistance via ML-KEM-768
- Enumeration resistance via a 2^128 room secret space
- Session anonymity, with no persistent identity keys visible to the server

**The protocol does not protect against:**
- Endpoint compromise (malware, physical device access)
- Traffic analysis (timing, message volume, session duration)
- A server that lies about room membership
- Cryptographic deniability
- Multi-session correlation by out-of-band means

See the full Dolev-Yao style adversary analysis in [THREAT-MODEL.md](./docs/THREAT-MODEL.md).

---

## Reporting a Vulnerability

> [!IMPORTANT]
> **_Please do not open a public issue for security vulnerabilities._**

### Private Advisory (preferred)

Use GitHub's private vulnerability reporting form:
[https://github.com/xero/covcom/security/advisories/new][advisory]

This opens a private channel between you and the maintainer, and you will
receive a response promptly. If the vulnerability is confirmed, we will
collaborate to fully understand the issue, including a review of proposed
fixes, so you can track and validate firsthand. Before any public advisory
is published, we will agree on a coordinated disclosure timeline. After
disclosure, you are encouraged to publish your own write-up, blog post, or
research notes, for full hacker scene credit.

### Direct Contact

If you prefer to contact the maintainer directly:

- **Email:** x﹫xero.style · PGP: [`0xAC1D0000`][pgp]
- **Matrix:** x0﹫rx.haunted.computer

> [!NOTE]
> Encrypted communication is welcome and _preferred_ for sensitive reports.

---

## scope

**In scope:**

- Vulnerabilities in COVCOM's web client, CLI, or server
- Vulnerabilities in the COVCOM wire protocol or session handshake
- Cryptographic weaknesses in the ratchet implementation or key derivation
- Vulnerabilities in leviathan-crypto primitives or the WASM layer
- Protocol design flaws (an unsound design itself counts)
- Dependency vulnerabilities that affect COVCOM's security properties
- Invite format weaknesses (enumeration, forgery, replay)

**Out of scope:**

- Bugs in leviathan-crypto unrelated to COVCOM's use of it. Please Report those
  in the [leviathan-crypto repository](https://github.com/xero/leviathan-crypto)
- The non-goals listed in the threat model: endpoint security, traffic
  analysis, server availability attacks, multi-session correlation
- Attacks requiring physical access to a participant's device
- Social engineering attacks against participants
- APT-level nation-state adversaries with quantum computing capability
  today (ML-KEM-768 addresses future quantum, not present-day state actors
  with unlimited classical resources)
- Spam or denial-of-service against publicly hosted instances

[advisory]: https://github.com/xero/covcom/security/advisories/new
[pgp]:      https://0w.nz/pgp.pub
