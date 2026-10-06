/**
 * What would rotated facets actually save on a real set?
 *
 * `scripts/_round_facet_probe.ts` shows the construction wins on a genuine
 * cylinder and loses on a compound part. This answers the question that
 * decides whether to wire it into the compiler at all: over a real model, how
 * many PLACEMENTS have a part that fits a round profile AND measures better
 * than its requested-grain lattice prototype, and how many cuboids would that
 * recover?  Coarser planner rungs are reported separately: beating one of
 * those is an opportunity if the planner already chose that rung, not licence
 * to replace the requested-grain prototype.
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
/** The rungs the planner may coarsen onto; they are not the requested-grain baseline. */
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
    requestedGrainDominated: boolean; requestedGrainCuboidsSaved: number;
    coarseRungs: Array<{
      grainLdu: number; cuboids: number; iou: number;
      silhouetteDominated: boolean; potentialCuboidsSaved: number;
    }>;
  }
  const rows: PartRow[] = [];
  let totalLattice = 0, requestedAfter = 0, roundPlacements = 0;

  for (const [part, count] of placements) {
    const mesh: LdrawPartMesh | null = await provider.getPartMesh(part);
    if (!mesh?.triangles.length) continue;
    const proto = cache.get(mesh, { ...quality, microcellLdu: GRAIN }, { hollow: false, decomposition: 'best-of' });
    totalLattice += proto.cuboids.length * count;

    const profile = fitRoundProfile(mesh, GRAIN);
    if (!profile) { requestedAfter += proto.cuboids.length * count; continue; }
    roundPlacements += count;

    const ref = silhouetteReference(mesh);
    const latticeIoU = proto.source === 'empty' ? 0 : silhouetteIoU(ref, proto.cuboids);
    const facetIoU = roundFacetIoU(mesh, profile, FACETS);

    // A facet candidate dominates a baseline only when it is at least as
    // faithful by this silhouette metric and uses fewer cuboids.  Requested
    // grain and coarser planner rungs are deliberately independent claims.
    const requestedGrainDominated = facetIoU >= latticeIoU && FACETS < proto.cuboids.length;
    const requestedGrainCuboidsSaved = requestedGrainDominated
      ? (proto.cuboids.length - FACETS) * count
      : 0;
    requestedAfter += (requestedGrainDominated ? FACETS : proto.cuboids.length) * count;

    const coarseRungs = COARSE_GRAINS.map(g => {
      const rp = cache.get(mesh, { ...quality, microcellLdu: g }, { hollow: false, decomposition: 'best-of' });
      const iou = rp.source === 'empty' ? 0 : silhouetteIoU(ref, rp.cuboids);
      const silhouetteDominated = facetIoU >= iou && FACETS < rp.cuboids.length;
      return {
        grainLdu: g,
        cuboids: rp.cuboids.length,
        iou: Math.round(iou * 10000) / 10000,
        silhouetteDominated,
        potentialCuboidsSaved: silhouetteDominated ? (rp.cuboids.length - FACETS) * count : 0,
      };
    });

    rows.push({
      part, placements: count, latticeCuboids: proto.cuboids.length,
      latticeIoU: Math.round(latticeIoU * 10000) / 10000,
      facets: FACETS, facetIoU: Math.round(facetIoU * 10000) / 10000,
      axis: profile.axis, radiusLdu: Math.round(profile.radiusLdu * 10) / 10,
      discAgreement: profile.discAgreement, requestedGrainDominated,
      requestedGrainCuboidsSaved, coarseRungs,
    });
  }

  rows.sort((a, b) => {
    const aCoarse = Math.max(0, ...a.coarseRungs.map(r => r.potentialCuboidsSaved));
    const bCoarse = Math.max(0, ...b.coarseRungs.map(r => r.potentialCuboidsSaved));
    return b.requestedGrainCuboidsSaved - a.requestedGrainCuboidsSaved || bCoarse - aCoarse;
  });
  const requestedCandidates = rows.filter(r => r.requestedGrainDominated);
  const coarseCandidates = rows.filter(r => r.coarseRungs.some(g => g.silhouetteDominated));
  const coarseRungSummary = COARSE_GRAINS.map(grainLdu => {
    const candidates = rows.flatMap(row => {
      const rung = row.coarseRungs.find(r => r.grainLdu === grainLdu);
      return rung?.silhouetteDominated ? [{ row, rung }] : [];
    });
    const candidateCuboidsBefore = candidates.reduce((sum, { row, rung }) => sum + rung.cuboids * row.placements, 0);
    const candidateCuboidsAfter = candidates.reduce((sum, { row }) => sum + row.facets * row.placements, 0);
    return {
      grainLdu,
      candidateParts: candidates.length,
      candidatePlacements: candidates.reduce((sum, { row }) => sum + row.placements, 0),
      candidateCuboidsBefore,
      candidateCuboidsAfter,
      potentialSavings: candidateCuboidsBefore - candidateCuboidsAfter,
    };
  });
  const requestedSavings = totalLattice - requestedAfter;
  const stem = basename(file).replace(/\.(ldr|mpd|io|lxf)$/i, '');
  mkdirSync('output/round-facet-yield', { recursive: true });
  writeFileSync(`output/round-facet-yield/${stem}.json`, JSON.stringify({
    file, facets: FACETS, grainLdu: GRAIN,
    caveat: 'Silhouette-only candidates; topology and colour/material preservation are not validated.',
    totalPlacements: doc.bricks.length, roundPlacements,
    requestedGrain: {
      candidateParts: requestedCandidates.length,
      candidatePlacements: requestedCandidates.reduce((sum, row) => sum + row.placements, 0),
      cuboidsBefore: totalLattice,
      hypotheticalCuboidsAfter: requestedAfter,
      potentialSavings: requestedSavings,
      potentialSavingsPercent: 100 * requestedSavings / Math.max(1, totalLattice),
    },
    coarseRungCandidates: {
      uniqueParts: coarseCandidates.length,
      uniquePlacements: coarseCandidates.reduce((sum, row) => sum + row.placements, 0),
      byGrain: coarseRungSummary,
    },
    rows,
  }, null, 1));

  console.log(`${stem}  (${doc.bricks.length} placements, ${FACETS} facets at ${GRAIN} LDU)`);
  console.log(`  round-profile placements: ${roundPlacements}`);
  console.log(`  requested-grain silhouette dominance: ${requestedCandidates.length} parts, ${requestedCandidates.reduce((sum, row) => sum + row.placements, 0)} placements`);
  console.log(`  requested-grain hypothetical cuboids ${totalLattice} -> ${requestedAfter}  (potential ${requestedSavings}, ${(100 * requestedSavings / Math.max(1, totalLattice)).toFixed(2)}%)`);
  console.log('  coarse-rung potential (candidate subset only; not comparable to the requested-grain total):');
  for (const rung of coarseRungSummary) {
    console.log(`    ${rung.grainLdu} LDU: ${rung.candidateParts} parts, ${rung.candidatePlacements} placements, candidate cuboids ${rung.candidateCuboidsBefore} -> ${rung.candidateCuboidsAfter} (potential ${rung.potentialSavings})`);
  }
  console.log('  CAVEAT: silhouette only; topology and colour/material preservation are not validated.');
  for (const r of rows.slice(0, 8)) {
    const rung = r.coarseRungs.map(x => `${x.grainLdu}LDU ${x.cuboids}@${x.iou.toFixed(3)}${x.silhouetteDominated ? ` (-${x.potentialCuboidsSaved})` : ''}`).join('  ');
    const verdict = r.requestedGrainDominated ? 'fine-dom' : r.coarseRungs.some(x => x.silhouetteDominated) ? 'coarse-only' : 'no-dom';
    console.log(`    ${verdict.padEnd(11)} ${r.part.padEnd(24)} x${String(r.placements).padStart(4)}  requested ${String(r.latticeCuboids).padStart(4)}@${r.latticeIoU.toFixed(3)}  facets ${r.facets}@${r.facetIoU.toFixed(3)}  saved ${r.requestedGrainCuboidsSaved}  | ${rung}`);
  }
}
