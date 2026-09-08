/** One-off: list bricks near a world point. Usage: bun scripts/_brick_near.ts <io> <x> <y> <z> [r] */
import { readFileSync } from 'node:fs';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
const [f, X, Y, Z, R] = process.argv.slice(2);
const buf = readFileSync(f!);
const io = await extractIoModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const bricks = parseLDraw(synthesizeLSynth(io.text).text);
const r = Number(R ?? 40);
for (const b of bricks) {
  if (Math.abs(b.x - Number(X)) < r && Math.abs(b.y - Number(Y)) < r && Math.abs(b.z - Number(Z)) < r)
    console.log(b.part, b.x, b.y, b.z, 'color', b.color);
}
