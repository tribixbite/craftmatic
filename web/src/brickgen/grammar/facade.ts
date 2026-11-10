/**
 * Facade grammars (A08, BIZ-05): A9's `FeatureSpec`s on the volumes' walls become openings (window, arch, door, portal,
 * rose), relief (buttresses, pilasters, cornices, balustrades, battlements, balconies, gargoyles, statues, pinnacles,
 * chimneys) and flying buttresses in the lattice.
 *
 * DATA-DRIVEN: `HANDLERS` maps a feature kind to a handler, `rules.ts` maps (style, kind) to the shape of its head. A
 * new idiom is a row, not a branch. Features with no handler (`lattice`, `cable`, `stair`, ...) are counted as skipped
 * with their kind in the notes, never silently dropped.
 *
 * Features whose shape is a ROOF (`spire`, `dome`, pyramid pinnacles with no edge) are built by `roof.ts` from the
 * volume's `RoofSpec`; here they are counted as `covered by roof`.
 */
import type { FeatureKind, FeatureSet, FeatureSpec, Massing, MassVolume } from '../types.js';
import type { Canvas } from './canvas.js';
import { openingMask, roseMask } from './arch.js';
import type { Frame } from './frame.js';
import { cellOf, plateOf } from './frame.js';
import type { Mask } from './footprint.js';
import { buttressDepth, placeBox, placePinnacle, placeRelief, placeStrut, type ReliefContext } from './relief.js';
import { openingRule, type StyleKey } from './rules.js';
import { cutOpening, edgeFrames, paintRow, runCentres, volumeLevels, type EdgeFrame } from './window.js';

export interface FacadeStats {
  /** Opening cells cut and openings made. */
  openings: number;
  /** Relief features built. */
  relief: number;
  skipped: number;
  /** Features handled per kind. */
  byKind: Record<string, number>;
}

export interface FacadeContext {
  canvas: Canvas;
  frame: Frame;
  massing: Massing;
  features: FeatureSet;
  masks: Map<string, Mask>;
  colours: { wall: number; trim: number; roof: number; base: number };
  style: StyleKey;
  notes: string[];
}

/** A feature kind that is built by the roof grammar. */
const ROOF_KINDS: ReadonlySet<FeatureKind> = new Set<FeatureKind>(['spire', 'dome']);

/** The volumes a flying-buttress feature stands for: they are drawn as struts, not as boxes with roofs. */
export function strutVolumeIds(features: FeatureSet): Set<string> {
  return new Set(features.features.filter(f => f.kind === 'flying-buttress' && f.edge === undefined).map(f => f.volume));
}

/** What a handler sees. */
interface Job {
  ctx: FacadeContext;
  relief: ReliefContext;
  f: FeatureSpec;
  v: MassVolume;
  ef: EdgeFrame | undefined;
  labels: Labels;
}

interface Labels { window: number; trim: number; wall: number; bar: number; cone: number; accent: number }

/** Result of a handler: how many openings / relief pieces it made, or why it made none. */
type Outcome = { openings?: number; relief?: number; skip?: string };
type Handler = (job: Job) => Outcome;

/** Opening handler: a run of openings (window, lancet, door, portal, arcade) with the style's head. */
const opening: Handler = ({ ctx, f, v, ef, labels }) => {
  if (!ef) return { skip: 'no edge' };
  const { frame, canvas } = ctx;
  const rule = openingRule(ctx.style, f.kind);
  const w = Math.max(1, Math.round(f.sizeM[0] * frame.spm));
  const h = Math.max(2, Math.round(f.sizeM[1] * frame.ppm));
  const { wallFrom, topP } = volumeLevels(v, frame);
  const p0 = Math.max(plateOf(frame, f.atM[1]), wallFrom + (rule.sill > 0 ? rule.sill : 0));
  const mask = openingMask(w, h, rule.head, rule.headFraction, frame.ppm / frame.spm);
  let made = 0, lastEnd = -Infinity;
  for (const c of runCentres(f.atM[0], f.count, f.spacingM)) {
    // Keep a pier of at least one stud between the items of a run, so they stay separate openings.
    let u0 = Math.round(c * frame.spm - w / 2);
    let ww = w, m = mask;
    if (u0 < lastEnd + 1) {
      ww = w - (lastEnd + 1 - u0);
      u0 = lastEnd + 1;
      if (ww < 1) continue;
      m = openingMask(ww, h, rule.head, rule.headFraction, frame.ppm / frame.spm);
    }
    const cut = cutOpening(canvas, ef, u0, p0, ww, Math.min(h, topP - 3 - p0), m, labels.window);
    if (cut === 0) continue;
    lastEnd = u0 + ww;
    made++;
    if (rule.sill > 0) paintRow(canvas, ef, u0, ww, p0 - 1, labels.trim);
  }
  return made ? { openings: made } : { skip: 'wall hidden' };
};

/** Rose window: a disc of open cells with vertical mullions. */
const rose: Handler = ({ ctx, f, v, ef, labels }) => {
  if (!ef) return { skip: 'no edge' };
  const { frame, canvas } = ctx;
  const diameter = Math.max(1, Math.round(Math.max(f.sizeM[0], f.sizeM[1]) * frame.spm));
  const { mask, bars, w, h } = roseMask(diameter, frame.ppm / frame.spm, diameter >= 7 ? 3 : diameter >= 3 ? 1 : 0);
  const p0 = Math.max(plateOf(frame, f.atM[1]), volumeLevels(v, frame).wallFrom);
  const u0 = Math.round(f.atM[0] * frame.spm - w / 2);
  const cut = cutOpening(canvas, ef, u0, p0, w, h, mask, labels.window);
  if (!cut) return { skip: 'wall hidden' };
  cutOpening(canvas, ef, u0, p0, w, h, bars, labels.bar);
  return { openings: 1 };
};

/** Clock: a disc of accent colour on the wall (no hole). */
const clock: Handler = ({ ctx, f, ef, v, labels }) => {
  if (!ef) return { skip: 'no edge' };
  const { frame, canvas } = ctx;
  const d = Math.max(2, Math.round(f.sizeM[0] * frame.spm));
  const { mask, w, h } = roseMask(d, frame.ppm / frame.spm, 0);
  const p0 = Math.max(plateOf(frame, f.atM[1]), volumeLevels(v, frame).wallFrom);
  return cutOpening(canvas, ef, Math.round(f.atM[0] * frame.spm - w / 2), p0, w, h, mask, labels.accent) ? { relief: 1 } : { skip: 'wall hidden' };
};

/** A relief profile: how far out, how tall, which cells. */
interface ReliefShape {
  /** Depth studs from the feature's depth; `min` when it is shallower. */
  minDepth: number;
  /** Plate rows (`undefined` = the feature's own height, clamped to `maxRows`). */
  rows?: number;
  maxRows?: number;
  /** Set back towards the top like a buttress. */
  stepped?: boolean;
  /** Only every n-th stud (balusters, merlons). */
  every?: number;
  /** Start at the ground (a buttress) instead of the feature's height. */
  fromGround?: boolean;
  /** Which label. */
  label: keyof Labels;
}

const reliefHandler = (shape: ReliefShape): Handler => ({ ctx, relief, f, v, ef, labels }) => {
  if (!ef) return { skip: 'no edge' };
  const { frame } = ctx;
  const w = Math.max(1, Math.round(f.sizeM[0] * frame.spm));
  const depthMax = Math.max(shape.minDepth, Math.round(f.sizeM[2] * frame.spm));
  const { topP, wallFrom } = volumeLevels(v, frame);
  const p0 = shape.fromGround ? wallFrom : Math.max(plateOf(frame, f.atM[1]), wallFrom);
  const rows = shape.rows ?? Math.max(1, Math.min(shape.maxRows ?? 1e9, Math.round(f.sizeM[1] * frame.ppm)));
  const p1 = Math.min(shape.fromGround ? Math.round(f.sizeM[1] * frame.ppm) + p0 : p0 + rows, shape.stepped ? topP + 3 : topP + 10);
  const depthAt = shape.stepped ? buttressDepth(depthMax) : () => depthMax;
  let made = 0;
  for (const c of runCentres(f.atM[0], f.count, f.spacingM)) {
    made += placeRelief(relief, ef, Math.round(c * frame.spm - w / 2), w, p0, Math.max(p0 + 1, p1), depthAt, labels[shape.label], shape.every ?? 1) > 0 ? 1 : 0;
  }
  return made ? { relief: made } : { skip: 'wall hidden' };
};

/** Battlement: merlons standing on the wall top, every other stud. */
const battlement: Handler = ({ f, v, ef, ctx, labels }) => {
  if (!ef) return { skip: 'no edge' };
  const { frame } = ctx;
  const { topP } = volumeLevels(v, frame);
  const w = Math.max(1, Math.round(f.sizeM[0] * frame.spm));
  // The merlons stand on the ceiling cap, which `isWall` does not take: place them directly.
  let n = 0;
  for (let col = 0; col < w; col += 2) {
    const u = Math.round(f.atM[0] * frame.spm - w / 2) + col;
    if (u < 0 || u >= ef.studs) continue;
    const [x, z] = ef.cell(u, 0);
    for (let p = topP; p < topP + 3; p++) if (ctx.canvas.get(x, p, z) === 0) { ctx.canvas.set(x, p, z, labels.wall); n++; }
  }
  return n ? { relief: 1 } : { skip: 'no wall' };
};

/** Pinnacle: a shaft and a cone on the wall top, from an edge position. */
const pinnacle: Handler = ({ ctx, relief, f, v, ef, labels }) => {
  const { frame } = ctx;
  if (!ef) return { skip: 'covered by roof' }; // a world-positioned pinnacle is the pyramid roof of its own volume
  const w = Math.max(1, Math.round(Math.max(f.sizeM[0], f.sizeM[2]) * frame.spm));
  const h = Math.max(3, Math.round(f.sizeM[1] * frame.ppm));
  const p0 = Math.max(plateOf(frame, f.atM[1]), volumeLevels(v, frame).topP - 1);
  return placePinnacle(relief, ef, f.atM[0] * frame.spm, w, p0, h, labels.wall, labels.cone) ? { relief: 1 } : { skip: 'nothing placed' };
};

/** Chimney and lantern: a solid box on the volume's top, from a world position. */
const stack: Handler = ({ ctx, relief, f, v, labels }) => {
  const { frame } = ctx;
  const w = Math.max(1, Math.round(f.sizeM[0] * frame.spm)), d = Math.max(1, Math.round(f.sizeM[2] * frame.spm));
  const x0 = cellOf(frame, f.atM[0]) - Math.floor(w / 2), z0 = cellOf(frame, f.atM[2]) - Math.floor(d / 2);
  const p0 = Math.max(plateOf(frame, f.atM[1]), volumeLevels(v, frame).topP);
  return placeBox(relief, x0, z0, w, d, p0, p0 + Math.max(2, Math.round(f.sizeM[1] * frame.ppm)), labels.trim) ? { relief: 1 } : { skip: 'nothing placed' };
};

/** The table: kind -> handler. Shapes of relief are rows of `reliefHandler`. */
export const HANDLERS: Readonly<Partial<Record<FeatureKind, Handler>>> = {
  window: opening, lancet: opening, door: opening, portal: opening, arcade: opening,
  rose, clock, battlement, pinnacle, chimney: stack, lantern: stack,
  buttress: reliefHandler({ minDepth: 2, stepped: true, fromGround: true, label: 'wall' }),
  pilaster: reliefHandler({ minDepth: 1, fromGround: true, label: 'wall' }),
  column: reliefHandler({ minDepth: 1, fromGround: true, label: 'wall' }),
  cornice: reliefHandler({ minDepth: 1, maxRows: 3, label: 'trim' }),
  balustrade: reliefHandler({ minDepth: 1, maxRows: 4, every: 2, label: 'trim' }),
  balcony: reliefHandler({ minDepth: 2, rows: 1, label: 'trim' }),
  gargoyle: reliefHandler({ minDepth: 2, maxRows: 2, label: 'trim' }),
  statue: reliefHandler({ minDepth: 1, maxRows: 6, label: 'trim' }),
};

/** Apply every feature. Unhandled kinds are skipped and listed in the notes. */
export function applyFeatures(ctx: FacadeContext): FacadeStats {
  const { canvas, frame, features, massing } = ctx;
  const stats: FacadeStats = { openings: 0, relief: 0, skipped: 0, byKind: {} };
  const relief: ReliefContext = { canvas, frame };
  const labels: Labels = {
    window: canvas.label({ role: 'window', colour: ctx.colours.trim }),
    trim: canvas.label({ role: 'trim', colour: ctx.colours.trim }),
    wall: canvas.label({ role: 'wall', colour: ctx.colours.wall }),
    bar: canvas.label({ role: 'wall', colour: ctx.colours.trim }),
    cone: canvas.label({ role: 'roof-slope', colour: ctx.colours.roof, feature: 'cone' }),
    accent: canvas.label({ role: 'trim', colour: 15 }),
  };
  const byId = new Map(massing.volumes.map(v => [v.id, v]));
  const frames = new Map<string, Map<number, EdgeFrame>>();
  const unhandled = new Map<string, number>();
  const count = (kind: string): void => { stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1; };

  // Struts first: they are volumes drawn as flying buttresses; everything else may stand on or beside them.
  for (const f of features.features) {
    if (f.kind !== 'flying-buttress' || f.edge !== undefined) continue;
    const v = byId.get(f.volume), mask = ctx.masks.get(f.volume);
    if (!v || !mask) { stats.skipped++; continue; }
    const n = placeStrut(relief, { volume: v, mask, dropPlates: Math.round(f.sizeM[1] * frame.ppm), label: labels.wall });
    if (n > 0) { stats.relief++; count('flying-buttress'); } else stats.skipped++;
  }
  // Relief before openings: an opening cut after a pilaster is placed still takes its wall cell.
  const order = (k: FeatureKind): number => (HANDLERS[k] === undefined ? 3 : ['window', 'lancet', 'door', 'portal', 'arcade', 'rose', 'clock'].includes(k) ? 1 : 0);
  const sorted = features.features.filter(f => !(f.kind === 'flying-buttress' && f.edge === undefined)).sort((a, b) => order(a.kind) - order(b.kind));
  for (const f of sorted) {
    if (ROOF_KINDS.has(f.kind)) { count(`${f.kind} (roof)`); continue; }
    const handler = HANDLERS[f.kind];
    if (!handler) { stats.skipped++; unhandled.set(f.kind, (unhandled.get(f.kind) ?? 0) + 1); continue; }
    const v = byId.get(f.volume);
    if (!v) { stats.skipped++; continue; }
    let efs = frames.get(v.id);
    if (!efs) { efs = edgeFrames(v, frame); frames.set(v.id, efs); }
    const out = handler({ ctx, relief, f, v, ef: f.edge === undefined ? undefined : efs.get(f.edge), labels });
    if (out.skip) { stats.skipped++; if (out.skip !== 'covered by roof') unhandled.set(`${f.kind}: ${out.skip}`, (unhandled.get(`${f.kind}: ${out.skip}`) ?? 0) + 1); continue; }
    stats.openings += out.openings ?? 0;
    stats.relief += out.relief ?? 0;
    count(f.kind);
  }
  if (unhandled.size) ctx.notes.push(`features not built: ${[...unhandled].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  return stats;
}
