/**
 * Roof grammars (A07, BIZ-05): a `RoofSpec` over a footprint becomes `roof-slope` cells in the descent direction the
 * X-10 slope picker expects, over roof fill, so the bricker turns the surface into real slope parts.
 *
 * One mechanism serves every shape. A roof is a RING FIELD over the footprint (cell -> its ring, counted in studs
 * from the eave inwards) plus a target height per ring (`stair.ts` quantises it into slope-part groups):
 *  - gabled / shed: the ring of a cell is its distance to the eave along the cross axis, measured per run, so an
 *    L-shaped plan gets a gable per leg at one pitch;
 *  - hipped, pyramidal, conical, spire, dome, onion, mansard: the ring is the Euclidean distance to the outside.
 * A cell's slope direction is the way to its lowest neighbour (the bricker's `slope.dir`: the way the roof descends).
 * Corners where two slopes meet and ridges one stud wide are plain roof fill; the bricker covers those with bricks.
 *
 * What the 45 and 33 degree slope families cannot do is documented in `stair.ts`; the measured consequences are in
 * the A07 report (a roof under about 11 degrees comes out steeper than asked; a roof over 31 degrees is stepped).
 */
import type { RoofShape, RoofSpec } from '../types.js';
import type { Canvas } from './canvas.js';
import { domeTarget, onionTarget } from './dome.js';
import { distanceToOutside, maskHas, runAround, STEPS, type Mask } from './footprint.js';
import { placeCone, spireHeight, spireTarget, spireTip } from './spire.js';
import { patternFor, stairRings, type RingSurface, type StairPattern } from './stair.js';

/** Fill within this many studs of the footprint's edge stays solid: a narrow spire must not be hollowed into pieces. */
const SOLID_EDGE_STUDS = 3.5;

/** Plates of solid fill kept at the bottom and under the surface when a roof's fill is hollowed. */
const HOLLOW_SKIN = 2;

/** Colours a roof is built in (LDraw codes). */
export interface RoofColours { slope: number; fill: number; gable: number }

/** Everything a roof needs beyond its footprint. */
export interface RoofInput {
  spec: RoofSpec;
  /** True for a spire (a very steep pyramid or cone). */
  spire?: boolean;
  /** Apex height in plates when it is known better than the pitch gives it (a spire's measured rise, a dome's height). */
  apexPlates?: number;
  /** Plates of rise per stud of run at 45 degrees: `platesPerMetre / studsPerMetre` (2.5 at the default scale). */
  platesPerStud: number;
  /** Highest plate the canvas has room for above the roof's base (clips are counted, never thrown). */
  room: number;
  /**
   * Cap on the roof's rise in plates. The massing's pitch is measured over the part's ORIGINAL half span, so a sub-stud
   * footprint widened to a stud keeps a pitch of 85 degrees and would rise like a tower: the caller caps it by the
   * volume's own wall height.
   */
  maxRise?: number;
}

export interface RoofResult {
  /** Cells written. */
  cells: number;
  /** Cells carrying a slope label. */
  slopeCells: number;
  /** Height of the highest column above the roof's base, plates. */
  apex: number;
  /** The shape actually built (a `flat` roof is `none`). */
  shape: RoofShape | 'none';
}

interface Field {
  ring: Int16Array;
  /** Per cell: the innermost ring of the run the cell belongs to. */
  ringMax: Int16Array;
  /** Descent direction per cell (0 +x, 1 -x, 2 +z, 3 -z), -1 where the cell has none. */
  dir: Int8Array;
  /** Cells that are a one-stud ridge or apex: flat roof fill at the height of the ring below. */
  flat: Uint8Array;
  /** Ridge axis for gables (0 = along x), so the gable ends can be recognised. */
  ridgeAxis?: 0 | 1;
  /** Half span in studs (the largest ring + 1, before a one-stud ridge is taken out): what a profile is scaled to. */
  span: number;
}

/** Descent direction of a cell towards the neighbour with the smallest distance (outside counts 0), if lower than its own. */
function lowestNeighbour(m: Mask, dist: Float32Array, i: number, j: number): number {
  const own = dist[i + m.w * j]!;
  let best = -1, bestD = own - 1e-3;
  STEPS.forEach(([di, dj], dir) => {
    const d = maskHas(m, i + di, j + dj) ? dist[i + di + m.w * (j + dj)]! : 0;
    if (d < bestD - 1e-9) { bestD = d; best = dir; }
  });
  return best;
}

/** Ring field from the distance to the outside: hips, pyramids, cones, domes. */
function distanceField(m: Mask): Field {
  const dist = distanceToOutside(m);
  const n = m.w * m.d;
  const ring = new Int16Array(n).fill(-1), ringMax = new Int16Array(n), dir = new Int8Array(n).fill(-1), flat = new Uint8Array(n);
  let max = 0;
  for (let k = 0; k < n; k++) if (m.inside[k]) { ring[k] = Math.max(0, Math.round(dist[k]!) - 1); max = Math.max(max, ring[k]!); }
  // A one-stud ridge (odd span) or apex cell has a lower neighbour on BOTH sides along an axis: it is flat.
  let singleRidge = false;
  const lower = (i: number, j: number, di: number, dj: number, own: number): boolean => (maskHas(m, i + di, j + dj) ? dist[i + di + m.w * (j + dj)]! : 0) < own - 1e-3;
  const isRidge = new Uint8Array(n);
  for (let j = 0; j < m.d; j++) for (let i = 0; i < m.w; i++) {
    const k = i + m.w * j;
    if (!m.inside[k] || ring[k] !== max) continue;
    const own = dist[k]!;
    if ((lower(i, j, 1, 0, own) && lower(i, j, -1, 0, own)) || (lower(i, j, 0, 1, own) && lower(i, j, 0, -1, own))) { isRidge[k] = 1; singleRidge = true; }
  }
  const slopeMax = singleRidge && max > 0 ? max - 1 : max;
  for (let j = 0; j < m.d; j++) for (let i = 0; i < m.w; i++) {
    const k = i + m.w * j;
    if (!m.inside[k]) continue;
    ringMax[k] = slopeMax;
    if (isRidge[k] && max > 0) { flat[k] = 1; ring[k] = slopeMax; continue; }
    dir[k] = lowestNeighbour(m, dist, i, j);
  }
  return { ring, ringMax, dir, flat, span: max + 1 };
}

/**
 * Ring field of a one-axis roof. `cross` is the axis the roof descends along (0 = x, 1 = z). A gable descends both
 * ways from a central ridge; a shed descends one way (towards the lower coordinate).
 */
function runField(m: Mask, cross: 0 | 1, gable: boolean): Field {
  const n = m.w * m.d;
  const ring = new Int16Array(n).fill(-1), ringMax = new Int16Array(n), dir = new Int8Array(n).fill(-1), flat = new Uint8Array(n);
  const down = cross === 0 ? 1 : 3, up = cross === 0 ? 0 : 2; // dir towards the lower / higher coordinate
  for (let j = 0; j < m.d; j++) for (let i = 0; i < m.w; i++) {
    const k = i + m.w * j;
    if (!m.inside[k]) continue;
    const { before, after } = runAround(m, i, j, cross);
    const len = before + after + 1;
    if (!gable) { ring[k] = before; ringMax[k] = len - 1; dir[k] = down; continue; }
    const half = Math.ceil(len / 2);
    if (len % 2 === 1 && before === after) {
      // The one-stud ridge: flat, at the height of the ring below it. A run of one stud has no slope at all.
      ring[k] = Math.max(0, half - 2); ringMax[k] = Math.max(0, half - 2); flat[k] = 1; continue;
    }
    ring[k] = Math.min(before, after);
    ringMax[k] = len % 2 === 1 ? half - 2 : half - 1;
    dir[k] = before < after ? down : up;
  }
  let span = 1;
  for (let k = 0; k < n; k++) span = Math.max(span, ringMax[k]! + 1);
  return { ring, ringMax, dir, flat, ridgeAxis: cross === 0 ? 1 : 0, span };
}

/** Longest side of the mask's box: 0 when it runs along x. */
function longAxis(m: Mask): 0 | 1 { return m.w >= m.d ? 0 : 1; }

/**
 * Build one roof on `canvas`, its base on plate `baseP`, over the footprint `mask`.
 * Only inside cells are written; a column that would pass the canvas ceiling is clipped and counted in `canvas.clipped`.
 */
export function buildRoof(canvas: Canvas, mask: Mask, baseP: number, input: RoofInput, colours: RoofColours): RoofResult {
  const { spec } = input;
  const none: RoofResult = { cells: 0, slopeCells: 0, apex: 0, shape: 'none' };
  const limit = Math.max(1, Math.min(input.room, input.maxRise ?? input.room));
  if (spec.shape === 'flat') return none;
  const pitch = spec.pitchDeg ?? 30;
  const platesPerStud = Math.tan((Math.min(pitch, 88.5) * Math.PI) / 180) * input.platesPerStud;
  let shape: RoofShape = spec.shape;
  if (input.spire) shape = 'spire';

  let field: Field;
  let targetOf: (rings: number) => (ring: number) => number;
  switch (shape) {
    case 'gabled': {
      // `ridgeAxis: 'long'` (the default): the ridge runs along the long side, the roof descends across the short one.
      const ridgeAlong = spec.ridgeAxis === 'short' ? (longAxis(mask) === 0 ? 1 : 0) : longAxis(mask);
      field = runField(mask, ridgeAlong === 0 ? 1 : 0, true);
      targetOf = () => ring => platesPerStud * (ring + 0.5);
      break;
    }
    case 'shed': {
      // The massing's pitch is measured over HALF the short span (its roof rise = tan(pitch) * half span), and a shed
      // rises over the whole span: half the per-stud pitch, or a 1-stud strip at 88 degrees becomes a tower.
      field = runField(mask, longAxis(mask) === 0 ? 1 : 0, false);
      targetOf = () => ring => (platesPerStud / 2) * (ring + 0.5);
      break;
    }
    case 'dome': case 'onion': {
      field = distanceField(mask);
      targetOf = () => {
        const apex = input.apexPlates ?? Math.max(3, field.span * input.platesPerStud * 0.8);
        return shape === 'dome' ? domeTarget(field.span, apex) : onionTarget(field.span, apex);
      };
      break;
    }
    case 'mansard': {
      field = distanceField(mask);
      const steep = Math.tan((70 * Math.PI) / 180) * input.platesPerStud, shallow = Math.tan((20 * Math.PI) / 180) * input.platesPerStud;
      targetOf = () => {
        const knee = Math.max(1, Math.round(field.span * 0.4));
        return ring => (ring < knee ? steep * (ring + 0.5) : steep * knee + shallow * (ring - knee + 0.5));
      };
      break;
    }
    case 'spire':
      field = distanceField(mask);
      targetOf = () => spireTarget(field.span, input.apexPlates ?? platesPerStud * field.span);
      break;
    default: // hipped, pyramidal, conical
      field = distanceField(mask);
      targetOf = () => ring => platesPerStud * (ring + 0.5);
  }

  const slopeLabel = new Map<string, number>();
  const slopeFor = (dir: 0 | 1 | 2 | 3, pattern: StairPattern): number => {
    const key = `${dir}.${pattern.rise}`;
    let v = slopeLabel.get(key);
    if (v === undefined) { v = canvas.label({ role: 'roof-slope', colour: colours.slope, slope: { dir, rise: pattern.rise } }); slopeLabel.set(key, v); }
    return v;
  };
  const fill = canvas.label({ role: 'roof-slope', colour: colours.fill, feature: 'fill' });
  const gableFill = canvas.label({ role: 'wall', colour: colours.gable });
  const edgeDist = distanceToOutside(mask);
  const near = new Uint8Array(edgeDist.length);
  for (let k = 0; k < near.length; k++) near[k] = edgeDist[k]! <= SOLID_EDGE_STUDS ? 1 : 0;
  const cap = canvas.label({ role: 'roof-flat', colour: colours.slope });
  const coneLabel = canvas.label({ role: 'roof-slope', colour: colours.slope, feature: 'cone' });

  const surfaces = new Map<number, { rings: RingSurface[]; pattern: StairPattern }>();
  const surfacesFor = (ringMax: number): { rings: RingSurface[]; pattern: StairPattern } => {
    let s = surfaces.get(ringMax);
    if (!s) {
      const pattern = patternFor(shape === 'shed' ? platesPerStud / 2 : platesPerStud);
      s = { rings: stairRings(ringMax, pattern, targetOf(ringMax), limit), pattern };
      surfaces.set(ringMax, s);
    }
    return s;
  };

  // A spire is built as STAGES, not slope groups: at 70+ degrees a pair of slope columns (3 plates over 2 studs) says
  // nothing about the taper, and the stair's group base averaged a spire's rings into one tall needle of constant width
  // (the merged Notre-Dame render). Each ring is a column to its own height on the straight taper, so the footprint
  // shrinks one stud a side per stage, and a square apex takes a real cone part.
  const columnar = shape === 'spire';
  let maxDist = 0;
  if (columnar) for (const d of edgeDist) maxDist = Math.max(maxDist, d);
  const tip = columnar ? spireTip(mask, edgeDist.map(d => (d >= maxDist - 1e-3 ? 1 : 0))) : undefined;
  let cells = 0, slopeCells = 0, apex = 0;
  const put = (x: number, p: number, z: number, v: number): void => { canvas.set(x, p, z, v); cells++; };
  for (let j = 0; j < mask.d; j++) for (let i = 0; i < mask.w; i++) {
    const k = i + mask.w * j;
    if (!mask.inside[k]) continue;
    const x = mask.x0 + i, z = mask.z0 + j;
    if (columnar) {
      // The height follows the cell's own Euclidean distance to the outside, not its rounded ring: the corners of an
      // octagon drop a stage earlier than its flats, so the taper is round, with more stages than the footprint has rings.
      const h = Math.min(Math.max(1, spireHeight(edgeDist[k]!, maxDist, input.apexPlates ?? platesPerStud * field.span)), limit);
      apex = Math.max(apex, h);
      const onTip = tip !== undefined && tip.cells.has(k) && h > tip.heightPlates + 2;
      const top = onTip ? h - tip!.heightPlates : h - 1;
      const solid = near[k] === 1 || ((x & 3) < 2 && (z & 3) < 2);
      for (let p = 0; p < top; p++) {
        if (p >= HOLLOW_SKIN && p < top - HOLLOW_SKIN && !solid) continue;
        put(x, baseP + p, z, fill);
      }
      if (onTip) { const n = placeCone(canvas, x, z, tip!, baseP + top, coneLabel); cells += n; slopeCells += n; } else put(x, baseP + top, z, cap);
      continue;
    }
    const { rings, pattern } = surfacesFor(field.ringMax[k]!);
    const s = rings[Math.min(field.ring[k]!, rings.length - 1)]!;
    // A one-stud ridge or apex is one ring past the last slope ring: it rises to the target there.
    const flatTop = field.flat[k] ? Math.round(targetOf(field.ringMax[k]!)(field.ringMax[k]! + 1)) : 0;
    const height = Math.min(Math.max(s.height, flatTop), limit);
    apex = Math.max(apex, height);
    // A gable end: the fill whose neighbour along the ridge is outside the footprint shows the wall's colour.
    let endWall = false;
    if (field.ridgeAxis !== undefined) {
      const [di, dj] = field.ridgeAxis === 0 ? [1, 0] : [0, 1];
      endWall = !maskHas(mask, i + di, j + dj) || !maskHas(mask, i - di, j - dj);
    }
    const base = Math.min(s.base, height);
    // Hollow the fill under the surface on a pattern the bricker cannot break: two plates solid at the bottom (on the
    // ceiling) and under the surface, solid within two studs of the edge, and 2 x 2 pillars between. The bricker's own
    // `hollowOk` would leave the upper skin hanging in mid-air wherever the fill is tall (measured: 110 unsupported).
    const core = near[k] === 1 || ((x & 3) < 2 && (z & 3) < 2);
    for (let p = 0; p < base; p++) {
      if (p >= HOLLOW_SKIN && p < base - HOLLOW_SKIN && !core) continue;
      put(x, baseP + p, z, endWall ? gableFill : fill);
    }
    const dir = field.dir[k]!;
    if (field.flat[k]) {
      for (let p = base; p < height - 1; p++) put(x, baseP + p, z, fill);
      if (height > base) put(x, baseP + height - 1, z, cap);
    } else {
      for (let p = base; p < height; p++) {
        if (dir >= 0) { put(x, baseP + p, z, slopeFor(dir as 0 | 1 | 2 | 3, pattern)); slopeCells++; } else put(x, baseP + p, z, fill);
      }
    }
  }
  return { cells, slopeCells, apex, shape };
}
