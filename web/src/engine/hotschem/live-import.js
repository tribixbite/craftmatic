// Portable codec: ASCII JSON + bounded LZW, no Node/browser globals in Bedrock.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const MAX_TEXT = 4 * 1048576;
export function checksum(text) { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return (h >>> 0).toString(16).padStart(8, '0'); }
export function encodeModel(model) {
  validateModel(model);
  const text = JSON.stringify(model).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (text.length > MAX_TEXT) throw Error('Model too large for clipboard import. Use the add-on download.');
  const dict = new Map(); let next = 256, phrase = '', out = '';
  const emit = n => { out += alphabet[(n >>> 12) & 15] + alphabet[(n >>> 6) & 63] + alphabet[n & 63]; };
  for (const c of text) {
    const joined = phrase + c;
    if (!phrase || dict.has(joined)) phrase = joined;
    else { emit(phrase.length === 1 ? phrase.charCodeAt(0) : dict.get(phrase)); if (next < 65536) dict.set(joined, next++); phrase = c; }
  }
  if (phrase) emit(phrase.length === 1 ? phrase.charCodeAt(0) : dict.get(phrase));
  if (out.length > MAX_TEXT) throw Error('Model too large for clipboard import. Use the add-on download.');
  return out;
}
export function decodeModel(encoded) {
  const job = decodeModelJob(encoded); let r; do { r = job.next(); } while (!r.done); return r.value;
}
export function* decodeModelJob(encoded) {
  if (!encoded || encoded.length % 3 || encoded.length > MAX_TEXT || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error('Invalid import data.');
  const dict = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)); let previous = '', text = '';
  for (let i = 0; i < encoded.length; i += 3) {
    if (i % 3072 === 0) yield;
    const n = alphabet.indexOf(encoded[i]) * 4096 + alphabet.indexOf(encoded[i + 1]) * 64 + alphabet.indexOf(encoded[i + 2]);
    const entry = dict[n] ?? (n === dict.length && previous ? previous + previous[0] : undefined);
    if (entry === undefined || text.length + entry.length > MAX_TEXT) throw Error('Invalid or oversized import.');
    text += entry;
    if (previous && dict.length < 65536) dict.push(previous + entry[0]);
    previous = entry;
  }
  const model = JSON.parse(text); validateModel(model); return model;
}
export function validateModel(m) {
  if (!m || typeof m.title !== 'string' || !m.title.length || m.title.length > 200 || /[\x00-\x1f§]/.test(m.title)) throw Error('Invalid model title.');
  if (![m.w, m.h, m.l].every(n => Number.isInteger(n) && n > 0 && n <= 4096) || m.w * m.h * m.l > 80000000) throw Error('Invalid model dimensions.');
  if (!Array.isArray(m.palette) || !m.palette.length || m.palette.length > 65535 || !Array.isArray(m.ops) || !m.ops.length || m.ops.length > 200000) throw Error('Invalid model palette/operations.');
  for (const p of m.palette) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(p[0]) || !p[1] || typeof p[1] !== 'object' || Array.isArray(p[1])) throw Error('Invalid block palette.');
    for (const [k, v] of Object.entries(p[1])) if (k.length > 100 || !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'string' && v.length > 100 || typeof v === 'number' && !Number.isFinite(v)) throw Error('Invalid block state.');
  }
  let blocks = 0;
  for (const op of m.ops) {
    if (!Array.isArray(op) || op.length !== 7 || !op.every(Number.isInteger) || op[0] < 0 || op[1] < 0 || op[2] < 0 || op[3] < op[0] || op[4] < op[1] || op[5] < op[2] || op[3] >= m.w || op[4] >= m.h || op[5] >= m.l || op[6] < 0 || op[6] >= m.palette.length) throw Error('Invalid placement operation.');
    blocks += (op[3] - op[0] + 1) * (op[4] - op[1] + 1) * (op[5] - op[2] + 1);
    if (blocks > 80000000) throw Error('Too many imported blocks.');
  }
  m.blocks = blocks; m.samples = [];
  for (let i = 0; i < m.ops.length; i += Math.max(1, Math.ceil(m.ops.length / 1024))) m.samples.push(...m.ops[i].slice(0, 3));
  return m;
}
export function makeParts(encoded, size = 8000) {
  if (!Number.isInteger(size) || size < 100 || size > 8000) throw Error('Invalid part size.');
  const id = checksum(encoded), count = Math.ceil(encoded.length / size);
  if (count > 16384) throw Error('Too many import parts. Use the add-on download.');
  return Array.from({ length: count }, (_, i) => `HS1:${id}:${i + 1}:${count}:${encoded.slice(i * size, (i + 1) * size)}`);
}
export function acceptPart(session, input, deferDecode = false) {
  const m = /^HS1:([a-f0-9]{8}):(\d+):(\d+):([A-Za-z0-9_-]{1,8000})$/.exec(input.trim());
  if (!m) throw Error('Paste the complete HS1 import part.');
  const index = Number(m[2]), count = Number(m[3]);
  if (count < 1 || count > 16384 || index < 1 || index > count) throw Error('Invalid part number.');
  if (!session) session = { id: m[1], count, parts: new Map(), size: 0 };
  if (session.id !== m[1] || session.count !== count) throw Error('Different model. Discard the current import first.');
  if (session.parts.has(index) && session.parts.get(index) !== m[4]) throw Error('Conflicting import part.');
  if (!session.parts.has(index)) { if (session.size + m[4].length > MAX_TEXT) throw Error('Import exceeds size limit.'); session.size += m[4].length; session.parts.set(index, m[4]); }
  if (session.parts.size !== count) return { session };
  const encoded = Array.from({ length: count }, (_, i) => session.parts.get(i + 1)).join('');
  if (checksum(encoded) !== session.id) throw Error('Import checksum failed. Discard and copy the parts again.');
  return { session, model: deferDecode ? undefined : decodeModel(encoded), encoded };
}
