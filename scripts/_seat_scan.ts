/**
 * List every seat `discoverSceneActors` finds in LDraw sources - moulded
 * seats and brick-built stools - with the seat surface, the parts in a
 * stool's column and the part a stool faces. The review surface for the
 * stool detector (`brickBuiltStools`): read the columns before trusting a
 * count.
 *
 * Usage: bun scripts/_seat_scan.ts <model.ldr|.mpd>... | --sweep <summary.json> [--why]   (--why: every 2 x 2 tile the detector looked at, and why it is or is not a stool)
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseLDrawDocument, embeddedPartTexts } from '../web/src/engine/ldraw-parser.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { brickBuiltFurniture, brickBuiltStools, discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const why = process.argv.includes('--why');
const args = process.argv.slice(2).filter(a => a !== '--why');
// `--sweep <summary.json>`: every LDraw first pick a favourites sweep exported (`_favorites_export_sweep.ts`).
const sweepAt = args.indexOf('--sweep');
const files = sweepAt >= 0
  ? (JSON.parse(readFileSync(args[sweepAt + 1]!, 'utf8')).rows as Array<{ path: string }>).map(r => `C:/git/clego/lego_sets/${r.path}`).filter(f => /\.(ldr|mpd)$/i.test(f))
  : args;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const doc = parseLDrawDocument(text);
  seedDatTexts(embeddedPartTexts(doc));
  const scene = await discoverSceneActors(doc.bricks);
  const stools = scene.seats.filter(s => s.part === 'stool');
  if (why) for (const fn of [brickBuiltStools, brickBuiltFurniture]) fn(doc.bricks, scene.meshes, scene.figureBricks, (b, v) => console.log(`  why ${b.part}@${[b.x, b.y, b.z].map(q => Math.round(q)).join(',')}/c${b.color}: ${v}`));
  console.log(`${basename(file)}: ${scene.seats.length} seats (${stools.length} brick-built stools), ground ${scene.groundLdu}`);
  for (const s of scene.seats) {
    const [x, y, z] = s.surfaceLdu;
    const brickBuilt = ['stool', 'bench', 'chair', 'bed'].includes(s.part);
    const column = brickBuilt
      ? doc.bricks.filter(b => Math.abs(b.x - x) <= 20 && Math.abs(b.z - z) <= 20 && b.y >= y - 1 && b.y <= y + 40).map(b => `${b.part.replace(/\.dat$/i, '')}@${Math.round(b.y)}/c${b.color}`).join(' ')
      : '';
    console.log(`  ${s.part.padEnd(8)} surface ${[x, y, z].map(v => v.toFixed(1)).join(', ')} facing ${s.facingLdu.map(v => v.toFixed(2)).join(',')}${column ? `  column ${column}` : ''}`);
  }
}
