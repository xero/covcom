# COVCOM

```
  ▄██▀ ▀█  ▄██▀ █▄  ▀██  ██▀  ▄██▀ ▀█  ▄██▀ █▄   █▄   ▄█
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒  ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▒▄▒▒▒
 ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒▌ ▒▒  ▐▒▒▒     ▐▒▒▒  ▒▒▌  ▒▒ ▀ ▒▒
  ▀██▄ ▄█  ▀██▄ █▀    ▀█▄▀    ▀██▄ ▄█  ▀██▄ █▀  ▄██▄ ▄██▄

XChaCha20 · ML-KEM-768 · SPQR · E2EE · ephemeral · N-party

  Covert  communications  for private group conversations.
  Invite,  talk,  close the client, and the chat vanishes.
  End-to-end  encrypted  with  post-quantum  cryptography,
  both manual and epoch-based ratchet events add layers of
  forward  secrecy, ensuring messages remain private today
  and unreadable to the computational power of tomorrow.
```

## https://xero.github.io/covcom/

[![GitHub Release](https://img.shields.io/github/v/release/xero/covcom?display_name=release&style=flat-square&logo=contributorcovenant&logoColor=%23bcb83a&color=%2378740b)](https://github.com/xero/covcom/releases/latest) [![Container Image Size](https://img.shields.io/docker/image-size/xerostyle/covcom/latest?arch=amd64&style=flat-square&logo=developmentcontainers&logoColor=%23bcb83a&color=%2378740b)](https://hub.docker.com/r/xerostyle/covcom) [![GitHub Wiki Publish](https://img.shields.io/github/actions/workflow/status/xero/covcom/wiki.yml?branch=main&style=flat-square&logo=gitbook&logoColor=%23bcb83a&label=wiki&color=%2378740b)](https://github.com/xero/covcom/wiki) [![MIT Licensed](https://img.shields.io/badge/MIT-License?style=flat-square&logo=internetarchive&logoColor=%23bcb83a&label=License&color=%2378740b)](https://github.com/xero/covcom/blob/main/LICENSE)

- **Code:** https://github.com/xero/covcom
- **Docs:** https://github.com/xero/covcom/wiki

---

## Version Support

COVCOM follows a rolling support policy. When a security fix ships, the
previous version is deprecated immediately. Only the current release is
supported. Deprecated versions receive no patches, so upgrade promptly.

COVCOM releases in tandem with it's cryptographic library
[leviathan-crypto](https://github.com/xero/leviathan-crypto/).
A vulnerability in either project triggers a coordinated release of both.

### Tags

- `X.Y.Z` is a specific release (recommended for production)
    - `latest` is the most recent release

<!-- DEPRECATED-START -->
### Deprecated Versions

| Tag | Reason | Replacement |
|-----|--------|-------------|
| `0.0.1` | public beta | `1.0.0` |
<!-- DEPRECATED-END -->

---

## Quick Start

Point `chat.example.com` at the host you'll run on, then:

```sh
docker pull xerostyle/covcom:latest
docker run -d \
  -p 80:80 -p 443:443 \
  -e DOMAIN=chat.example.com \
  xerostyle/covcom:latest
```

Caddy auto-provisions a TLS certificate for `$DOMAIN` on first start.

Open https://chat.example.com in a browser. Create a room, share the invite, & chat.


## Environment Variables

| Variable        | Default  | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| `DOMAIN`        | required | Domain name for Caddy TLS                      |
| `PORT`          | `3000`   | Internal port the Bun server listens on        |
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
| [PROTOCOL-DIAGRAM](https://xero.github.io/covcom/protocol_diagram.html)   | Animated visualization of a 3-party session and epochs               |
| [RECONNECT-DIAGRAM](https://xero.github.io/covcom/reconnect_diagram.html) | Animated visualization of peers left / join ceremonies               |

---

## License

**COVCOM** is released under the [MIT license](https://github.com/xero/covcom/blob/main/LICENSE)
