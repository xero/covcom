# COVCOM

Covert communications for private group conversations. End-to-end
encrypted with post-quantum cryptography. Share an invite, talk, close
the tab, it's gone. Ratchet anytime for added forward security.

`XChaCha20 · ML-KEM-768 · SPQR · E2EE · ephemeral · N-party`

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

- `X.Y.Z` — specific release (recommended for production)
    - `latest` — most recent release

<!-- DEPRECATED-START -->
### Deprecated Versions

| Tag | Reason | Replacement |
|-----|--------|-------------|
| `0.0.1` | public beta | `1.0.0` |
<!-- DEPRECATED-END -->

---

## Quick Start

```sh
docker run -d \
  -p 80:80 -p 443:443 \
  -e DOMAIN=chat.example.com \
  xerostyle/covcom:latest
```

Caddy auto-provisions a TLS certificate for `$DOMAIN` on first start.

## Environment Variables

| Variable        | Default  | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| `DOMAIN`        | required | Domain name for Caddy TLS                      |
| `PORT`          | `3000`   | Internal port the Bun server listens on        |
| `ADMIN_TOKEN`   | unset    | Optional token gating room creation            |
| `ROOM_TTL`      | `24`     | Hours before empty rooms expire (`0` disables) |
| `MAX_ROOM_SIZE` | `20`     | Max participants per room (`0` is unlimited)   |

---

## Security

- [Security Policy](https://github.com/xero/covcom/blob/main/SECURITY.md)
- [Protocol Overview](https://github.com/xero/covcom/wiki/PROTOCOL)
- [Cryptography Reference](https://github.com/xero/covcom/wiki/CRYPTOGRAPHY)
- [Thread Model](https://github.com/xero/covcom/wiki/THREAT-MODEL)
- [Vulnerability Reports](https://github.com/xero/covcom/security/advisories)

---

## license

MIT
