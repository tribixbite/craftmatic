/**
 * Per-set feasibility of the CUSTOM-BLOCK consumer for a resident part library.
 *
 * The 2026-09-19 audit priced the block route on corpus-wide permutation
 * counts. A per-set pack only declares what ITS placements use, so this
 * measures, on the two cached full placement manifests (71043 in
 * corpus-part-census-ids.json, 10307 in corpus-part-census-10307.json):
 *
 *   - aligned share (signed-permutation rotation matrices);
 *   - permutations a per-set block pack needs when colour + rotation are one
 *     "variant" state per part block (distinct (part, rotation, colour) triples);
 *   - the same with the origin's sub-block offset quantised to 1/16 block and
 *     baked into the variant via `minecraft:transformation.translation`;
 *   - the 30x30x30 px block-geometry bound at the export scale;
 *   - BLOCK-CELL OCCUPANCY: a block cell holds one block, so two parts whose
 *     origins fall in the same cell cannot both be blocks. Reported at three
 *     model scales.
 *
 * Run from C:/git/craftmatic:  bun scripts/block-route-per-set.ts
 * Writes output/master-addon-audit/block-route-per-set.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.ts';

const D = 'output/master-addon-audit/';
interface Placement { part: string; color: number; x: number; y: number; z: number; rot: number[] | null }
const readJson = <T,>(f: string): T => JSON.parse(readFileSync(D + f, 'utf8')) as T;
const bounds = readJson<Record<string, { ext: [number, number, number] }>>('part-bounds.json');
const manifests: Record<string, Placement[]> = {
  '71043': readJson<{ manifest: { placements: Placement[] } }>('corpus-part-census-ids.json').manifest.placements,
  '10307': readJson<{ manifest: { placements: Placement[] } }>('corpus-part-census-10307.json').manifest.placements,
};

/** True when a 3x3 matrix is a signed permutation (one of the 48 axis-aligned rotations/reflections). */
const isAligned = (rot: number[] | null, tol = 0.01): boolean => {
  if (!rot) return true;
  for (let r = 0; r < 3; r++) {
    let ones = 0;
    for (let c = 0; c < 3; c++) { const v = Math.abs(rot[r * 3 + c]!); if (Math.abs(v - 1) < tol) ones++; else if (v > tol) return false; }
    if (ones !== 1) return false;
  }
  return true;
};
const rotCode = (rot: number[] | null): string => rot ? rot.map(v => Math.abs(v) < 0.01 ? '0' : v > 0 ? '+' : '-').join('') : 'I';
const BLOCK_PX = 16, BOUND_PX = 30;

const out: Record<string, unknown> = { lduPerBlockAtScale1: LDU_PER_BLOCK };
for (const [setId, placements] of Object.entries(manifests)) {
  const aligned = placements.filter(p => isAligned(p.rot));
  const triples = new Set(aligned.map(p => `${p.part}|${rotCode(p.rot)}|${p.color}`));
  const pairs = new Set(placements.map(p => `${p.part}|${p.color}`));
  const parts = new Set(placements.map(p => p.part));
  const colours = new Set(placements.map(p => p.color));
  const rotations = new Set(aligned.map(p => rotCode(p.rot)));
  const report: Record<string, unknown> = {
    placements: placements.length, distinctParts: parts.size, colours: colours.size, pairs: pairs.size,
    aligned: aligned.length, alignedShare: +(aligned.length / placements.length).toFixed(3), alignedRotations: rotations.size,
    permutationsColourRotation: triples.size,
  };
  const scales: Record<string, unknown> = {};
  for (const modelScale of [1, 0.5, 2]) {
    const lduPerBlock = LDU_PER_BLOCK / modelScale;
    const limitLdu = lduPerBlock * BOUND_PX / BLOCK_PX;
    const fits = (part: string): boolean => { const b = bounds[part]; return !!b && b.ext.every(e => e <= limitLdu + 1e-6); };
    const fitting = placements.filter(p => fits(p.part)).length;
    const alignedFitting = aligned.filter(p => fits(p.part)).length;
    // Offset classes: origin position modulo the block, at 1/16 block.
    const q16 = (v: number): number => Math.round(((v / lduPerBlock) % 1 + 1) % 1 * 16) % 16;
    const offsetVariants = new Set(aligned.map(p => `${p.part}|${rotCode(p.rot)}|${p.color}|${q16(p.x)},${q16(p.y)},${q16(p.z)}`));
    // Cell occupancy on the placement ORIGIN (LDraw origins sit at the part's top centre) and on an estimated part centre.
    const cellOf = (p: Placement, centre: boolean): string => {
      const ext = bounds[p.part]?.ext ?? [0, 0, 0];
      // LDraw +Y is down: the body hangs below the origin, so the centre is half the height further down.
      const y = centre ? p.y + ext[1] / 2 : p.y;
      return `${Math.floor(p.x / lduPerBlock)},${Math.floor(y / lduPerBlock)},${Math.floor(p.z / lduPerBlock)}`;
    };
    const occupancy = (centre: boolean, pool: Placement[]) => {
      const cells = new Map<string, number>();
      for (const p of pool) cells.set(cellOf(p, centre), (cells.get(cellOf(p, centre)) ?? 0) + 1);
      let sole = 0, maxPerCell = 0;
      for (const n of cells.values()) { if (n === 1) sole++; if (n > maxPerCell) maxPerCell = n; }
      return { cells: cells.size, placements: pool.length, solePlacements: sole, soleShare: +(sole / Math.max(1, pool.length)).toFixed(3), maxPerCell, placementsPerCell: +(pool.length / Math.max(1, cells.size)).toFixed(2) };
    };
    scales[`scale ${modelScale} (1 block = ${lduPerBlock.toFixed(2)} LDU, bound ${limitLdu.toFixed(0)} LDU)`] = {
      placementsFittingBound: fitting, fittingShare: +(fitting / placements.length).toFixed(3),
      alignedAndFitting: alignedFitting, alignedAndFittingShare: +(alignedFitting / placements.length).toFixed(3),
      permutationsWithOffset16: offsetVariants.size,
      occupancyOrigin_all: occupancy(false, placements), occupancyCentre_all: occupancy(true, placements),
      occupancyCentre_alignedFitting: occupancy(true, aligned.filter(p => fits(p.part))),
    };
  }
  report.scales = scales;
  out[setId] = report;
  console.log(setId, JSON.stringify(report, null, 1));
}
writeFileSync(D + 'block-route-per-set.json', JSON.stringify(out, null, 1));
console.log(`-> ${D}block-route-per-set.json`);
