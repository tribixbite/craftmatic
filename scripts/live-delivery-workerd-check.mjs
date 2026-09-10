import { createRequire } from 'node:module';
import {
  createCipheriv, createDecipheriv, createHash, createPublicKey,
  diffieHellman, generateKeyPairSync,
} from 'node:crypto';
import { checksum } from '../web/src/engine/hotschem/live-import.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const base = process.env.CRAFTMATIC_WORKER_URL || 'http://127.0.0.1:8787';
const session = await (await fetch(`${base}/connect`, { method: 'POST' })).json();
const localWs = remote => `${base.replace(/^http/, 'ws')}${new URL(remote).pathname}`;
const received = new Map();
let expected = 0;

const minecraft = new WebSocket(localWs(session.minecraftUrl), 'com.microsoft.minecraft.wsencrypt');
let encrypt = null;
let decrypt = null;
minecraft.on('message', (wire, binary) => {
  const bytes = binary && decrypt ? decrypt.update(wire) : wire;
  let message;
  try { message = JSON.parse(bytes.toString()); }
  catch (error) { console.error('minecraft decode failed', { binary, hex: Buffer.from(bytes).subarray(0, 32).toString('hex') }); throw error; }
  const { requestId } = message.header;
  const line = message.body.commandLine;
  const respond = body => {
    const reply = Buffer.from(JSON.stringify({
      header: { version: 17104896, requestId, messagePurpose: 'commandResponse' }, body,
    }));
    minecraft.send(encrypt ? encrypt.update(reply) : reply.toString(), { binary: !!encrypt });
  };
  if (line.startsWith('enableencryption ')) {
    const [public64, salt64] = [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const pair = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64').replace(/=+$/, '');
    const keyReply = JSON.stringify({ header: { version: 17104896, requestId, messagePurpose: 'ws:encrypt' }, body: { publicKey } });
    minecraft.send(keyReply);
    let shared = diffieHellman({ privateKey: pair.privateKey, publicKey: createPublicKey({ key: Buffer.from(public64, 'base64'), type: 'spki', format: 'der' }) });
    while (shared.length > 1 && shared[0] === 0) shared = shared.subarray(1);
    const secret = createHash('sha256').update(Buffer.from(salt64, 'base64')).update(shared).digest();
    encrypt = createCipheriv('aes-256-cfb8', secret, secret.subarray(0, 16));
    decrypt = createDecipheriv('aes-256-cfb8', secret, secret.subarray(0, 16));
    return;
  }
  if (line === 'getlocalplayername') return respond({ statusCode: 0, localplayername: 'WorkerdCheck' });
  const part = /HS1:([a-f0-9]{8}):(\d+):(\d+):([A-Za-z0-9_-]+)/.exec(line);
  if (part) { expected = Number(part[3]); received.set(Number(part[2]), part[4]); return respond({ statusCode: 0 }); }
  if (line.includes('tag=hs_stream_v1')) return respond({ statusCode: 0 });
  if (line.includes('tag=hs_error_')) return respond({ statusCode: 1 });
  if (line.includes('tag=hs_ready_')) return respond({ statusCode: received.size === expected ? 0 : 1 });
  return respond({ statusCode: 0 });
});
await new Promise((resolve, reject) => { minecraft.once('open', resolve); minecraft.once('error', reject); });

const browser = new WebSocket(localWs(session.browserUrl));
await new Promise((resolve, reject) => { browser.once('open', resolve); browser.once('error', reject); });
browser.send(JSON.stringify({ type: 'auth', token: session.browserToken }));
await waitFor(browser, m => m.type === 'authenticated');
const encoded = 'AbCd_09-'.repeat(91);
browser.send(JSON.stringify({ type: 'import', encoded, checksum: checksum(encoded) }));
const completed = await waitFor(browser, m => m.type === 'complete' || m.type === 'error', 15000);
if (completed.type !== 'complete') throw new Error(JSON.stringify(completed));
if ([...received.keys()].some((n, i) => n !== i + 1)) throw new Error('HS1 indices were not one-based and contiguous');
console.log(JSON.stringify({ ok: true, player: completed.player, chunks: completed.chunks, crypto: 'P-384/AES-256-CFB8 in workerd' }));
browser.close();
minecraft.close();

function waitFor(ws, predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out')); }, timeout);
    const onMessage = raw => { const value = JSON.parse(raw.toString()); if (predicate(value)) { cleanup(); resolve(value); } };
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); };
    ws.on('message', onMessage);
  });
}
