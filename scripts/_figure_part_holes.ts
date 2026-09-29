/**
 * Holes a figure part's COMPILE punches through it: per distinct figure part
 * of the given sources, its prototype (the compile the figure entity uses:
 * figure grain, surface-preserving for headwear) is rasterised from 26
 * directions beside the part's own LDraw triangles, in the part's own frame.
 * A pixel inside the cuboids' silhouette that no cuboid covers (an enclosed
 * miss: see-through) but the mould's triangles DO cover is a hole the compile
 * made; a through-hole the mould itself has (a hand's clip) is not counted.
 *
 * Pose-independent: a part is rigid on its bone, so a hole here shows in
 * every pose. Joint and cull holes (between bones) are `_figure_holes.ts`'s.
 *
 * Usage: bun scripts/_figure_part_holes.ts <source.ldr|.mpd>... [--px=0.5] [--min=2]
 *          [--preserve=all|headwear] [--json=<out>]
 *   --min: smallest hole reported, LDU².
 *   --preserve=all: compile EVERY part surface-preserving (the candidate fix), to compare.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';
import { assembleMinifig } from '../web/src/engine/minifig-rig.ts';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.ts';
import { partCompileHoles, figurePartPrototype } from '../web/src/engine/figure-holes.ts';

const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const px = Number(opt('px') ?? 0.5);
const minArea = Number(opt('min') ?? 2);
const preserveAll = opt('preserve') === 'all';
const jsonOut = opt('json');
const files = argv.filter(a => !a.startsWith('--'));

interface PartRow { part: string; slot: string; description: string; sets: Set<string>; placements: number; mesh: LdrawPartMesh }
const parts = new Map<string, PartRow>();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  seedDatTexts([...embeddedPartTexts(doc)]);
  const bricks: ParsedBrick[] = doc.bricks;
  const scene = await discoverSceneActors(bricks, createPartGeometryProvider());
  const set = basename(file).replace(/\.(ldr|mpd)$/i, '');
  for (const f of scene.figures) {
    const a = assembleMinifig(f.bricks, scene.meshes);
    const provider = createPartGeometryProvider();
    for (let i = 0; i < a.bricks.length; i++) {
      const b = a.bricks[i]!;
      if (resolveLdrawEntityMaterial(b.color).alpha < 1) continue;
      const mesh = scene.meshes.get(b.part) ?? await provider.getPartMesh(b.part);
      if (!mesh || !mesh.triangles.length) continue;
      const slot = a.slots[i] ?? '?';
      const key = `${mesh.partId}|${slot === 'headwear' ? 'p' : 'm'}`;
      const row = parts.get(key) ?? { part: mesh.partId, slot, description: mesh.description, sets: new Set<string>(), placements: 0, mesh };
      row.sets.add(set); row.placements++;
      parts.set(key, row);
    }
  }
  console.error(`${set}: ${scene.figures.length} figures, ${parts.size} distinct parts so far`);
}

const out: unknown[] = [];
let holed = 0, holedPlacements = 0, placements = 0;
for (const row of [...parts.values()].sort((a, b) => a.part.localeCompare(b.part))) {
  const proto = figurePartPrototype(row.mesh, preserveAll || row.slot === 'headwear');
  const res = partCompileHoles(row.mesh, proto.cuboids, { pixel: px, minArea });
  placements += row.placements;
  if (res.holes.length) { holed++; holedPlacements += row.placements; }
  const worst = res.holes.reduce((m, h) => Math.max(m, h.area), 0);
  const line = `${row.part.padEnd(14)} ${row.slot.padEnd(10)} cubes ${String(proto.cuboids.length).padStart(4)}  holes ${String(res.holes.length).padStart(3)}  worst ${worst.toFixed(1).padStart(6)} LDU²  x${row.placements} in ${[...row.sets].join(',')}  ${row.description.slice(0, 48)}`;
  if (res.holes.length) console.log(line);
  out.push({ part: row.part, slot: row.slot, description: row.description, sets: [...row.sets], placements: row.placements, cubes: proto.cuboids.length, holes: res.holes });
}
console.log(`distinct figure parts ${parts.size} (${placements} placements); with compile holes ${holed} (${holedPlacements} placements)`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
