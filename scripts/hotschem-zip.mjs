import { deflateRawSync } from 'node:zlib';
function crc(b) { let c = 0xffffffff; for (const v of b) { c ^= v; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
export function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), b = Buffer.from(data), d = deflateRawSync(b), checksum = crc(b);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(checksum, 14); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, d);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); h.copy(c, 6, 4, 30); c.writeUInt32LE(offset, 42); central.push(c, n);
    offset += h.length + n.length + d.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
