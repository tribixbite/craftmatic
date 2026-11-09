/**
 * Facade geometry for annotations (A09): turns pixel marks into metres on a massing volume.
 *
 * Two ways to say which wall an image shows:
 *  - `edge`: ring edge `i` of `MassVolume.outer`, from `outer[i]` to `outer[i + 1]`. Image x grows from the edge
 *    start to its end (reversed by `mirror`). The edge's own length calibrates the horizontal scale when the
 *    calibration gives a `spanPx`.
 *  - `facing`: a compass side. The image spans the volume's whole extent on that side and the mark's ring edge is
 *    chosen per mark (the longest edge looking that way that covers it, else the longest looking that way). Looking
 *    at a face from outside, image x grows to the viewer's right: west face -> +z, east face -> -z, south face ->
 *    +x, north face -> -x (x east, z south, so a viewer facing east has north on the left).
 */
import { signedArea } from '../massing/geometry.js';
import type { MassVolume, Vec2m } from '../types.js';
import type { FacadeEntry, Facing } from './types.js';

/** Massing volume id of an OSM part id (`way/123` -> `vol-way-123`); a `vol-` id passes through. */
export function volumeIdForPart(partOrVolumeId: string): string {
  return partOrVolumeId.startsWith('vol-') ? partOrVolumeId : `vol-${partOrVolumeId.replace('/', '-')}`;
}

/** The SourceRef id `siteFromOverpass` gives an OSM element (`way/123` -> `osm-way-123`). */
export function osmSourceId(partId: string): string {
  return `osm-${partId.replace('/', '-')}`;
}

/** One edge of a volume's outer ring. */
export interface EdgeInfo {
  index: number;
  a: Vec2m;
  b: Vec2m;
  length: number;
  /** Unit vector from `a` to `b`. */
  dir: Vec2m;
  /** Unit outward normal. */
  normal: Vec2m;
}

/** Every non-degenerate edge of the outer ring with its direction and outward normal. */
export function outerEdges(v: Pick<MassVolume, 'outer'>): EdgeInfo[] {
  const ring = v.outer;
  // For a ring with positive shoelace area the outward normal of direction (dx, dz) is (dz, -dx); flip otherwise.
  const s = signedArea(ring) >= 0 ? 1 : -1;
  const out: EdgeInfo[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < 1e-9) continue;
    out.push({ index: i, a, b, length, dir: [dx / length, dz / length], normal: [(s * dz) / length, (-s * dx) / length] });
  }
  return out;
}

/** Outward unit normal of a compass side in the massing frame. */
export function facingNormal(f: Facing): Vec2m {
  switch (f) {
    case 'west': return [-1, 0];
    case 'east': return [1, 0];
    case 'south': return [0, 1];
    case 'north': return [0, -1];
  }
}

/** How a facade's pixels map to the plan and to heights. */
export interface FacadeMapper {
  /** Metres per pixel along the facade / up the facade. */
  scaleX: number;
  scaleY: number;
  /** Plan point (massing metres) under image column `xPx`. */
  planAt(xPx: number): Vec2m;
  /** Height above the model's zero at image row `yPx`. */
  heightAt(yPx: number): number;
  /** The ring edge a mark centred at `plan` belongs to. */
  edgeFor(plan: Vec2m): EdgeInfo;
}

/** @throws Error naming the facade when the entry cannot be mapped (bad edge, no scale, no facing edge). */
export function mapFacade(entry: FacadeEntry, volume: MassVolume): FacadeMapper {
  const cal = entry.calibration;
  const edges = outerEdges(volume);
  const tag = `facade ${entry.id}`;
  const spanPx = cal.spanPx;
  if (spanPx && !(spanPx[1] > spanPx[0])) throw new Error(`${tag}: spanPx must increase (${spanPx.join(', ')})`);
  const x0 = spanPx?.[0] ?? 0;
  const spanW = spanPx ? spanPx[1] - spanPx[0] : 0;

  let scaleX: number;
  let planAt: (xPx: number) => Vec2m;
  let edgeFor: (p: Vec2m) => EdgeInfo;

  if (entry.edge !== undefined) {
    const e = volume.outer.length > entry.edge && entry.edge >= 0 ? edges.find(k => k.index === entry.edge) : undefined;
    if (!e) throw new Error(`${tag}: edge ${entry.edge} is not an edge of ${volume.id} (ring has ${volume.outer.length} vertices)`);
    scaleX = spanPx ? e.length / spanW : cal.rectifiedScale ?? NaN;
    planAt = xPx => {
      const along = (xPx - x0) * scaleX;
      const t = entry.mirror ? e.length - along : along;
      return [e.a[0] + e.dir[0] * t, e.a[1] + e.dir[1] * t];
    };
    edgeFor = () => e;
  } else if (entry.facing) {
    const n = facingNormal(entry.facing);
    const xs = volume.outer.map(p => p[0]), zs = volume.outer.map(p => p[1]);
    const lo = { x: Math.min(...xs), z: Math.min(...zs) }, hi = { x: Math.max(...xs), z: Math.max(...zs) };
    // The face plane and the run of the facade along it, left end to right end as the viewer sees it.
    const faceX = n[0] < 0 ? lo.x : hi.x, faceZ = n[1] < 0 ? lo.z : hi.z;
    const horizontal = n[1] !== 0; // a north/south face runs along x
    const start = horizontal ? (n[1] > 0 ? lo.x : hi.x) : (n[0] < 0 ? lo.z : hi.z);
    const sign = horizontal ? (n[1] > 0 ? 1 : -1) : (n[0] < 0 ? 1 : -1);
    const extent = horizontal ? hi.x - lo.x : hi.z - lo.z;
    scaleX = spanPx ? extent / spanW : cal.rectifiedScale ?? NaN;
    planAt = xPx => {
      const along = (xPx - x0) * scaleX;
      const t = start + sign * (entry.mirror ? extent - along : along);
      return horizontal ? [t, faceZ] : [faceX, t];
    };
    const facing = edges.filter(k => k.normal[0] * n[0] + k.normal[1] * n[1] >= 0.85);
    if (facing.length === 0) throw new Error(`${tag}: ${volume.id} has no edge facing ${entry.facing}`);
    edgeFor = p => {
      // Prefer an edge whose own extent covers the point (projected along its direction), the longest first.
      const covering = facing.filter(k => {
        const t = (p[0] - k.a[0]) * k.dir[0] + (p[1] - k.a[1]) * k.dir[1];
        return t >= -1e-6 && t <= k.length + 1e-6;
      });
      const pool = covering.length > 0 ? covering : facing;
      return pool.reduce((best, k) => (k.length > best.length ? k : best));
    };
  } else {
    throw new Error(`${tag}: neither edge nor facing is given`);
  }

  // Vertical scale: two known heights beat one scale, which beats the horizontal scale.
  const ref = cal.heightRef;
  let scaleY: number;
  if (ref) {
    const dy = cal.groundRowPx - ref.rowPx;
    if (!(dy > 0) || !(ref.heightM > 0)) throw new Error(`${tag}: heightRef must sit above the ground row`);
    scaleY = ref.heightM / dy;
  } else scaleY = cal.rectifiedScale ?? scaleX;
  if (!Number.isFinite(scaleX) || !(scaleX > 0)) throw new Error(`${tag}: no horizontal scale (give spanPx or rectifiedScale)`);
  if (!Number.isFinite(scaleY) || !(scaleY > 0)) throw new Error(`${tag}: no vertical scale`);
  const ground = cal.groundHeightM ?? volume.baseM;
  return { scaleX, scaleY, planAt, heightAt: yPx => ground + (cal.groundRowPx - yPx) * scaleY, edgeFor };
}
