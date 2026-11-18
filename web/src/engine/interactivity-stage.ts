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
import { classifiedDescription, withClassifiedDescriptions, type LdrawPartMesh, type Vec3 } from './ldraw-part-geometry.js';
import { cleanPartId } from './ldraw-entity-compiler.js';
import { MAX_INTERACTIVES, capInteractives, discoverInteractives, interactiveHitboxes, interactiveKindOf, separateHitboxes, type InteractiveKind, type SceneInteractive } from './bedrock-interactives.js';
import { discoverBrickHinges, type HingeLineReport } from './brick-hinges.js';
import { VEHICLE_PART, closesWhenMoving } from './vehicle-parts.js';
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
  /**
   * The brick-built hinge detector (`brick-hinges.ts`): how many joint lines
   * it cut, their verdicts, and every line that moved with what it became.
   */
  hinges?: { lines: number; verdicts: Partial<Record<HingeLineReport['verdict'], number>>; moved: HingeLineReport[] };
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
  /**
   * `toGrid`'s y 0 is the ground the placement stands on (the scene's grid frame): a root under it is moved up onto
   * it (`groundedAnchors`). Absent for a frame with no ground (a vehicle's own parts, shaped at minifig scale).
   */
  groundPlane?: boolean;
}

export interface InteractivityStageResult {
  /** The moving parts, each with its tap boxes already shaped and kept clear of seats and of each other. */
  items: SceneInteractive[];
  report: InteractivityReport;
  warnings: string[];
}

/** How far apart (grid blocks) two leaves' mid-planes may lie and still stand in one doorway: about a cell. */
export const STACK_PLANE_BLOCKS = 0.5;
/** The gap (grid blocks) under which two leaves one above the other TOUCH: a sixteenth, the colliders' grain. */
export const STACK_TOUCH_BLOCKS = 1 / 16;

/**
 * The door and gate leaves STACKED in one doorway, as groups of indices into `items`, each group lowest leaf first
 * (groups of one are left out). Two leaves stack when they face the same way within `STACK_PLANE_BLOCKS` of one plane,
 * cover at least half the narrower one's width there, and one stands on the other - their heights touch or overlap
 * (`STACK_TOUCH_BLOCKS`) and their feet are at least half the shorter leaf's height apart (a double door's two leaves
 * are side by side at one height). The upper leaf's threshold is then the lower leaf's head room: one door's passage
 * takes the other's floor, so at most one of them can work. PDF reconstructions of the "building set" buckets stack
 * two to four doors in one column (census 2026-11-16: 5582 Doors 1-2, 5482 Doors 1-4, 3600 Doors 1-2; 5582 Door 2 fell
 * 3.19 blocks at 150 %). The export keeps the one that leads somewhere (playable-addon.ts `chooseStackedDoors`).
 * `toGrid` maps LDraw to grid blocks (y up).
 */
export function doorStacks(items: readonly SceneInteractive[], toGrid: (p: Vec3) => Vec3): number[][] {
  interface Leaf { i: number; c: Vec3; a: Vec3; w: number; n: Vec3; y0: number; y1: number }
  const leaves: Leaf[] = [];
  items.forEach((it, i) => {
    if ((it.kind !== 'door' && it.kind !== 'gate') || !it.leaf) return;
    const L = it.leaf, c = toGrid(L.corner);
    const pa = toGrid([L.corner[0] + L.along[0], L.corner[1] + L.along[1], L.corner[2] + L.along[2]]);
    const pu = toGrid([L.corner[0] + L.up[0], L.corner[1] + L.up[1], L.corner[2] + L.up[2]]);
    const pn = toGrid([L.corner[0] + L.normal[0], L.corner[1] + L.normal[1], L.corner[2] + L.normal[2]]);
    const a: Vec3 = [pa[0] - c[0], 0, pa[2] - c[2]], w = Math.hypot(a[0], a[2]);
    const n: Vec3 = [pn[0] - c[0], 0, pn[2] - c[2]], nl = Math.hypot(n[0], n[2]);
    if (w < 1e-6 || nl < 1e-6) return;
    leaves.push({ i, c, a: [a[0] / w, 0, a[2] / w], w, n: [n[0] / nl, 0, n[2] / nl], y0: Math.min(c[1], pu[1]), y1: Math.max(c[1], pu[1]) });
  });
  const stacked = (p: Leaf, q: Leaf): boolean => {
    if (Math.abs(p.n[0] * q.n[0] + p.n[2] * q.n[2]) < 0.9) return false;
    const d: Vec3 = [q.c[0] - p.c[0], 0, q.c[2] - p.c[2]];
    if (Math.abs(d[0] * p.n[0] + d[2] * p.n[2]) > STACK_PLANE_BLOCKS) return false;
    // Both leaves' widths on p's width axis: q's runs from its corner along its own direction.
    const q0 = d[0] * p.a[0] + d[2] * p.a[2], q1 = q0 + q.w * (q.a[0] * p.a[0] + q.a[2] * p.a[2]);
    const cover = Math.min(p.w, Math.max(q0, q1)) - Math.max(0, Math.min(q0, q1));
    if (cover < 0.5 * Math.min(p.w, q.w)) return false;
    const overlap = Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0);
    return overlap >= -STACK_TOUCH_BLOCKS && Math.abs(q.y0 - p.y0) >= 0.5 * Math.min(p.y1 - p.y0, q.y1 - q.y0);
  };
  // Stacks are chains (a tower of four doors): group by union-find.
  const parent = leaves.map((_, k) => k);
  const root = (k: number): number => { while (parent[k] !== k) k = parent[k] = parent[parent[k]!]!; return k; };
  for (let p = 0; p < leaves.length; p++) for (let q = p + 1; q < leaves.length; q++) if (stacked(leaves[p]!, leaves[q]!)) parent[root(p)] = root(q);
  const groups = new Map<number, Leaf[]>();
  leaves.forEach((l, k) => { const r = root(k); const g = groups.get(r); if (g) g.push(l); else groups.set(r, [l]); });
  return [...groups.values()].filter(g => g.length > 1).map(g => g.sort((p, q) => p.y0 - q.y0).map(l => l.i));
}

/** Every leaf of a stack but its lowest (`doorStacks`): what "keep the lowest" leaves static, the export's fallback. */
export function stackedDoorways(items: readonly SceneInteractive[], toGrid: (p: Vec3) => Vec3): Set<number> {
  return new Set(doorStacks(items, toGrid).flatMap(g => g.slice(1)));
}

/**
 * Each part with its entity origin (`anchorLdu`, the closed assembly's bottom centre) moved straight up onto the
 * ground plane (grid y 0) where it lies under it; other parts are returned as they are (the same object). An entity
 * is lit by the block at its root, so a root inside the ground block draws the part dark (the shell's own root is
 * lifted into open sky for the same reason, `originAboveModel`); the rig's root bone, the compiled geometry and the
 * tap boxes all hang off the anchor, and the placement turns and scales about it, so moving it moves nothing drawn.
 * 2504's right gate leaf, posed upside down by its reconstruction, hangs 0.48 under the ground (census 2026-11-16).
 */
export function groundedAnchors(items: readonly SceneInteractive[], toGrid: (p: Vec3) => Vec3): SceneInteractive[] {
  return items.map(it => {
    const g = toGrid(it.anchorLdu);
    if (g[1] >= 0) return it;
    const perLdu = toGrid([it.anchorLdu[0], it.anchorLdu[1] + 1, it.anchorLdu[2]])[1] - g[1];
    if (!Number.isFinite(perLdu) || Math.abs(perLdu) < 1e-12) return it;
    return { ...it, anchorLdu: [it.anchorLdu[0], it.anchorLdu[1] - g[1] / perLdu, it.anchorLdu[2]] as Vec3 };
  });
}

/** Run the stage: discover, shape and separate the tap boxes, and report every candidate. */
export function interactivityStage(input: InteractivityStageInput): InteractivityStageResult {
  const warnings: string[] = [];
  const scenery = input.bricks.filter(b => !input.owned.has(b));
  // Moulded parts by description, then BRICK-BUILT assemblies on a turning
  // joint (`brick-hinges.ts`) among what is left; the cap applies to both together.
  const moulded = discoverInteractives(scenery, input.meshes, { max: Number.MAX_SAFE_INTEGER });
  const classified = withClassifiedDescriptions(input.meshes);
  const taken = new Set<ParsedBrick>([...moulded.items.flatMap(it => it.bricks), ...input.seats.flatMap(s => (s.brick ? [s.brick] : []))]);
  const hinged = discoverBrickHinges({ bricks: scenery, meshOf: b => { const m = classified.get(b.part); return m && m.triangles.length ? m : null; }, taken });
  const capped = capInteractives([...moulded.items, ...hinged.items], input.max ?? MAX_INTERACTIVES);
  // Every root is on or over the ground. Doors stacked in one doorway all stay doors here: the export keeps the one
  // that leads somewhere and fixes the rest shut (playable-addon.ts `chooseStackedDoors`), as only it has the colliders.
  const grounded = input.groundPlane ? groundedAnchors(capped.items, input.toGrid) : capped.items;
  const found = { items: grounded, skipped: [...moulded.skipped, ...capped.skipped], warnings: [...moulded.warnings, ...capped.warnings] };
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
  const verdictOf = new Map<ParsedBrick, { verdict: InteractivityVerdict; reason?: string; cls?: InteractivityClass; description?: string }>();
  const labelOf = (it: SceneInteractive): string => `${it.kind} ${it.part}`;
  for (const it of items) {
    // A brick-built assembly's row is the assembly (its joint half is only the part that names it).
    it.bricks.forEach((b, i) => verdictOf.set(b, i === 0 ? { verdict: 'found', cls: it.kind, ...(it.builtFrom ? { reason: 'brick-built on a turning joint', description: it.builtFrom } : {}) } : { verdict: 'rides', reason: `rides with ${labelOf(it)}` }));
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
    if (v && v.verdict !== 'rides') { addRow(v.cls ?? named ?? 'door', b, v.description ?? description, v.verdict, v.reason); continue; }
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
  const verdicts: Partial<Record<HingeLineReport['verdict'], number>> = {};
  for (const l of hinged.lines) verdicts[l.verdict] = (verdicts[l.verdict] ?? 0) + 1;
  const hinges = { lines: hinged.lines.length, verdicts, moved: hinged.lines.filter(l => l.verdict === 'moves') };
  return { items, report: { rows, totals, found: foundByClass, hinges }, warnings };
}

/** One line for the pack warnings: what the stage found and what it left, by verdict. */
export function interactivitySummary(label: string, report: InteractivityReport): string {
  const found = Object.entries(report.found).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') || 'nothing';
  const unhandled = report.rows.filter(r => r.verdict === 'unhandled');
  const statics = report.rows.filter(r => r.verdict === 'static');
  return `${label}: interactivity found ${found}; ${report.totals.static} static (${statics.map(r => `${r.part} x${r.count}`).join(', ') || 'none'}); ${report.totals.unhandled} unhandled (${unhandled.map(r => `${r.cls} ${r.part} x${r.count}`).join(', ') || 'none'}); ${report.totals.excluded} owned by vehicles, figures or rides; ${report.totals.rides} ride${report.totals.rides === 1 ? 's' : ''} with a vehicle or a ride.`;
}

/** A vehicle entity and the placements it carries, for `vehicleCarriedParts`. */
export interface CarryingVehicle {
  label: string;
  kind: string;
  bricks: readonly ParsedBrick[];
  /** Furniture seats and beds in it (`discoverSceneActors`) offered to the vehicle as passenger seats; the rest are listed as dropped. */
  passengerSeats?: readonly SceneSeat[];
  droppedSeats?: ReadonlyArray<{ seat: SceneSeat; reason: string }>;
  /** Slides and other world-path rides found in it that stay fixed geometry (a native vehicle's), by mould. */
  rides?: readonly string[];
  /** Slides ridden while the (scripted) vehicle is parked, by mould (vehicle-parts.ts `VehicleSlideRuntime`). */
  slides?: readonly string[];
  /**
   * Its moving parts open while it is parked (vehicle-parts.ts): a SCRIPTED vehicle, whose runtime answers the tap.
   * False or absent: a native one (a rotorcraft, a flyer); its parts stay fixed geometry.
   */
  opens?: boolean;
}

/**
 * What a VEHICLE entity carries that would move or seat a player in a building (audit 2026-11-15 A-02): the
 * stage is run over the vehicle's own placements as if they were scenery. On a scripted vehicle (`opens`) every
 * moving part it finds, up to `VEHICLE_PART.MAX`, becomes one of the vehicle's own hinged bones (vehicle-parts.ts):
 * it opens on a tap while the vehicle is parked and rides with it - `items[i]` are vehicle i's, for the compiler.
 * On a native one, and past the cap, a part stays fixed on the vehicle, reported with why. Seats and beds ride with
 * it as its passenger seats where they were offered one. Nothing is dropped silently: every row names the vehicle.
 */
export function vehicleCarriedParts(vehicles: readonly CarryingVehicle[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, isFigure: (b: ParsedBrick) => boolean): { rows: InteractivityRow[]; warnings: string[]; items: SceneInteractive[][] } {
  const rows: InteractivityRow[] = [];
  const warnings: string[] = [];
  const items: SceneInteractive[][] = [];
  const rowOf = (cls: InteractivityClass, b: ParsedBrick, verdict: InteractivityVerdict, reason: string, groups: Map<string, InteractivityRow>): void => {
    const m = meshes.get(b.part);
    const part = cleanPartId(b.part);
    const key = `${cls}|${part}|${verdict}|${reason}`;
    const row = groups.get(key) ?? { cls, part, description: m ? classifiedDescription(m) : '', verdict, reason, count: 0, at: [] };
    row.count++;
    if (row.at.length < 6) row.at.push([Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10, Math.round(b.z * 10) / 10]);
    groups.set(key, row);
  };
  for (const v of vehicles) {
    const groups = new Map<string, InteractivityRow>();
    const owned = new Map<ParsedBrick, string>();
    for (const b of v.bricks) if (isFigure(b)) owned.set(b, 'a figure');
    // Tap boxes are shaped in blocks at minifig scale (53.33 LDU, y up), as the real stage shapes them in grid blocks.
    const dry = interactivityStage({ bricks: v.bricks, meshes, owned, seats: [], seatPoints: [], toGrid: p => [p[0] / 53.33, -p[1] / 53.33, p[2] / 53.33], max: Number.MAX_SAFE_INTEGER });
    const carried = v.opens ? dry.items.slice(0, VEHICLE_PART.MAX) : [];
    const left = dry.items.slice(carried.length);
    items.push(carried);
    // A native ROTORCRAFT's parts open too (vehicle-driver.js answers the tap, `opens`). Left fixed: a component flown
    // as a `flyer` (a creator's motion hint; a set-canon flyer mount is not a vehicle component) - vehicle-driver.js
    // would answer it the same way, unmeasured. # TODO(vehicle-interactives): carry a flyer component's parts too.
    const fixed = v.opens
      ? `stays fixed on ${v.label}: the ${v.kind} carries at most ${VEHICLE_PART.MAX} moving parts (one actor property each)`
      : `stays fixed on ${v.label}: a native ${v.kind} has no script to answer a tap on its parts`;
    const opens = (it0Kind: InteractiveKind): string => `opens on ${v.label} while it is parked: a bone of the ${v.kind}'s own geometry, so it rides with it${closesWhenMoving(it0Kind) ? '; it closes as the vehicle moves' : ''}`;
    for (const it of carried) rowOf(it.kind, it.bricks[0]!, 'rides', opens(it.kind), groups);
    for (const it of left) rowOf(it.kind, it.bricks[0]!, 'excluded', fixed, groups);
    for (const s of v.passengerSeats ?? []) if (s.brick) rowOf(s.part === 'bed' ? 'bed' : 'seat', s.brick, 'excluded', `rides with ${v.label}: offered to it as a passenger seat`, groups);
    for (const d of v.droppedSeats ?? []) if (d.seat.brick) rowOf(d.seat.part === 'bed' ? 'bed' : 'seat', d.seat.brick, 'excluded', `dropped on ${v.label}: ${d.reason}`, groups);
    rows.push(...groups.values());
    const listed = (list: readonly SceneInteractive[]): string => {
      const named = new Map<string, number>();
      for (const it of list) { const k = `${it.kind} ${cleanPartId(it.part)}`; named.set(k, (named.get(k) ?? 0) + 1); }
      return [...named].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ');
    };
    if (carried.length) warnings.push(`${v.label}: ${carried.length} moving part${carried.length === 1 ? ' opens' : 's open'} on the parked ${v.kind} (${listed(carried)}): tap one standing beside it; doors, lids and cupboards close as it drives off and ride with it.`);
    if (left.length) warnings.push(`${v.label}: ${left.length} moving part${left.length === 1 ? ' stays' : 's stay'} fixed on the ${v.kind} (${listed(left)}): ${v.opens ? `over the ${VEHICLE_PART.MAX}-part cap` : `a native ${v.kind} has no script to answer a tap`}.`);
    if (v.passengerSeats?.length || v.droppedSeats?.length) warnings.push(`${v.label}: ${v.passengerSeats?.length ?? 0} furniture seat${v.passengerSeats?.length === 1 ? '' : 's'} or bed${v.passengerSeats?.length === 1 ? '' : 's'} offered to the ${v.kind} as passenger seats${v.droppedSeats?.length ? `; ${v.droppedSeats.length} dropped (${v.droppedSeats.map(d => `${d.seat.part}: ${d.reason}`).join('; ')})` : ''}.`);
    if (v.rides?.length) warnings.push(`${v.label}: ${v.rides.length} ride${v.rides.length === 1 ? '' : 's'} (${v.rides.join(', ')}) stay${v.rides.length === 1 ? 's' : ''} fixed geometry on the ${v.kind}: a native ${v.kind} has no script to start a ride from where it stands.`);
    if (v.slides?.length) warnings.push(`${v.label}: ${v.slides.length} slide${v.slides.length === 1 ? '' : 's'} on the ${v.kind} (${v.slides.join(', ')}): tap ${v.slides.length === 1 ? 'it' : 'one'} standing beside the parked ${v.kind} to ride it while it is parked; a tap while it moves is refused.`);
  }
  return { rows, warnings, items };
}
