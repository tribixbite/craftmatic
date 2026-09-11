import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import {
  BEDROCK_PROTOCOL,
  createBedrockBridge,
} from '../bedrock-ws.mjs';

const SESSION = '0123456789abcdef0123456789abcdef';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function createBackend(onConnection = () => {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has(BEDROCK_PROTOCOL) ? BEDROCK_PROTOCOL : false;
    },
  });
  wss.on('connection', onConnection);
  const port = await listen(server);
  return {
    origin: `ws://127.0.0.1:${port}`,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function createBridge(backendOriginForTests, options = {}) {
  const bridge = createBedrockBridge({
    insecureHttp: true,
    backendOriginForTests,
    ...options,
  });
  const address = await bridge.listen(0, '127.0.0.1');
  return { bridge, port: address.port };
}

function rawUpgrade(port, path, protocol = BEDROCK_PROTOCOL) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for upgrade response'));
    }, 2_000);
    socket.on('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        protocol === null ? null : `Sec-WebSocket-Protocol: ${protocol}`,
        '',
        '',
      ].filter((line) => line !== null).join('\r\n'));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (response.includes('\r\n\r\n')) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(response.slice(0, response.indexOf('\r\n\r\n') + 4));
      }
    });
    socket.on('error', reject);
  });
}

function openClient(port) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(
      `ws://127.0.0.1:${port}/connect/${SESSION}`,
      BEDROCK_PROTOCOL,
      { perMessageDeflate: false },
    );
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  // A client close frame can arrive before the server processes its own close event.
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

test('successful raw handshake emits exact Connection: Upgrade capitalization', async (t) => {
  const backend = await createBackend();
  const { bridge, port } = await createBridge(backend.origin);
  t.after(() => bridge.close());
  t.after(() => backend.close());

  const response = await rawUpgrade(port, `/connect/${SESSION}`);
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.ok(response.includes('\r\nConnection: Upgrade\r\n'));
  assert.ok(response.includes(`\r\nSec-WebSocket-Protocol: ${BEDROCK_PROTOCOL}\r\n`));
});

test('relays text and binary frames in both directions without opcode changes', async (t) => {
  const backendFrames = [];
  const backend = await createBackend((socket) => {
    socket.on('message', (data, isBinary) => {
      backendFrames.push({ data: Buffer.from(data), isBinary });
      socket.send(data, { binary: isBinary });
    });
  });
  const { bridge, port } = await createBridge(backend.origin);
  t.after(() => bridge.close());
  t.after(() => backend.close());
  const client = await openClient(port);
  t.after(() => client.terminate());

  const clientFrames = [];
  client.on('message', (data, isBinary) => clientFrames.push({ data: Buffer.from(data), isBinary }));
  client.send('encrypted-text-envelope');
  client.send(Buffer.from([0, 1, 2, 255]), { binary: true });

  await assert.doesNotReject(async () => {
    while (clientFrames.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  assert.deepEqual(backendFrames.map((frame) => frame.isBinary), [false, true]);
  assert.deepEqual(clientFrames.map((frame) => frame.isBinary), [false, true]);
  assert.equal(clientFrames[0].data.toString(), 'encrypted-text-envelope');
  assert.deepEqual([...clientFrames[1].data], [0, 1, 2, 255]);
});

test('rejects browser, malformed, queried paths and incorrect protocols', async (t) => {
  const backend = await createBackend();
  const { bridge, port } = await createBridge(backend.origin);
  t.after(() => bridge.close());
  t.after(() => backend.close());

  for (const path of [
    `/connect/${SESSION}/browser`,
    '/connect/550e8400-e29b-41d4-a716-446655440000',
    `/connect/${SESSION}?target=wss://example.test`,
  ]) {
    const response = await rawUpgrade(port, path);
    assert.match(response, /^HTTP\/1\.1 404 Not Found\r\n/);
  }
  assert.match(
    await rawUpgrade(port, `/connect/${SESSION}`, 'chat'),
    /^HTTP\/1\.1 426 Upgrade Required\r\n/,
  );
  assert.match(
    await rawUpgrade(port, `/connect/${SESSION}`, null),
    /^HTTP\/1\.1 426 Upgrade Required\r\n/,
  );
  assert.equal(bridge.activeConnections, 0);
});

test('backend connection failure closes and removes the front session', async (t) => {
  const unusedServer = http.createServer();
  const unusedPort = await listen(unusedServer);
  await new Promise((resolve) => unusedServer.close(resolve));
  const { bridge, port } = await createBridge(`ws://127.0.0.1:${unusedPort}`, {
    backendHandshakeTimeoutMs: 200,
  });
  t.after(() => bridge.close());

  const client = await openClient(port);
  const [code] = await once(client, 'close');
  assert.equal(code, 1011);
  assert.equal(await waitUntil(() => bridge.activeConnections === 0), true);
});

test('expires a session at its bounded lifetime and cleans up both sockets', async (t) => {
  let backendClosed;
  const backend = await createBackend((socket) => {
    backendClosed = once(socket, 'close');
  });
  const { bridge, port } = await createBridge(backend.origin, { sessionTtlMs: 30 });
  t.after(() => bridge.close());
  t.after(() => backend.close());

  const client = await openClient(port);
  const [code] = await once(client, 'close');
  assert.equal(code, 1000);
  await backendClosed;
  assert.equal(await waitUntil(() => bridge.activeConnections === 0), true);
});

test('rejects upgrades above the simultaneous session limit', async (t) => {
  const backend = await createBackend();
  const { bridge, port } = await createBridge(backend.origin, { maxConnections: 1 });
  t.after(() => bridge.close());
  t.after(() => backend.close());
  const client = await openClient(port);
  t.after(() => client.terminate());

  const response = await rawUpgrade(port, `/connect/${SESSION}`);
  assert.match(response, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.equal(bridge.activeConnections, 1);
});
