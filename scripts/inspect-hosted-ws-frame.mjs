import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const local = process.env.LOCAL_WS_INSPECT === '1';
const host = local ? '127.0.0.1' : 'craftmatic.click';
const port = local ? 19135 : 443;
let path = '/';
{
  const origin = local ? `http://${host}:${port}` : `https://${host}`;
  const created = await fetch(`${origin}/connect`, { method: 'POST' });
  if (!created.ok) throw new Error(`session HTTP ${created.status}`);
  const session = await created.json();
  path = new URL(session.minecraftUrl).pathname;
}
const key = crypto.randomBytes(16).toString('base64');
const request = [
  `GET ${path} HTTP/1.1`,
  `Host: ${host}${local ? `:${port}` : ''}`,
  'Connection: Upgrade',
  'Upgrade: websocket',
  `Sec-WebSocket-Key: ${key}`,
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Protocol: com.microsoft.minecraft.wsencrypt',
  'Accept-Encoding: gzip',
  '', '',
].join('\r\n');

const bytes = await new Promise((resolve, reject) => {
  const socket = local
    ? net.connect(port, host, () => socket.write(request))
    : tls.connect({ port, host, servername: host }, () => socket.write(request));
  let buffered = Buffer.alloc(0);
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('timed out')); }, 5000);
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    const split = buffered.indexOf('\r\n\r\n');
    if (split < 0 || buffered.length < split + 8) return;
    const frame = parseFrame(buffered.subarray(split + 4));
    if (!frame) return;
    clearTimeout(timer);
    socket.destroy();
    const headers = buffered.subarray(0, split).toString().split('\r\n');
    const message = JSON.parse(frame.payload.toString('utf8'));
    const command = message.body?.commandLine ?? '';
    resolve({
      status: headers[0],
      responseHeaders: headers.slice(1).filter(h => /^(upgrade|connection|sec-websocket)/i.test(h)),
      frame: { fin: frame.fin, rsv: frame.rsv, opcode: frame.opcode, masked: frame.masked, bytes: frame.payload.length },
      json: {
        header: message.header,
        commandPattern: command.replace(/"[^"]+"/g, value => `"<${value.length - 2} chars>"`),
        ascii: /^[\x20-\x7e]+$/.test(frame.payload.toString('latin1')),
      },
    });
  });
  socket.on('error', reject);
});
console.log(JSON.stringify(bytes, null, 2));

function parseFrame(data) {
  if (data.length < 2) return null;
  const first = data[0], second = data[1];
  let length = second & 0x7f, offset = 2;
  if (length === 126) { if (data.length < 4) return null; length = data.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (data.length < 10) return null; length = Number(data.readBigUInt64BE(2)); offset = 10; }
  const masked = !!(second & 0x80);
  const maskBytes = masked ? 4 : 0;
  if (data.length < offset + maskBytes + length) return null;
  const mask = masked ? data.subarray(offset, offset + 4) : null;
  offset += maskBytes;
  const payload = Buffer.from(data.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin: !!(first & 0x80), rsv: (first >> 4) & 7, opcode: first & 15, masked, payload };
}
