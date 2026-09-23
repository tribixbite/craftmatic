/**
 * What would rotated facets actually save on a real set?
 *
 * `scripts/_round_facet_probe.ts` shows the construction wins on a genuine
 * cylinder and loses on a compound part. This answers the question that
 * decides whether to wire it into the compiler at all: over a real model, how
 * many PLACEMENTS have a part that fits a round profile AND measures better
 * than its lattice prototype, and how many cuboids would that recover?
 *
 * Cuboids are counted per placement (Bedrock has no in-entity instancing), so
 * the saving is (lattice cuboids - facets) * placements.
 *
 * Usage: bun scripts/_round_facet_yield.ts <model…> [--facets 4] [--grain 2]
 * Output: output/round-facet-yield/<stem>.json (gitignored `output/`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import {
  createPrototypeCache, resolveEntityQuality, silhouetteIoU, silhouetteReference,
} from '../web/src/engine/ldraw-part-prototype.ts';
import { fitRoundProfile, roundFacetIoU } from '../web/src/engine/ldraw-round-facets.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const argv = process.argv.slice(2);
const num = (flag: string, fallback: number): number => {
  const i = argv.indexOf(flag);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const FACETS = num('--facets', 4);
const GRAIN = num('--grain', 2);
/** The rungs the planner coarsens onto; facets must beat one of these to be worth taking. */
const COARSE_GRAINS = [GRAIN * 2, GRAIN * 4];
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
if (!files.length) { console.error('usage: bun scripts/_round_facet_yield.ts <model…>'); process.exit(2); }

const quality = resolveEntityQuality('balanced');

for (const file of files) {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const provider = createPartGeometryProvider({ document: doc });
  const cache = createPrototypeCache();

  const placements = new Map<string, number>();
  for (const brick of doc.bricks) placements.set(brick.part, (placements.get(brick.part) ?? 0) + 1);

  interface PartRow {
    part: string; placements: number; latticeCuboids: number; latticeIoU: number;
    facets: number; facetIoU: number; axis: number; radiusLdu: number; discAgreement: number;
    accepted: boolean; cuboidsSaved: number; rungs?: Array<{ grainLdu: number; cuboids: number; iou: number }>;
  }
  const rows: PartRow[] = [];
  let totalLattice = 0, totalAfter = 0, roundPlacements = 0, acceptedPlacements = 0;

  for (const [part, count] of placements) {
    const mesh: LdrawPartMesh | null = await provider.getPartMesh(part);
    if (!mesh?.triangles.length) continue;
    const proto = cache.get(mesh, { ...quality, microcellLdu: GRAIN }, { hollow: false, decomposition: 'best-of' });
    totalLattice += proto.cuboids.length * count;

    const profile = fitRoundProfile(mesh, GRAIN);
    if (!profile) { totalAfter += proto.cuboids.length * count; continue; }
    roundPlacements += count;

    const ref = silhouetteReference(mesh);
    const latticeIoU = proto.source === 'empty' ? 0 : silhouetteIoU(ref, proto.cuboids);
    const facetIoU = roundFacetIoU(mesh, profile, FACETS);

    // Facets do not compete with the FINEST grain — they compete with the
    // coarse rungs the budget actually forces a part onto, which are the
    // square-reading ones. The gate is domination: at least as faithful as that
    // rung AND cheaper. Never a part table, never a guess; a compound part that
    // merely looks round is refused because its facet IoU collapses.
    const rungs = COARSE_GRAINS.map(g => {
      const rp = cache.get(mesh, { ...quality, microcellLdu: g }, { hollow: false, decomposition: 'best-of' });
      const iou = rp.source === 'empty' ? 0 : silhouetteIoU(ref, rp.cuboids);
      return { grainLdu: g, cuboids: rp.cuboids.length, iou: Math.round(iou * 10000) / 10000 };
    });
    const dominated = rungs.filter(r => facetIoU >= r.iou && FACETS < r.cuboids);
    const accepted = dominated.length > 0;
    // What it saves against the COARSEST rung it beats: the rung a squeezed
    // model would otherwise have used.
    const target = dominated.length ? dominated[dominated.length - 1]! : null;
    const saved = target ? (target.cuboids - FACETS) * count : 0;
    if (accepted) acceptedPlacements += count;
    totalAfter += (accepted && target ? FACETS : proto.cuboids.length) * count;

    rows.push({
      part, placements: count, latticeCuboids: proto.cuboids.length,
      latticeIoU: Math.round(latticeIoU * 10000) / 10000,
      facets: FACETS, facetIoU: Math.round(facetIoU * 10000) / 10000,
      axis: profile.axis, radiusLdu: Math.round(profile.radiusLdu * 10) / 10,
      discAgreement: profile.discAgreement, accepted, cuboidsSaved: saved, rungs,
    });
  }

  rows.sort((a, b) => b.cuboidsSaved - a.cuboidsSaved);
  const accepted = rows.filter(r => r.accepted);
  const stem = basename(file).replace(/\.(ldr|mpd|io|lxf)$/i, '');
  mkdirSync('output/round-facet-yield', { recursive: true });
  writeFileSync(`output/round-facet-yield/${stem}.json`, JSON.stringify({
    file, facets: FACETS, grainLdu: GRAIN,
    totalPlacements: doc.bricks.length, roundPlacements, acceptedPlacements,
    cuboidsBefore: totalLattice, cuboidsAfter: totalAfter,
    saved: totalLattice - totalAfter, rows,
  }, null, 1));

  console.log(`${stem}  (${doc.bricks.length} placements, ${FACETS} facets at ${GRAIN} LDU)`);
  console.log(`  round-profile placements: ${roundPlacements}   accepted by measurement: ${acceptedPlacements}`);
  console.log(`  cuboids ${totalLattice} -> ${totalAfter}  (saved ${totalLattice - totalAfter}, ${(100 * (totalLattice - totalAfter) / Math.max(1, totalLattice)).toFixed(1)}%)`);
  console.log(`  parts fitting a profile: ${rows.length}, accepted ${accepted.length}, refused ${rows.length - accepted.length}`);
  for (const r of rows.slice(0, 8)) {
    const rung = (r.rungs ?? []).map(x => `${x.grainLdu}LDU ${x.cuboids}@${x.iou.toFixed(3)}`).join('  ');
    console.log(`    ${r.accepted ? 'take' : 'skip'} ${r.part.padEnd(24)} x${String(r.placements).padStart(4)}  fine ${String(r.latticeCuboids).padStart(4)}@${r.latticeIoU.toFixed(3)}  facets ${r.facets}@${r.facetIoU.toFixed(3)}  | ${rung}  saved ${r.cuboidsSaved}`);
  }
  for (const r of rows.filter(x => !x.accepted).slice(0, 4)) {
    console.log(`    refused ${r.part.padEnd(24)} lattice ${String(r.latticeCuboids).padStart(4)}@${r.latticeIoU.toFixed(3)} vs facets ${r.facetIoU.toFixed(3)}`);
  }
}
