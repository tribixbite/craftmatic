import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

export const BEDROCK_PROTOCOL = 'com.microsoft.minecraft.wsencrypt';
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const SESSION_TTL_MS = 15 * 60 * 1000;
export const MAX_CONNECTIONS = 64;

const BACKEND_ORIGIN = 'wss://craftmatic.click';
const CONNECT_PATH = /^\/connect\/[0-9a-f]{32}$/;

function rejectUpgrade(socket, status, label, headers = '') {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n${headers}Content-Length: 0\r\n\r\n`,
  );
}

function parseConnectPath(rawUrl) {
  try {
    const url = new URL(rawUrl ?? '/', 'https://bridge.invalid');
    return url.search === '' && CONNECT_PATH.test(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

function hasExactProtocol(header) {
  if (typeof header !== 'string') return false;
  const protocols = header.split(',').map((value) => value.trim()).filter(Boolean);
  return protocols.length === 1 && protocols[0] === BEDROCK_PROTOCOL;
}

function payloadSize(data) {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return MAX_FRAME_BYTES + 1;
}

function createHttpHandler() {
  return (_request, response) => {
    response.writeHead(404, { 'Content-Length': '0' });
    response.end();
  };
}

/**
 * Creates the bridge without listening. Production callers must supply TLS.
 * backendOriginForTests is intentionally absent from the command-line surface.
 */
export function createBedrockBridge({
  tls,
  insecureHttp = false,
  backendOriginForTests,
  sessionTtlMs = SESSION_TTL_MS,
  backendHandshakeTimeoutMs = 10_000,
  maxFrameBytes = MAX_FRAME_BYTES,
  maxBufferedBytes = MAX_BUFFERED_BYTES,
  maxConnections = MAX_CONNECTIONS,
  closeGraceMs = 2_000,
} = {}) {
  if (!tls && !insecureHttp) {
    throw new Error('TLS certificate and key are required');
  }

  const backendOrigin = backendOriginForTests ?? BACKEND_ORIGIN;
  const parsedBackend = new URL(backendOrigin);
  if (!['ws:', 'wss:'].includes(parsedBackend.protocol) || parsedBackend.pathname !== '/') {
    throw new Error('Invalid backend origin');
  }

  const server = tls
    ? https.createServer(tls, createHttpHandler())
    : http.createServer(createHttpHandler());
  const frontServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxFrameBytes,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.size === 1 && protocols.has(BEDROCK_PROTOCOL)
        ? BEDROCK_PROTOCOL
        : false;
    },
  });
  const relays = new Set();
  const frontSockets = new Set();

  function startRelay(front, connectPath) {
    const pending = [];
    let pendingBytes = 0;
    let ended = false;
    let backend;
    let forceCloseTimer;

    const finish = ({ notifyFront = false, code = 1011, reason = 'Bridge unavailable' } = {}) => {
      if (ended) return;
      ended = true;
      clearTimeout(ttlTimer);
      clearTimeout(handshakeTimer);
      pending.length = 0;
      pendingBytes = 0;
      relays.delete(finish);

      if (notifyFront && front.readyState === WebSocket.OPEN) {
        front.close(code, reason);
        forceCloseTimer = setTimeout(() => front.terminate(), closeGraceMs);
        forceCloseTimer.unref?.();
      } else if (front.readyState === WebSocket.OPEN || front.readyState === WebSocket.CONNECTING) {
        front.terminate();
      }
      if (backend && (backend.readyState === WebSocket.OPEN || backend.readyState === WebSocket.CONNECTING)) {
        backend.terminate();
      }
    };

    const sendBounded = (destination, data, isBinary) => {
      const size = payloadSize(data);
      if (
        size > maxFrameBytes
        || destination.bufferedAmount + size > maxBufferedBytes
      ) {
        finish({ notifyFront: true, code: 1009, reason: 'Buffer limit exceeded' });
        return false;
      }
      destination.send(data, { binary: isBinary }, (error) => {
        if (error) finish({ notifyFront: destination === backend });
      });
      return true;
    };

    const ttlTimer = setTimeout(() => {
      finish({ notifyFront: true, code: 1000, reason: 'Session expired' });
    }, sessionTtlMs);
    ttlTimer.unref?.();

    const backendUrl = new URL(connectPath, parsedBackend);
    backend = new WebSocket(backendUrl, BEDROCK_PROTOCOL, {
      maxPayload: maxFrameBytes,
      perMessageDeflate: false,
      handshakeTimeout: backendHandshakeTimeoutMs,
    });
    const handshakeTimer = setTimeout(() => {
      finish({ notifyFront: true });
    }, backendHandshakeTimeoutMs);
    handshakeTimer.unref?.();

    relays.add(finish);

    front.on('message', (data, isBinary) => {
      if (ended) return;
      const size = payloadSize(data);
      if (size > maxFrameBytes) {
        finish({ notifyFront: true, code: 1009, reason: 'Frame too large' });
        return;
      }
      if (backend.readyState === WebSocket.OPEN) {
        sendBounded(backend, data, isBinary);
        return;
      }
      if (backend.readyState !== WebSocket.CONNECTING || pendingBytes + size > maxBufferedBytes) {
        finish({ notifyFront: true, code: 1009, reason: 'Buffer limit exceeded' });
        return;
      }
      pending.push({ data, isBinary, size });
      pendingBytes += size;
    });
    front.on('close', () => {
      clearTimeout(forceCloseTimer);
      frontSockets.delete(front);
      finish();
    });
    front.on('error', () => finish());

    backend.on('open', () => {
      clearTimeout(handshakeTimer);
      for (const frame of pending) {
        if (!sendBounded(backend, frame.data, frame.isBinary)) return;
      }
      pending.length = 0;
      pendingBytes = 0;
    });
    backend.on('message', (data, isBinary) => {
      if (!ended && front.readyState === WebSocket.OPEN) {
        sendBounded(front, data, isBinary);
      }
    });
    backend.on('close', (code) => {
      finish({
        notifyFront: true,
        code: code === 1000 ? 1000 : 1011,
        reason: code === 1000 ? 'Backend closed' : 'Bridge unavailable',
      });
    });
    backend.on('error', () => finish({ notifyFront: true }));
  }

  server.on('upgrade', (request, socket, head) => {
    const connectPath = parseConnectPath(request.url);
    if (!connectPath) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!hasExactProtocol(request.headers['sec-websocket-protocol'])) {
      rejectUpgrade(
        socket,
        426,
        'Upgrade Required',
        `Sec-WebSocket-Protocol: ${BEDROCK_PROTOCOL}\r\n`,
      );
      return;
    }
    if (frontSockets.size >= maxConnections) {
      rejectUpgrade(socket, 503, 'Service Unavailable', 'Retry-After: 5\r\n');
      return;
    }

    frontServer.handleUpgrade(request, socket, head, (front) => {
      frontSockets.add(front);
      startRelay(front, connectPath);
    });
  });

  return {
    server,
    get activeConnections() {
      return frontSockets.size;
    },
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      for (const finish of [...relays]) finish();
      for (const front of [...frontSockets]) front.terminate();
      frontServer.close();
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function main() {
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  if (!certFile || !keyFile) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE are required');
  }
  const tls = {
    cert: await readFile(certFile),
    key: await readFile(keyFile),
  };
  const bridge = createBedrockBridge({ tls });
  const port = Number.parseInt(process.env.PORT ?? '8443', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  await bridge.listen(port);
  process.once('SIGTERM', () => void bridge.close());
  process.once('SIGINT', () => void bridge.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Do not print request URLs, session IDs, or frame data.
    process.stderr.write(`Bridge startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
