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

| Document                                                                  | Purpose                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [USAGE](USAGE.md)                                                         | Client and server applications development and runtime help          |
| [PROTOCOL](PROTOCOL.md)                                                   | Cipher, chains, ratchet, group model, session lifecycle, server role |
| [CRYPTOGRAPHY](CRYPTOGRAPHY.md)                                           | Primitives, KDF chains, wire format, invite encoding                 |
| [THREAT-MODEL](THREAT-MODEL.md)                                           | Principals, adversary tiers, guarantees, non-goals                   |
| [CLI-SPEC](CLI-SPEC.md)                                                   | CLI architecture, rendering, input, widgets, views, & color system   |
| [SECURITY-POLICY](../SECURITY.md)                                         | Supported versions, disclosure policy, cryptographic foundation      |
| [PROTOCOL-DIAGRAM](https://xero.github.io/covcom/protocol_diagram.html)   | Animated visualization of a 3-party session and epochs               |
| [RECONNECT-DIAGRAM](https://xero.github.io/covcom/reconnect_diagram.html) | Animated visualization of peers left / join ceremonies               |

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
