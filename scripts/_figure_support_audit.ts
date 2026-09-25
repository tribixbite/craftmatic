/**
 * What does each figure of a source stand on, and does the shell carry it?
 *
 * For every upright figure `discoverSceneActors` finds (the same pass the
 * add-on export runs), list the placements whose TOP is within a plate of
 * the figure's feet and whose footprint overlaps the figure's legs - the part
 * it stands on - and say whose each one is: the shell's (so it becomes
 * colliders), another figure's (so it leaves the shell with that figure) or
 * the figure's own group. A figure whose support is nobody's shell part falls
 * when it is placed (the 2026-09-25 census found 16 in 5 favourites).
 *
 * Usage: bun scripts/_figure_support_audit.ts <source.ldr|.mpd|.io>... [--json=out.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';

// The same library and mirror copy as scripts/_playable_ref.ts.
const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;

type Vec3 = [number, number, number];
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) { console.error('usage: bun scripts/_figure_support_audit.ts <source>... [--json=out.json]'); process.exit(2); }

/** Legs footprint half-width around the figure centre, LDU (a minifig's hips are 20 wide, its feet 10 deep). */
const FOOT_HALF_X = 10, FOOT_HALF_Z = 8;
/** A top this close to the feet counts as the surface the figure stands on (LDU; a plate is 8). */
const SUPPORT_BAND = 6;

const out: unknown[] = [];
for (const file of files) {
  const bytes = readFileSync(file);
  let text: string;
  let custom = new Map<string, string>();
  if (/\.io$/i.test(file)) {
    const io = await extractIoModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    text = io.text; custom = io.customParts;
  } else text = bytes.toString('utf8');
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  seedDatTexts([...embeddedPartTexts(doc), ...custom]);
  const bricks: ParsedBrick[] = doc.bricks;
  const provider = createPartGeometryProvider();
  const scene = await discoverSceneActors(bricks, provider);
  const box = (b: ParsedBrick): { min: Vec3; max: Vec3 } | null => {
    const mesh = scene.meshes.get(b.part);
    if (!mesh || !mesh.triangles.length) return null;
    const R = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const lo = mesh.bounds.min, hi = mesh.bounds.max;
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const cx of [lo[0], hi[0]]) for (const cy of [lo[1], hi[1]]) for (const cz of [lo[2], hi[2]]) {
      const v: Vec3 = [R[0]! * cx + R[1]! * cy + R[2]! * cz + b.x, R[3]! * cx + R[4]! * cy + R[5]! * cz + b.y, R[6]! * cx + R[7]! * cy + R[8]! * cz + b.z];
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, v[k]!); max[k] = Math.max(max[k]!, v[k]!); }
    }
    return { min, max };
  };
  const figureOf = new Map<ParsedBrick, number>();
  scene.figures.forEach((f, k) => f.bricks.forEach(b => figureOf.set(b, k)));
  const rows = scene.figures.map((f, k) => {
    const [cx, , cz] = f.centreLdu;
    const feet = f.floorLdu; // LDraw Y is down: the feet are the body's largest y.
    const under: Array<{ part: string; desc: string; top: number; owner: string; dy: number }> = [];
    let nearestShellBelow = Infinity;
    for (const b of bricks) {
      const own = figureOf.get(b);
      if (own === k) continue;
      const bb = box(b);
      if (!bb) continue;
      if (bb.max[0] < cx - FOOT_HALF_X || bb.min[0] > cx + FOOT_HALF_X || bb.max[2] < cz - FOOT_HALF_Z || bb.min[2] > cz + FOOT_HALF_Z) continue;
      const top = bb.min[1];
      const dy = top - feet; // > 0: below the feet
      if (own === undefined && dy >= -SUPPORT_BAND) nearestShellBelow = Math.min(nearestShellBelow, dy);
      if (Math.abs(dy) > SUPPORT_BAND) continue;
      under.push({ part: b.part, desc: scene.meshes.get(b.part)?.description ?? '', top, owner: own === undefined ? 'shell' : `figure ${own + 1}`, dy: Math.round(dy * 10) / 10 });
    }
    const supported = under.some(u => u.owner === 'shell');
    return { figure: k + 1, centre: f.centreLdu.map(v => Math.round(v)), feet: Math.round(feet * 10) / 10, supported, nearestShellBelowLdu: Number.isFinite(nearestShellBelow) ? Math.round(nearestShellBelow * 10) / 10 : null, under };
  });
  console.log(`\n${basename(file)}: ${rows.length} figures, ${rows.filter(r => !r.supported).length} with no shell part under the feet`);
  for (const r of rows) {
    console.log(`  figure ${String(r.figure).padStart(2)} feet ${r.feet} ${r.supported ? 'supported' : `UNSUPPORTED (nearest shell top below: ${r.nearestShellBelowLdu ?? 'none'} LDU)`}`);
    for (const u of r.under) console.log(`      ${u.owner.padEnd(10)} ${u.part.padEnd(18)} dy ${String(u.dy).padStart(6)}  ${u.desc}`);
  }
  out.push({ file: basename(file), rows });
}
const json = flag('json');
if (json) writeFileSync(json, JSON.stringify(out, null, 1) + '\n');
