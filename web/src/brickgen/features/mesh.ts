/**
 * Features from mesh slices (A09, BIZ-05): a licence-clean mesh (open LiDAR, an own scan, or the local-only GLB of
 * the optional image-to-3D adapter, `TODO(b15-adapter)`) is cut with `sliceMeshAtY` every `deltaY` metres and the
 * silhouette's profile over height is read for what a facade photo would show as a feature:
 *  - a spire: the topmost run in which the main silhouette area falls at every step down to a point;
 *  - a cornice: a thin band (<= 2.5 m) whose area is >= 10 % larger than the levels above and below it;
 *  - pinnacles: small (<= 4 m2) detached silhouettes that stand at least 1 m tall.
 * The mesh is measured and discarded: nothing of it ships, only these `FeatureSpec`s citing the mesh's `SourceRef`.
 *
 * Mesh coordinates are metres, y up. With `frame` (from `buildMassing`) the mesh is assumed to be in the SITE frame
 * and is rotated/translated into the massing frame; without it the mesh is taken to be in the massing frame already.
 */
import { sliceMeshAtY, type MeshSliceInput, type Polygon2D } from '@craft/pipeline/synthesis/slice-extract';
import { pointInRing, rotatePoint } from '../massing/geometry.js';
import type { MassingResult } from '../massing/index.js';
import type { FeatureKind, FeatureSpec, Massing, MassVolume, Vec2m } from '../types.js';
import type { OriginFeature } from './types.js';

export interface MeshFeatureOptions {
  /** `SourceRef` id of the mesh (kind `mesh` or `lidar`). */
  source: string;
  /** The massing's frame; the mesh is rotated/translated by it. Omit when the mesh is already in the massing frame. */
  frame?: MassingResult['frame'];
  /** Height added to every mesh y (metres) to bring the mesh's ground to the model's zero. */
  yOffsetM?: number;
  /** Slice spacing in metres (default 0.5). */
  deltaY?: number;
}

const CONF = { spire: 0.6, cornice: 0.5, pinnacle: 0.45 } as const;
const SPIRE_MIN_HEIGHT_M = 3;
const SPIRE_APEX_RATIO = 0.35;
const SPIRE_STEP_DROP = 0.97;
const CORNICE_MIN_GROWTH = 1.1;
const CORNICE_MAX_THICKNESS_M = 2.5;
const PINNACLE_MAX_AREA_M2 = 4;
const PINNACLE_MIN_HEIGHT_M = 1;
const TRACK_RADIUS_M = 1;

interface Level { y: number; polys: Polygon2D[] }

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function bboxOf(p: Polygon2D): { w: number; d: number } {
  const xs = p.points.map(q => q.x), zs = p.points.map(q => q.z);
  return { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...zs) - Math.min(...zs) };
}

/** The volume a feature at plan point `p` and height `y` belongs to (see the file comment for the fallbacks). */
function volumeAt(volumes: ReadonlyArray<MassVolume>, p: Vec2m, y: number): MassVolume | undefined {
  const inPlan = volumes.filter(v => pointInRing(p[0], p[1], v.outer) && !v.holes.some(h => pointInRing(p[0], p[1], h)));
  const inRange = inPlan.filter(v => y >= v.baseM - 0.5 && y <= v.topM + 0.5);
  const pick = (vs: MassVolume[]): MassVolume | undefined => vs.reduce<MassVolume | undefined>((b, v) => (!b || v.baseM > b.baseM ? v : b), undefined);
  if (inRange.length > 0) return pick(inRange);
  if (inPlan.length > 0) {
    // Nearest in height: a spire above a tower whose wall top is a little lower.
    return inPlan.reduce((b, v) => (Math.abs(y - v.topM) < Math.abs(y - b.topM) ? v : b));
  }
  let best: MassVolume | undefined, bestD = Infinity;
  for (const v of volumes) {
    const cx = v.outer.reduce((s, q) => s + q[0], 0) / v.outer.length, cz = v.outer.reduce((s, q) => s + q[1], 0) / v.outer.length;
    const d = Math.hypot(cx - p[0], cz - p[1]);
    if (d < bestD) { best = v; bestD = d; }
  }
  return best;
}

/**
 * Reads spires, cornices and pinnacles off the slice profile of `meshes`.
 * An empty or flat mesh yields no features. Deterministic.
 */
export function featuresFromMesh(
  massing: Massing,
  meshes: ReadonlyArray<MeshSliceInput>,
  opts: MeshFeatureOptions,
): { features: FeatureSpec[]; origin: OriginFeature[] } {
  const dy = opts.deltaY ?? 0.5;
  let minY = Infinity, maxY = -Infinity;
  for (const m of meshes) for (let i = 1; i < m.positions.length; i += 3) { minY = Math.min(minY, m.positions[i]!); maxY = Math.max(maxY, m.positions[i]!); }
  if (!(maxY - minY > dy)) return { features: [], origin: [] };

  const toMassing = (p: { x: number; z: number }): Vec2m => {
    if (!opts.frame) return [p.x, p.z];
    const r = rotatePoint([p.x, p.z], -opts.frame.rotationDeg);
    return [r[0] + opts.frame.translateM[0], r[1] + opts.frame.translateM[1]];
  };
  /** A polygon in the massing frame (area and bbox are rotation-invariant for the sizes read here). */
  const levels: Level[] = [];
  for (let y = minY + dy / 2; y < maxY; y += dy) levels.push({ y, polys: sliceMeshAtY(meshes, y).sort((a, b) => b.area - a.area) });

  const out: OriginFeature[] = [];
  const emit = (kind: FeatureKind, poly: Polygon2D, y: number, heightM: number, ref: string, confidence: number): void => {
    const c = toMassing(poly.centroid);
    const yy = y + (opts.yOffsetM ?? 0);
    const vol = volumeAt(massing.volumes, c, yy);
    if (!vol) return;
    const { w, d } = bboxOf(poly);
    out.push({
      origin: 'mesh', ref,
      spec: {
        kind, volume: vol.id, atM: [r6(c[0]), r6(yy), r6(c[1])], sizeM: [r6(w), r6(heightM), r6(d)],
        confidence, sources: [opts.source],
      },
    });
  };

  // Main silhouette: the largest polygon of each level.
  const main = levels.map(l => l.polys[0]);

  // Spire: the longest top suffix where the main area strictly falls at every step.
  let top = levels.length - 1;
  while (top >= 0 && !main[top]) top--;
  let s = top;
  while (s > 0 && main[s - 1] && main[s]!.area < main[s - 1]!.area * SPIRE_STEP_DROP) s--;
  if (top >= 1 && s < top) {
    const base = main[s]!, apex = main[top]!;
    const rise = levels[top]!.y - levels[s]!.y + dy;
    if (rise >= SPIRE_MIN_HEIGHT_M && apex.area <= SPIRE_APEX_RATIO * base.area) emit('spire', base, levels[s]!.y, rise, `slice@${r6(levels[s]!.y)}`, CONF.spire);
  }

  // Cornice: an area step up that steps back down within 2.5 m to about where it started.
  for (let i = 1; i < levels.length; i++) {
    const a = main[i], prev = main[i - 1];
    if (!a || !prev || a.area < prev.area * CORNICE_MIN_GROWTH) continue;
    let j = i;
    while (j < levels.length && main[j] && main[j]!.area >= prev.area * CORNICE_MIN_GROWTH) j++;
    const after = main[j];
    const thick = (j - i) * dy;
    if (after && thick <= CORNICE_MAX_THICKNESS_M && Math.abs(after.area - prev.area) <= 0.15 * Math.max(after.area, prev.area)) {
      emit('cornice', a, levels[i]!.y, thick, `slice@${r6(levels[i]!.y)}`, CONF.cornice);
    }
    i = j;
  }

  // Pinnacles: small silhouettes tracked upward by centroid.
  interface Track { poly: Polygon2D; y0: number; y1: number; maxArea: number; last: Polygon2D }
  let open: Track[] = [];
  const closed: Track[] = [];
  for (const lv of levels) {
    const small = lv.polys.slice(1).filter(p => p.area <= PINNACLE_MAX_AREA_M2);
    const next: Track[] = [];
    for (const p of small) {
      const t = open.find(k => !next.includes(k) && Math.hypot(k.last.centroid.x - p.centroid.x, k.last.centroid.z - p.centroid.z) <= TRACK_RADIUS_M);
      if (t) { t.y1 = lv.y; t.maxArea = Math.max(t.maxArea, p.area); t.last = p; next.push(t); }
      else next.push({ poly: p, y0: lv.y, y1: lv.y, maxArea: p.area, last: p });
    }
    for (const k of open) if (!next.includes(k)) closed.push(k);
    open = next;
  }
  closed.push(...open);
  for (const k of closed) {
    const h = k.y1 - k.y0 + dy;
    if (h >= PINNACLE_MIN_HEIGHT_M) emit('pinnacle', k.poly, k.y0, h, `slice@${r6(k.y0)}`, CONF.pinnacle);
  }

  return { features: out.map(o => o.spec), origin: out };
}
