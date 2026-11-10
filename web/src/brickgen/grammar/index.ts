/**
 * The grammar stage (A07 roofs, A08 facades; BIZ-05): `Massing` + `FeatureSet` -> `IntentLattice`, the input of the
 * X-10 bricker. It replaces the plain stand-in (`bricker/plain-massing.ts`: stepped hip roofs, no openings).
 *
 *  1. a two-plate base plate under the whole site (studs join only vertically, so buildings that merely touch
 *     side by side need it to be one model);
 *  2. per volume, lowest top first: shell (`wall.ts`), then its roof (`roof.ts`), cutting through what stood there;
 *  3. A9's features: openings, relief and trim (`facade.ts`), roofs' spires and pinnacles (`relief.ts`);
 *  4. cells cut off from the base plate by overlapping volumes are removed and counted.
 *
 * Everything is data-driven: shapes come from `RoofSpec` and `FeatureSpec`, idioms from `rules.ts`. No stage names a
 * building.
 */
import type { FeatureSet, IntentLattice, Massing, MassVolume } from '../types.js';
import { Canvas } from './canvas.js';
import { applyFeatures, strutVolumeIds, type FacadeStats } from './facade.js';
import { rasterise, type Mask } from './footprint.js';
import { styleKeyOf, STYLE_RULES } from './rules.js';
import { isSpire } from './spire.js';
import { buildRoof } from './roof.js';
import { buildShell, type ShellLabels } from './wall.js';
import type { Frame } from './frame.js';

export { STYLE_RULES, styleKeyOf } from './rules.js';
export type { Frame } from './frame.js';

/** Plate layers of the base plate every model stands on. */
export const BASE_PLATES = 2;
/** Studs of margin on every side of the massing, for buttresses and other relief that stands outside the footprint. */
export const PAD_STUDS = 4;
/** Plates of headroom above the tallest estimated roof. */
const HEADROOM = 8;

export interface GrammarOptions {
  /** Overrides for the colours taken from `FeatureSet.style` (LDraw codes). */
  colours?: Partial<{ wall: number; trim: number; roof: number; base: number }>;
}

export interface GrammarStats {
  volumes: number;
  /** Roofs built per shape. */
  roofs: Record<string, number>;
  /** Slope-labelled cells of all roofs. */
  slopeCells: number;
  facade: FacadeStats;
  /** Cells cut off from the base plate and removed. */
  stranded: number;
  /** Cells written past the lattice ceiling and dropped (should be 0). */
  clipped: number;
}

export interface GrammarResult {
  lattice: IntentLattice;
  /** What was simplified, dropped or guessed. */
  notes: string[];
  stats: GrammarStats;
  frame: Frame;
}

/** Plates a roof of `v` can rise above its walls, estimated from its pitch and span (for sizing the lattice). */
function roofRiseEstimate(v: MassVolume, mask: Mask, platesPerStud: number): number {
  if (v.roof.shape === 'flat') return 0;
  const pitch = Math.min(v.roof.pitchDeg ?? 30, 88.5);
  const half = Math.max(1, Math.min(mask.w, mask.d) / 2);
  return Math.ceil(Math.tan((pitch * Math.PI) / 180) * Math.max(0, half - 0.5) * platesPerStud) + 6;
}

/** Build the lattice of a massing and its features. */
export function buildGrammarLattice(massing: Massing, features: FeatureSet, options: GrammarOptions = {}): GrammarResult {
  const spm = massing.scale.studsPerMetre, ppm = massing.scale.platesPerMetre;
  const style = features.style;
  const rule = STYLE_RULES[styleKeyOf(style.era)];
  const colours = {
    wall: options.colours?.wall ?? style.wallColour,
    trim: options.colours?.trim ?? style.trimColour,
    roof: options.colours?.roof ?? style.roofColour,
    base: options.colours?.base ?? 19,
  };
  const frame: Frame = { spm, ppm, pad: PAD_STUDS, basePlates: BASE_PLATES };
  const platesPerStud = ppm / spm;
  const notes: string[] = [];

  // Size the lattice: the massing's bounds, a margin for relief, and room for the tallest roof.
  const masks = new Map<string, Mask>();
  let topPlates = Math.ceil(massing.boundsM[1][1] * ppm);
  for (const v of massing.volumes) {
    const m = rasterise(v, spm);
    if (!m) continue;
    masks.set(v.id, { ...m, x0: m.x0 + frame.pad, z0: m.z0 + frame.pad });
    topPlates = Math.max(topPlates, Math.round(v.topM * ppm) + roofRiseEstimate(v, m, platesPerStud));
  }
  const W = Math.round(massing.boundsM[1][0] * spm) + 2 * frame.pad;
  const D = Math.round(massing.boundsM[1][2] * spm) + 2 * frame.pad;
  const H = topPlates + BASE_PLATES + HEADROOM;
  const canvas = new Canvas(W, H, D);

  const shellLabels: ShellLabels = {
    floor: canvas.label({ role: 'floor', colour: colours.wall }),
    wall: canvas.label({ role: 'wall', colour: colours.wall }),
    cap: canvas.label({ role: 'roof-flat', colour: colours.wall }),
    trim: canvas.label({ role: 'trim', colour: colours.trim }),
    terrain: canvas.label({ role: 'terrain', colour: colours.base }),
  };
  canvas.box(0, 0, 0, W, BASE_PLATES, D, shellLabels.terrain);

  const volumes = [...massing.volumes].sort((a, b) => a.topM - b.topM || a.baseM - b.baseM);
  const stats: GrammarStats = { volumes: 0, roofs: {}, slopeCells: 0, facade: { openings: 0, relief: 0, skipped: 0, byKind: {} }, stranded: 0, clipped: 0 };
  let dropped = 0;
  const struts = strutVolumeIds(features);
  for (const v of volumes) {
    const mask = masks.get(v.id);
    if (struts.has(v.id)) continue; // drawn as a flying buttress by the facade grammar
    const baseP = Math.round(v.baseM * ppm) + BASE_PLATES, topP = Math.round(v.topM * ppm) + BASE_PLATES;
    if (!mask || topP <= baseP) { dropped++; continue; }
    stats.volumes++;
    const courses: number[] = [];
    if (v.role === 'tower' && rule.towerCourseM > 0) {
      const every = Math.max(4, Math.round(rule.towerCourseM * ppm));
      for (let c = every; c < topP - baseP - 4; c += every) courses.push(c);
    }
    buildShell(canvas, mask, shellLabels, { baseP, topP, grounded: baseP === BASE_PLATES, solid: v.role === 'terrain', stringCourses: courses });
    // Cut through whatever stood above this volume's ceiling; its own roof is drawn next.
    for (let j = 0; j < mask.d; j++) for (let i = 0; i < mask.w; i++) {
      if (mask.inside[i + mask.w * j]) canvas.column(mask.x0 + i, mask.z0 + j, topP, H, 0);
    }
    if (v.role === 'terrain') continue;
    const spire = isSpire(v.roof.shape, v.roof.pitchDeg, features.features, v.id);
    const dome = features.features.find(f => f.kind === 'dome' && f.volume === v.id);
    const r = buildRoof(canvas, mask, topP, {
      spec: v.roof, spire, platesPerStud, room: H - topP,
      ...(dome ? { apexPlates: Math.max(3, Math.round(dome.sizeM[1] * ppm)) } : {}),
    }, { slope: v.roof.colour ?? colours.roof, fill: v.roof.colour ?? colours.roof, gable: colours.wall });
    if (r.shape !== 'none') { stats.roofs[r.shape] = (stats.roofs[r.shape] ?? 0) + 1; stats.slopeCells += r.slopeCells; }
  }
  if (dropped) notes.push(`${dropped} volume(s) collapsed below one stud or one plate and were skipped`);

  stats.facade = applyFeatures({ canvas, frame, massing, features, masks, colours, style: styleKeyOf(style.era), notes });
  stats.stranded = canvas.removeStranded();
  if (stats.stranded) notes.push(`${stats.stranded} cell(s) cut off from the base plate by overlapping volumes were removed`);
  stats.clipped = canvas.clipped;
  if (canvas.clipped) notes.push(`${canvas.clipped} cell(s) above the lattice ceiling were dropped`);
  notes.push(`${stats.volumes} volumes; roofs: ${Object.entries(stats.roofs).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}; ${stats.slopeCells} slope cells`);
  return { lattice: canvas.toLattice(), notes, stats, frame };
}
