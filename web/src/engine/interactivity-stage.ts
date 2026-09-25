/**
 * The interactivity stage: ONE pass that decides, for a building's static
 * scenery, which parts become moving entities (doors, gates, windows,
 * hatches, cupboards, levers, turnables) and which become seats, with a
 * per-set report of every candidate it looked at and why each ended where it
 * did. Every rule is driven by the LDraw library's description, the part's
 * own frame and the model's geometry - never by a set number.
 *
 * The report is the audit surface (docs/bedrock-interactivity.md, "The
 * 40-set audit"): each row is a class, a mould, a verdict and a reason -
 * `found` (it moves or seats), `static` (matched but left in the shell, with
 * the rule that kept it), `rides` (carried by another part's entity: a glass
 * insert, a handle), `excluded` (part of a vehicle, figure, ride car or
 * pinball table that owns it) or `unhandled` (its description names a movable
 * thing no rule handles yet - the list the next rule is written from). It
 * ships in `craftmatic-diagnostics.json` as `interactivity`.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { classifiedDescription, type LdrawPartMesh, type Vec3 } from './ldraw-part-geometry.js';
import { cleanPartId } from './ldraw-entity-compiler.js';
import { discoverInteractives, interactiveHitboxes, interactiveKindOf, separateHitboxes, type InteractiveKind, type SceneInteractive } from './bedrock-interactives.js';
import type { SceneSeat } from './bedrock-scene-actors.js';

/** What a player does with a part: a moving part's kind, a seat, or a bed (a seat on its mattress). */
export type InteractivityClass = InteractiveKind | 'seat' | 'bed';

export type InteractivityVerdict = 'found' | 'static' | 'rides' | 'excluded' | 'unhandled';

export interface InteractivityRow {
  cls: InteractivityClass;
  part: string;
  description: string;
  verdict: InteractivityVerdict;
  reason?: string;
  count: number;
  /** Up to six LDraw positions, to find the part in a render. */
  at: Vec3[];
}

export interface InteractivityReport {
  rows: InteractivityRow[];
  /** Placements per verdict, over every row. */
  totals: Record<InteractivityVerdict, number>;
  /** Found per class (seats count seats, moving parts count entities). */
  found: Partial<Record<InteractivityClass, number>>;
}

/**
 * The class a description NAMES, broader than the moving-part rules
 * (`interactiveKindOf`) and the seat rules: anything a player would expect to
 * open, turn, sit or lie on. Frames, glass inserts, rails, stickers and
 * holders are fixtures, not movable things.
 */
export function movableClassOf(description: string): InteractivityClass | null {
  const d = description.replace(/^[~=_]+\s*/, '');
  if (/\b(Sticker|Holder|Frame|Rail|Track|Hinge Plate|Hinge Brick|Base|Stand|Support|Mount)\b/i.test(d)) return null;
  // Worn and carried things, wheel hubs and a baby's stroller seat are not the player's to use.
  if (/^Minifig(ure)?,? (Headgear|Utensil Stroller)|\bHeadgear\b|\bHub\b|\b(Stroller|Baby Carriage|Pram)\b/i.test(d)) return null;
  // A container's BODY is a fixture: its door, drawer or lid is a part of its own (a one-piece chest has none).
  if (/^Container\b/i.test(d) && !/\b(Door|Drawer|Lid)\b/i.test(d)) return null;
  // A window FRAME ("Window 1 x 4 x 3 without Shutter Tabs") is a fixture; its panes and shutters are the movable parts.
  if (/^Window\b/i.test(d) && !/\b(Pane|Shutter|Opening)\b/i.test(d.replace(/\bwithout Shutter\b/i, ''))) return null;
  const kind = interactiveKindOf(d);
  if (kind) return kind;
  if (/\bGlass\b/i.test(d)) return null;
  if (/\bDrawer\b/i.test(d)) return 'drawer';
  if (/\b(Bed|Bunk|Cot|Hammock|Sleeping Bag)\b/i.test(d)) return 'bed';
  if (/\b(Chair|Seat|Bench|Stool|Throne|Sofa|Couch|Armchair|Toilet|Saddle)\b/i.test(d) && !/\bSeat ?Belt\b/i.test(d)) return 'seat';
  if (/\b(Trap ?Door|Hatch)\b/i.test(d)) return 'hatch';
  if (/\bGate\b/i.test(d)) return 'gate';
  if (/\bShutter\b/i.test(d) && !/\bwithout Shutter\b/i.test(d)) return 'window';
  if (/\bDoor\b/i.test(d)) return 'door';
  if (/\b(Cupboard|Cabinet|Locker|Wardrobe|Safe|Chest)\b/i.test(d) || /\bLid\b/i.test(d)) return 'cabinet';
  if (/\b(Lever|Crank|Joystick|Control Stick)\b/i.test(d)) return 'lever';
  if (/\b(Turntable|Propeller|Rotor|Windmill|Water ?wheel|Spinning Wheel|Winch|Capstan|Steering Wheel|Ship'?s? Wheel)\b/i.test(d)) return 'turnable';
  return null;
}

export interface InteractivityStageInput {
  /** Every placement of the model (the report counts the excluded ones too). */
  bricks: readonly ParsedBrick[];
  meshes: ReadonlyMap<string, LdrawPartMesh | null>;
  /** Placements another stage owns (vehicles, figures, ride cars, pinball), with who owns them. */
  owned: ReadonlyMap<ParsedBrick, string>;
  /** The scene's seats (`discoverSceneActors`), and each seat's point in the grid frame for the tap-box separation. */
  seats: readonly SceneSeat[];
  seatPoints: readonly Vec3[];
  /** LDraw -> grid (the export frame, `sceneGridPoint`). */
  toGrid: (p: Vec3) => Vec3;
  /** Cap on moving parts (default `MAX_INTERACTIVES`). */
  max?: number;
}

export interface InteractivityStageResult {
  /** The moving parts, each with its tap boxes already shaped and kept clear of seats and of each other. */
  items: SceneInteractive[];
  report: InteractivityReport;
  warnings: string[];
}

/** Run the stage: discover, shape and separate the tap boxes, and report every candidate. */
export function interactivityStage(input: InteractivityStageInput): InteractivityStageResult {
  const warnings: string[] = [];
  const scenery = input.bricks.filter(b => !input.owned.has(b));
  const found = discoverInteractives(scenery, input.meshes, { ...(input.max !== undefined ? { max: input.max } : {}) });
  warnings.push(...found.warnings);
  // Tap boxes: each part's own shape, kept off the seats and off each other. A
  // part that cannot keep a box to itself (a turntable under a seat, two
  // coincident rotors) stays static in the shell.
  const hits = found.items.map(it => ({ origin: input.toGrid(it.anchorLdu), hit: interactiveHitboxes(it, input.toGrid) }));
  separateHitboxes(hits, input.seatPoints.map(p => [p[0], p[1], p[2]]));
  const keep = hits.map(h => h.hit.closed.length > 0 && h.hit.open.length > 0);
  const items = found.items.map((it, k) => ({ ...it, hit: hits[k]!.hit })).filter((_, k) => keep[k]);
  const lostBoxes = found.items.filter((_, k) => !keep[k]);
  if (lostBoxes.length) warnings.push(`${lostBoxes.length} moving part${lostBoxes.length === 1 ? ' stays' : 's stay'} static: ${lostBoxes.map(it => `${it.kind} ${it.part}`).join(', ')} cannot keep a tap box clear of a seat or another part.`);

  // Who each placement ended up with.
  const verdictOf = new Map<ParsedBrick, { verdict: InteractivityVerdict; reason?: string; cls?: InteractivityClass }>();
  const labelOf = (it: SceneInteractive): string => `${it.kind} ${it.part}`;
  for (const it of items) {
    it.bricks.forEach((b, i) => verdictOf.set(b, i === 0 ? { verdict: 'found', cls: it.kind } : { verdict: 'rides', reason: `rides with ${labelOf(it)}` }));
  }
  for (const it of lostBoxes) verdictOf.set(it.bricks[0]!, { verdict: 'static', reason: 'its tap box cannot be kept clear of a seat or another part', cls: it.kind });
  // `skipped` names the mould, not the placement: match by part among the unassigned placements.
  const skippedByPart = new Map<string, string[]>();
  for (const s of found.skipped) { const l = skippedByPart.get(s.part) ?? []; l.push(s.reason); skippedByPart.set(s.part, l); }
  const builtFrom: Record<string, string> = {
    stool: 'brick-built stool (a 2 x 2 tile on a narrow column)', bench: 'brick-built bench (a seat on legs)',
    chair: 'brick-built chair or sofa (a seat with a backrest)', bed: 'brick-built bed (a mattress with a headboard)',
  };
  for (const s of input.seats) if (s.brick) verdictOf.set(s.brick, { verdict: 'found', cls: s.part === 'bed' ? 'bed' : 'seat', ...(builtFrom[s.part] ? { reason: builtFrom[s.part] } : {}) });

  const groups = new Map<string, InteractivityRow>();
  const addRow = (cls: InteractivityClass, b: ParsedBrick, description: string, verdict: InteractivityVerdict, reason?: string): void => {
    const part = cleanPartId(b.part);
    const key = `${cls}|${part}|${verdict}|${reason ?? ''}`;
    const row = groups.get(key) ?? { cls, part, description, verdict, ...(reason ? { reason } : {}), count: 0, at: [] };
    row.count++;
    if (row.at.length < 6) row.at.push([Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, Math.round(b.z * 10) / 10]);
    groups.set(key, row);
  };
  for (const b of input.bricks) {
    const m = input.meshes.get(b.part);
    const description = m ? classifiedDescription(m) : '';
    const v = verdictOf.get(b);
    const named = movableClassOf(description);
    if (v && v.verdict !== 'rides') { addRow(v.cls ?? named ?? 'door', b, description, v.verdict, v.reason); continue; }
    if (!named) continue;
    if (v) { addRow(named, b, description, 'rides', v.reason); continue; }
    const owner = input.owned.get(b);
    if (owner) { addRow(named, b, description, 'excluded', owner); continue; }
    const skipped = skippedByPart.get(cleanPartId(b.part));
    if (skipped?.length) { addRow(named, b, description, 'static', skipped[0]); continue; }
    if (named === 'seat') { addRow(named, b, description, 'unhandled', 'a seat-like part with no seat rule (no mould seat, not furniture the rule names)'); continue; }
    if (interactiveKindOf(description)) { addRow(named, b, description, 'static', 'matched a moving-part rule but not placed (no geometry)'); continue; }
    addRow(named, b, description, 'unhandled', `its description names a ${named} and no rule moves it yet`);
  }
  const rows = [...groups.values()].sort((a, b) => a.cls.localeCompare(b.cls) || a.verdict.localeCompare(b.verdict) || b.count - a.count);
  const totals: Record<InteractivityVerdict, number> = { found: 0, static: 0, rides: 0, excluded: 0, unhandled: 0 };
  for (const r of rows) totals[r.verdict] += r.count;
  const foundByClass: Partial<Record<InteractivityClass, number>> = {};
  for (const it of items) foundByClass[it.kind] = (foundByClass[it.kind] ?? 0) + 1;
  for (const s of input.seats) { const c: InteractivityClass = s.part === 'bed' ? 'bed' : 'seat'; foundByClass[c] = (foundByClass[c] ?? 0) + 1; }
  return { items, report: { rows, totals, found: foundByClass }, warnings };
}

/** One line for the pack warnings: what the stage found and what it left, by verdict. */
export function interactivitySummary(label: string, report: InteractivityReport): string {
  const found = Object.entries(report.found).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') || 'nothing';
  const unhandled = report.rows.filter(r => r.verdict === 'unhandled');
  const statics = report.rows.filter(r => r.verdict === 'static');
  return `${label}: interactivity found ${found}; ${report.totals.static} static (${statics.map(r => `${r.part} x${r.count}`).join(', ') || 'none'}); ${report.totals.unhandled} unhandled (${unhandled.map(r => `${r.cls} ${r.part} x${r.count}`).join(', ') || 'none'}); ${report.totals.excluded} owned by vehicles, figures or rides.`;
}
