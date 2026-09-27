/**
 * The seat census: every place in a LEGO model where a minifig or a mini-doll
 * is meant to sit, and what the exported add-on gives the PLAYER there.
 *
 * A place is found from the source's own parts, never from what the export
 * made of them, so a seat the pipeline missed is counted as missed:
 *  - a seat mould (`4079`, a car base with seats), a furniture mould (a chair,
 *    bench, stool, throne, sofa, toilet, swing, a wheelchair), a saddle;
 *  - a steering wheel or stand, and a ship's wheel (a helm is steered
 *    standing, but it is where the vehicle's driver is);
 *  - a figure the source SAT DOWN: its legs bent forward at the hip;
 *  - a brick-built seat the scene's furniture rules found (they have no
 *    mould, so these come from the pipeline, and their precision is the
 *    rules' own - see the tracker's "Seat precision").
 *
 * Each place is then judged against what the pack ships (`SeatCensusContext`,
 * collected by the pipeline): the driver's seat of a rideable vehicle, one of
 * its passenger seats, an invisible scene seat, a seat a source figure already
 * rides, a coaster car or ride, or nothing - with the reason.
 *
 * Several parts often name ONE seat (a driver figure on a seat mould behind a
 * steering wheel), so rows are also clustered into DISTINCT places; report
 * both counts (the raw count over-weights a cockpit that carries three
 * pieces of evidence).
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import { classifiedDescription } from './ldraw-part-geometry.js';
import { cleanPartId, groupFigures, isSeat } from './ldraw-entity-compiler.js';
import { isShipWheel, isSteeringWheel } from './steering-parts.js';
import { SEAT_BELOW_TORSO_LDU, seatedFigure } from './minifig-rig.js';
import { isFurnitureSeat } from './bedrock-scene-actors.js';

/** What a place was recognised by. */
export type SeatPlaceKind = 'seat-mould' | 'furniture' | 'saddle' | 'steering' | 'helm' | 'seated-figure' | 'brick-built' | 'cockpit';

/** One place a figure is meant to sit, read from the source. */
export interface SeatPlace {
  kind: SeatPlaceKind;
  /** The part id (`cleanPartId`), `figure` for a seated figure's torso, the scene's label for a brick-built seat. */
  part: string;
  description: string;
  /** The placement it was read from (a seated figure: its torso); absent for a brick-built seat. */
  brick?: ParsedBrick;
  /** A seated figure's parts. */
  figure?: readonly ParsedBrick[];
  /** Where a figure would sit, LDraw (the seat's pan, a figure's hips, behind a wheel). */
  pointLdu: Vec3;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const local = (b: ParsedBrick, v: Vec3): Vec3 => {
  const m = b.rot ?? IDENTITY;
  return [b.x + m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], b.y + m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], b.z + m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
};
const strip = (d: string): string => d.replace(/^[~=_]+\s*/, '');

/** Which kind of seat place a single part is, or null. Seated figures and brick-built seats are found elsewhere. */
export function seatPartKind(part: string, description: string): Exclude<SeatPlaceKind, 'seated-figure' | 'brick-built' | 'cockpit'> | null {
  const d = strip(description);
  if (/\bSticker\b/i.test(d)) return null;
  if (isSeat(part, description)) return 'seat-mould';
  if (isFurnitureSeat(description) || /^Minifig Wheelchair\b/i.test(d)) return 'furniture';
  if (/\bSaddle\b/i.test(d)) return 'saddle';
  if (isShipWheel(part, description)) return 'helm';
  if (isSteeringWheel(part, description)) return 'steering';
  return null;
}

/** Every seat place a model's own parts name (brick-built seats are added from the scene, `takeSeatCensus`). */
export function findSeatPlaces(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>): SeatPlace[] {
  const out: SeatPlace[] = [];
  const desc = (b: ParsedBrick): string => { const m = meshes.get(b.part); return m ? classifiedDescription(m) : ''; };
  for (const b of bricks) {
    const d = desc(b);
    const kind = seatPartKind(b.part, d);
    if (!kind) continue;
    // A seat mould's pan is a plate over its origin (4079); a wheel's driver sits 30 LDU behind it, the hips ~23 under its hub.
    const point: Vec3 = kind === 'seat-mould' ? local(b, [0, -8, 0]) : kind === 'steering' ? local(b, [0, 23, 30]) : [b.x, b.y, b.z];
    out.push({ kind, part: cleanPartId(b.part), description: strip(d), brick: b, pointLdu: point });
  }
  for (const group of groupFigures(bricks as ParsedBrick[], meshes as Map<string, LdrawPartMesh | null>)) {
    const parts = group.parts.map(i => bricks[i]!);
    const seated = seatedFigure(parts, meshes);
    if (!seated) continue;
    out.push({ kind: 'seated-figure', part: 'figure', description: `${seated.system} sitting (legs ${seated.bendDeg} deg)`, brick: seated.torso, figure: parts, pointLdu: local(seated.torso, [0, SEAT_BELOW_TORSO_LDU[seated.system], 0]) });
  }
  return out;
}

/** A rideable vehicle entity and the source parts its seats were read from (playable-addon.ts `vehicleSeats`). */
export interface VehicleSeatReport {
  label: string;
  entity: string;
  kind: string;
  /** Every placement the entity was compiled from. */
  bricks: readonly ParsedBrick[];
  /** The placements the driver's seat was read from (`Cockpit.evidenceParts`). */
  driver: readonly ParsedBrick[];
  /** The cockpit evidence (`CockpitSource`). */
  driverSource: string;
  /** Per measured passenger seat, the placements it was read from. */
  passengers: ReadonlyArray<readonly ParsedBrick[]>;
  /** Rideable seats the entity ships, the driver's included. */
  seatCount: number;
  /** How it is driven (`scripted car`, `native rotor`, ...). */
  controls: string;
  /** Wand sizes at which a rider is drawn in the driver's seat (null: always). */
  riderVisibleSizes: number[] | null;
  /** Where the driver sits, SOURCE LDraw (its seat pan): the place a cockpit with no seat part names (a canopy, a default cabin). */
  driverPointLdu: Vec3;
}

/** A scene's invisible seat (bedrock-scene-actors `SceneSeat`) and the source figure that rides it, if any. */
export interface SceneSeatReport {
  brick?: ParsedBrick;
  part: string;
  surfaceLdu: Vec3;
  occupant?: {
    label: string;
    bricks: ReadonlySet<ParsedBrick>;
    /** The figure gives the seat up to a player who comes to it (bedrock-figure-life.ts): the seat is the player's too. */
    yields?: boolean;
  };
}

/** Everything else a seat place can belong to in the pack. */
export interface SeatCensusContext {
  vehicles: readonly VehicleSeatReport[];
  /** The scene's invisible seats (bedrock-scene-actors `SceneSeat`) and who rides each one. */
  sceneSeats: ReadonlyArray<SceneSeatReport>;
  /** Other owners of placements: coaster cars and their riders, ride cars, moving parts, the pinball table, figures. */
  owners: ReadonlyArray<{ label: string; use: 'coaster' | 'ride' | 'none'; bricks: ReadonlySet<ParsedBrick>; reason: string; /** A moving part that turns on its own (a turnable): a wheel in it steers nothing. */ decoration?: boolean }>;
}

/** What the player can do at a place. */
export type SeatUse = 'driver' | 'passenger' | 'seat' | 'coaster' | 'ride' | 'occupied' | 'none';
/** Uses that seat the player (an `occupied` seat does not, until its figure leaves). */
export const PLAYER_SEAT_USES: ReadonlySet<SeatUse> = new Set(['driver', 'passenger', 'seat', 'coaster', 'ride']);
const USE_RANK: SeatUse[] = ['driver', 'passenger', 'seat', 'coaster', 'ride', 'occupied', 'none'];

export interface SeatCensusRow {
  kind: SeatPlaceKind;
  part: string;
  description: string;
  pointLdu: [number, number, number];
  use: SeatUse;
  /** The entity, seat or owner, and why. */
  detail: string;
  /** Index into `places`. */
  place: number;
}
export interface SeatCensusPlace { use: SeatUse; kinds: SeatPlaceKind[]; parts: string[]; pointLdu: [number, number, number]; detail: string }
export interface SeatCensus {
  rows: SeatCensusRow[];
  places: SeatCensusPlace[];
  /** Raw (per part) and distinct (per place) counts by use. */
  counts: { raw: Record<SeatUse, number>; distinct: Record<SeatUse, number> };
  /**
   * Parts named like a seat that are not a place to sit, and why: a steering
   * wheel or ship's wheel the build mounts as a turnable on a wall or a post
   * (10303's and 76457's 5 x 5 wheels, 910032's ten, 71040's helm) - kept
   * out of `places` so decoration does not read as a missed seat.
   */
  excluded: Array<{ kind: SeatPlaceKind; part: string; pointLdu: [number, number, number]; detail: string }>;
}

/** Two rows closer than this (LDU, horizontal and vertical) are one place: a seated driver 0-10 LDU over its seat mould, 30 behind its wheel. */
export const SAME_PLACE_LDU = { across: 28, up: 30 } as const;

/** Judge every place against the pack and cluster the rows into distinct places. */
export function takeSeatCensus(places: readonly SeatPlace[], context: SeatCensusContext): SeatCensus {
  const rows: Array<Omit<SeatCensusRow, 'place'>> = [];
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const matchedScene = new Set<number>();
  const excluded: SeatCensus['excluded'] = [];
  for (const place of places) {
    const pointLdu: [number, number, number] = [r1(place.pointLdu[0]), r1(place.pointLdu[1]), r1(place.pointLdu[2])];
    // A wheel that turns on its own (an interactive turnable) is steering nothing: decoration.
    const turnable = (place.kind === 'steering' || place.kind === 'helm') && place.brick
      ? context.owners.find(o => o.decoration && o.bricks.has(place.brick!)) : undefined;
    if (turnable) { excluded.push({ kind: place.kind, part: place.part, pointLdu, detail: `${turnable.label}: mounted to turn on its own, no vehicle around it` }); continue; }
    const verdict = judge(place, context, matchedScene);
    rows.push({ kind: place.kind, part: place.part, description: place.description, pointLdu, ...verdict });
  }
  // Brick-built seats have no mould: the scene's own seats that no part above named.
  context.sceneSeats.forEach((seat, i) => {
    if (matchedScene.has(i)) return;
    rows.push({ kind: 'brick-built', part: seat.part, description: `brick-built ${seat.part}`, pointLdu: [r1(seat.surfaceLdu[0]), r1(seat.surfaceLdu[1]), r1(seat.surfaceLdu[2])], ...sceneSeatVerdict(seat, i, ' (brick-built rule)') });
  });
  // A driver's seat no part above named (a canopy, glass or a default cabin; a figure the rig cannot read as sitting): the cockpit itself.
  for (const v of context.vehicles) {
    if (rows.some(row => row.use === 'driver' && row.detail.startsWith(`${v.entity}:`))) continue;
    rows.push({ kind: 'cockpit', part: v.driverSource, description: `${v.label}: the driver's seat`, pointLdu: [r1(v.driverPointLdu[0]), r1(v.driverPointLdu[1]), r1(v.driverPointLdu[2])], use: 'driver', detail: driverDetail(v) });
  }
  // Cluster: union-find over rows closer than SAME_PLACE_LDU.
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i]!.pointLdu, b = rows[j]!.pointLdu;
    if (Math.hypot(a[0] - b[0], a[2] - b[2]) <= SAME_PLACE_LDU.across && Math.abs(a[1] - b[1]) <= SAME_PLACE_LDU.up) parent[find(i)] = find(j);
  }
  const roots = [...new Set(rows.map((_, i) => find(i)))];
  const placeOf = new Map(roots.map((r, k) => [r, k]));
  const placesOut: SeatCensusPlace[] = roots.map(r => {
    const members = rows.filter((_, i) => find(i) === r);
    const best = members.reduce((a, b) => USE_RANK.indexOf(b.use) < USE_RANK.indexOf(a.use) ? b : a);
    return { use: best.use, kinds: [...new Set(members.map(m => m.kind))], parts: [...new Set(members.map(m => m.part))], pointLdu: best.pointLdu, detail: best.detail };
  });
  // A part counts at its PLACE's use (a driver's seat mould and wheel are the driver's seat too); its own verdict stays in `detail`.
  const out: SeatCensusRow[] = rows.map((row, i) => {
    const place = placeOf.get(find(i))!;
    return { ...row, use: placesOut[place]!.use, place };
  });
  const tally = (list: ReadonlyArray<{ use: SeatUse }>): Record<SeatUse, number> => {
    const t = Object.fromEntries(USE_RANK.map(u => [u, 0])) as Record<SeatUse, number>;
    for (const x of list) t[x.use]++;
    return t;
  };
  return { rows: out, places: placesOut, counts: { raw: tally(out), distinct: tally(placesOut) }, excluded };
}

function judge(place: SeatPlace, context: SeatCensusContext, matchedScene: Set<number>): { use: SeatUse; detail: string } {
  const b = place.brick;
  // 1. A rideable vehicle's.
  for (const v of context.vehicles) {
    if (!b || !v.bricks.includes(b)) continue;
    if (v.driver.includes(b)) return { use: 'driver', detail: driverDetail(v) };
    const k = v.passengers.findIndex(list => list.includes(b));
    if (k >= 0) return { use: 'passenger', detail: `${v.entity}: passenger seat ${k + 1} of ${v.seatCount - 1}` };
    const why = place.kind === 'seated-figure' ? 'a figure sitting in it that is not the driver stays in the vehicle\'s geometry; its seat is not offered'
      : place.kind === 'steering' || place.kind === 'helm' ? `not the driver's place (the driver's seat came from ${v.driverSource})`
      : place.kind === 'seat-mould' ? `a seat mould that is not a player seat (${v.seatCount - 1} passenger seat${v.seatCount === 2 ? '' : 's'} shipped; a figure may sit on it)`
      : `part of the vehicle's body`;
    return { use: 'none', detail: `${v.entity}: ${why}` };
  }
  // 2. A scene seat (its mould is the seat's own placement; a seated figure rides it).
  if (b) {
    const i = context.sceneSeats.findIndex(s => s.brick === b);
    if (i >= 0) {
      matchedScene.add(i);
      const s = context.sceneSeats[i]!;
      return sceneSeatVerdict(s, i, '');
    }
    if (place.kind === 'seated-figure') {
      const j = context.sceneSeats.findIndex(s => s.occupant?.bricks.has(b));
      if (j >= 0) return sceneSeatVerdict(context.sceneSeats[j]!, j, ` (${context.sceneSeats[j]!.part})`);
    }
  }
  // 3. Anything else that took the part.
  for (const owner of context.owners) {
    if (b && owner.bricks.has(b)) return { use: owner.use, detail: `${owner.label}: ${owner.reason}` };
  }
  // 4. Left in the static build.
  const why: Record<SeatPlaceKind, string> = {
    'seat-mould': 'a seat mould left in the build with no seat entity',
    furniture: 'a furniture mould left in the build with no seat entity',
    saddle: 'a saddle: animals are not rideable',
    steering: 'a steering wheel in the build: no vehicle was found around it',
    helm: 'a ship\'s wheel in the build: no vehicle was found around it',
    'seated-figure': 'a figure the source sat down on no seat the scene found',
    'brick-built': 'brick-built',
    cockpit: 'a cockpit',
  };
  return { use: 'none', detail: why[place.kind] };
}

/** A driver's seat, for the census detail. */
function driverDetail(v: VehicleSeatReport): string {
  const drawn = v.riderVisibleSizes ? `; rider drawn at ${v.riderVisibleSizes.length ? v.riderVisibleSizes.map(f => `${f * 100}%`).join('/') : 'no size (hidden, eye only)'}` : '';
  return `${v.entity}: the driver's seat (${v.driverSource}; ${v.controls}; ${v.seatCount} seat${v.seatCount === 1 ? '' : 's'}${drawn})`;
}

/** A scene seat: the player's, or held by the source figure that rides it (unless that figure gives it up). */
function sceneSeatVerdict(seat: SceneSeatReport, i: number, note: string): { use: SeatUse; detail: string } {
  if (!seat.occupant) return { use: 'seat', detail: `scene seat ${i + 1}${note}` };
  return seat.occupant.yields
    ? { use: 'seat', detail: `scene seat ${i + 1}${note}: ${seat.occupant.label} sits there and gives it up to a player` }
    : { use: 'occupied', detail: `scene seat ${i + 1}${note}, ridden by ${seat.occupant.label}` };
}

/** One line for the export's warnings. */
export function describeSeatCensus(label: string, census: SeatCensus): string {
  const c = census.counts;
  const player = (t: Record<SeatUse, number>): number => [...PLAYER_SEAT_USES].reduce((n, u) => n + t[u], 0);
  const parts = (t: Record<SeatUse, number>): string => USE_RANK.filter(u => t[u]).map(u => `${t[u]} ${u}`).join(', ');
  return `${label}: seats - ${census.places.length} place${census.places.length === 1 ? '' : 's'} a figure sits (${census.rows.length} part${census.rows.length === 1 ? '' : 's'} name them); the player can sit at ${player(c.distinct)} (${parts(c.distinct) || 'none'}).`;
}
