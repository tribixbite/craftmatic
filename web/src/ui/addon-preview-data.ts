/**
 * The DATA side of the in-browser add-on walk (ui/addon-preview.ts is the
 * visual side): everything a generated `.mcaddon` says about itself, read
 * back out of the pack, plus the pure arithmetic the preview needs — the
 * collider grid as the wand lays it at a chosen size and quarter turn, the
 * invisible treads that ship for that size, the reach walk over it, and the
 * legend counts. No DOM, no Three.js: all of it is unit-tested against the
 * real packs in `output/bedrock-entity-qa/`.
 *
 * Frame. Every position here is in MODEL BLOCKS at 100 %, Y up, from the
 * model's corner — the frame `PlacementActor` positions, the collider cells
 * and the coaster route samples all share (the runtime's `pointAt` then
 * `× f`). At size `f` and turn `r` the laid grid is `scaledDims`, and a
 * model point lands at `rotatePlacementPoint(p) × f`.
 *
 * What the pack carries and where (see `buildPlayableAddon`):
 *   - `<BP>/scripts/placement.js` — `const CONFIG = {...}`: the actor list
 *     (typeId, label, x/y/z/yaw, ride/door/coaster links), the run-length
 *     collider grid with its tread plans per `${size}:${turn}`, the access
 *     recommendation, the runtime door candidates and the size steps.
 *   - `<BP>/scripts/coaster.js` — `const CONFIG = {...}`: the measured routes
 *     (the polyline itself, its station arc span, chain span, lift) and the
 *     role of every coaster entity type.
 *   - `<BP>/craftmatic-diagnostics.json` — the provenance stamp, the full
 *     access measurement and per-entity geometry diagnostics.
 *   - `<BP>/craftmatic-treads.json` — the tread planner's report per size and
 *     turn: reach before/after, refused edges, targets.
 */

import {
  colliderSourceCells, decodeTreadPlan, rotatePlacementPoint, SIZE_STEPS,
  type PlacementActor, type PlacementColliders, type PlacementRotation, type PlacementTreadReport,
} from '@engine/bedrock-placement-pack.js';
import {
  cellColumns, rotatedCell, scaledDims, ScaledColliderGrid, walkScaledColliders,
  type GridDims, type QuarterTurn, type ReachResult, type SourceCell, type TreadBlock,
} from '@engine/bedrock-collider-scale.js';
import type { AccessScaleRecommendation } from '@engine/bedrock-scene-actors.js';
import type { PinballMap, PinballRuntimeConfig } from '@engine/bedrock-pinball.js';
import type { CoasterRiderViewConfig } from '@engine/bedrock-coaster.js';
import { extractMatching, listZipEntries } from '@engine/zip-utils.js';
import type { InteractiveRuntimeConfig } from '@engine/bedrock-interactives.js';
import { APPEARANCE_FILE_PATTERN, buildAddonAppearance, type AddonAppearance } from './addon-appearance.js';

// ─── Model ───────────────────────────────────────────────────────────────────

/** The kinds the legend counts. `lift` is a platform lift; `counterweight` its opposite. */
export type AddonEntityKind = 'shell' | 'figure' | 'seat' | 'door' | 'car' | 'lift' | 'counterweight' | 'vehicle' | 'screen' | 'other';

export interface AddonEntity {
  typeId: string;
  label: string;
  kind: AddonEntityKind;
  /** Model blocks at 100 % from the model's corner (`PlacementActor`). */
  x: number; y: number; z: number;
  /** Bedrock yaw, degrees (0 faces +Z). */
  yaw: number;
  /** The actor this one rides once both are spawned (a figure on a seat). */
  rideOf?: number;
  coasterRouteIndex?: number;
  coasterCarIndex?: number;
  /** Spawns only below this wand size (a door leaf the vanilla door replaces). */
  maxSizeExclusive?: number;
  hideAt100?: boolean;
  /** The console, ball or a flipper of a playable pinball table (`PlacementActor.pinball`). */
  pinball?: boolean;
  /** An interactive part's index in `scripts/interactives.js`'s items (`PlacementActor.interactive`). */
  interactive?: number;
}

export interface AddonRouteLift {
  type: string;
  counterweightType?: string;
  deckLength: number;
  travel: [number, number, number];
  parkedPoint: [number, number, number];
  counterweightPoint?: [number, number, number];
}

export interface AddonRoute {
  label: string;
  /** The measured track polyline, model blocks at 100 %. */
  points: Array<[number, number, number]>;
  /** Arc length at each point. */
  cumulative: number[];
  length: number;
  closed: boolean;
  /** The flat reload zone: arc span and the brake point. */
  station?: { start: number; end: number; stop: number; point: [number, number, number] };
  /** A measured chain drive's arc span. */
  chain?: { start: number; end: number };
  lift?: AddonRouteLift;
  /** `heading` ±1: the set's own cars keep their authored nose along the route; 0: the fabricated cart faces its motion. */
  cars: { count: number; spacing: number; extent: number; heading: 1 | -1 | 0; slots?: Array<{ type: string; rider: number; label: string }> };
  direction: 1 | -1 | 0;
}

/** A vanilla door the wand hangs at a size where the opening is big enough. */
export interface AddonDoorCandidate { x: number; y: number; z: number; requiredSize: number }

export interface AddonPreviewModel {
  /** The pack's id (`CONFIG.id`) and display label. */
  id: string;
  label: string;
  /** The 100 % grid the structure tiles span. */
  dims: GridDims;
  /** The shipped collider cells, decoded from the run-length grid (empty for a blocks-only pack). */
  cells: SourceCell[];
  /** The shipped collider record, when the pack has one (its tread plans live here). */
  colliders: PlacementColliders | null;
  /** Cells that are blocks at 100 % only (doors, lights): not colliders, not re-laid. */
  keptCells: number;
  entities: AddonEntity[];
  routes: AddonRoute[];
  doorCandidates: AddonDoorCandidate[];
  /** The wand's own size steps (percent). */
  sizes: number[];
  /** The measured walk-through recommendation carried by the pack, whole. */
  access: { sizePct?: number; reason: string } | null;
  /** The same measurement with its numbers, from the diagnostics file. */
  accessDetail: AccessScaleRecommendation | null;
  treadReport: PlacementTreadReport | null;
  /** The pipeline stamp the pack name carries, and the source it was built from. */
  provenance: { display?: string; source?: { file?: string; hash?: string; setNum?: string } } | null;
  /** Cuboid budget as the pack reports it. */
  pack: { cuboids?: number; entities?: number; shareOfDeviceBudget?: number } | null;
  /** What the pack DRAWS, read back from its geometry: null when it ships none. */
  appearance: AddonAppearance | null;
  /** Face atlas PNG bytes by resource path (no extension), for groups with a `texture`. */
  faceTextures?: Map<string, Uint8Array>;
  /**
   * `scripts/coaster.js`'s `CONFIG.types`, whole: role plus the measured
   * `wheelbase` (blocks, the chord a car pitches on) and `seat` (the rideable
   * seat offset, entity frame) `buildCoasterRideAssets` fills in. Keyed by the
   * full type id, same as `AddonEntity.typeId` and `AddonRoute.cars.slots[].type`.
   */
  coasterTypes: Record<string, { role: string; riders: number; wheelbase?: number; seat?: [number, number, number] }>;
  /** The pack's rider camera (`CONFIG.camera`, `COASTER_RIDER_VIEW`); absent in a pack built before it, which rides in plain first person. */
  coasterCamera?: CoasterRiderViewConfig;
  /**
   * `scripts/pinball.js`'s `CONFIG`, whole (`PinballRuntimeConfig`), when the
   * pack ships a playable pinball table: the console/ball/flipper type ids,
   * the simulation table and the plane-to-world map the walk needs to run the
   * same `createPinballSim` and place its ball/flippers. Null for any other
   * pack, or one whose script the preview could not parse.
   */
  pinball: PinballRuntimeConfig | null;
  /**
   * `scripts/interactives.js`'s `CONFIG`, whole (`InteractiveRuntimeConfig`,
   * bedrock-interactives.ts): each moving part's class, angle, hinge (pivot +
   * axis in model blocks), doorway cells and passable size. Null when the pack
   * ships no moving parts.
   */
  interactives: InteractiveRuntimeConfig | null;
  /** Per-entity-type collision the pack's BEHAVIOUR file declares, when
   * `minecraft:physics.has_collision` is true (a standing figure blocks a
   * player in game; a ride car's is `false` — see CLAUDE.md/bedrock-coaster.ts —
   * so it is simply absent here and the preview adds no box for it). */
  entityCollision: Map<string, { width: number; height: number }>;
  /** Anything about the pack the preview could not read, said rather than dropped. */
  notes: string[];
}

// ─── Pack reading ────────────────────────────────────────────────────────────

/**
 * Take the first balanced `{...}` JSON object that follows `marker` in a
 * script — the pack's `const CONFIG = ` literal. A JSON-aware scan (strings
 * and escapes respected) because the collider runs use every character from
 * `(` upward, braces included.
 */
export function extractJsonAfter(source: string, marker: string): unknown {
  const at = source.indexOf(marker);
  if (at < 0) return undefined;
  const start = source.indexOf('{', at + marker.length);
  if (start < 0) return undefined;
  let depth = 0, inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
  }
  return undefined;
}

/** Behaviour-pack `entities/<id>.json`: the BP's own per-type definition (plural "entities", vs the RP's singular "entity"). */
const BEHAVIOR_ENTITY_FILE_PATTERN = /(^|\/)entities\/[^/]+\.json$/;

/** The raw files the preview reads; `readAddonPreviewFiles` fills it from a `.mcaddon`. */
export interface AddonPreviewFiles {
  placementScript?: string;
  coasterScript?: string;
  pinballScript?: string;
  interactivesScript?: string;
  diagnosticsJson?: string;
  treadsJson?: string;
  /** Resource-pack geometry, entity and controller files, keyed by archive path. */
  appearanceSources?: Map<string, string>;
  /** Behaviour-pack `entities/<id>.json` files, keyed by archive path — read for
   * `minecraft:collision_box` / `minecraft:physics.has_collision` (`entityCollisionFromSources`). */
  behaviorEntitySources?: Map<string, string>;
  /**
   * Face atlases (`textures/entity/<id>_faces.png`), keyed by resource path
   * WITHOUT the extension - the form a client entity's `textures` map uses.
   */
  faceTextures?: Map<string, Uint8Array>;
}

const utf8 = new TextDecoder();
/** A face atlas the compiler writes beside an entity (`head-face.ts`). */
const FACE_TEXTURE_PATTERN = /(^|\/)(textures\/entity\/[^/]+_faces)\.png$/;

/** Pull the files the preview reads out of a built `.mcaddon` (a zip of the BP and RP folders). */
export async function readAddonPreviewFiles(mcaddon: ArrayBuffer): Promise<AddonPreviewFiles> {
  const behaviour = (name: string): boolean => /(^|\/)(scripts\/(placement|coaster|pinball|interactives)\.js|craftmatic-diagnostics\.json|craftmatic-treads\.json)$/.test(name);
  const wanted = (name: string): boolean => behaviour(name) || APPEARANCE_FILE_PATTERN.test(name) || BEHAVIOR_ENTITY_FILE_PATTERN.test(name) || FACE_TEXTURE_PATTERN.test(name);
  const names = listZipEntries(mcaddon).filter(behaviour);
  if (!names.length) throw new Error('Not a Craftmatic add-on: no scripts/placement.js in the archive.');
  const found = await extractMatching(mcaddon, wanted);
  const text = (suffix: RegExp): string | undefined => {
    for (const [name, data] of found) if (suffix.test(name)) return utf8.decode(data);
    return undefined;
  };
  const appearanceSources = new Map<string, string>();
  for (const [name, data] of found) if (APPEARANCE_FILE_PATTERN.test(name)) appearanceSources.set(name, utf8.decode(data));
  const behaviorEntitySources = new Map<string, string>();
  for (const [name, data] of found) if (BEHAVIOR_ENTITY_FILE_PATTERN.test(name)) behaviorEntitySources.set(name, utf8.decode(data));
  const faceTextures = new Map<string, Uint8Array>();
  for (const [name, data] of found) { const m = FACE_TEXTURE_PATTERN.exec(name); if (m) faceTextures.set(m[2]!, new Uint8Array(data)); }
  return {
    placementScript: text(/scripts\/placement\.js$/),
    coasterScript: text(/scripts\/coaster\.js$/),
    pinballScript: text(/scripts\/pinball\.js$/),
    interactivesScript: text(/scripts\/interactives\.js$/),
    diagnosticsJson: text(/craftmatic-diagnostics\.json$/),
    treadsJson: text(/craftmatic-treads\.json$/),
    appearanceSources,
    behaviorEntitySources,
    faceTextures,
  };
}

/**
 * Every entity type's `minecraft:collision_box`, but only where
 * `minecraft:physics.has_collision` is true — a ride car, the shell and the
 * screen all declare `has_collision: false` (the player walks through them;
 * the LEGO collider grid or, for a car, nothing at all is what actually
 * blocks a player there — see CLAUDE.md), so they are correctly ABSENT here
 * rather than zeroed. A standing figure is `true` at 0.6 x 1.8, same as the
 * player's own box, and that is genuinely a box a player bumps into in game.
 */
export function entityCollisionFromSources(sources: ReadonlyMap<string, string>): Map<string, { width: number; height: number }> {
  const out = new Map<string, { width: number; height: number }>();
  for (const [, text] of sources) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    const entity = (parsed as { 'minecraft:entity'?: Record<string, unknown> })['minecraft:entity'];
    const identifier = (entity?.['description'] as { identifier?: string } | undefined)?.identifier;
    const components = entity?.['components'] as Record<string, unknown> | undefined;
    if (!identifier || !components) continue;
    const physics = components['minecraft:physics'] as { has_collision?: boolean } | undefined;
    if (physics?.has_collision !== true) continue;
    const box = components['minecraft:collision_box'] as { width?: unknown; height?: unknown } | undefined;
    const width = typeof box?.width === 'number' ? box.width : undefined;
    const height = typeof box?.height === 'number' ? box.height : undefined;
    if (width !== undefined && height !== undefined) out.set(identifier, { width, height });
  }
  return out;
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const vec3 = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number') ? [v[0] as number, v[1] as number, v[2] as number] : undefined;

/**
 * What an actor IS, from its entity type id. `buildPlayableAddon` prefixes a
 * numeric stem with a letter (`b_` shell, `f_` figure, `s_` seat/screen,
 * `c_` coaster, `v_` vehicle) but leaves an alphabetic stem bare, so the
 * suffix is what is classified; the coaster role table settles car vs lift.
 * A pinball table's actors carry `pinball: true` (bedrock-placement-pack.ts)
 * rather than a matching suffix — the console is classified `seat`-like (the
 * walk gives it its own "Play pinball" interact instead of a plain "Sit");
 * the ball and flippers fall through to `other` (they render as real
 * geometry regardless, and need no legend row of their own).
 */
export function classifyAddonEntity(typeId: string, actor: Partial<PlacementActor>, coasterRoles: Record<string, string>, pinballConsoleType?: string): AddonEntityKind {
  const id = typeId.replace(/^[^:]*:/, '');
  if (actor.pinball && pinballConsoleType && typeId === pinballConsoleType) return 'seat';
  const role = coasterRoles[typeId] ?? coasterRoles[id];
  if (role === 'platform') return 'lift';
  if (role === 'counterweight') return 'counterweight';
  if (role === 'car' || actor.coasterRouteIndex !== undefined || /_coaster_(vehicle|cart)(_\d+)?$/.test(id)) return 'car';
  if (/_shell$/.test(id)) return 'shell';
  if (/_fig\d+$/.test(id) || /^f_/.test(id)) return 'figure';
  // Every moving part (door, window, hatch, lever, turnable) is on the legend's door row; its class is in `interactives`.
  if (actor.interactive !== undefined || /_door_leaf_\d+$/.test(id) || actor.doorCandidateIndex !== undefined) return 'door';
  if (/_seat(_\d+)?$/.test(id) || /_manual_seat$/.test(id)) return 'seat';
  if (/_screen(_\d+)?$/.test(id)) return 'screen';
  if (/^v_/.test(id)) return 'vehicle';
  return 'other';
}

/**
 * Build the preview model from the pack's files. Only `placementScript` is
 * required; a missing coaster script, diagnostics or tread report is noted
 * and the model is built without it.
 */
export function buildAddonPreviewModel(files: AddonPreviewFiles): AddonPreviewModel {
  const notes: string[] = [];
  if (!files.placementScript) throw new Error('The pack has no scripts/placement.js — nothing to walk.');
  const config = extractJsonAfter(files.placementScript, 'const CONFIG') as Record<string, unknown> | undefined;
  if (!config) throw new Error('scripts/placement.js carries no CONFIG literal.');

  const dims: GridDims = { width: Math.max(1, num(config['width'], 1)), height: Math.max(1, num(config['height'], 1)), length: Math.max(1, num(config['length'], 1)) };
  const colliders = (config['colliders'] && typeof config['colliders'] === 'object' && typeof (config['colliders'] as PlacementColliders).runs === 'string')
    ? config['colliders'] as PlacementColliders : null;
  if (!colliders) notes.push('This pack ships no collider grid (a blocks-only building or a vehicle-only pack): there is nothing to re-lay, so every size shows the same footprint.');
  const cells = colliders ? colliderSourceCells(colliders) : [];

  // Coaster: routes and the role of each coaster entity type.
  const routes: AddonRoute[] = [];
  const coasterRoles: Record<string, string> = {};
  const coasterTypes: AddonPreviewModel['coasterTypes'] = {};
  let coasterCamera: CoasterRiderViewConfig | undefined;
  if (files.coasterScript) {
    const coaster = extractJsonAfter(files.coasterScript, 'const CONFIG') as Record<string, unknown> | undefined;
    if (coaster) {
      const camera = coaster['camera'] as Record<string, unknown> | undefined;
      const mode = camera?.['mode'];
      if (camera && (mode === 'roll' || mode === 'rollover' || mode === 'clamp' || mode === 'over' || mode === 'off')) {
        coasterCamera = { mode, lookYaw: num(camera['lookYaw'], 70), lookPitch: num(camera['lookPitch'], 50), ease: num(camera['ease'], 0.1), maxTurn: num(camera['maxTurn'], 40), spline: num(camera['spline'], 0.05) };
      }
      for (const [type, t] of Object.entries((coaster['types'] as Record<string, { role?: string; riders?: number; wheelbase?: number; seat?: unknown }> | undefined) ?? {})) {
        if (!t?.role) continue;
        coasterRoles[type] = t.role;
        coasterTypes[type] = {
          role: t.role, riders: num(t.riders),
          ...(typeof t.wheelbase === 'number' ? { wheelbase: t.wheelbase } : {}),
          ...(vec3(t.seat) ? { seat: vec3(t.seat)! } : {}),
        };
      }
      for (const r of (coaster['routes'] as Array<Record<string, unknown>> | undefined) ?? []) {
        const path = r['path'] as { points?: unknown[]; cumulative?: unknown[]; length?: number; closed?: boolean } | undefined;
        const points = (path?.points ?? []).map(vec3).filter((p): p is [number, number, number] => !!p);
        if (points.length < 2) { notes.push(`Route "${String(r['label'] ?? '?')}" has fewer than two samples and is not drawn.`); continue; }
        const cumulative = Array.isArray(path?.cumulative) && path.cumulative.length === points.length
          ? path.cumulative.map(v => num(v)) : arcLengths(points);
        const station = r['station'] as Record<string, unknown> | undefined;
        const lift = r['lift'] as Record<string, unknown> | undefined;
        const cars = r['cars'] as Record<string, unknown> | undefined;
        const chain = r['chain'] as Record<string, unknown> | undefined;
        const stationPoint = station ? vec3(station['point']) : undefined;
        const liftTravel = lift ? vec3(lift['travel']) : undefined, liftParked = lift ? vec3(lift['parkedPoint']) : undefined;
        routes.push({
          label: String(r['label'] ?? `Track ${routes.length + 1}`),
          points, cumulative,
          length: num(path?.length, cumulative[cumulative.length - 1] ?? 0),
          closed: path?.closed === true,
          ...(station && stationPoint ? { station: { start: num(station['start']), end: num(station['end']), stop: num(station['stop']), point: stationPoint } } : {}),
          ...(chain ? { chain: { start: num(chain['start']), end: num(chain['end']) } } : {}),
          ...(lift && liftTravel && liftParked ? { lift: {
            type: String(lift['type'] ?? ''),
            ...(typeof lift['counterweightType'] === 'string' ? { counterweightType: lift['counterweightType'] } : {}),
            deckLength: num(lift['deckLength']), travel: liftTravel, parkedPoint: liftParked,
            ...(vec3(lift['counterweightPoint']) ? { counterweightPoint: vec3(lift['counterweightPoint'])! } : {}),
          } } : {}),
          cars: { count: Math.max(1, num(cars?.['count'], 1)), spacing: num(cars?.['spacing']), extent: num(cars?.['extent']),
            heading: (cars?.['heading'] === 1 || cars?.['heading'] === -1 ? cars['heading'] : 0) as 1 | -1 | 0,
            ...(Array.isArray(cars?.['slots']) ? { slots: cars['slots'] as AddonRoute['cars']['slots'] } : {}) },
          direction: (r['direction'] === 1 || r['direction'] === -1 ? r['direction'] : 0) as 1 | -1 | 0,
        });
      }
    } else notes.push('scripts/coaster.js carries no CONFIG literal; the track is not drawn.');
  }

  // Pinball: the console/ball/flipper type ids and the simulation the walk
  // needs to play the table itself. `PinballRuntimeConfig` is exactly the
  // `CONFIG` literal `pinballScript` (bedrock-pinball.ts) serialises, so a
  // successful parse is already shaped right — no per-field reconstruction
  // the way the coaster/access blocks above need for a plain JSON blob.
  let pinball: PinballRuntimeConfig | null = null;
  if (files.pinballScript) {
    const cfg = extractJsonAfter(files.pinballScript, 'const CONFIG') as PinballRuntimeConfig | undefined;
    if (cfg && cfg.sim && cfg.map && typeof cfg.consoleType === 'string' && typeof cfg.ballType === 'string' && Array.isArray(cfg.flipperTypes)) pinball = cfg;
    else notes.push('scripts/pinball.js carries no usable CONFIG literal; the pinball table is shown as a static model, not played.');
  }

  let interactives: InteractiveRuntimeConfig | null = null;
  if (files.interactivesScript) {
    const cfg = extractJsonAfter(files.interactivesScript, 'const CONFIG') as InteractiveRuntimeConfig | undefined;
    if (cfg && Array.isArray(cfg.items) && cfg.dims) interactives = cfg;
    else notes.push('scripts/interactives.js carries no usable CONFIG literal; the moving parts are drawn but do not open.');
  }

  const entities: AddonEntity[] = [];
  for (const a of (config['actors'] as PlacementActor[] | undefined) ?? []) {
    if (typeof a?.typeId !== 'string') continue;
    entities.push({
      typeId: a.typeId, label: String(a.label ?? a.typeId),
      kind: classifyAddonEntity(a.typeId, a, coasterRoles, pinball?.consoleType),
      x: num(a.x), y: num(a.y), z: num(a.z), yaw: num(a.yaw),
      ...(a.rideOf !== undefined ? { rideOf: a.rideOf } : {}),
      ...(a.coasterRouteIndex !== undefined ? { coasterRouteIndex: a.coasterRouteIndex } : {}),
      ...(a.coasterCarIndex !== undefined ? { coasterCarIndex: a.coasterCarIndex } : {}),
      ...(a.maxSizeExclusive !== undefined ? { maxSizeExclusive: a.maxSizeExclusive } : {}),
      ...(a.hideAt100 ? { hideAt100: true } : {}),
      ...(a.pinball ? { pinball: true } : {}),
      ...(typeof a.interactive === 'number' ? { interactive: a.interactive } : {}),
    });
  }
  if (pinball) {
    const missing = [pinball.consoleType, pinball.ballType, ...pinball.flipperTypes].filter(t => !entities.some(e => e.typeId === t));
    if (missing.length) notes.push(`The pinball table's own actors are missing from the placement (${missing.join(', ')}); it cannot be played in the walk.`);
  }

  const doorCandidates: AddonDoorCandidate[] = [];
  for (const d of (config['runtimeDoorCandidates'] as Array<Record<string, unknown>> | undefined) ?? []) {
    doorCandidates.push({ x: num(d['x']), y: num(d['y']), z: num(d['z']), requiredSize: num(d['requiredSize'], 100) });
  }

  let accessDetail: AccessScaleRecommendation | null = null;
  let provenance: AddonPreviewModel['provenance'] = null;
  let pack: AddonPreviewModel['pack'] = null;
  if (files.diagnosticsJson) {
    try {
      const diag = JSON.parse(files.diagnosticsJson) as Record<string, unknown>;
      if (diag['access'] && typeof diag['access'] === 'object') accessDetail = diag['access'] as AccessScaleRecommendation;
      provenance = {
        ...(typeof diag['display'] === 'string' ? { display: diag['display'] } : {}),
        ...(diag['source'] && typeof diag['source'] === 'object' ? { source: diag['source'] as { file?: string; hash?: string; setNum?: string } } : {}),
      };
      if (diag['pack'] && typeof diag['pack'] === 'object') {
        const p = diag['pack'] as Record<string, unknown>;
        pack = { cuboids: num(p['cuboids']), entities: num(p['entities']), shareOfDeviceBudget: num(p['shareOfDeviceBudget']) };
      }
    } catch { notes.push('craftmatic-diagnostics.json is not valid JSON; the provenance and access details are unavailable.'); }
  } else notes.push('The pack carries no craftmatic-diagnostics.json (built before it existed?): no provenance or access numbers.');

  let treadReport: PlacementTreadReport | null = null;
  if (files.treadsJson) {
    try { treadReport = JSON.parse(files.treadsJson) as PlacementTreadReport; }
    catch { notes.push('craftmatic-treads.json is not valid JSON; the planner report is unavailable.'); }
  }

  const access = config['access'] && typeof config['access'] === 'object'
    ? { ...(typeof (config['access'] as { sizePct?: number }).sizePct === 'number' ? { sizePct: (config['access'] as { sizePct: number }).sizePct } : {}), reason: String((config['access'] as { reason?: string }).reason ?? '') }
    : null;
  const sizes = Array.isArray(config['sizes']) && (config['sizes'] as unknown[]).every(s => typeof s === 'number') ? config['sizes'] as number[] : [...SIZE_STEPS];

  // What the pack DRAWS. A pack read from an older export may carry no
  // resource-pack files here; the preview then simply has no model layer, and
  // says so rather than showing an empty world as if that were the model.
  let appearance: AddonAppearance | null = null;
  if (files.appearanceSources?.size) {
    appearance = buildAddonAppearance(files.appearanceSources);
    notes.push(...appearance.notes);
    if (!appearance.cubeCount) { notes.push('The pack ships geometry the preview could not read: no model layer.'); appearance = null; }
  }

  const entityCollision = files.behaviorEntitySources?.size ? entityCollisionFromSources(files.behaviorEntitySources) : new Map<string, { width: number; height: number }>();

  return {
    id: String(config['id'] ?? 'addon'), label: String(config['label'] ?? config['id'] ?? 'Add-on'),
    dims, cells, colliders, keptCells: colliders ? num(colliders.keptCells) : 0,
    entities, routes, doorCandidates, sizes, access, accessDetail, treadReport, provenance, pack,
    appearance, faceTextures: files.faceTextures ?? new Map(), coasterTypes, ...(coasterCamera ? { coasterCamera } : {}), pinball, interactives, entityCollision, notes,
  };
}

/** Cumulative arc length of a polyline (for a route whose script carries none). */
export function arcLengths(points: ReadonlyArray<readonly [number, number, number]>): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    out.push(out[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return out;
}

/** Read a `.mcaddon` into a preview model in one step. */
export async function loadAddonPreviewModel(mcaddon: ArrayBuffer): Promise<AddonPreviewModel> {
  return buildAddonPreviewModel(await readAddonPreviewFiles(mcaddon));
}

// ─── Legend ──────────────────────────────────────────────────────────────────

/** The legend's rows, in display order. */
export const LEGEND_KINDS = ['model', 'figure', 'seat', 'door', 'track', 'vehicle', 'collider', 'tread'] as const;
export type LegendKind = typeof LEGEND_KINDS[number];

export const LEGEND_LABELS: Record<LegendKind, string> = {
  model: 'Model (in game)', figure: 'Minifigs', seat: 'Chairs / seats', door: 'Doors / moving parts', track: 'Track', vehicle: 'Vehicles', collider: 'Colliders', tread: 'Treads',
};

/** Which legend row an entity belongs to (null: the shell and other non-legend actors). */
export function legendKindOf(kind: AddonEntityKind): LegendKind | null {
  switch (kind) {
    case 'figure': return 'figure';
    case 'seat': return 'seat';
    case 'door': return 'door';
    case 'car': case 'lift': case 'counterweight': case 'vehicle': return 'vehicle';
    default: return null;
  }
}

export interface LegendCounts extends Record<LegendKind, number> {
  /** Extra detail per row, for the legend's subtitle. */
  detail: Partial<Record<LegendKind, string>>;
}

/**
 * Counts per legend row. Doors count leaves AND runtime candidates (a candidate
 * becomes a vanilla door at the size it names). Track counts routes; its
 * detail carries total length, stations and lifts. Treads count the blocks
 * shipped for the chosen size and turn.
 */
export function legendCounts(model: AddonPreviewModel, sizePct: number, rotation: QuarterTurn): LegendCounts {
  const counts: LegendCounts = { model: 0, figure: 0, seat: 0, door: 0, track: 0, vehicle: 0, collider: 0, tread: 0, detail: {} };
  let cars = 0, lifts = 0, counterweights = 0, vehicles = 0, riders = 0;
  for (const e of model.entities) {
    const k = legendKindOf(e.kind);
    if (k) counts[k]++;
    if (e.kind === 'car') cars++;
    else if (e.kind === 'lift') lifts++;
    else if (e.kind === 'counterweight') counterweights++;
    else if (e.kind === 'vehicle') vehicles++;
    if (e.kind === 'figure' && e.rideOf !== undefined) riders++;
  }
  counts.door += model.doorCandidates.length;
  counts.track = model.routes.length;
  counts.collider = model.cells.length;
  // The drawn model: cuboids over the entities that actually spawn at this size.
  if (model.appearance) {
    let cubes = 0, drawn = 0;
    for (const e of model.entities) {
      if (!entitySpawnsAt(e, sizePct)) continue;
      const entry = model.appearance.byType.get(e.typeId);
      if (!entry) continue;
      cubes += entry.cubeCount; drawn++;
    }
    counts.model = cubes;
    // Say so when the preview draws fewer cuboids than the pack reports: a
    // geometry it could not read is a gap in the answer, not a smaller model.
    const shipped = model.pack?.cuboids;
    const short = typeof shipped === 'number' && shipped > cubes ? shipped - cubes : 0;
    counts.detail.model = `${drawn} entit${drawn === 1 ? 'y' : 'ies'} drawn`
      + (short ? `, ${short.toLocaleString()} the preview could not read` : '');
  }
  counts.tread = treadBlocksAt(model, sizePct, rotation).length;
  if (riders) counts.detail.figure = `${riders} seated`;
  if (model.interactives?.items.length) {
    const byKind = new Map<string, number>();
    for (const it of model.interactives.items) byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
    const passNow = model.interactives.items.filter(it => it.passSize !== undefined && it.passSize > 0 && sizePct >= it.passSize).length;
    const doorways = model.interactives.items.filter(it => it.passSize !== undefined).length;
    counts.detail.door = `${[...byKind].map(([k, n]) => `${n} ${k}${n === 1 ? '' : k === 'hatch' ? 'es' : 's'}`).join(', ')}${doorways ? `; ${passNow}/${doorways} passable at ${sizePct} %` : ''}`;
  } else if (model.doorCandidates.length) counts.detail.door = `${model.doorCandidates.length} vanilla at size`;
  if (model.routes.length) {
    const length = model.routes.reduce((s, r) => s + r.length, 0);
    const stations = model.routes.filter(r => r.station).length, routeLifts = model.routes.filter(r => r.lift).length, chains = model.routes.filter(r => r.chain).length;
    counts.detail.track = `${Math.round(length)} blocks${stations ? `, ${stations} station${stations === 1 ? '' : 's'}` : ''}${routeLifts ? `, ${routeLifts} lift${routeLifts === 1 ? '' : 's'}` : ''}${chains ? `, ${chains} chain${chains === 1 ? '' : 's'}` : ''}`;
  }
  const vehicleBits = [cars ? `${cars} car${cars === 1 ? '' : 's'}` : '', vehicles ? `${vehicles} driven` : '', lifts ? `${lifts} platform` : '', counterweights ? `${counterweights} counterweight` : ''].filter(Boolean);
  if (vehicleBits.length) counts.detail.vehicle = vehicleBits.join(', ');
  if (model.keptCells) counts.detail.collider = `${model.keptCells} kept as blocks`;
  if (counts.tread) counts.detail.tread = `${sizePct} % turn ${rotation}`;
  else if (sizePct > 100 && model.colliders?.treads) counts.detail.tread = 'none needed here';
  return counts;
}

/** Per-row show / highlight state, the legend's own toggles. */
export interface LegendRowState { show: boolean; highlight: boolean }
export type LegendState = Record<LegendKind, LegendRowState>;

export function defaultLegendState(): LegendState {
  const out = {} as LegendState;
  for (const k of LEGEND_KINDS) out[k] = { show: true, highlight: false };
  return out;
}

/** A new state with one row's flag flipped (the state object is never mutated). */
export function toggleLegend(state: LegendState, kind: LegendKind, flag: keyof LegendRowState): LegendState {
  return { ...state, [kind]: { ...state[kind], [flag]: !state[kind][flag] } };
}

// ─── The laid grid at a size ─────────────────────────────────────────────────

/** One world block of the laid grid: `[x, x+1] × [y + lo/16, y + hi/16] × [z, z+1]` from the pin. */
export interface LaidBlock { x: number; y: number; z: number; lo: number; hi: number; tread: boolean }

/** The shipped tread blocks for a size and turn (empty at 100 % and where none was needed). */
export function treadBlocksAt(model: Pick<AddonPreviewModel, 'colliders'>, sizePct: number, rotation: QuarterTurn): TreadBlock[] {
  const plan = model.colliders?.treads?.plans[`${sizePct}:${rotation}`];
  return plan ? decodeTreadPlan(plan) : [];
}

/**
 * The collider blocks the wand lays at `sizePct` and `rotation`, reproducing
 * the runtime's `placeColliders` arithmetic for EVERY size: each source cell
 * covers `cellColumns` in x and z (below 100 % several cells share a block
 * and the shared block keeps min lo / max hi), its scaled span is cut into
 * per-row sixteenths, and the tread plan's blocks replace what they land on.
 * For sizes of 100 % and above this equals `ScaledColliderGrid.allBlocks()`
 * (asserted in the tests); below 100 % that class does not apply.
 */
export function laidColliderBlocks(cells: readonly SourceCell[], dims: GridDims, sizePct: number, rotation: QuarterTurn, treads: readonly TreadBlock[] = []): { blocks: LaidBlock[]; dims: GridDims } {
  const f = sizePct / 100;
  const laid = scaledDims(dims, f, rotation);
  const byKey = new Map<number, LaidBlock>();
  const key = (x: number, y: number, z: number): number => (x * laid.height + y) * laid.length + z;
  for (const c of cells) {
    const rc = rotatedCell(c.x, c.z, dims, rotation);
    const [x0, x1] = cellColumns(rc.x, f), [z0, z1] = cellColumns(rc.z, f);
    const wy0 = (c.y + c.lo / 16) * f, wy1 = (c.y + c.hi / 16) * f;
    for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
      const lo = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16)));
      const hi = Math.max(lo + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
      for (let wx = x0; wx <= x1; wx++) for (let wz = z0; wz <= z1; wz++) {
        if (wx < 0 || wz < 0 || wx >= laid.width || wz >= laid.length || wy < 0 || wy >= laid.height) continue;
        const k = key(wx, wy, wz);
        const prev = byKey.get(k);
        if (!prev) byKey.set(k, { x: wx, y: wy, z: wz, lo, hi, tread: false });
        else { prev.lo = Math.min(prev.lo, lo); prev.hi = Math.max(prev.hi, hi); }
      }
    }
  }
  for (const t of treads) {
    if (t.x < 0 || t.z < 0 || t.y < 0 || t.x >= laid.width || t.z >= laid.length || t.y >= laid.height) continue;
    byKey.set(key(t.x, t.y, t.z), { x: t.x, y: t.y, z: t.z, lo: t.lo, hi: t.hi, tread: true });
  }
  const blocks = [...byKey.values()].sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
  return { blocks, dims: laid };
}

/** An axis-aligned box in world blocks, the unit the preview draws and the walk engine collides with. */
export interface LaidBox { x: number; z: number; y0: number; y1: number; tread: boolean }

/**
 * Merge a column's consecutive blocks into boxes: a full block (`lo` 0, `hi`
 * 16) sitting on another that reaches 16 joins it. Partial blocks and treads
 * stay their own box so a slab top reads as one. Input order is `laidColliderBlocks`'s.
 */
export function columnBoxes(blocks: readonly LaidBlock[]): LaidBox[] {
  const out: LaidBox[] = [];
  let open: LaidBox | null = null, openY = -1;
  for (const b of blocks) {
    const y0 = b.y + b.lo / 16, y1 = b.y + b.hi / 16;
    if (open && !b.tread && !open.tread && open.x === b.x && open.z === b.z && b.y === openY + 1 && b.lo === 0 && b.hi === 16 && Math.abs(open.y1 - b.y) < 1e-9) {
      open.y1 = y1; openY = b.y; continue;
    }
    open = { x: b.x, z: b.z, y0, y1, tread: b.tread }; openY = b.y;
    out.push(open);
  }
  return out;
}

// ─── Reach ───────────────────────────────────────────────────────────────────

export interface ReachSurface { x: number; z: number; t: number; reached: boolean }

export interface ReachOverlay {
  surfaces: ReachSurface[];
  reachedSurfaces: number;
  unreachedSurfaces: number;
  reachedColumns: number;
  /** The highest reached standable top, blocks above the pin at this size. */
  highestBlocks: number;
  /** A ScaledColliderGrid over the laid blocks, treads applied, for the walk engine and probes. */
  grid: ScaledColliderGrid;
}

/**
 * The reach walk over the laid grid WITH its treads: every standable top
 * inside the footprint, marked reached or not by the engine's breadth-first
 * walk from the ring of ground around the model — the block-grid form of the
 * pipeline's own access measurement. Null below 100 %, where the scaled grid
 * class does not apply (no rise can exceed a jump there).
 */
export function reachOverlay(cells: readonly SourceCell[], dims: GridDims, sizePct: number, rotation: QuarterTurn, treads: readonly TreadBlock[] = []): ReachOverlay | null {
  if (sizePct < 100 || !cells.length) return null;
  const grid = new ScaledColliderGrid(cells, dims, sizePct / 100, rotation);
  for (const t of treads) grid.write(t.x, t.z, { row: t.y, lo: t.lo, hi: t.hi, src16: 0 });
  const reach = walkScaledColliders(grid);
  const surfaces = reachSurfacesFromGrid(grid, reach);
  let reached = 0, unreached = 0;
  const columns = new Set<number>();
  for (const s of surfaces) {
    if (s.reached) { reached++; columns.add(s.x * grid.length + s.z); } else unreached++;
  }
  return { surfaces, reachedSurfaces: reached, unreachedSurfaces: unreached, reachedColumns: columns.size, highestBlocks: reach.highest16 / 16, grid };
}

/**
 * Every standable top inside the footprint of an already-built grid (treads
 * written in), marked by a reach walk over it. The ground under the pin
 * (`t` = 0) is the player's own world, not a surface of the model, and is
 * left out. Shared by `reachOverlay` and the walk's live overlay, which
 * reads the WalkWorld's grid instead of building a second one.
 */
export function reachSurfacesFromGrid(grid: ScaledColliderGrid, reach: Pick<ReachResult, 'visited'>): ReachSurface[] {
  const surfaces: ReachSurface[] = [];
  for (let x = 0; x < grid.width; x++) for (let z = 0; z < grid.length; z++) {
    for (const t of grid.surfaces(x, z)) {
      if (t === 0) continue;
      surfaces.push({ x, z, t, reached: reach.visited.has(grid.key(x, z, t)) });
    }
  }
  return surfaces;
}

// ─── Placing things at a size ────────────────────────────────────────────────

/** A model point (100 %, unrotated) as the wand places it at a size and turn: `rotatePlacementPoint` then `× f`. */
export function placedPoint(p: { x: number; y: number; z: number }, dims: GridDims, sizePct: number, rotation: QuarterTurn): { x: number; y: number; z: number } {
  const q = rotatePlacementPoint(p, dims.width, dims.length, rotation as PlacementRotation);
  const f = sizePct / 100;
  return { x: q.x * f, y: q.y * f, z: q.z * f };
}

/**
 * A model-frame DIRECTION (not a point — the pinball table's plane normal, an
 * axis to spin a flipper about) as the wand's quarter-turn placement carries
 * it: the SAME rotation `placedPoint`/`rotatePlacementPoint` applies to a
 * point, but without the corner-preserving translation a turn adds to keep
 * the footprint's minimum corner at the pin (that translation is a constant
 * per rotation, so subtracting the rotated origin from the rotated point
 * cancels it — a direction has no position for it to apply to anyway).
 */
export function placedDirection(d: { x: number; y: number; z: number }, dims: GridDims, sizePct: number, rotation: QuarterTurn): { x: number; y: number; z: number } {
  const r = rotation as PlacementRotation;
  const zero = rotatePlacementPoint({ x: 0, y: 0, z: 0 }, dims.width, dims.length, r);
  const one = rotatePlacementPoint(d, dims.width, dims.length, r);
  const f = sizePct / 100;
  return { x: (one.x - zero.x) * f, y: (one.y - zero.y) * f, z: (one.z - zero.z) * f };
}

// ─── Pinball: the sim's plane onto the model, and the runtime's own world map ─

/**
 * Plane `(u, w, h)` -> a model point (model blocks at 100 % from the model's
 * corner — the same frame `PlacementActor.x/y/z` and `placedPoint` use):
 * `map.p0 + u*map.u + w*map.w + h*map.n`. Exactly `pinballRuntime`'s own
 * `planePoint` (bedrock-pinball.ts), reproduced here because that function is
 * serialised into the pack's script by `.toString()` and may not be imported.
 */
export function pinballPlanePoint(map: PinballMap, u: number, w: number, h: number): { x: number; y: number; z: number } {
  const [px, py, pz] = map.p0, [ux, uy, uz] = map.u, [wx, wy, wz] = map.w, [nx, ny, nz] = map.n;
  return { x: px + u * ux + w * wx + h * nx, y: py + u * uy + w * wy + h * ny, z: pz + u * uz + w * wz + h * nz };
}

/**
 * The pinball runtime's OWN world transform — `toWorld(planePoint(u, w, h) +
 * offset)` in bedrock-pinball.ts's `pinballRuntime` — reproduced byte-for-byte
 * so it can be unit-tested without evaluating the serialised script: rotate
 * the plane point (plus a fixed model-frame offset, e.g. the ball's own
 * `ballOffset`) about Y by the placement's rotation (an arbitrary degree, the
 * actor's real Bedrock yaw — NOT the walk's own quarter-turn `placedPoint`,
 * which additionally keeps the footprint's corner at the pin; see
 * `placedDirection`), scale, then translate by its origin.
 */
export function pinballRuntimeWorldPoint(
  map: PinballMap, u: number, w: number, h: number, offset: readonly [number, number, number],
  origin: { x: number; y: number; z: number }, rotationDeg: number, scale: number,
): { x: number; y: number; z: number } {
  const c = pinballPlanePoint(map, u, w, h);
  const px = c.x + offset[0], py = c.y + offset[1], pz = c.z + offset[2];
  const a = rotationDeg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  return { x: origin.x + (px * cs - pz * sn) * scale, y: origin.y + py * scale, z: origin.z + (px * sn + pz * cs) * scale };
}

/** Whether an actor is spawned at all at this size (door leaves retire once the vanilla door fits). */
export function entitySpawnsAt(e: Pick<AddonEntity, 'maxSizeExclusive' | 'hideAt100'>, sizePct: number): boolean {
  if (e.maxSizeExclusive !== undefined && sizePct >= e.maxSizeExclusive) return false;
  if (e.hideAt100 && sizePct === 100) return false;
  return true;
}

/** The size step to mark as recommended, and why; null when the pack carries no measurement. */
export function recommendedSize(model: Pick<AddonPreviewModel, 'access' | 'accessDetail'>): { sizePct: number | null; reason: string } | null {
  const a = model.access ?? (model.accessDetail ? { sizePct: model.accessDetail.sizePct, reason: model.accessDetail.reason } : null);
  if (!a) return null;
  return { sizePct: a.sizePct ?? null, reason: a.reason };
}

/** Where the walk starts: on the ground a few blocks off the footprint's −X edge, facing the model (Bedrock yaw 270 = +X). */
export function spawnPoint(laid: GridDims): { x: number; y: number; z: number; yawDeg: number } {
  return { x: -6, y: 0, z: laid.length / 2, yawDeg: 270 };
}
