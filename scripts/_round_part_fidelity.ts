/**
 * How square does a ROUND part read, per grain?
 *
 * The standing close-up complaint is specific: at 2-5 blocks, round track
 * tubes stair-step and 2x2 round bricks read as squares. The whole-model
 * silhouette IoU cannot see that — it averages a model whose flat bricks are
 * exact. This measures the parts named in the complaint on their own, at every
 * grain the planner's ladder can put them at, so the fidelity conversation has
 * a number per part instead of an impression.
 *
 * Usage: bun scripts/_round_part_fidelity.ts [part…]
 *   Defaults to the round moulds the complaint names plus flat controls.
 * Output: output/round-part-fidelity.json (gitignored `output/`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import {
  createPrototypeCache, resolveEntityQuality, silhouetteIoU, silhouetteReference,
} from '../web/src/engine/ldraw-part-prototype.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

/** The complaint's parts, plus flat controls that should stay exact at every grain. */
const DEFAULT_PARTS: ReadonlyArray<readonly [string, string]> = [
  ['3941', 'Brick 2 x 2 Round'],
  ['3062b', 'Brick 1 x 1 Round'],
  ['4073', 'Plate 1 x 1 Round'],
  ['6143', 'Brick 2 x 2 Round (open stud)'],
  ['85861', 'Plate 1 x 1 Round with Open Stud'],
  ['3957', 'Antenna 4H'],
  ['24869', 'Wheels Roller Coaster'],
  ['26021', 'Train Base 4 x 5 Roller Coaster'],
  ['3001', 'Brick 2 x 4 (flat control)'],
  ['3024', 'Plate 1 x 1 (flat control)'],
];

const GRAINS = [2, 4, 8];
const parts = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets: ReadonlyArray<readonly [string, string]> = parts.length
  ? parts.map(p => [p, ''] as const)
  : DEFAULT_PARTS;

const provider = createPartGeometryProvider({});
const cache = createPrototypeCache();
const base = resolveEntityQuality('balanced');

interface Row {
  part: string; label: string; resolved: boolean;
  sizeLdu?: [number, number, number];
  at: Record<string, { cuboids: number; iou: number; source: string }>;
}
const rows: Row[] = [];

for (const [part, label] of targets) {
  const mesh: LdrawPartMesh | null = await provider.getPartMesh(`${part}.dat`);
  const row: Row = { part, label, resolved: Boolean(mesh?.triangles.length), at: {} };
  if (!mesh?.triangles.length) { rows.push(row); continue; }
  const { min, max } = mesh.bounds;
  row.sizeLdu = [
    Math.round((max[0] - min[0]) * 10) / 10,
    Math.round((max[1] - min[1]) * 10) / 10,
    Math.round((max[2] - min[2]) * 10) / 10,
  ];
  const ref = silhouetteReference(mesh);
  for (const grain of GRAINS) {
    const proto = cache.get(mesh, { ...base, microcellLdu: grain }, { hollow: false, decomposition: 'best-of' });
    // Always measured, never shortcut on `source`: a round part collapses to a
    // single bbox-filling cuboid at a coarse grain and is LABELLED `exact-box`,
    // which is precisely the mislabel that hid this defect from the planner.
    const iou = proto.source === 'empty' ? 0 : silhouetteIoU(ref, proto.cuboids);
    row.at[String(grain)] = { cuboids: proto.cuboids.length, iou: Math.round(iou * 10000) / 10000, source: proto.source };
  }
  rows.push(row);
}

mkdirSync('output', { recursive: true });
writeFileSync('output/round-part-fidelity.json', JSON.stringify({ grains: GRAINS, rows }, null, 1));

const head = GRAINS.map(g => `${g} LDU`.padStart(18)).join('');
console.log(`part      size LDU          ${head}   label`);
for (const row of rows) {
  if (!row.resolved) { console.log(`${row.part.padEnd(10)}unresolved`); continue; }
  const cells = GRAINS.map(g => {
    const m = row.at[String(g)]!;
    return `${String(m.cuboids).padStart(6)} @ ${m.iou.toFixed(3)}`.padStart(18);
  }).join('');
  const size = `${row.sizeLdu!.join('x')}`.padEnd(18);
  console.log(`${row.part.padEnd(10)}${size}${cells}   ${row.label}`);
}
console.log('\nwrote output/round-part-fidelity.json');
