/**
 * Run the BRICK-BUILT hinge detector (`engine/brick-hinges.ts`) on LDraw
 * sources without building a pack: every joint line it cut, what came away,
 * what it became and why the rest did not move. The fast loop for a rule
 * change; the pack's own report (`interactivity.hinges` in the diagnostics,
 * `_ix_audit_report.ts`) is the final word.
 *
 * Usage: bun scripts/_ix_hinges.ts <model.ldr|.mpd>... [--list=<file>] [--all] [--crops=<dir>]
 *   --all    list every joint line, not only the ones that move
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseLDrawDocument, embeddedPartTexts } from '../web/src/engine/ldraw-parser.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';
import { discoverInteractives } from '../web/src/engine/bedrock-interactives.ts';
import { discoverBrickHinges } from '../web/src/engine/brick-hinges.ts';
import { withClassifiedDescriptions } from '../web/src/engine/ldraw-part-geometry.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const all = process.argv.includes('--all');
// --crops=<dir>: per moving assembly, an .ldr of it in red inside its surroundings in grey (render with _shoot_set.mjs).
const crops = process.argv.find(a => a.startsWith('--crops='))?.slice(8);
const CROP_PAD = 100;
// --list=<file>: one `<set> <path>` or `<path>` per line (the favourites' first picks); LDraw text only.
const listArg = process.argv.find(a => a.startsWith('--list='))?.slice(7);
const listed = listArg ? readFileSync(listArg, 'utf8').split(/\r?\n/).map(l => l.trim().replace(/^\d+\s+(?=[A-Za-z]:|\/)/, '')).filter(p => /\.(ldr|mpd|dat)$/i.test(p)) : [];
for (const file of [...process.argv.slice(2).filter(a => !a.startsWith('--')), ...listed]) {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  seedDatTexts(embeddedPartTexts(doc));
  const scene = await discoverSceneActors(doc.bricks);
  const meshes = withClassifiedDescriptions(scene.meshes);
  const scenery = doc.bricks.filter(b => !scene.figureBricks.has(b));
  const moulded = discoverInteractives(scenery, meshes, { max: Number.MAX_SAFE_INTEGER });
  const taken = new Set([...moulded.items.flatMap(it => it.bricks), ...scene.seats.flatMap(s => (s.brick ? [s.brick] : []))]);
  const t0 = Date.now();
  const found = discoverBrickHinges({ bricks: scenery, meshOf: b => { const m = meshes.get(b.part); return m && m.triangles.length ? m : null; }, taken });
  const tally = new Map<string, number>();
  for (const l of found.lines) tally.set(l.verdict, (tally.get(l.verdict) ?? 0) + 1);
  console.log(`== ${basename(file)}: ${found.lines.length} joint lines ${JSON.stringify(Object.fromEntries(tally))}, ${found.items.length} moving (${Date.now() - t0} ms)`);
  found.items.forEach((it, k) => {
    const b = it.boundsLdu;
    console.log(`  ${it.kind.padEnd(8)} ${it.description}  angle ${it.angleDeg}${it.sweep ? `  sweep ${it.sweep.chosen}/${it.sweep.other}` : ""}  box [${b.min.map(v => Math.round(v))}]..[${b.max.map(v => Math.round(v))}]${it.openingLdu ? `  opening ${Math.round(it.openingLdu.width)} x ${Math.round(it.openingLdu.height)}` : ''}`);
    if (!crops) return;
    // A review file: what moves in red, everything within `CROP_PAD` of it in light grey.
    const moving = new Set(it.bricks);
    const lines = [`0 ${basename(file)} ${it.description}`, `0 Name: ${basename(file).replace(/\.\w+$/, '')}-${k + 1}.ldr`];
    for (const p of scenery) {
      const near = [0, 1, 2].every(i => [p.x, p.y, p.z][i]! >= b.min[i]! - CROP_PAD && [p.x, p.y, p.z][i]! <= b.max[i]! + CROP_PAD);
      if (!near && !moving.has(p)) continue;
      lines.push(`1 ${moving.has(p) ? 4 : 71} ${p.x} ${p.y} ${p.z} ${(p.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).join(' ')} ${p.part}`);
    }
    mkdirSync(crops, { recursive: true });
    writeFileSync(join(crops, `${basename(file).replace(/\.\w+$/, '')}-${k + 1}-${it.kind}.ldr`), lines.join('\n') + '\n');
  });
  if (all) for (const l of found.lines) if (l.verdict !== 'moves') console.log(`  - ${l.verdict.padEnd(9)} ${l.joint} at [${l.at}] ${l.parts ? `(${l.parts} parts) ` : ''}${l.reason}`);
}
