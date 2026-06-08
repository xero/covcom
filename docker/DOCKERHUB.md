# COVCOM

```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

  Covert communications for private group conversations.
  Invite, talk, close the client, and the chat vanishes.
  Every message is encrypted with XChaCha20 and signed
  with Ed25519. A BLAKE3 fingerprint on each key allows
  peers to verify one another. SPQR's manual and epoch
  ratchets add forward secrecy, while post-quantum
  ML-KEM-768 encapsulation keeps recorded communications
  unreadable and secure against future cryptanalysis.
```

## https://xero.github.io/covcom/

[![GitHub Release](https://img.shields.io/github/v/release/xero/covcom?display_name=release&style=flat-square&logo=contributorcovenant&logoColor=%23bcb83a&color=%2378740b)](https://github.com/xero/covcom/releases/latest) [![Container Image Size](https://img.shields.io/docker/image-size/xerostyle/covcom/latest?arch=amd64&style=flat-square&logo=developmentcontainers&logoColor=%23bcb83a&color=%2378740b)](https://hub.docker.com/r/xerostyle/covcom) [![GitHub Wiki Publish](https://img.shields.io/github/actions/workflow/status/xero/covcom/wiki.yml?branch=main&style=flat-square&logo=gitbook&logoColor=%23bcb83a&label=wiki&color=%2378740b)](https://github.com/xero/covcom/wiki) [![MIT Licensed](https://img.shields.io/badge/MIT-License?style=flat-square&logo=internetarchive&logoColor=%23bcb83a&label=License&color=%2378740b)](https://github.com/xero/covcom/blob/main/LICENSE)

- **Code:** https://github.com/xero/covcom
- **Docs:** https://github.com/xero/covcom/wiki

> **Crypto stack:** XChaCha20-Poly1305 AEAD, ML-KEM-768 post-quantum KEM ratchet,
HKDF-SHA-256 chain derivation, Ed25519 message + identity-claim signatures, and
a BLAKE3-chained identity fingerprint for out-of-band verification.

---

## Version Support

COVCOM follows a rolling support policy. When a security fix ships, the
previous version is deprecated immediately. Only the current release is
supported. Deprecated versions receive no patches, so upgrade promptly.

COVCOM releases in tandem with its cryptographic library
[leviathan-crypto](https://github.com/xero/leviathan-crypto/).
A vulnerability in either project triggers a coordinated release of both.

| Tag | Status       | Reason         |
|-----|--------------|----------------|
| [3.0.0](https://github.com/xero/covcom/blob/main/CHANGELOG.md#v300) | ✓ supported  | Latest version |
| [1.0.0](https://github.com/xero/covcom/blob/main/CHANGELOG.md#v100) | ✗ deprecated | XChaCha20 seal wasn't key-committing, thus vulnerable to salamander style partitioning-oracle attacks |
| 0.0.1 | ✗ deprecated | public beta |

---

## Quick Start

Point `chat.example.com` at the host you'll run on, then:

```sh
docker pull xerostyle/covcom:latest
docker run -d \
  -p 80:80 -p 443:443 \
  -e DOMAIN=chat.example.com \
  -v covcom_caddy_data:/data \
  -v covcom_caddy_config:/config \
  xerostyle/covcom:latest
```

Caddy auto-provisions a TLS certificate for `$DOMAIN` on first start and stores
it on the `covcom_caddy_data` volume, so it survives restarts and avoids
Let's Encrypt rate limits.

Open https://chat.example.com in a browser. Create a room, share the invite, & chat.


## Environment Variables

| Variable        | Default  | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| `DOMAIN`        | required | Domain name for Caddy TLS                      |
| `PORT`          | `1337`   | Internal port the Bun server listens on        |
| `ADMIN_TOKEN`   | unset    | Optional token gating room creation            |
| `ROOM_TTL`      | `24`     | Hours before empty rooms expire (`0` disables) |
| `MAX_ROOM_SIZE` | `20`     | Max participants per room (`0` is unlimited)   |

---

## Documentation

| Document                                                                  | Purpose                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [USAGE](https://github.com/xero/covcom/wiki/USAGE)                        | Client and server applications development and runtime help          |
| [PROTOCOL](https://github.com/xero/covcom/wiki/PROTOCOL)                  | Cipher, chains, ratchet, group model, session lifecycle, server role |
| [CRYPTOGRAPHY](https://github.com/xero/covcom/wiki/CRYPTOGRAPHY)          | Primitives, KDF chains, wire format, invite encoding                 |
| [THREAT-MODEL](https://github.com/xero/covcom/wiki/THREAT-MODEL)          | Principals, adversary tiers, guarantees, non-goals                   |
| [CLI-SPEC](https://github.com/xero/covcom/wiki/CLI-SPEC)                  | CLI architecture, rendering, input, widgets, views, & color system   |
| [SECURITY-POLICY](https://github.com/xero/covcom/wiki/SECURITY-POLICY)    | Supported versions, disclosure policy, cryptographic foundation      |
| [DIAGRAM](https://xero.github.io/covcom/diagram.html)                     | Animated visualization of a session: establishment, epochs, and reconnect ceremonies |

---

## License

**COVCOM** is released under the [MIT license](https://github.com/xero/covcom/blob/main/LICENSE)
