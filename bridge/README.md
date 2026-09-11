# Bedrock WebSocket bridge

This narrow bridge exists for Bedrock clients that reject Cloudflare's lower-case
`Connection: upgrade` response. Node's `ws` server writes the successful handshake
as `Connection: Upgrade`, then relays the WebSocket frames unchanged to
`wss://craftmatic.click`.

The public listener accepts only `/connect/<32 lowercase hex characters>` with the
single subprotocol `com.microsoft.minecraft.wsencrypt`. It has no HTTP token route,
does not accept a configurable target, and rejects query strings and `/browser`.
Text and binary opcodes are preserved. Encryption remains end-to-end between the
Minecraft client and the existing Craftmatic session handler because this service
does not inspect or transform frame contents.

## Run

Mount a certificate and private key readable by the container, then set:

```text
TLS_CERT_FILE=/run/secrets/fullchain.pem
TLS_KEY_FILE=/run/secrets/privkey.pem
PORT=8443
```

Build from this directory:

```sh
docker build -t craftmatic-bedrock-ws-bridge .
docker run --rm -p 8443:8443 \
  -v /host/certs:/run/secrets:ro \
  -e TLS_CERT_FILE=/run/secrets/fullchain.pem \
  -e TLS_KEY_FILE=/run/secrets/privkey.pem \
  craftmatic-bedrock-ws-bridge
```

Production always terminates TLS in this Node process. A load balancer is safe only
when it forwards native TCP without rewriting the HTTP upgrade, or when its exact
raw `101` response has been verified to retain `Connection: Upgrade`. Do not assume
that a managed HTTP ingress preserves capitalization. Verify the public response
bytes with a real upgrade request before configuring `MINECRAFT_WS_ORIGIN`.

Sessions expire after 15 minutes, and the process accepts at most 64 simultaneous
sessions. Individual frames and each direction's buffered data are capped at 4 MiB.
Either socket closing or failing cleans up its peer. The
service does not log paths, session identifiers, subprotocol frames, or frame data.

## Test

From the repository root, where `ws` is already installed:

```sh
node --test bridge/test/*.test.mjs
```

For an isolated install, run `npm install` and `npm test` inside this directory.
