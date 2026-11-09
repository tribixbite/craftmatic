/**
 * Our own figure, design study (BIZ-21, WP-F01): the geometry and the
 * distinctness metric for candidate figures built ONLY from generic official
 * LDraw parts (round bricks, plates, cones, dishes) - no minifigure moulds.
 *
 * This module is pure (no fs, no network): a part resolver is passed in, so the
 * tests and `scripts/_figure_distinctness.ts` read the same code over the same
 * library. It holds
 *
 *  - a small LDraw flattener for figure files (type 1/3/4 lines, nested parts and
 *    primitives, colour inheritance) that tags every top-level part with the body
 *    group a `0 !CRAFTMATIC FIGPART <group>` meta names;
 *  - the minifigure composite the candidates are measured against, laid out from
 *    `MINIFIG_CANON` (minifig-rig.ts) so it is the figure the rest of the engine
 *    already treats as "the minifig";
 *  - the gate: front and side silhouette IoU after both are normalised to the same
 *    height (strictest of centred and best-shift alignment, so a lucky offset
 *    cannot hide an overlap), and the head/height and shoulder/height ratios;
 *  - a draft canon (neck, shoulders, hips, feet) read off the groups, for F02's
 *    `'brickling'` figure system (this module does NOT add that system);
 *  - a z-buffered orthographic renderer for the contact sheets.
 *
 * Frame: LDraw. Y is DOWN, the figure faces -Z, the sole is at y = 0 and the
 * crown at negative y (the minifig composite is shifted to match). Units: LDU.
 *
 * The numbers are evidence for the lawyer's file, not proof of non-infringement
 * (docs/plans/business-A-original-packs.md section 6).
 */
import { MINIFIG_CANON } from './minifig-rig.js';

export type V3 = [number, number, number];

/** The body groups a part can be tagged with; `other` is anything untagged. */
export type FigureGroup = 'head' | 'torso' | 'arm_right' | 'arm_left' | 'leg_right' | 'leg_left' | 'other';

const GROUPS: readonly FigureGroup[] = ['head', 'torso', 'arm_right', 'arm_left', 'leg_right', 'leg_left', 'other'];

/** One triangle of the flattened figure, with the top-level part it came from. */
export interface FigTri {
  a: V3; b: V3; c: V3;
  /** LDraw colour code (16 and 24 already resolved against the part's colour). */
  colour: number;
  group: FigureGroup;
  /** Index of the top-level type-1 line, so the renderer can outline parts. */
  partIndex: number;
}

/** Returns a part's `.dat` text by the name a type-1 line uses, or null when the library lacks it. */
export type PartResolver = (name: string) => string | null;

/** Row-major 3x3 + translation of an LDraw placement. */
interface Xform { m: readonly number[]; t: V3 }
const IDENT: Xform = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

const applyX = (x: Xform, p: V3): V3 => [
  x.m[0]! * p[0] + x.m[1]! * p[1] + x.m[2]! * p[2] + x.t[0],
  x.m[3]! * p[0] + x.m[4]! * p[1] + x.m[5]! * p[2] + x.t[1],
  x.m[6]! * p[0] + x.m[7]! * p[1] + x.m[8]! * p[2] + x.t[2],
];
const composeX = (outer: Xform, inner: Xform): Xform => {
  const m: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    m.push(outer.m[i * 3]! * inner.m[j]! + outer.m[i * 3 + 1]! * inner.m[3 + j]! + outer.m[i * 3 + 2]! * inner.m[6 + j]!);
  }
  return { m, t: applyX(outer, inner.t) };
};

/** The pending-group meta a figure file puts before the part it describes. */
const FIGPART_META = /^0\s+!CRAFTMATIC\s+FIGPART\s+(\w+)/;

/**
 * Flatten an LDraw figure file to triangles. A `0 !CRAFTMATIC FIGPART <group>`
 * line tags the NEXT type-1 line (and everything it expands to) with that group.
 * Throws when a part the file names is missing: a silently dropped part would
 * make a figure look thinner than it is and flatter the distinctness numbers.
 */
export function flattenFigure(ldr: string, resolve: PartResolver): FigTri[] {
  const out: FigTri[] = [];
  const cache = new Map<string, string[]>();
  const linesOf = (name: string): string[] => {
    const key = name.replace(/\\/g, '/').toLowerCase();
    let lines = cache.get(key);
    if (!lines) {
      const text = resolve(key);
      if (text === null) throw new Error(`figure-brickling: part "${name}" is not in the library`);
      lines = text.split(/\r?\n/);
      cache.set(key, lines);
    }
    return lines;
  };
  const walk = (lines: readonly string[], x: Xform, colour: number, group: FigureGroup, partIndex: () => number, top: boolean): void => {
    let pending: FigureGroup | null = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const f = line.split(/\s+/);
      const kind = f[0];
      if (kind === '0') {
        if (top) {
          const meta = FIGPART_META.exec(line);
          if (meta) {
            const g = meta[1] as FigureGroup;
            if (!GROUPS.includes(g)) throw new Error(`figure-brickling: unknown FIGPART group "${meta[1]}"`);
            pending = g;
          }
        }
      } else if (kind === '1' && f.length >= 15) {
        const n = f.slice(2, 14).map(Number);
        const sub: Xform = { m: n.slice(3, 12), t: [n[0]!, n[1]!, n[2]!] };
        const c = Number(f[1]);
        const childColour = c === 16 || c === 24 ? colour : c;
        const name = f.slice(14).join(' ');
        if (top) {
          const idx = partIndex();
          walk(linesOf(name), composeX(x, sub), childColour, pending ?? 'other', () => idx, false);
          pending = null;
        } else {
          walk(linesOf(name), composeX(x, sub), childColour, group, partIndex, false);
        }
      } else if (kind === '3' || kind === '4') {
        const n = f.slice(2).map(Number);
        const c = Number(f[1]);
        const col = c === 16 || c === 24 ? colour : c;
        const pts: V3[] = [];
        for (let i = 0; i + 2 < n.length && pts.length < (kind === '3' ? 3 : 4); i += 3) pts.push(applyX(x, [n[i]!, n[i + 1]!, n[i + 2]!]));
        const idx = partIndex();
        if (pts.length >= 3) out.push({ a: pts[0]!, b: pts[1]!, c: pts[2]!, colour: col, group, partIndex: idx });
        if (pts.length === 4) out.push({ a: pts[0]!, b: pts[2]!, c: pts[3]!, colour: col, group, partIndex: idx });
      }
    }
  };
  let counter = -1;
  walk(ldr.split(/\r?\n/), IDENT, 16, 'other', () => ++counter, true);
  return placeOnGround(out);
}

/** Shift a figure so its sole sits at y = 0 (LDraw Y is down, so the crown is negative). */
function placeOnGround(tris: FigTri[]): FigTri[] {
  let maxY = -Infinity;
  for (const t of tris) maxY = Math.max(maxY, t.a[1], t.b[1], t.c[1]);
  if (!Number.isFinite(maxY)) return tris;
  return tris.map(t => ({ ...t, a: [t.a[0], t.a[1] - maxY, t.a[2]], b: [t.b[0], t.b[1] - maxY, t.b[2]], c: [t.c[0], t.c[1] - maxY, t.c[2]] }));
}

// ─── The minifigure composite ───────────────────────────────────────────────

const row = (m: readonly number[]): string => m.join(' ');
const piece = (group: FigureGroup, colour: number, pos: readonly number[], rot: readonly number[], file: string): string =>
  `0 !CRAFTMATIC FIGPART ${group}\n1 ${colour} ${pos.join(' ')} ${row(rot)} ${file}`;

/**
 * The standard minifigure as LDraw text: head 3626b, torso 973, hips 3815, legs
 * 3816/3817, arms 3818/3819 and hands 3820, every one placed from
 * `MINIFIG_CANON` (torso-local LDU, the arms in their canonical 10 degree
 * turn). The reference every candidate is measured against.
 */
export function minifigReferenceLdr(): string {
  const c = MINIFIG_CANON;
  const I = c.torso.rotation;
  return [
    piece('head', 14, c.head.position, I, '3626b.dat'),
    piece('torso', 4, c.torso.position, I, '973.dat'),
    piece('torso', 1, c.hips.position, I, '3815.dat'),
    piece('leg_right', 1, c.leg_right.position, I, '3816.dat'),
    piece('leg_left', 1, c.leg_left.position, I, '3817.dat'),
    piece('arm_right', 4, c.arm_right.position, c.arm_right.rotation, '3818.dat'),
    piece('arm_left', 4, c.arm_left.position, c.arm_left.rotation, '3819.dat'),
    piece('arm_right', 14, c.hand_right.position, c.hand_right.rotation, '3820.dat'),
    piece('arm_left', 14, c.hand_left.position, c.hand_left.rotation, '3820.dat'),
  ].join('\n');
}

// ─── Silhouettes and the gate ───────────────────────────────────────────────

export type View = 'front' | 'side' | 'back';

/** A binary silhouette, row 0 at the TOP of the figure. */
export interface Silhouette { w: number; h: number; data: Uint8Array }

/** Screen u (right) and v (up) of a point for a view; the figure faces -Z. */
const project = (p: V3, view: View): [number, number] => {
  if (view === 'front') return [p[0], -p[1]];
  if (view === 'back') return [-p[0], -p[1]];
  return [-p[2], -p[1]];
};

/** Figure height in LDU, sole to crown. */
export function figureHeight(tris: readonly FigTri[]): number {
  let lo = Infinity, hi = -Infinity;
  for (const t of tris) for (const p of [t.a, t.b, t.c]) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
  return hi - lo;
}

/** The silhouette grid: `heightPx` tall and `widthPx` wide, centred on the bounding-box centre. */
export function silhouetteOf(tris: readonly FigTri[], view: View, heightPx = 240, widthPx = 240): Silhouette {
  let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
  for (const t of tris) for (const p of [t.a, t.b, t.c]) {
    const [u, v] = project(p, view);
    uLo = Math.min(uLo, u); uHi = Math.max(uHi, u); vLo = Math.min(vLo, v); vHi = Math.max(vHi, v);
  }
  const scale = heightPx / (vHi - vLo);
  const uMid = (uLo + uHi) / 2;
  const toPx = (p: V3): [number, number] => {
    const [u, v] = project(p, view);
    return [widthPx / 2 + (u - uMid) * scale, heightPx - (v - vLo) * scale];
  };
  const data = new Uint8Array(widthPx * heightPx);
  const EPS = 1e-9;
  for (const t of tris) {
    const [ax, ay] = toPx(t.a), [bx, by] = toPx(t.b), [cx, cy] = toPx(t.c);
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < EPS) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(widthPx - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(heightPx - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
      const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
      const l3 = 1 - l1 - l2;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) data[y * widthPx + x] = 1;
    }
  }
  return { w: widthPx, h: heightPx, data };
}

/** Intersection over union of two same-size silhouettes, `b` shifted `dx` pixels right. */
function iouShifted(a: Silhouette, b: Silhouette, dx: number): number {
  let inter = 0, union = 0;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const bx = x - dx;
    const va = a.data[y * a.w + x]!;
    const vb = bx >= 0 && bx < b.w ? b.data[y * b.w + bx]! : 0;
    if (va && vb) inter++;
    if (va || vb) union++;
  }
  // `b` pixels shifted out of frame still count toward the union.
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    const tx = x + dx;
    if (b.data[y * b.w + x]! && (tx < 0 || tx >= a.w)) union++;
  }
  return union === 0 ? 0 : inter / union;
}

/** The IoU of two silhouettes centred on their bounding boxes (the plain reading). */
export const silhouetteIou = (a: Silhouette, b: Silhouette): number => iouShifted(a, b, 0);

/**
 * The best IoU over horizontal shifts of up to `maxShiftPx`: what an adversary
 * who slid one outline over the other would find. The gate uses the larger of
 * this and the centred IoU.
 */
export function bestShiftIou(a: Silhouette, b: Silhouette, maxShiftPx = 24): number {
  let best = 0;
  for (let dx = -maxShiftPx; dx <= maxShiftPx; dx++) best = Math.max(best, iouShifted(a, b, dx));
  return best;
}

/** The two ratios the gate compares, as fractions of the figure's height. */
export interface FigureRatios {
  /** Vertical extent of the head group / total height. */
  headToHeight: number;
  /** Width of the upper quarter of the torso + arms (the shoulder line) / total height. */
  shoulderToHeight: number;
}

/** Vertices of the triangles in the given groups. */
function verticesOf(tris: readonly FigTri[], groups: readonly FigureGroup[]): V3[] {
  const pts: V3[] = [];
  for (const t of tris) if (groups.includes(t.group)) pts.push(t.a, t.b, t.c);
  return pts;
}

/** Head/height and shoulder/height of a tagged figure. Throws when the head or torso group is empty. */
export function figureRatios(tris: readonly FigTri[]): FigureRatios {
  const height = figureHeight(tris);
  const head = verticesOf(tris, ['head']);
  if (head.length === 0) throw new Error('figure-brickling: no head group');
  const headH = Math.max(...head.map(p => p[1])) - Math.min(...head.map(p => p[1]));
  const upper = verticesOf(tris, ['torso', 'arm_right', 'arm_left']);
  if (upper.length === 0) throw new Error('figure-brickling: no torso group');
  const top = Math.min(...upper.map(p => p[1])), bottom = Math.max(...upper.map(p => p[1]));
  const band = upper.filter(p => p[1] <= top + 0.25 * (bottom - top));
  const shoulderW = Math.max(...band.map(p => p[0])) - Math.min(...band.map(p => p[0]));
  return { headToHeight: headH / height, shoulderToHeight: shoulderW / height };
}

/** The distinctness numbers of one candidate against the minifig composite. */
export interface Distinctness {
  frontIou: number; sideIou: number;
  frontIouBestShift: number; sideIouBestShift: number;
  /** The larger (stricter) of centred and best-shift IoU per view. */
  frontGate: number; sideGate: number;
  candidate: FigureRatios; minifig: FigureRatios;
  /** |candidate - minifig| / minifig. */
  headRatioDifference: number; shoulderRatioDifference: number;
  heightLdu: number; minifigHeightLdu: number;
}

/** The thresholds of the gate (the brief, section 6 of plan A). */
export const DISTINCTNESS_GATE = { maxIou: 0.6, minRatioDifference: 0.25, heightLdu: [120, 140] as const };

/** Measure a candidate against the minifig composite (both normalised to the same height). */
export function measureDistinctness(candidate: readonly FigTri[], minifig: readonly FigTri[]): Distinctness {
  const view = (tris: readonly FigTri[], v: View): Silhouette => silhouetteOf(tris, v);
  const fc = view(candidate, 'front'), fm = view(minifig, 'front');
  const sc = view(candidate, 'side'), sm = view(minifig, 'side');
  const frontIou = silhouetteIou(fc, fm), sideIou = silhouetteIou(sc, sm);
  const frontIouBestShift = bestShiftIou(fc, fm), sideIouBestShift = bestShiftIou(sc, sm);
  const candidateRatios = figureRatios(candidate), minifigRatios = figureRatios(minifig);
  return {
    frontIou, sideIou, frontIouBestShift, sideIouBestShift,
    frontGate: Math.max(frontIou, frontIouBestShift), sideGate: Math.max(sideIou, sideIouBestShift),
    candidate: candidateRatios, minifig: minifigRatios,
    headRatioDifference: Math.abs(candidateRatios.headToHeight - minifigRatios.headToHeight) / minifigRatios.headToHeight,
    shoulderRatioDifference: Math.abs(candidateRatios.shoulderToHeight - minifigRatios.shoulderToHeight) / minifigRatios.shoulderToHeight,
    heightLdu: figureHeight(candidate), minifigHeightLdu: figureHeight(minifig),
  };
}

/** Whether a measurement clears every number of the gate. */
export function passesDistinctness(d: Distinctness): boolean {
  return d.frontGate < DISTINCTNESS_GATE.maxIou && d.sideGate < DISTINCTNESS_GATE.maxIou
    && d.headRatioDifference >= DISTINCTNESS_GATE.minRatioDifference
    && d.shoulderRatioDifference >= DISTINCTNESS_GATE.minRatioDifference
    && d.heightLdu >= DISTINCTNESS_GATE.heightLdu[0] && d.heightLdu <= DISTINCTNESS_GATE.heightLdu[1];
}

// ─── Draft canon and seat / walk compatibility ──────────────────────────────

/** Axis-aligned bounds of a group's vertices; null when the group is empty. */
export function groupBounds(tris: readonly FigTri[], group: FigureGroup): { lo: V3; hi: V3 } | null {
  const pts = verticesOf(tris, [group]);
  if (pts.length === 0) return null;
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, p[i]!); hi[i] = Math.max(hi[i]!, p[i]!); }
  return { lo, hi };
}

/**
 * The draft canon of a candidate, ground-frame LDU (y negative upwards): the
 * pivots F02 would turn into `BRICKLING_BONES` and the numbers its seat and
 * gait code needs. `hipY` is the height of the hip pivot over the sole, which is
 * the seat-pan height a seated figure's hips sit at.
 */
export interface FigureCanonDraft {
  heightLdu: number;
  /** Neck: bottom centre of the head. */
  neck: V3;
  shoulderRight: V3; shoulderLeft: V3;
  hipRight: V3; hipLeft: V3;
  /** Hip pivot height over the sole (positive up). */
  hipHeightLdu: number;
  /** Hip to sole: the leg length a gait and a seated thigh derive from. */
  legLengthLdu: number;
  /** Eye height over the sole (head centre). */
  eyeHeightLdu: number;
  /** Whole figure, arms included. */
  widthLdu: number; depthLdu: number;
  /** Widest of the torso group alone (the body a doorway must pass, arms hang or fold in). */
  bodyWidthLdu: number;
}

/** The Bedrock player's height in blocks: a figure scaled to the player stands this tall (lego-scale.ts, playable-addon.ts figure cap). */
export const PLAYER_HEIGHT_BLOCKS = 1.8;

/** Read the draft canon off a tagged figure; throws when a limb group is missing. */
export function draftCanon(tris: readonly FigTri[]): FigureCanonDraft {
  const need = (g: FigureGroup): { lo: V3; hi: V3 } => {
    const b = groupBounds(tris, g);
    if (!b) throw new Error(`figure-brickling: no ${g} group`);
    return b;
  };
  const head = need('head'), ar = need('arm_right'), al = need('arm_left'), lr = need('leg_right'), ll = need('leg_left');
  const mid = (b: { lo: V3; hi: V3 }, i: number): number => (b.lo[i]! + b.hi[i]!) / 2;
  const torso = need('torso');
  const hipTop = Math.min(lr.lo[1], ll.lo[1]);
  const all = { lo: [Infinity, Infinity, Infinity] as V3, hi: [-Infinity, -Infinity, -Infinity] as V3 };
  for (const g of GROUPS) {
    const b = groupBounds(tris, g);
    if (!b) continue;
    for (let i = 0; i < 3; i++) { all.lo[i] = Math.min(all.lo[i]!, b.lo[i]!); all.hi[i] = Math.max(all.hi[i]!, b.hi[i]!); }
  }
  return {
    heightLdu: figureHeight(tris),
    neck: [mid(head, 0), head.hi[1], mid(head, 2)],
    shoulderRight: [mid(ar, 0), ar.lo[1], mid(ar, 2)], shoulderLeft: [mid(al, 0), al.lo[1], mid(al, 2)],
    hipRight: [mid(lr, 0), hipTop, mid(lr, 2)], hipLeft: [mid(ll, 0), hipTop, mid(ll, 2)],
    hipHeightLdu: -hipTop,
    legLengthLdu: -hipTop,
    eyeHeightLdu: -mid(head, 1),
    widthLdu: all.hi[0] - all.lo[0], depthLdu: all.hi[2] - all.lo[2],
    bodyWidthLdu: torso.hi[0] - torso.lo[0],
  };
}

/** A stud stands 4 LDU proud of its brick, so stacked parts' boxes interpenetrate by up to that much. */
const STUD_LDU = 4;

/** Whether two boxes share real volume: more than a stud's depth along EVERY axis (touching or stud-seated parts do not count). */
const overlapVolume = (a: { lo: V3; hi: V3 }, b: { lo: V3; hi: V3 }): boolean =>
  [0, 1, 2].every(i => Math.min(a.hi[i]!, b.hi[i]!) - Math.max(a.lo[i]!, b.lo[i]!) > STUD_LDU + 0.5);

/** One failed seat / walk requirement, empty list = compatible. */
export function compatibilityProblems(tris: readonly FigTri[]): string[] {
  const problems: string[] = [];
  const names: FigureGroup[] = ['head', 'torso', 'arm_right', 'arm_left', 'leg_right', 'leg_left'];
  const b = Object.fromEntries(names.map(n => [n, groupBounds(tris, n)])) as Record<string, { lo: V3; hi: V3 } | null>;
  for (const n of names) if (!b[n]) problems.push(`missing group ${n}`);
  if (problems.length) return problems;
  const g = (n: string): { lo: V3; hi: V3 } => b[n]!;
  // Bones turn separately, so no limb may share volume with the torso or its twin.
  for (const limb of ['arm_right', 'arm_left', 'leg_right', 'leg_left']) {
    if (overlapVolume(g(limb), g('torso'))) problems.push(`${limb} overlaps the torso`);
  }
  if (overlapVolume(g('leg_right'), g('leg_left'))) problems.push('the legs overlap (they could not swing apart)');
  if (overlapVolume(g('arm_right'), g('arm_left'))) problems.push('the arms overlap');
  // Right is -X, as the minifig rig has it.
  if (!(g('arm_right').hi[0] < g('arm_left').lo[0] + 0.01)) problems.push('arm_right is not on the -X side');
  if (!(g('leg_right').hi[0] < g('leg_left').lo[0] + 0.01)) problems.push('leg_right is not on the -X side');
  // Sitting: the legs must reach a seat pan from the hips, and the head clear the torso.
  const canon = draftCanon(tris);
  if (canon.legLengthLdu < 32) problems.push(`legs ${canon.legLengthLdu} LDU long: too short to sit and gait`);
  if (g('head').lo[1] > g('torso').lo[1]) problems.push('the head top is lower than the torso top');
  // Mirror symmetry of the limbs (a walk cycle swings them as mirror twins).
  const wr = g('arm_right').hi[0] - g('arm_right').lo[0], wl = g('arm_left').hi[0] - g('arm_left').lo[0];
  if (Math.abs(wr - wl) > 1) problems.push('the arms are not mirror twins');
  return problems;
}

// ─── Orthographic renderer for the contact sheets ───────────────────────────

/** LDraw colour code to sRGB; unknown codes draw mid grey. */
const COLOURS: Record<number, V3> = {
  0: [27, 42, 52], 1: [0, 85, 191], 2: [35, 120, 65], 4: [201, 26, 9], 5: [200, 80, 155], 6: [88, 42, 18], 7: [155, 161, 157],
  8: [99, 95, 82], 10: [75, 159, 74], 11: [5, 157, 165], 14: [242, 205, 55], 15: [244, 244, 244], 19: [228, 205, 158],
  25: [254, 138, 24], 26: [146, 57, 120], 28: [149, 138, 115], 70: [105, 64, 39], 71: [163, 162, 164], 72: [99, 95, 98],
  73: [90, 147, 219], 272: [32, 58, 86], 288: [39, 70, 44], 320: [123, 46, 47], 378: [160, 188, 172], 484: [145, 80, 28],
};
const colourOf = (code: number): V3 => COLOURS[code] ?? [140, 140, 140];

/**
 * Render a figure orthographically into an RGB buffer (`width` x `height`, the
 * figure fitted to `heightPx` tall at the bottom): a z-buffer, flat shading from a
 * headlight plus a fixed key light, and a dark outline wherever the part index or
 * depth jumps, so the separate bricks read.
 */
export function renderFigure(tris: readonly FigTri[], view: View, width: number, height: number, heightPx: number): Uint8Array {
  let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
  for (const t of tris) for (const p of [t.a, t.b, t.c]) {
    const [u, v] = project(p, view);
    uLo = Math.min(uLo, u); uHi = Math.max(uHi, u); vLo = Math.min(vLo, v); vHi = Math.max(vHi, v);
  }
  const scale = heightPx / (vHi - vLo);
  const uMid = (uLo + uHi) / 2;
  const base = height - Math.round((height - heightPx) / 2);
  // View depth: distance toward the viewer along the camera axis (larger = nearer).
  const depthOf = (p: V3): number => view === 'side' ? -p[0] : view === 'front' ? -p[2] : p[2];
  const rgb = new Uint8Array(width * height * 3).fill(0);
  for (let i = 0; i < width * height; i++) { rgb[i * 3] = 24; rgb[i * 3 + 1] = 27; rgb[i * 3 + 2] = 33; }
  const zbuf = new Float32Array(width * height).fill(-Infinity);
  const ids = new Int32Array(width * height).fill(-1);
  const toPx = (p: V3): [number, number] => {
    const [u, v] = project(p, view);
    return [width / 2 + (u - uMid) * scale, base - (v - vLo) * scale];
  };
  const light: V3 = [-0.35, -0.6, -0.72];
  const lightLen = Math.hypot(...light);
  for (const t of tris) {
    const e1: V3 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], e2: V3 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
    let n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nl = Math.hypot(...n);
    if (nl < 1e-9) continue;
    n = [n[0] / nl, n[1] / nl, n[2] / nl];
    // Two-sided: flip toward the viewer (normal dotted with the view-depth direction).
    const toViewer: V3 = view === 'side' ? [-1, 0, 0] : view === 'front' ? [0, 0, -1] : [0, 0, 1];
    if (n[0] * toViewer[0] + n[1] * toViewer[1] + n[2] * toViewer[2] < 0) n = [-n[0], -n[1], -n[2]];
    const head = n[0] * toViewer[0] + n[1] * toViewer[1] + n[2] * toViewer[2];
    const key = Math.max(0, -(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / lightLen);
    const shade = 0.38 + 0.37 * head + 0.35 * key;
    const col = colourOf(t.colour);
    const [ax, ay] = toPx(t.a), [bx, by] = toPx(t.b), [cx, cy] = toPx(t.c);
    const za = depthOf(t.a), zb = depthOf(t.b), zc = depthOf(t.c);
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
      const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const z = l1 * za + l2 * zb + l3 * zc;
      const k = y * width + x;
      if (z <= zbuf[k]!) continue;
      zbuf[k] = z; ids[k] = t.partIndex;
      for (let ch = 0; ch < 3; ch++) rgb[k * 3 + ch] = Math.min(255, Math.round(col[ch]! * shade));
    }
  }
  // Outline: darken a pixel whose part index differs from the pixel to its right/below (or from the background).
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const k = y * width + x;
    if (ids[k] !== ids[k + 1] || ids[k] !== ids[k + width]) {
      const front = ids[k] !== -1 ? k : (ids[k + 1] !== -1 ? k + 1 : k + width);
      if (ids[front] === -1) continue;
      for (let ch = 0; ch < 3; ch++) rgb[front * 3 + ch] = Math.round(rgb[front * 3 + ch]! * 0.35);
    }
  }
  return rgb;
}
