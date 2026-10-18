/**
 * Would ROTATED facets beat axis-aligned microcells on round parts?
 *
 * The project's own ladder says axis-aligned voxels are at their asymptote on
 * 10303: uniform 4 LDU is 50.9k cuboids at IoU 0.949, 2 LDU is 142k at 0.967,
 * 1 LDU is 316k at 0.977 — 2.2x the cuboids for +0.010. The residual is
 * round-vs-square error that no grain removes, which is why round bricks read
 * as squares up close. `studCuboids` already answers this for STUDS: `facets`
 * equal rectangles fanned about the axis, each spanning the disc's diameter,
 * giving a 4*facets-sided outline from `facets` cuboids.
 *
 * This measures that construction against the real thing before any of it is
 * built into the compiler. It also reports the shared preflight decision at
 * each grain, including topology, material, count and per-view fidelity gates.
 *
 * Both sides are rasterised through `silhouetteReference`, so the comparison
 * uses the SAME rule as the planner's own metric. The fanned union spans the
 * full diameter along each rectangle's length, so it shares the part's bounding
 * box and therefore its raster resolution — the bitmaps are comparable pixel
 * for pixel.
 *
 * Usage: bun scripts/_round_facet_probe.ts [part…]
 * Output: output/round-facet-probe.json (gitignored `output/`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { createPrototypeCache, resolveEntityQuality, silhouetteIoU, silhouetteReference } from '../web/src/engine/ldraw-part-prototype.ts';
import { selectRoundFacetCandidate } from '../web/src/engine/ldraw-round-facets.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

/** Round moulds the complaint names. The shared profile supplies the measured axis. */
const DEFAULT_PARTS: ReadonlyArray<readonly [string, string]> = [
  ['3062b', 'Brick 1 x 1 Round'],
  ['4073', 'Plate 1 x 1 Round'],
  ['3941', 'Brick 2 x 2 Round'],
  ['6143', 'Brick 2 x 2 Round (open stud)'],
  ['85861', 'Plate 1 x 1 Round with Open Stud'],
  ['3957', 'Antenna 4H'],
  ['24869', 'Wheels Roller Coaster'],
];

const FACET_COUNTS = [2, 3, 4, 6];
const GRAINS = [2, 4, 8];

const parts = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = parts.length
  ? parts.map(p => [p, ''] as const)
  : DEFAULT_PARTS;

const provider = createPartGeometryProvider({});
const cache = createPrototypeCache();
const base = resolveEntityQuality('balanced');
const rows: unknown[] = [];

console.log('part      label                          voxel (cuboids @ IoU)                    facets (cuboids @ IoU)');
for (const [part, label] of targets) {
  const mesh = await provider.getPartMesh(`${part}.dat`);
  if (!mesh?.triangles.length) { console.log(`${part.padEnd(10)}unresolved`); continue; }
  const ref = silhouetteReference(mesh);

  const voxel: Record<string, { cuboids: number; iou: number }> = {};
  const prototypes = new Map<number, ReturnType<typeof cache.get>>();
  for (const grain of GRAINS) {
    const proto = cache.get(mesh, { ...base, microcellLdu: grain }, { hollow: false, decomposition: 'best-of' });
    prototypes.set(grain, proto);
    voxel[String(grain)] = { cuboids: proto.cuboids.length, iou: +silhouetteIoU(ref, proto.cuboids).toFixed(4) };
  }

  const facets: Record<string, { cuboids: number; iou: number | null; acceptedAtGrains: number[]; rejectionReasonsByGrain: Record<string, string[]> }> = {};
  let profileAxis: number | null = null;
  for (const k of FACET_COUNTS) {
    const decisions = GRAINS.map(grain => ({ grain, decision: selectRoundFacetCandidate(mesh, prototypes.get(grain)!, { facets: k }) }));
    const measured = decisions.find(entry => entry.decision.measurement)?.decision.measurement;
    profileAxis ??= measured?.profile.axis ?? null;
    facets[String(k)] = {
      cuboids: k,
      iou: measured ? +(measured.candidateViewIoU.reduce((sum, value) => sum + value, 0) / measured.candidateViewIoU.length).toFixed(4) : null,
      acceptedAtGrains: decisions.filter(entry => entry.decision.accepted).map(entry => entry.grain),
      rejectionReasonsByGrain: Object.fromEntries(decisions.map(entry => [String(entry.grain), [...entry.decision.reasons]])),
    };
  }

  rows.push({ part, label, profileAxis, voxel, facets });
  const vs = GRAINS.map(g => `${String(voxel[String(g)]!.cuboids).padStart(4)}@${voxel[String(g)]!.iou.toFixed(3)}`).join(' ');
  const fs = FACET_COUNTS.map(k => {
    const candidate = facets[String(k)]!;
    const accepted = candidate.acceptedAtGrains.length ? ` ok:${candidate.acceptedAtGrains.join('/')}` : ' rejected';
    const score = candidate.iou === null ? 'n/a' : candidate.iou.toFixed(3);
    const notRound = Object.values(candidate.rejectionReasonsByGrain).every(reasons => reasons.includes('not-round')) ? ' not-round' : accepted;
    return `${String(k).padStart(2)}@${score}${notRound}`;
  }).join(' ');
  console.log(`${part.padEnd(10)}${label.slice(0, 30).padEnd(31)}${vs}    ${fs}`);
}

mkdirSync('output', { recursive: true });
writeFileSync('output/round-facet-probe.json', JSON.stringify({ grains: GRAINS, facetCounts: FACET_COUNTS, rows }, null, 1));
console.log('\nvoxel columns are 2/4/8 LDU; facet columns are 2/3/4/6 rotated boxes followed by the grains where the shared preflight accepts them.');
console.log('wrote output/round-facet-probe.json');
