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

| Document                                              | Purpose                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| [USAGE](USAGE.md)                                     | Client and server applications development and runtime help           |
| [PROTOCOL](PROTOCOL.md)                               | Cipher, chains, ratchet, group model, session lifecycle, server role  |
| [CRYPTOGRAPHY](CRYPTOGRAPHY.md)                       | Primitives, KDF chains, wire format, invite encoding                  |
| [THREAT-MODEL](THREAT-MODEL.md)                       | Principals, adversary tiers, guarantees, non-goals                    |
| [LIB-SPEC](LIB-SPEC.md)                               | Shared library API, session and identity surface, invites, & files    |
| [SERVER-SPEC](SERVER-SPEC.md)                         | Server wire contract, message handlers, room lifecycle, & config      |
| [WEB-SPEC](WEB-SPEC.md)                               | Web client architecture, state, session, views, & single-file build   |
| [CLI-SPEC](CLI-SPEC.md)                               | CLI architecture, rendering, input, widgets, views, & color system    |
| [TESTING](TESTING.md)                                 | Test layers, unit and end-to-end suites, cross-client interop, and CI |
| [SECURITY-POLICY](../SECURITY.md)                     | Supported versions, disclosure policy, cryptographic foundation       |
| [DIAGRAM](https://xero.github.io/covcom/diagram.html) | Animated protocol visualization, session establishment, epochs, fingerprinting, file attachments, ratchets, and reconnect ceremonies |

## Quickstart

Point `chat.example.com` at the host you'll run on, then:

```sh
docker pull xerostyle/covcom:latest
docker run -d \
  -p 80:80 -p 443:443 \
  -e DOMAIN=chat.example.com \
  xerostyle/covcom:latest
```

Open https://chat.example.com in a browser. Create a room, share the invite, & chat.

## Client Previews

[![cli and web client previews](https://raw.githubusercontent.com/wiki/xero/covcom/log.png)](https://github.com/xero/covcom/raw/main/docs/log.png)

