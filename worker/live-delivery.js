import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Aes256Cfb8 } from './aes-cfb8.js';

export const LIVE_SESSION_TTL_MS = 15 * 60 * 1000;
export const MAX_HS1_BYTES = 4 * 1024 * 1024;
export const HS1_CHUNK_SIZE = 300;
export const MAX_HS1_CHUNKS = 16_384;
const MAX_BROWSER_MESSAGE = MAX_HS1_BYTES + 1024;
const COMMAND_TIMEOUT_MS = 12_000;
const COMMIT_TIMEOUT_MS = 90_000;
export const COMMAND_WINDOW = 8;
const WS_PROTOCOL = 'com.microsoft.minecraft.wsencrypt';

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function validateHs1(encoded, checksum) {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_HS1_BYTES) {
    throw new Error(`HS1 payload must contain 1-${MAX_HS1_BYTES} ASCII characters`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('HS1 payload contains invalid characters');
  if (typeof checksum !== 'string' || !/^[0-9a-f]{8}$/.test(checksum)) {
    throw new Error('HS1 checksum must be eight lowercase hex characters');
  }
  if (fnv1a32(encoded) !== checksum) throw new Error('HS1 checksum does not match payload');
  const count = Math.ceil(encoded.length / HS1_CHUNK_SIZE);
  if (count > MAX_HS1_CHUNKS) throw new Error(`HS1 payload needs ${count} chunks; maximum is ${MAX_HS1_CHUNKS}`);
  return count;
}

function allowedOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.origin === 'https://craftmatic.click') return url.origin;
    if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
        (url.protocol === 'http:' || url.protocol === 'https:')) return url.origin;
  } catch { /* invalid origins are refused */ }
  return null;
}

function corsHeaders(request) {
  const origin = allowedOrigin(request);
  return origin ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  } : {};
}

function publicWsUrl(request, pathname) {
  const url = new URL(request.url);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

/** Handle only the public live-delivery routes; return null for existing proxy routes. */
export async function handleLiveDeliveryRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/connect' && request.method === 'OPTIONS') {
    const headers = corsHeaders(request);
    return Object.keys(headers).length ? new Response(null, { status: 204, headers }) : json({ error: 'Origin not allowed' }, 403);
  }
  if (url.pathname === '/connect' && request.method === 'POST') {
    const origin = allowedOrigin(request);
    if (request.headers.has('origin') && !origin) return json({ error: 'Origin not allowed' }, 403);
    const sessionId = randomBytes(16).toString('hex');
    const browserToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LIVE_SESSION_TTL_MS).toISOString();
    const stub = env.LIVE_DELIVERY.get(env.LIVE_DELIVERY.idFromName(sessionId));
    const init = await stub.fetch('https://live.internal/init', {
      method: 'POST',
      body: JSON.stringify({ browserToken, expiresAt }),
    });
    if (!init.ok) return json({ error: 'Unable to create delivery session' }, 503, corsHeaders(request));
    const minecraftUrl = publicWsUrl(request, `/connect/${sessionId}`);
    return json({
      sessionId,
      minecraftUrl,
      browserUrl: publicWsUrl(request, `/connect/${sessionId}/browser`),
      browserToken,
      pairingCommand: `/wsserver ${minecraftUrl}`,
      expiresAt,
    }, 201, { ...corsHeaders(request), 'referrer-policy': 'no-referrer' });
  }
  const match = url.pathname.match(/^\/connect\/([0-9a-f]{32})(\/browser)?$/);
  if (!match) return null;
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'WebSocket upgrade required' }, 426);
  }
  const stub = env.LIVE_DELIVERY.get(env.LIVE_DELIVERY.idFromName(match[1]));
  const target = match[2] ? 'browser' : 'minecraft';
  return stub.fetch(`https://live.internal/${target}`, request);
}

export class LiveDeliverySession {
  constructor(state) {
    this.state = state;
    this.minecraft = null;
    this.browser = null;
    this.browserAuthed = false;
    this.minecraftReady = null;
    this.pairingResolve = null;
    this.pairingReject = null;
    this.pairingSettled = false;
    this.player = null;
    this.encrypt = null;
    this.decrypt = null;
    this.pending = new Map();
    this.deliveryRunning = false;
    this.deliveryGeneration = 0;
    this.stages = [];
    this.resetPairing();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      const existing = await this.state.storage.get('session');
      if (existing) return json({ error: 'Session already initialized' }, 409);
      const body = await request.json();
      const expiresAt = Date.parse(body.expiresAt);
      if (typeof body.browserToken !== 'string' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return json({ error: 'Invalid session' }, 400);
      }
      const tokenHash = createHash('sha256').update(body.browserToken).digest('hex');
      await this.state.storage.put('session', { tokenHash, expiresAt });
      await this.state.storage.setAlarm(expiresAt);
      return json({ ok: true }, 201);
    }

    const session = await this.state.storage.get('session');
    if (!session || session.expiresAt <= Date.now()) return json({ error: 'Session expired' }, 410);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Upgrade required' }, 426);
    if (url.pathname === '/minecraft') return this.acceptMinecraft(request);
    if (url.pathname === '/browser') return this.acceptBrowser(session);
    return json({ error: 'Not found' }, 404);
  }

  async alarm() {
    this.pairingReject?.(new Error('Delivery session expired'));
    this.sendBrowser({ type: 'error', code: 'expired', message: 'Delivery session expired' });
    this.browser?.close(1000, 'Session expired');
    this.minecraft?.close(1000, 'Session expired');
    await this.state.storage.deleteAll();
  }

  acceptBrowser(session) {
    if (this.browser && this.browser.readyState === 1) return json({ error: 'Browser already connected' }, 409);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.browser = server;
    this.browserAuthed = false;
    const authTimer = setTimeout(() => {
      if (!this.browserAuthed) server.close(1008, 'Authentication required');
    }, 5000);
    server.addEventListener('message', event => {
      void this.onBrowserMessage(event.data, session).catch(error => {
        this.sendBrowser({ type: 'error', code: 'delivery_failed', message: error instanceof Error ? error.message : String(error) });
        this.deliveryRunning = false;
      });
    });
    server.addEventListener('close', () => {
      clearTimeout(authTimer);
      if (this.browser === server) { this.browser = null; this.browserAuthed = false; }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async onBrowserMessage(data, session) {
    if (typeof data !== 'string' || data.length > MAX_BROWSER_MESSAGE) throw new Error('Browser message is not valid bounded JSON');
    const message = JSON.parse(data);
    if (!this.browserAuthed) {
      if (message?.type !== 'auth' || typeof message.token !== 'string') throw new Error('Authentication required');
      const actual = createHash('sha256').update(message.token).digest('hex');
      if (actual !== session.tokenHash) {
        this.browser?.close(1008, 'Invalid credential');
        return;
      }
      this.browserAuthed = true;
      this.sendBrowser({ type: 'authenticated', expiresAt: new Date(session.expiresAt).toISOString() });
      this.sendBrowser({ type: 'diagnostic', stages: this.stages });
      if (this.player) this.sendBrowser({ type: 'paired', player: this.player });
      return;
    }
    if (message?.type === 'cancel') {
      this.deliveryRunning = false;
      this.deliveryGeneration++;
      this.sendBrowser({ type: 'cancelled' });
      return;
    }
    if (message?.type !== 'import') throw new Error('Only HS1 import messages are accepted');
    if (this.deliveryRunning) throw new Error('A delivery is already running');
    const count = validateHs1(message.encoded, message.checksum);
    this.deliveryRunning = true;
    const generation = ++this.deliveryGeneration;
    try {
      await this.deliver(message.encoded, message.checksum, count, generation);
    } finally {
      if (this.deliveryGeneration === generation) this.deliveryRunning = false;
    }
  }

  acceptMinecraft(request) {
    if (this.minecraft && this.minecraft.readyState === 1) this.minecraft.close(1012, 'Replaced by reconnect');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.minecraft = server;
    this.player = null;
    this.encrypt = null;
    this.decrypt = null;
    this.pending.clear();
    this.recordStage('minecraft_accepted', {
      protocol: request.headers.get('sec-websocket-protocol') || '',
    });
    // Some retail clients treat a data frame coalesced with the HTTP 101 as a
    // WebSocket protocol error. Let the upgrade response leave the edge before
    // sending Minecraft's first application frame.
    const handshake = new Promise(resolve => setTimeout(resolve, 100))
      .then(() => this.startMinecraftHandshake(server));
    // A failed/abandoned pairing may happen before a browser connects. Keep the
    // rejection observable to deliver() without creating an unhandled promise.
    handshake.then(player => this.pairingResolve?.(player)).catch(error => {
      this.sendBrowser({ type: 'error', code: 'minecraft_handshake', message: error instanceof Error ? error.message : String(error) });
    });
    server.addEventListener('message', event => this.onMinecraftMessage(event.data));
    server.addEventListener('close', event => {
      this.recordStage('minecraft_closed', { code: event.code, reason: String(event.reason || '').slice(0, 80) });
      if (this.minecraft === server) {
        this.minecraft = null;
        this.player = null;
        if (this.pairingSettled) this.resetPairing();
        for (const pending of this.pending.values()) pending.reject(new Error('Minecraft disconnected'));
        this.pending.clear();
        this.sendBrowser({ type: 'unpaired' });
      }
    });
    server.addEventListener('error', () => this.sendBrowser({ type: 'error', code: 'minecraft_socket', message: 'Minecraft connection failed' }));
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': WS_PROTOCOL } });
  }

  async startMinecraftHandshake(socket) {
    this.recordStage('key_generation_started');
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-384' }, true, ['deriveBits'],
    );
    const salt = randomBytes(16);
    const publicKey = Buffer.from(await globalThis.crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64').replace(/=+$/, '');
    this.recordStage('encryption_request_sending', { publicKeyChars: publicKey.length });
    const response = await this.command(`enableencryption "${publicKey}" "${salt.toString('base64').replace(/=+$/, '')}" cfb8`, false);
    this.recordStage('encryption_key_received', { hasPublicKey: !!response?.publicKey });
    if (!response?.publicKey) throw new Error('Minecraft refused encrypted WebSockets');
    const peerKey = await globalThis.crypto.subtle.importKey(
      'spki', Buffer.from(response.publicKey, 'base64'), { name: 'ECDH', namedCurve: 'P-384' }, false, [],
    );
    let shared = Buffer.from(await globalThis.crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerKey }, pair.privateKey, 384,
    ));
    while (shared.length > 1 && shared[0] === 0) shared = shared.subarray(1);
    const secret = createHash('sha256').update(salt).update(shared).digest();
    const iv = secret.subarray(0, 16);
    this.encrypt = new Aes256Cfb8(secret, iv);
    this.decrypt = new Aes256Cfb8(secret, iv, true);
    this.recordStage('ciphers_ready');
    const playerBody = await this.command('getlocalplayername');
    const player = String(playerBody?.localplayername ?? playerBody?.playername ?? '').trim();
    if (!player || player.length > 16 || /[\x00-\x1f\x7f]/.test(player)) throw new Error('Minecraft returned an invalid player name');
    if (socket !== this.minecraft) throw new Error('Minecraft connection was replaced');
    this.player = player;
    this.recordStage('player_ready');
    this.sendBrowser({ type: 'paired', player });
    return player;
  }

  onMinecraftMessage(data) {
    let bytes;
    try {
      this.recordStage('minecraft_frame', {
        kind: typeof data === 'string' ? 'text' : 'binary',
        bytes: typeof data === 'string' ? data.length : data?.byteLength,
      });
      if (typeof data === 'string') bytes = Buffer.from(data);
      else bytes = Buffer.from(data);
      // Retail sends handshake/control responses as plaintext text and switches
      // encrypted command responses to binary frames. Cipher state is advanced
      // only for binary frames.
      if (typeof data !== 'string' && this.decrypt) bytes = this.decrypt.update(bytes);
      const message = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const requestId = message?.header?.requestId;
      const pending = this.pending.get(requestId);
      if (pending) {
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(message.body);
      }
    } catch (error) {
      // Malformed/unsolicited events never become commands or browser data.
      this.sendBrowser({ type: 'error', code: 'minecraft_decode', message: error instanceof Error ? error.message : String(error) });
    }
  }

  command(commandLine, encrypted = true) {
    if (!this.minecraft || this.minecraft.readyState !== 1) return Promise.reject(new Error('Minecraft is not connected'));
    const requestId = randomUUID();
    const payload = Buffer.from(JSON.stringify({
      header: { version: 1, requestId, messageType: 'commandRequest', messagePurpose: 'commandRequest' },
      body: { commandLine },
    }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Minecraft command timed out (${commandLine.split(' ')[0]})`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        const wire = encrypted && this.encrypt ? this.encrypt.update(payload) : payload.toString('utf8');
        this.minecraft.send(wire);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  selector(...filters) {
    const escaped = this.player.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `@a[name="${escaped}",c=1${filters.map(filter => `,${filter}`).join('')}]`;
  }

  async checkedCommand(line) {
    const response = await this.command(line);
    if (response?.statusCode !== 0) throw new Error(response?.statusMessage || `Minecraft rejected command (${response?.statusCode ?? 'no status'})`);
    return response;
  }

  async deliver(encoded, checksum, count, generation) {
    this.sendBrowser({ type: 'progress', phase: 'pairing', acknowledged: 0, total: count });
    const player = await this.minecraftReady;
    if (!this.deliveryRunning || this.deliveryGeneration !== generation) return;
    const selector = this.selector();
    this.sendBrowser({ type: 'progress', phase: 'probing', acknowledged: 0, total: count });
    await this.checkedCommand(`execute as ${selector} at @s run scriptevent hotschem:probe HS1`);
    await this.waitForTag('hs_stream_v1', 6000);
    for (let start = 0; start < count; start += COMMAND_WINDOW) {
      if (!this.deliveryRunning || this.deliveryGeneration !== generation) return;
      const end = Math.min(count, start + COMMAND_WINDOW);
      const commands = [];
      for (let index = start; index < end; index++) {
        const chunk = encoded.slice(index * HS1_CHUNK_SIZE, (index + 1) * HS1_CHUNK_SIZE);
        // HS1 part numbers are deliberately one-based; the paste importer and
        // behavior-pack receiver share this exact grammar.
        const command = `execute as ${selector} at @s run scriptevent hotschem:stream HS1:${checksum}:${index + 1}:${count}:${chunk}`;
        if (command.length > 461) throw new Error('Internal command exceeded the verified transport bound');
        commands.push(this.checkedCommand(command));
      }
      // Eight outstanding requests keeps the retail client's <100 request
      // limit distant while amortising WAN latency. Writes above occur in
      // order; the receiver tolerates out-of-order acknowledgements.
      await Promise.all(commands);
      this.sendBrowser({ type: 'progress', phase: 'transferring', acknowledged: end, total: count });
    }
    if (!this.deliveryRunning || this.deliveryGeneration !== generation) return;
    this.sendBrowser({ type: 'progress', phase: 'committing', acknowledged: count, total: count });
    await this.waitForCompletion(checksum);
    if (!this.deliveryRunning || this.deliveryGeneration !== generation) return;
    this.sendBrowser({ type: 'complete', checksum, chunks: count, bytes: encoded.length, player });
  }

  async waitForTag(tag, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
      const response = await this.command(`testfor ${this.selector(`tag=${tag}`)}`);
      if (response?.statusCode === 0) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error(`Minecraft receiver did not report ${tag}`);
  }

  async waitForCompletion(checksum) {
    const deadline = Date.now() + COMMIT_TIMEOUT_MS;
    do {
      const failed = await this.command(`testfor ${this.selector(`tag=hs_error_${checksum}`)}`);
      if (failed?.statusCode === 0) throw new Error('Minecraft rejected the imported model');
      const ready = await this.command(`testfor ${this.selector(`tag=hs_ready_${checksum}`)}`);
      if (ready?.statusCode === 0) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error('Minecraft did not acknowledge the completed model');
  }

  sendBrowser(message) {
    if (!this.browserAuthed || !this.browser || this.browser.readyState !== 1) return;
    if (this.browser.bufferedAmount > 512 * 1024) {
      this.browser.close(1013, 'Browser is not reading acknowledgements');
      return;
    }
    this.browser.send(JSON.stringify(message));
  }

  resetPairing() {
    this.pairingSettled = false;
    this.minecraftReady = new Promise((resolve, reject) => {
      this.pairingResolve = value => { this.pairingSettled = true; resolve(value); };
      this.pairingReject = error => { this.pairingSettled = true; reject(error); };
    });
    // A session can expire without a browser ever awaiting this promise.
    this.minecraftReady.catch(() => {});
  }

  recordStage(stage, detail = {}) {
    const record = { stage, at: Date.now(), ...detail };
    this.stages.push(record);
    if (this.stages.length > 16) this.stages.shift();
    console.log(JSON.stringify({ liveDelivery: record }));
    this.sendBrowser({ type: 'diagnostic', stages: [record] });
  }
}
