/**
 * Loose SOURCE pieces lying well clear of the model, left out of a Bedrock pack (audit 2026-11-15 A-08, VIEW-02).
 *
 * Converted sources carry what the instructions' last page shows beside the build: the alternate model's parts in
 * rows (77092's `_sm01`, 352 parts up to 97.5 studs out), accessory rows (76417's 16 goblets), wand sprues that
 * stretched 76457 to 69 blocks. In a pack they are pieces on the grass, and they widen the grid, the colliders and
 * the shell for nothing. The export census (`analyseOrphans`, ldraw-entity-compiler.ts) only REPORTED them.
 *
 * The rule, decided for the user by the 2026-11-15 audit orchestrator and measured over the 40 favourites:
 *  - a connected piece (4 LDU touch, `connectedClusters`) of FEWER than `STRAY_MAX_PARTS` parts,
 *  - not part of a figure (`groupFigures`; figures stay and are left out of the clustering, so a line-up on the
 *    grass leaves as walking figures and what only touched it is judged on its own),
 *  - more than `STRAY_CLEARANCE_LDU` (8 studs) of clear air from the MAIN body (pieces of `MAIN_MIN_PARTS` /
 *    `MAIN_MIN_SHARE`, as the census counts a sub-build),
 * is dropped, and the export names every dropped piece in a warning. Everything else stays: the main body
 * (pieces of `SUB_BUILD`-size), a substantial sub-build beside it, figures and what lies near them.
 * Nothing is dropped from a model with no main body at all (every piece small: a loose parts pile is the model).
 *
 * The 30-part line, from the far (> 8 studs) pieces the favourites' census named on sweep 4e5963dc: 1-26 parts are
 * debris rows (77092's alternate-build sub-assemblies of 8-26 parts, 76417's 16 goblets, 41703's 14-20-part loose
 * bits, 71043's six 7-part boats); 36-52 parts are small builds a player would miss (41703's 36, 71043's 45,
 * 42663's 46, 10365's 46-part rigging piece, 75397's 52-part skiff).
 */
import type { ParsedBrick } from './ldraw-parser.js';
import type { PartGeometryProvider, Vec3 } from './ldraw-part-geometry.js';
import { partStem } from './part-id.js';
import { connectedClusters, groupFigures, placementWorldBox } from './ldraw-entity-compiler.js';

/** A piece of this many parts or more is a sub-build and always stays. */
export const STRAY_MAX_PARTS = 30;
/** Clear air (LDU) from everything kept beyond which a small piece is debris: 8 studs. */
export const STRAY_CLEARANCE_LDU = 160;
/** The main body: a piece at least this big (or this share of the model) anchors what stays (`analyseOrphans`'s rule). */
const MAIN_MIN_PARTS = 200, MAIN_MIN_SHARE = 0.05;

export interface StrayFragment {
  /** Indices into the boxes / bricks given. */
  indices: number[];
  /** Clear air to the nearest kept part, LDU. */
  clearanceLdu: number;
  /** Mean of the parts' box centres, LDU in the source frame. */
  centreLdu: Vec3;
}

/** Squared gap between two boxes, 0 when they touch or overlap. */
function gapSquared(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): number {
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const gap = Math.max(0, b.min[axis]! - a.max[axis]!, a.min[axis]! - b.max[axis]!);
    squared += gap * gap;
  }
  return squared;
}

/**
 * The pieces to leave out, given each placement's world box and whether it belongs to a FIGURE (`groupFigures`: a
 * torso and the head, limbs, hair and held items around it). Figure placements always stay (a line-up on the grass
 * leaves as walking figures) and are left out of the clustering, so what merely touches a figure (76457's wand
 * sprues lying across its figure row) is judged as the loose piece it becomes once the figure walks off. Pure: the
 * export (`withoutStrayFragments`) supplies the boxes and the figure groups.
 */
export function findStrayFragments(boxes: ReadonlyArray<{ min: Vec3; max: Vec3 }>, figureMember: readonly boolean[]): { dropped: StrayFragment[] } {
  const rest = boxes.map((_, i) => i).filter(i => !figureMember[i]);
  const groups = connectedClusters(rest.map(i => boxes[i]!) as Array<{ min: Vec3; max: Vec3 }>).map(g => g.map(k => rest[k]!));
  const mainMin = Math.max(MAIN_MIN_PARTS, rest.length * MAIN_MIN_SHARE);
  if (!groups.some(g => g.length >= mainMin)) return { dropped: [] };
  // Clearance from the MAIN body only. Measured against everything kept (2026-11-15, first cut), loose pieces
  // chained to each other and through figure rows: 77092's alternate-build field (146 pieces, 318 parts, up to
  // 97.5 studs out) and 76457's wands each lay within 8 studs of the next, and nothing was dropped.
  const main = groups.filter(g => g.length >= mainMin).flat();
  const limit = STRAY_CLEARANCE_LDU * STRAY_CLEARANCE_LDU;
  const pending = groups.filter(g => g.length < STRAY_MAX_PARTS).map(g => {
    let best = Infinity;
    for (const i of g) {
      for (const j of main) {
        const s = gapSquared(boxes[i]!, boxes[j]!);
        if (s < best) best = s;
      }
      if (best <= limit) break;
    }
    return { g, best, anchored: best <= limit };
  });
  const dropped = pending
    .filter(p => !p.anchored)
    .map(p => ({
      indices: [...p.g].sort((a, b) => a - b),
      clearanceLdu: Math.sqrt(p.best),
      centreLdu: [0, 1, 2].map(axis => p.g.reduce((s, i) => s + (boxes[i]!.min[axis]! + boxes[i]!.max[axis]!) / 2, 0) / p.g.length) as Vec3,
    }))
    .sort((a, b) => b.clearanceLdu - a.clearanceLdu);
  return { dropped };
}

/** What `withoutStrayFragments` left out: each piece's part ids, clearance and centre, worst first. */
export interface StrayReport {
  parts: number;
  pieces: Array<{ parts: string[]; clearanceLdu: number; centreLdu: Vec3 }>;
}

/**
 * `bricks` without the stray pieces (`findStrayFragments`), with what was left out. Returns the SAME array when
 * nothing is dropped, so callers keyed on the brick list keep their identity (as `withoutBuildTools` does).
 */
export async function withoutStrayFragments<T extends ParsedBrick>(bricks: T[], provider: PartGeometryProvider): Promise<{ bricks: T[]; report: StrayReport }> {
  const meshes = new Map<string, Awaited<ReturnType<PartGeometryProvider['getPartMesh']>>>();
  await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const boxes = bricks.map(b => placementWorldBox(b, meshes.get(b.part)));
  // Figures by the export's own grouping (every torso group, posed and statue ones too: they stay in the shell).
  const member = new Array<boolean>(bricks.length).fill(false);
  for (const g of groupFigures(bricks, meshes)) for (const i of g.parts) member[i] = true;
  const { dropped } = findStrayFragments(boxes, member);
  if (!dropped.length) return { bricks, report: { parts: 0, pieces: [] } };
  const out = new Set<number>(dropped.flatMap(d => d.indices));
  return {
    bricks: bricks.filter((_, i) => !out.has(i)),
    report: {
      parts: out.size,
      pieces: dropped.map(d => ({ parts: d.indices.map(i => partStem(bricks[i]!.part)), clearanceLdu: d.clearanceLdu, centreLdu: d.centreLdu })),
    },
  };
}

/** The export's report line: how many parts in how many pieces, and every piece by its parts and place. */
export function describeStrayReport(report: StrayReport): string {
  const piece = (p: StrayReport['pieces'][number]): string => {
    const counts = new Map<string, number>();
    for (const id of p.parts) counts.set(id, (counts.get(id) ?? 0) + 1);
    const ids = [...counts].map(([id, n]) => (n > 1 ? `${n}x ${id}` : id)).join(' + ');
    return `${ids} (${(p.clearanceLdu / 20).toFixed(1)} studs clear at LDU ${p.centreLdu.map(v => Math.round(v)).join(',')})`;
  };
  return `Left out ${report.parts} loose part${report.parts === 1 ? '' : 's'} in ${report.pieces.length} piece${report.pieces.length === 1 ? '' : 's'} lying more than ${STRAY_CLEARANCE_LDU / 20} studs clear of the model (pieces under ${STRAY_MAX_PARTS} parts, no figure; the source's loose layout, not the build): ${report.pieces.map(piece).join('; ')}.`;
}
