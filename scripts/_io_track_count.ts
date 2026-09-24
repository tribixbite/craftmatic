/** One-off: count coaster-track mould placements in an .io archive's chosen
 * entry versus a plain LDraw file, to find placements a conversion dropped. */
import { readFileSync } from 'node:fs';
import { extractIoModel, ioEntryTexts } from '../web/src/engine/io-extractor.ts';
import { coasterTrackProfile } from '../web/src/engine/coaster-track.ts';
const counts = (text: string) => {
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 15 && p[0] === '1') {
      // Every mould coaster-track.ts can route (includes the 26022 short straight).
      const id = coasterTrackProfile(p[14]!)?.partId;
      if (id) out[id] = (out[id] ?? 0) + 1;
    }
  }
  return out;
};
const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const buf = readFileSync(process.argv[2]!);
const io = await extractIoModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const c = counts(io.text);
console.log('chosen entry', JSON.stringify(c), 'total', total(c), 'chars', io.text.length);
for (const [name, text] of await ioEntryTexts(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)) {
  const cc = counts(text);
  if (total(cc)) console.log(`entry ${name}`, JSON.stringify(cc), 'total', total(cc));
}
const other = readFileSync(process.argv[3]!, 'utf8');
const c2 = counts(other);
console.log('ldr file ', JSON.stringify(c2), 'total', total(c2));
for (const m of new Set([...Object.keys(c), ...Object.keys(c2)])) if ((c[m] ?? 0) !== (c2[m] ?? 0)) console.log(`DIFF ${m}: io=${c[m] ?? 0} ldr=${c2[m] ?? 0}`);
