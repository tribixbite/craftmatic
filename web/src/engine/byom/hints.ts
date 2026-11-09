/**
 * `ByomHints` (B03, BIZ-31): what a creator who brings their own model says about it.
 *
 * In explicit mode (`PackProfile.flags.explicitOnly`, X-17) no title or set number decides anything;
 * the creator's hints do. They name WHAT is a vehicle (a selector over the model's own parts, a kind,
 * a nose and a seat count) and which parts may become doors and seats. Three steps, all pure:
 *
 *  1. `parseByomHints(raw)`   the JSON (a `<stem>.byom.json` beside the file, or the UI's state) is
 *                             checked and normalised; every fault is one message with its path.
 *  2. `resolveByomHints(h,b)` the selectors are resolved over the model's placements; a selector that
 *                             matches nothing, or a part claimed twice, is an error naming it.
 *  3. `byomComponentsFromHints` the resolved vehicles become the pipeline's `PlayableBrickComponent`s
 *                             (kind, nose, seats and motion explicit), replacing every title-derived one.
 *
 * Nothing here reads the clock, the disk or the network, so it runs in the Worker, Bun and vitest.
 */
import type { ParsedBrick } from '../ldraw-parser.js';
import type { AddonScaleChoice } from '../addon-scale.js';
import type { VehicleMotion } from '../bedrock-vehicle.js';
import { withPlayableBounds, type PlayableBrickComponent, type PlayableKind, type VehicleFacing } from '../playable-components.js';

export type ByomVec3 = [number, number, number];

/** Which of the model's placements a hint is about. */
export type ByomSelector =
  /** Every placement made inside the named MPD / `.io` sub-model (nested ones included). */
  | { submodel: string }
  /** Indices into the imported model's placements (`ImportedModel.bricks`). */
  | { brickIndices: number[] }
  /** Placements whose origin lies inside the box, LDraw units, both corners inclusive. */
  | { box: [ByomVec3, ByomVec3] };

/** What a creator can say a component is. `flyer` and `coaster-car` are named by the plan and refused for now. */
export const BYOM_COMPONENT_KINDS = ['car', 'plane', 'boat', 'hover', 'flyer', 'static', 'coaster-car'] as const;
export type ByomComponentKind = (typeof BYOM_COMPONENT_KINDS)[number];
/** The kinds the converter builds today. */
export type ByomBuildableKind = 'car' | 'plane' | 'boat' | 'hover' | 'static';

export type ByomFacing = Exclude<VehicleFacing, 'auto'>;

export interface ByomComponentHint {
  select: ByomSelector;
  kind: ByomComponentKind;
  /** The nose, in the model's own axes. Absent: the compiler measures it from the parts. */
  facing?: ByomFacing;
  /** 1, 2 or 4 (the layouts the rideable emitter has). Absent: the engine default. */
  seats?: number;
  /** Player-facing name. Absent: the title (one component) or `<title> <sub-model>`. */
  label?: string;
}

/** Which detected doors / seats may ship: all of them, none, or only those on the selected parts. */
export type ByomSceneRule = 'detect' | 'none' | { select: ByomSelector };

/** A door / seat / slide / lift on a mesh or photo model, by position. Validated and carried; the legolizer (B13) applies it. */
export interface ByomFeatureHint { kind: 'door' | 'seat' | 'slide' | 'lift'; at: ByomVec3; yaw: number; size?: ByomVec3 }

export interface ByomHints {
  /** Player-facing name; never parsed for set numbers or vehicle words. */
  title: string;
  /** `<creator>_<pack>`, `[a-z0-9_]{3,32}`; applied by the id rewriter (X-03) through the pack profile. */
  namespace: string;
  components: ByomComponentHint[];
  features: ByomFeatureHint[];
  /** The model's scale choice (engine/addon-scale.ts); the caller feeds it to `planAddonScale`. */
  scale: AddonScaleChoice;
  figures: 'keep' | 'none';
  doors: ByomSceneRule;
  seats: ByomSceneRule;
}

/** Thrown by the pipeline when hints are refused: every message, one per line. */
export class ByomHintsError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`The creator hints were refused:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'ByomHintsError';
  }
}

export type ByomHintsParse = { ok: true; hints: ByomHints } | { ok: false; errors: string[] };

const NAMESPACE = /^[a-z0-9_]{3,32}$/;
const FACINGS: readonly ByomFacing[] = ['+x', '-x', '+z', '-z'];
const SEAT_LAYOUTS = [1, 2, 4];
const SCALES: readonly AddonScaleChoice[] = ['auto', '0.25', '0.5', '0.75', '1', '1.5', '2', '3', '4'];
const FEATURE_KINDS = ['door', 'seat', 'slide', 'lift'] as const;
const TOP_KEYS = ['title', 'namespace', 'components', 'features', 'scale', 'figures', 'doors', 'seats'];
const COMPONENT_KEYS = ['select', 'kind', 'facing', 'seats', 'label'];
/** Kinds the plan names that the converter cannot build yet, and where they are coming from. */
const UNSUPPORTED_KINDS: Readonly<Record<string, string>> = {
  flyer: 'a flyer is a figure\'s mount and needs the mount rig (set canon today); TODO(B03-flyer) a hint-driven mount',
  'coaster-car': 'a coaster car runs on a track; TODO(C02) hinted coaster tracks (B13/C02)',
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isVec3 = (v: unknown): v is ByomVec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const quote = (v: unknown): string => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

/** One selector, or its faults (each prefixed with `path`). */
function parseSelector(raw: unknown, path: string, errors: string[]): ByomSelector | null {
  if (!isObject(raw) || Object.keys(raw).filter(k => ['submodel', 'brickIndices', 'box'].includes(k)).length !== 1 || Object.keys(raw).length !== 1) {
    errors.push(`${path}: must have exactly one of "submodel", "brickIndices" or "box" (got ${quote(raw)}).`);
    return null;
  }
  if ('submodel' in raw) {
    if (typeof raw.submodel !== 'string' || !raw.submodel.trim()) { errors.push(`${path}.submodel: must be a non-empty sub-model name.`); return null; }
    return { submodel: raw.submodel };
  }
  if ('brickIndices' in raw) {
    const idx = raw.brickIndices;
    if (!Array.isArray(idx) || !idx.length || !idx.every(i => Number.isInteger(i) && (i as number) >= 0)) {
      errors.push(`${path}.brickIndices: must be a non-empty list of whole numbers >= 0.`);
      return null;
    }
    return { brickIndices: idx as number[] };
  }
  const box = raw.box;
  if (!Array.isArray(box) || box.length !== 2 || !isVec3(box[0]) || !isVec3(box[1])) { errors.push(`${path}.box: must be [[x, y, z], [x, y, z]] in LDraw units.`); return null; }
  const [lo, hi] = box as [ByomVec3, ByomVec3];
  if (lo.some((v, i) => v > hi[i]!)) { errors.push(`${path}.box: the first corner must be the min on every axis (got ${JSON.stringify(box)}).`); return null; }
  return { box: [[...lo], [...hi]] };
}

function parseComponent(raw: unknown, i: number, errors: string[]): ByomComponentHint | null {
  const path = `components[${i}]`;
  if (!isObject(raw)) { errors.push(`${path}: must be an object.`); return null; }
  const before = errors.length;
  for (const k of Object.keys(raw)) if (!COMPONENT_KEYS.includes(k)) errors.push(`${path}: unknown key "${k}" (expected ${COMPONENT_KEYS.join(', ')}).`);
  const select = parseSelector(raw.select, `${path}.select`, errors);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(BYOM_COMPONENT_KINDS as readonly string[]).includes(kind)) {
    errors.push(`${path}.kind: ${quote(kind)} is not one of ${BYOM_COMPONENT_KINDS.join(', ')}.`);
  } else if (kind in UNSUPPORTED_KINDS) {
    errors.push(`${path}.kind: "${kind}" is not supported yet: ${UNSUPPORTED_KINDS[kind]}.`);
  }
  if (raw.facing !== undefined && !FACINGS.includes(raw.facing as ByomFacing)) errors.push(`${path}.facing: ${quote(raw.facing)} is not one of ${FACINGS.join(', ')}.`);
  if (raw.seats !== undefined && !SEAT_LAYOUTS.includes(raw.seats as number)) errors.push(`${path}.seats: ${quote(raw.seats)} is not a layout the converter has: 1, 2 or 4.`);
  if (raw.label !== undefined && (typeof raw.label !== 'string' || !raw.label.trim())) errors.push(`${path}.label: must be a non-empty string.`);
  if (errors.length > before || !select) return null;
  return {
    select, kind: kind as ByomComponentKind,
    ...(raw.facing !== undefined ? { facing: raw.facing as ByomFacing } : {}),
    ...(raw.seats !== undefined ? { seats: raw.seats as number } : {}),
    ...(raw.label !== undefined ? { label: (raw.label as string).trim() } : {}),
  };
}

function parseSceneRule(raw: unknown, key: 'doors' | 'seats', errors: string[]): ByomSceneRule {
  if (raw === undefined || raw === 'detect') return 'detect';
  if (raw === 'none') return 'none';
  if (isObject(raw) && Object.keys(raw).length === 1 && 'select' in raw) {
    const select = parseSelector(raw.select, `${key}.select`, errors);
    return select ? { select } : 'detect';
  }
  errors.push(`${key}: must be "detect", "none" or { "select": <selector> } (got ${quote(raw)}).`);
  return 'detect';
}

/** Check and normalise a hints JSON: defaults filled, unknown keys refused, every fault named with its path. */
export function parseByomHints(raw: unknown): ByomHintsParse {
  if (!isObject(raw)) return { ok: false, errors: ['The hints must be a JSON object.'] };
  const errors: string[] = [];
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errors.push(`unknown key "${k}" (expected ${TOP_KEYS.join(', ')}).`);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 64) errors.push('title: must be 1 to 64 characters (the player-facing name).');
  if (typeof raw.namespace !== 'string' || !NAMESPACE.test(raw.namespace)) errors.push(`namespace: ${quote(raw.namespace)} must match [a-z0-9_]{3,32}.`);
  const components: ByomComponentHint[] = [];
  if (raw.components !== undefined && !Array.isArray(raw.components)) errors.push('components: must be a list.');
  else (raw.components as unknown[] | undefined ?? []).forEach((c, i) => { const p = parseComponent(c, i, errors); if (p) components.push(p); });
  const features: ByomFeatureHint[] = [];
  if (raw.features !== undefined && !Array.isArray(raw.features)) errors.push('features: must be a list.');
  else (raw.features as unknown[] | undefined ?? []).forEach((f, i) => {
    const path = `features[${i}]`;
    if (!isObject(f)) { errors.push(`${path}: must be an object.`); return; }
    const before = errors.length;
    if (!(FEATURE_KINDS as readonly unknown[]).includes(f.kind)) errors.push(`${path}.kind: ${quote(f.kind)} is not one of ${FEATURE_KINDS.join(', ')}.`);
    if (!isVec3(f.at)) errors.push(`${path}.at: must be [x, y, z].`);
    if (typeof f.yaw !== 'number' || !Number.isFinite(f.yaw)) errors.push(`${path}.yaw: must be a number of degrees.`);
    if (f.size !== undefined && !(isVec3(f.size) && f.size.every(n => n > 0))) errors.push(`${path}.size: must be [x, y, z], each > 0.`);
    if (errors.length === before) features.push({ kind: f.kind as ByomFeatureHint['kind'], at: f.at as ByomVec3, yaw: f.yaw as number, ...(f.size ? { size: f.size as ByomVec3 } : {}) });
  });
  if (raw.scale !== undefined && !SCALES.includes(raw.scale as AddonScaleChoice)) errors.push(`scale: ${quote(raw.scale)} is not one of ${SCALES.join(', ')}.`);
  if (raw.figures === 'brick-figure') errors.push('figures: "brick-figure" is not supported yet; TODO(A-figure) the non-minifig figure of plan A (Q3). Use "keep" or "none".');
  else if (raw.figures !== undefined && raw.figures !== 'keep' && raw.figures !== 'none') errors.push(`figures: ${quote(raw.figures)} is not one of keep, none.`);
  const doors = parseSceneRule(raw.doors, 'doors', errors), seats = parseSceneRule(raw.seats, 'seats', errors);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    hints: { title, namespace: raw.namespace as string, components, features, scale: (raw.scale as AddonScaleChoice | undefined) ?? 'auto', figures: (raw.figures as 'keep' | 'none' | undefined) ?? 'keep', doors, seats },
  };
}

/** `<dir>/<stem>.byom.json` for a model file (either slash style; the last extension is replaced). */
export function byomHintsPathFor(modelFile: string): string {
  const slash = Math.max(modelFile.lastIndexOf('/'), modelFile.lastIndexOf('\\'));
  const dot = modelFile.lastIndexOf('.');
  const stemEnd = dot > slash + 1 ? dot : modelFile.length;
  return `${modelFile.slice(0, stemEnd)}.byom.json`;
}

/** A sub-model name as a selector compares it: lower case, forward slashes, no `.ldr/.mpd/.dat` extension. */
const normName = (name: string): string => name.trim().toLowerCase().replace(/\\/g, '/').replace(/\.(ldr|mpd|dat)$/, '');

/** The placements a selector names, in model order, or why none. */
function select(sel: ByomSelector, bricks: readonly ParsedBrick[], path: string): { bricks: ParsedBrick[]; error?: string } {
  if ('brickIndices' in sel) {
    const bad = sel.brickIndices.filter(i => i >= bricks.length);
    if (bad.length) return { bricks: [], error: `${path}: brickIndices ${bad.slice(0, 5).join(', ')} are past the end; the model has only ${bricks.length} placements.` };
    return { bricks: [...new Set(sel.brickIndices)].sort((a, b) => a - b).map(i => bricks[i]!) };
  }
  if ('box' in sel) {
    const [lo, hi] = sel.box;
    const hit = bricks.filter(b => b.x >= lo[0] && b.x <= hi[0] && b.y >= lo[1] && b.y <= hi[1] && b.z >= lo[2] && b.z <= hi[2]);
    return hit.length ? { bricks: hit } : { bricks: [], error: `${path}: box ${JSON.stringify(sel.box)} matches no placements (LDraw units, y is down).` };
  }
  const want = normName(sel.submodel);
  const hit = bricks.filter(b => b.sourcePath?.some(p => normName(p) === want));
  if (hit.length) return { bricks: hit };
  const names = [...new Set(bricks.flatMap(b => b.sourcePath ?? []).map(normName))].sort();
  return { bricks: [], error: `${path}: submodel "${sel.submodel}" matches no placements; the model has ${names.length ? `the sub-models ${names.map(n => `"${n}"`).join(', ')}` : 'no sub-models'}.` };
}

export interface ResolvedByomComponent { index: number; hint: ByomComponentHint; bricks: ParsedBrick[] }
/** A door / seat rule over the placements: null = every detected one, else the only placements allowed. */
export type ResolvedSceneRule = { mode: 'detect' } | { mode: 'none' } | { mode: 'only'; bricks: Set<ParsedBrick> };
export interface ResolvedByomHints {
  hints: ByomHints;
  /** Vehicle components (kind other than `static`), in hint order. */
  components: ResolvedByomComponent[];
  /** Every placement a `static` or vehicle hint claimed. */
  claimed: Set<ParsedBrick>;
  doors: ResolvedSceneRule;
  seats: ResolvedSceneRule;
}
export type ByomResolve = { ok: true; resolved: ResolvedByomHints } | { ok: false; errors: string[] };

/** Resolve every selector over the model's placements (the list the indices refer to). */
export function resolveByomHints(hints: ByomHints, bricks: readonly ParsedBrick[]): ByomResolve {
  const errors: string[] = [];
  const owner = new Map<ParsedBrick, number>();
  const components: ResolvedByomComponent[] = [];
  hints.components.forEach((hint, index) => {
    const path = `components[${index}]`;
    const r = select(hint.select, bricks, `${path}.select`);
    if (r.error) { errors.push(r.error); return; }
    const taken = r.bricks.find(b => owner.has(b));
    if (taken) { errors.push(`${path}.select: placement ${bricks.indexOf(taken)} is already in components[${owner.get(taken)}]; one part belongs to one component.`); return; }
    for (const b of r.bricks) owner.set(b, index);
    if (hint.kind !== 'static') components.push({ index, hint, bricks: r.bricks });
  });
  const rule = (r: ByomSceneRule, key: 'doors' | 'seats'): ResolvedSceneRule => {
    if (r === 'detect') return { mode: 'detect' };
    if (r === 'none') return { mode: 'none' };
    const s = select(r.select, bricks, `${key}.select`);
    if (s.error) { errors.push(s.error); return { mode: 'none' }; }
    return { mode: 'only', bricks: new Set(s.bricks) };
  };
  const doors = rule(hints.doors, 'doors'), seats = rule(hints.seats, 'seats');
  if (errors.length) return { ok: false, errors };
  return { ok: true, resolved: { hints, components, claimed: new Set(owner.keys()), doors, seats } };
}

/** Parse then resolve in one step (what the CLI and the UI call). */
export function validateByomHints(raw: unknown, bricks: readonly ParsedBrick[]): { ok: true; hints: ByomHints; resolved: ResolvedByomHints } | { ok: false; errors: string[] } {
  const parsed = parseByomHints(raw);
  if (!parsed.ok) return parsed;
  const r = resolveByomHints(parsed.hints, bricks);
  return r.ok ? { ok: true, hints: parsed.hints, resolved: r.resolved } : r;
}

/** The engine kind and motion a hint kind builds as (`hover` is boat geometry that floats). */
const BUILD: Readonly<Record<Exclude<ByomBuildableKind, 'static'>, { kind: PlayableKind; motion: VehicleMotion }>> = {
  car: { kind: 'car', motion: 'car' },
  plane: { kind: 'plane', motion: 'plane' },
  boat: { kind: 'boat', motion: 'boat' },
  hover: { kind: 'boat', motion: 'hover' },
};

/** Which bricks a rule lets a door / seat be made of; null means "no limit". */
export function sceneRuleAllows(rule: ResolvedSceneRule, brick: ParsedBrick | undefined): boolean {
  if (rule.mode === 'detect') return true;
  if (rule.mode === 'none') return false;
  return brick !== undefined && rule.bricks.has(brick);
}

/** A rule over the pipeline's own placements (`finalOf` maps the resolved ones; a dropped placement leaves the rule). */
export function remapSceneRule(rule: ResolvedSceneRule, finalOf: ReadonlyMap<ParsedBrick, ParsedBrick>): ResolvedSceneRule {
  if (rule.mode !== 'only') return rule;
  return { mode: 'only', bricks: new Set([...rule.bricks].map(b => finalOf.get(b)).filter((b): b is ParsedBrick => b !== undefined)) };
}

/**
 * The pipeline's components for the resolved vehicle hints. `finalOf` maps a resolved placement to the
 * placement the pipeline now holds (build tools are dropped and a torso is repaired before this runs);
 * a placement with no final one (a dropped build tool) simply leaves the component.
 */
export function byomComponentsFromHints(resolved: ResolvedByomHints, finalOf: ReadonlyMap<ParsedBrick, ParsedBrick>): { components: PlayableBrickComponent[]; warnings: string[] } {
  const { hints } = resolved;
  const warnings: string[] = [];
  const components: PlayableBrickComponent[] = [];
  for (const rc of resolved.components) {
    const bricks = rc.bricks.map(b => finalOf.get(b)).filter((b): b is ParsedBrick => b !== undefined);
    const label = rc.hint.label ?? (resolved.components.length === 1 ? hints.title : `${hints.title} ${'submodel' in rc.hint.select ? rc.hint.select.submodel.replace(/\.(ldr|mpd|dat)$/i, '') : rc.hint.kind}`);
    if (!bricks.length) { warnings.push(`${label}: every selected placement was a build tool; no ${rc.hint.kind} was made.`); continue; }
    const { kind, motion } = BUILD[rc.hint.kind as Exclude<ByomBuildableKind, 'static'>];
    components.push(withPlayableBounds({
      id: `${rc.hint.kind}_${components.length + 1}`, label, kind, bricks, motion,
      provenance: `creator hint: ${describeSelector(rc.hint.select)} as a ${rc.hint.kind}`,
      ...(rc.hint.facing ? { forwardDirection: rc.hint.facing } : {}),
      ...(rc.hint.seats ? { seatCount: rc.hint.seats } : {}),
    }));
  }
  return { components, warnings };
}

function describeSelector(sel: ByomSelector): string {
  if ('submodel' in sel) return `submodel "${sel.submodel}"`;
  if ('brickIndices' in sel) return `${sel.brickIndices.length} listed placements`;
  return `box ${JSON.stringify(sel.box)}`;
}
