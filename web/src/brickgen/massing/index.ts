/**
 * Massing (A05, BIZ-05): `SiteEvidence` -> `Massing` (`MassVolume[]` at a chosen scale).
 *
 * Steps, all deterministic:
 *  1. licence gate (`commercial` defaults to TRUE: a caller must opt out explicitly);
 *  2. pair every `parts` entry with its `footprint` entry (`partId`);
 *  3. rotate the whole site so its dominant wall direction is the stud grid's axis (`frame.rotationDeg`);
 *  4. drop an entry that is already replaced by others (an OSM building outline under its `building:part`s);
 *  5. split each part's height into wall top + roof rise (OSM `height` includes the roof);
 *  6. choose the scale (`scale.ts`), simplify + snap every ring to the stud grid (`simplify.ts`), snap heights to
 *     plates, translate so the minimum corner is (0, 0).
 *
 * Output frame: metres, x east, z south, min corner at the origin, every footprint vertex an integer number of
 * studs (`value * studsPerMetre` is an integer), every height an integer number of plates. `frame` records the
 * rotation and translation applied so annotations and features can map back; `reports[].edgeSource` maps each
 * output edge to the ORIGINAL ring vertex it starts at (for `FacadeAnnotation.edge`).
 *
 * Not here: mesh-derived massing (`sliceMeshAtY`) belongs with A09's mesh adapter.
 */
import { OUTLINE_PREFIX, ROOF_DIRECTION_PREFIX, ROOF_RISE_PREFIX } from '../site/osm.js';

export { OUTLINE_PREFIX };
import { assertSiteLicences, type LicenceGateResult } from '../site/licence-gate.js';
import type { Massing, MassVolume, RoofSpec, SiteEvidence, Vec2m, Vec3m } from '../types.js';
import { areaWithHoles, coverageFraction, dominantAxisDeg, dropCollinear, orientRing, pointInPolygon, pointInRing, ringArea, ringBounds, rotatePoint } from './geometry.js';
import { maskCount, newMask, openMask, traceMask, type CellMask } from './raster.js';
import { chooseScale, type MetreVolume, type ScaleRequest } from './scale.js';
import { minFeatureSquare, simplifyRingStuds, type SimplifyOptions } from './simplify.js';

/** A skillion whose rise is at least this many metres, and at least `TERRACE_BODY_FRACTION` of its height, is a sloped BODY. */
export const TERRACE_MIN_RISE_M = 10;
/** Share of a part's height its roof must make up for the roof to be the body (Eiffel's legs: 90 to 100 %). */
export const TERRACE_BODY_FRACTION = 0.5;
/** Thinnest terrace, in plates (three plates is a brick): a gentler slope gets wider steps instead of thinner slabs. */
export const TERRACE_MIN_PLATES = 3;

/** Pitch assumed for a pitched roof with no `roof:height` (degrees). */
export const DEFAULT_ROOF_PITCH_DEG = 30;

/**
 * A `MassVolume` that also records its roof's rise above `topM` (metres, a whole number of plates). `MassVolume`
 * itself has no rise field (`types.ts` is X-08's), and a consumer that re-derived the rise from `pitchDeg` and its own
 * span disagreed with this module: a skillion 15 m high over a 1.5 m wide strip (its true run is the 13 m along the
 * slope) became a 96 m spike in the plain bricker. TODO(types): promote `roofRiseM` to `MassVolume` when X-08 allows.
 */
export interface RoofedVolume extends MassVolume { roofRiseM: number }

/** The recorded roof rise of a volume in metres, or undefined for a massing built elsewhere that does not carry it. */
export function volumeRoofRiseM(v: MassVolume): number | undefined {
  return (v as Partial<RoofedVolume>).roofRiseM;
}

export interface MassingOptions {
  /** Role hint per part id (OSM adapter's `roles`); anything else is a `body`. */
  roles?: Record<string, MassVolume['role']>;
  /** True (default) for a run that ships: refuses Google/unknown inputs. Pass false only for local comparison. */
  commercial?: boolean;
  scale?: ScaleRequest;
  /** `'auto'` (default) rotates to the dominant wall direction, a number forces degrees, `false` keeps north-up. */
  rotate?: 'auto' | number | false;
  /** An entry whose area is at least this covered by other entries is dropped as redundant (default 0.85). */
  outlineCoverage?: number;
  simplify?: SimplifyOptions;
}

export interface VolumeReport {
  id: string;
  partId: string;
  originalVertices: number;
  vertices: number;
  holes: number;
  /** Edges that are neither horizontal nor vertical (`TODO(non-orthogonal)`). */
  nonOrthogonalEdges: number;
  mode: 'snapped' | 'rounded' | 'unsnapped' | 'min-feature';
  /** Output footprint area minus the source area, as a fraction of the source. */
  areaChange: number;
  /** For each output outer edge, the original ring vertex it starts at. */
  edgeSource: number[];
}

export interface MassingResult {
  massing: Massing;
  /** The site was turned by `rotationDeg` (about the metre origin), then shifted by `translateM`. */
  frame: { rotationDeg: number; translateM: Vec2m };
  reports: VolumeReport[];
  dropped: Array<{ partId: string; reason: string }>;
  warnings: string[];
  licence: LicenceGateResult;
  /**
   * The true top in metres: the highest point of any volume INCLUDING its roof and spire. `massing.volumes[].topM` is the
   * wall top, so the tallest `topM` understates a building whose height is mostly roof (an Elizabeth Tower, a spire).
   */
  trueTopM: number;
}

interface Entry {
  partId: string;
  outer: Vec2m[];
  holes: Vec2m[][];
  baseM: number;
  heightM: number;
  roof: RoofSpec;
  riseM: number | undefined;
  /** `roof:direction`: compass bearing the slope faces, degrees clockwise from north (site frame, before rotation). */
  directionDeg: number | undefined;
  /** A building OUTLINE (`building-outline:` marker): parts replace it wherever they cover it. */
  outline?: boolean;
  /** Suffix of the volume id for a piece of a part that massing split (terrace, outline remnant); the first piece has none. */
  idSuffix?: string;
  /** The ring is already integer stud coordinates (from a cell mask): it is not simplified or snapped again. */
  gridRing?: boolean;
}

/**
 * Horizontal length of the ring along the compass bearing `bearingDeg`, in the TURNED frame (x east, z south, the site
 * rotated by `rotationDeg`). A skillion rises over this length, not over the ring's short side: 15 m over a 13 m long
 * strip is 49 degrees, 15 m over its 1.5 m width would be 84.
 */
function extentAlongBearing(outer: ReadonlyArray<Vec2m>, bearingDeg: number, rotationDeg: number): number {
  const r = (bearingDeg * Math.PI) / 180;
  const [dx, dz] = rotatePoint([Math.sin(r), -Math.cos(r)], -rotationDeg); // north is -z
  const along = outer.map(([x, z]) => x * dx + z * dz);
  return Math.max(...along) - Math.min(...along);
}

/** Half the short side of the ring's oriented bounding box: the run a roof rises over. */
function halfShortSpan(outer: ReadonlyArray<Vec2m>): number {
  const th = dominantAxisDeg([outer]);
  const pts = outer.map(p => rotatePoint(p, -th));
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2;
}

/** A part's wall top and roof rise, before snapping. `terrace` marks a skillion that is the body (see `terraceSplits`). */
interface Split { e: Entry; wallTopM: number; riseM: number; pitchDeg: number | undefined; terrace?: boolean }

/** Cell grid over the stud-space bounds of some rings: cell (i, j) covers [x0 + i, x0 + i + 1) x [z0 + j, z0 + j + 1) studs. */
function gridOver(rings: ReadonlyArray<ReadonlyArray<Vec2m>>): { x0: number; z0: number; mask: CellMask } {
  const [minX, minZ, maxX, maxZ] = ringBounds(rings);
  const x0 = Math.floor(minX), z0 = Math.floor(minZ);
  return { x0, z0, mask: newMask(Math.max(1, Math.ceil(maxX) - x0), Math.max(1, Math.ceil(maxZ) - z0)) };
}

const toStuds = (r: ReadonlyArray<Vec2m>, sp: number): Vec2m[] => r.map(([x, z]) => [x * sp, z * sp] as Vec2m);

/** A piece of a part as its own entry: the ring is read off the stud grid (`x0`, `z0` offset it), in metres. */
function pieceOf(e: Entry, region: { outer: Vec2m[]; holes: Vec2m[][] }, x0: number, z0: number, sp: number, suffix: string): Entry {
  const back = (r: Vec2m[]): Vec2m[] => r.map(([x, z]) => [(x + x0) / sp, (z + z0) / sp] as Vec2m);
  return { ...e, outer: back(region.outer), holes: region.holes.map(back), gridRing: true, idSuffix: suffix };
}

/**
 * An outline's remnant: what is left of its footprint where NO part stands (a boolean difference on the stud grid,
 * then an opening that removes slivers narrower than 3 studs, because an outline's edge and its parts' edges never align
 * exactly). Each connected remnant is its own volume, in the outline's height; the first keeps the outline's id.
 * An outline wholly covered by its parts vanishes and is recorded in `dropped`.
 */
function outlineRemnants(
  s: Split, covers: ReadonlyArray<Entry>, sp: number, splitOf: (e: Entry) => Split, dropped: Array<{ partId: string; reason: string }>,
): Split[] {
  const e = s.e;
  const outer = toStuds(e.outer, sp), holes = e.holes.map(h => toStuds(h, sp));
  const [bx0, bz0, bx1, bz1] = ringBounds([outer]);
  const nearby = covers
    .map(c => ({ outer: toStuds(c.outer, sp), holes: c.holes.map(h => toStuds(h, sp)) }))
    .filter(c => { const [x0, z0, x1, z1] = ringBounds([c.outer]); return x1 >= bx0 && x0 <= bx1 && z1 >= bz0 && z0 <= bz1; });
  const { x0, z0, mask } = gridOver([outer]);
  for (let j = 0; j < mask.d; j++) for (let i = 0; i < mask.w; i++) {
    const cx = x0 + i + 0.5, cz = z0 + j + 0.5;
    if (pointInPolygon(cx, cz, outer, holes) && !nearby.some(c => pointInPolygon(cx, cz, c.outer, c.holes))) mask.cells[i + mask.w * j] = 1;
  }
  const regions = traceMask(openMask(mask));
  if (regions.length === 0) {
    dropped.push({ partId: e.partId, reason: `the outline is covered by ${covers.length} building part(s); only slivers are left, so the parts stand in its place` });
    return [];
  }
  return regions.map((r, k) => splitOf(pieceOf(e, r, x0, z0, sp, k === 0 ? '' : `-r${k}`)));
}

/**
 * Terraces of a skillion that is the whole body. The plane rises from the wall top at the low edge (the edge furthest
 * along `roof:direction`) to the part's top at the high edge. It is cut into `n` flat slabs, slab k holding the cells
 * whose plane height reaches the middle of its band, so the stack steps up the slope in whole plates and the highest
 * slab ends exactly at the part's top. Slab k + 1 stands on slab k (its cells are a subset), so the stack is one
 * piece. `n` is at most the run in studs (a step is never narrower than a stud) and at most the rise in bricks
 * (`TERRACE_MIN_PLATES`): a steep plane gets thick slabs, a gentle one wide steps.
 */
function terraceSplits(s: Split, sp: number, ppm: number, rotationDeg: number): Split[] {
  const e = s.e;
  const r = ((e.directionDeg ?? 0) * Math.PI) / 180;
  const [dx, dz] = rotatePoint([Math.sin(r), -Math.cos(r)], -rotationDeg); // downhill, in the turned frame (north is -z)
  const proj = (x: number, z: number): number => x * dx + z * dz;
  const along = e.outer.map(([x, z]) => proj(x, z));
  const lo = Math.min(...along), hi = Math.max(...along);
  const runStuds = (hi - lo) * sp;
  const basePl = Math.round(e.baseM * ppm), wallPl = Math.round(s.wallTopM * ppm), topPl = Math.round((s.wallTopM + s.riseM) * ppm);
  const ratePl = topPl - wallPl;
  const n = Math.max(1, Math.min(Math.floor(runStuds), Math.floor(ratePl / TERRACE_MIN_PLATES)));
  const outer = toStuds(e.outer, sp), holes = e.holes.map(h => toStuds(h, sp));
  const { x0, z0, mask: all } = gridOver([outer]);
  const t = new Float32Array(all.w * all.d).fill(-1); // plane position per cell: 0 at the low edge, 1 at the high edge
  for (let j = 0; j < all.d; j++) for (let i = 0; i < all.w; i++) {
    const cx = x0 + i + 0.5, cz = z0 + j + 0.5;
    if (!pointInPolygon(cx, cz, outer, holes)) continue;
    t[i + all.w * j] = hi - lo > 0 ? Math.min(1, Math.max(0, (hi - proj(cx / sp, cz / sp)) / (hi - lo))) : 0;
  }
  const out: Split[] = [];
  let lowerPl = basePl;
  for (let k = 0; k < n; k++) {
    const mask = newMask(all.w, all.d);
    for (let c = 0; c < t.length; c++) if (t[c]! >= 0 && (k === 0 || t[c]! >= (k + 0.5) / n)) mask.cells[c] = 1;
    if (maskCount(mask) === 0) continue;
    // Slab k spans up to the plane height of its band's top; the first also holds the wall under the plane.
    const upperPl = k === n - 1 ? topPl : wallPl + Math.round(((k + 1) * ratePl) / n);
    if (upperPl <= lowerPl) continue;
    for (const region of traceMask(mask)) {
      const piece = pieceOf({ ...e, roof: { shape: 'flat' }, baseM: lowerPl / ppm }, region, x0, z0, sp, out.length === 0 ? '' : `-t${out.length}`);
      out.push({ e: piece, wallTopM: upperPl / ppm, riseM: 0, pitchDeg: undefined });
    }
    lowerPl = upperPl;
  }
  // The highest slab may be empty when the footprint is a single stud wide: it still reaches the part's top.
  const last = out[out.length - 1];
  if (last && Math.round(last.wallTopM * ppm) < topPl) last.wallTopM = topPl / ppm;
  return out;
}

/** Turns a `SiteEvidence` into a stud-gridded `Massing`. @throws LicenceGateError on a refused input. */
export function buildMassing(site: SiteEvidence, opts: MassingOptions = {}): MassingResult {
  const licence = assertSiteLicences(site, { commercial: opts.commercial ?? true });
  const warnings: string[] = [];
  const dropped: MassingResult['dropped'] = [];

  const riseOf = new Map<string, number>();
  const directionOf = new Map<string, number>();
  const outlineIds = new Set<string>();
  for (const m of site.measurements) {
    if (m.what.startsWith(OUTLINE_PREFIX)) { outlineIds.add(m.what.slice(OUTLINE_PREFIX.length)); continue; }
    if (m.what.startsWith(ROOF_RISE_PREFIX)) riseOf.set(m.what.slice(ROOF_RISE_PREFIX.length), m.valueM);
    else if (m.what.startsWith(ROOF_DIRECTION_PREFIX)) directionOf.set(m.what.slice(ROOF_DIRECTION_PREFIX.length), m.valueM); // degrees, see the prefix
  }

  // 2. pair parts with footprints; a footprint with no part entry is a plain body of unknown height (reported).
  let entries: Entry[] = [];
  for (const fp of site.footprint) {
    const part = site.parts.find(p => p.partId === (fp.partId ?? ''));
    if (!part) { dropped.push({ partId: fp.partId ?? '(unnamed)', reason: 'footprint has no matching parts entry (no height)' }); continue; }
    entries.push({
      partId: part.partId, outer: fp.outer.map(p => [...p] as Vec2m), holes: fp.holes.map(h => h.map(p => [...p] as Vec2m)),
      baseM: part.baseM, heightM: part.heightM, roof: part.roof ?? { shape: 'flat' }, riseM: riseOf.get(part.partId), directionDeg: directionOf.get(part.partId),
      ...(outlineIds.has(part.partId) ? { outline: true } : {}),
    });
  }
  if (entries.length === 0) throw new Error('massing: the site has no footprint with a height');

  // 3. rotate to the dominant wall direction.
  const rotationDeg = opts.rotate === false ? 0 : typeof opts.rotate === 'number' ? opts.rotate
    : dominantAxisDeg(entries.flatMap(e => [e.outer, ...e.holes]));
  const turn = (r: Vec2m[]): Vec2m[] => r.map(p => rotatePoint(p, -rotationDeg));
  entries = entries.map(e => ({ ...e, outer: turn(e.outer), holes: e.holes.map(turn) }));

  // 4. drop entries replaced by the others (an outline under its parts). Largest first so the outline goes, not a part.
  // A marked OUTLINE is handled apart (below): it never covers a part, whatever the heights, and the parts replace it
  // wherever they stand, so an outline as tall as its parts cannot hide them (Cologne: 85 parts became one volume).
  const threshold = opts.outlineCoverage ?? 0.85;
  const partEntries = entries.filter(e => !e.outline);
  const outlineEntries = partEntries.length > 0 ? entries.filter(e => e.outline) : [];
  const legacy = partEntries.length > 0 ? partEntries : entries;
  const ordered = [...legacy].sort((a, b) => areaWithHoles(b.outer, b.holes) - areaWithHoles(a.outer, a.holes));
  const alive = new Set(ordered.map(e => e.partId));
  for (const cand of ordered) {
    if (alive.size <= 1) break;
    // A cover counts only when it spans the candidate's WHOLE height range (a taller tower is not hidden by a
    // lower gallery around it, and a spire above a tower is not hidden by the tower).
    const covers = ordered.filter(o => o !== cand && alive.has(o.partId)
      && o.baseM <= cand.baseM + 1e-6 && o.heightM >= cand.heightM - 1e-6);
    if (covers.length === 0) continue;
    const cov = coverageFraction(cand.outer, cand.holes, covers);
    if (cov >= threshold) {
      alive.delete(cand.partId);
      dropped.push({ partId: cand.partId, reason: `${Math.round(cov * 100)}% covered by ${covers.length} other part(s) over the same heights` });
    }
  }
  const survivors = ordered.filter(e => alive.has(e.partId));
  /** The parts that stand where an outline does: its remnant is what they do not cover (made once the scale is known). */
  const coverersOf = new Map<string, Entry[]>();
  for (const o of outlineEntries) coverersOf.set(o.partId, survivors);
  entries = [...survivors, ...outlineEntries];

  // 5. wall top + roof rise (metres, before snapping).
  const splitOf = (e: Entry): Split => {
    if (e.roof.shape === 'flat') {
      if (e.riseM && e.riseM > 0) warnings.push(`${e.partId}: roof:height ${e.riseM} m ignored on a flat roof`);
      return { e, wallTopM: e.heightM, riseM: 0, pitchDeg: undefined };
    }
    const room = e.heightM - e.baseM;
    // A skillion that IS the body (OSM `building:part=roof` skillions for the Eiffel Tower's legs: a rise of 54 m over
    // 54 m of height) is not a roof to tile with slope bricks, which top out at 45 degrees and rise only over the
    // footprint's own run; it is built as flat terraces that follow the plane (`terraceSplits`).
    if (e.roof.shape === 'shed' && e.directionDeg !== undefined && e.riseM !== undefined
      && e.riseM >= TERRACE_MIN_RISE_M && e.riseM >= TERRACE_BODY_FRACTION * room) {
      const rise = Math.min(e.riseM, room);
      return { e, wallTopM: e.heightM - rise, riseM: rise, pitchDeg: undefined, terrace: true };
    }
    const half = halfShortSpan(e.outer);
    // A shed's run is the footprint's length along its slope when OSM gives the direction, else twice the half span.
    const run = e.roof.shape !== 'shed' ? half
      : e.directionDeg !== undefined ? extentAlongBearing(e.outer, e.directionDeg, rotationDeg) : 2 * half;
    let rise = e.riseM ?? Math.tan((DEFAULT_ROOF_PITCH_DEG * Math.PI) / 180) * half;
    if (e.riseM === undefined) warnings.push(`${e.partId}: ${e.roof.shape} roof with no roof:height, assumed ${DEFAULT_ROOF_PITCH_DEG} deg`);
    if (rise > 0.9 * room) { warnings.push(`${e.partId}: roof rise ${rise.toFixed(2)} m exceeds the part; clamped to 90%`); rise = 0.9 * room; }
    return { e, wallTopM: e.heightM - rise, riseM: rise, pitchDeg: run > 0 ? (Math.atan(rise / run) * 180) / Math.PI : undefined };
  };
  let splits: Split[] = entries.map(splitOf);

  // 6a. scale from the unsnapped metre volumes.
  const metreVolumes: MetreVolume[] = splits.map(s => ({ outer: s.e.outer, holes: s.e.holes, baseM: s.e.baseM, topM: s.wallTopM + s.riseM }));
  const scale = chooseScale(metreVolumes, opts.scale);
  const sp = scale.studsPerMetre, ppm = scale.platesPerMetre;

  // 6a'. split what only the stud grid can express: an outline's remnant beside its parts, a skillion's terraces.
  splits = splits.flatMap(sp0 => {
    const covers = coverersOf.get(sp0.e.partId);
    if (covers) return outlineRemnants(sp0, covers, sp, splitOf, dropped);
    if (sp0.terrace) return terraceSplits(sp0, sp, ppm, rotationDeg);
    return [sp0];
  });

  // 6b. simplify + snap, in stud units.
  interface Built { id: string; partId: string; outer: Vec2m[]; holes: Vec2m[][]; baseP: number; topP: number; riseP: number; roof: RoofSpec; report: VolumeReport }
  const built: Built[] = [];
  let minFeatures = 0;
  for (const s of splits) {
    const { e } = s;
    const studRing = e.outer.map(([x, z]) => [x * sp, z * sp] as Vec2m);
    // A ring read off the stud grid is already integer and axis-aligned: simplifying it would turn its steps into diagonals.
    let ring = e.gridRing
      ? { points: dropCollinear(studRing.map(([x, z], i) => ({ x: Math.round(x), z: Math.round(z), src: i }))), nonOrthogonalEdges: 0, mode: 'snapped' as const }
      : simplifyRingStuds(studRing, opts.simplify);
    let outer = orientRing(ring.points.map(p => [p.x, p.z] as Vec2m), true);
    if (ring.points.length < 3 || ringArea(outer) < 1) {
      // Sub-stud detail (a pinnacle) becomes a 1 x 1 stud column rather than vanishing.
      const small = minFeatureSquare(studRing);
      if (small) { ring = small; outer = orientRing(small.points.map(p => [p.x, p.z] as Vec2m), true); minFeatures++; }
    }
    if (ring.points.length < 3 || ringArea(outer) < 1) { dropped.push({ partId: e.partId, reason: 'footprint collapses below one stud^2 at this scale' }); continue; }
    const holes: Vec2m[][] = [];
    let holeNonOrth = 0;
    for (const h of e.holes) {
      const hr = e.gridRing
        ? { points: dropCollinear(h.map(([x, z], i) => ({ x: Math.round(x * sp), z: Math.round(z * sp), src: i }))), nonOrthogonalEdges: 0 }
        : simplifyRingStuds(h.map(([x, z]) => [x * sp, z * sp] as Vec2m), opts.simplify);
      const hp = hr.points.map(p => [p.x, p.z] as Vec2m);
      const inside = hp.length >= 3 && pointInRing(hp[0]![0], hp[0]![1], outer) ;
      if (hp.length < 3 || ringArea(hp) < 1 || !inside) { warnings.push(`${e.partId}: a hole collapsed or left the footprint at this scale and was dropped`); continue; }
      holes.push(orientRing(hp, false));
      holeNonOrth += hr.nonOrthogonalEdges;
    }
    const baseP = Math.round(e.baseM * ppm);
    let riseP = Math.round(s.riseM * ppm);
    let topP = Math.round(s.wallTopM * ppm);
    let roof: RoofSpec = { ...e.roof };
    if (riseP < 1) { roof = { shape: 'flat' }; topP = Math.round((s.wallTopM + s.riseM) * ppm); riseP = 0; }
    else {
      roof = { ...e.roof, pitchDeg: Math.round((s.pitchDeg ?? DEFAULT_ROOF_PITCH_DEG) * 10) / 10, ridgeAxis: e.roof.ridgeAxis ?? 'long' };
    }
    if (topP <= baseP) { dropped.push({ partId: e.partId, reason: 'height collapses below one plate at this scale' }); continue; }
    const srcArea = areaWithHoles(e.outer, e.holes) * sp * sp;
    built.push({
      id: `vol-${e.partId.replace('/', '-')}${e.idSuffix ?? ''}`, partId: e.partId, outer, holes, baseP, topP, riseP, roof,
      report: {
        id: `vol-${e.partId.replace('/', '-')}${e.idSuffix ?? ''}`, partId: e.partId, originalVertices: e.outer.length, vertices: outer.length, holes: holes.length,
        nonOrthogonalEdges: ring.nonOrthogonalEdges + holeNonOrth, mode: ring.mode,
        areaChange: srcArea > 0 ? (areaWithHoles(outer, holes) - srcArea) / srcArea : 0,
        edgeSource: ring.points.map(p => p.src),
      },
    });
  }
  if (built.length === 0) throw new Error('massing: nothing survived snapping at this scale');
  if (minFeatures > 0) warnings.push(`${minFeatures} sub-stud footprint(s) widened to a 1 x 1 stud column`);
  const nonOrth = built.reduce((s, b) => s + b.report.nonOrthogonalEdges, 0);
  if (nonOrth > 0) warnings.push(`TODO(non-orthogonal): ${nonOrth} diagonal edge(s) kept as straight diagonals between snapped corners`);

  // 6c. translate the minimum corner to the origin (all values are integers, so the shift stays on the grid).
  let minX = Infinity, minZ = Infinity;
  for (const b of built) for (const [x, z] of b.outer) { minX = Math.min(minX, x); minZ = Math.min(minZ, z); }
  const shift = (r: Vec2m[]): Vec2m[] => r.map(([x, z]) => [(x - minX) / sp, (z - minZ) / sp] as Vec2m);
  const roles = opts.roles ?? {};
  const volumes: RoofedVolume[] = built.map(b => ({
    id: b.id, outer: shift(b.outer), holes: b.holes.map(shift),
    baseM: b.baseP / ppm, topM: b.topP / ppm, roof: b.roof, role: roles[b.partId] ?? 'body', roofRiseM: b.riseP / ppm,
  }));

  let maxX = 0, maxZ = 0, minY = Infinity, maxY = 0;
  built.forEach((b, i) => {
    for (const [x, z] of volumes[i]!.outer) { maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z); }
    minY = Math.min(minY, b.baseP / ppm);
    maxY = Math.max(maxY, (b.topP + b.riseP) / ppm);
  });
  const boundsM: [Vec3m, Vec3m] = [[0, minY, 0], [maxX, maxY, maxZ]];
  return {
    massing: { volumes, scale, boundsM },
    frame: { rotationDeg, translateM: [-minX / sp, -minZ / sp] },
    reports: built.map(b => b.report), dropped, warnings, licence, trueTopM: maxY,
  };
}
