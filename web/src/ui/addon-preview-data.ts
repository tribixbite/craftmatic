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
  scaledDims, ScaledColliderGrid, walkScaledColliders,
  type GridDims, type QuarterTurn, type ReachResult, type SourceCell, type TreadBlock,
} from '@engine/bedrock-collider-scale.js';
import type { AccessScaleRecommendation } from '@engine/bedrock-scene-actors.js';
import { isShellEntityId } from '@engine/bedrock-building-shell.js';
import type { PinballMap, PinballRuntimeConfig } from '@engine/bedrock-pinball.js';
import type { CoasterRiderViewConfig } from '@engine/bedrock-coaster.js';
import { extractMatching, listZipEntries } from '@engine/zip-utils.js';
import { COLLIDER_KIT, type Box16, type ColliderForm } from '@engine/collider-form.js';
import type { InteractiveRuntimeConfig } from '@engine/bedrock-interactives.js';
import { APPEARANCE_FILE_PATTERN, appearancePbrPngPaths, buildAddonAppearance, readAppearancePbrMaterials, type AddonAppearance, type AppearancePbrMaterials } from './addon-appearance.js';

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
  /**
   * The client animations each entity type plays (its RP entity file's
   * `animations` / `scripts` and the `animations/*.json` clips), compiled
   * from their Molang (`compileMolang`), keyed by the full type id. The
   * walker drives its bones by these - the pack's own gait, track pitch,
   * door swing and flipper - rather than by a second implementation.
   */
  animations: Map<string, ClientAnimationSet>;
  /** Anything about the pack the preview could not read, said rather than dropped. */
  notes: string[];
}

// ─── Pack reading ────────────────────────────────────────────────────────────

/** The pack script's `const CONFIG = {...}` reader lives with the simulator's pack module (web/src/sim/pack/script-config.ts). */
export { extractJsonAfter } from '../sim/pack/script-config.js';
import { extractJsonAfter } from '../sim/pack/script-config.js';

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
  /** Manifest-gated PBR values decoded from the pack's texture sets and uniform MER images. */
  appearancePbr?: AppearancePbrMaterials;
  /** Behaviour-pack `entities/<id>.json` files, keyed by archive path — read for
   * `minecraft:collision_box` / `minecraft:physics.has_collision` (`entityCollisionFromSources`). */
  behaviorEntitySources?: Map<string, string>;
  /**
   * Face atlases (`textures/entity/<id>_faces.png`), keyed by resource path
   * WITHOUT the extension - the form a client entity's `textures` map uses.
   */
  faceTextures?: Map<string, Uint8Array>;
  /** Resource-pack `animations/*.json` files, keyed by archive path: the Molang the client animates bones by. */
  animationSources?: Map<string, string>;
}

const utf8 = new TextDecoder();
/** A face atlas the compiler writes beside an entity (`head-face.ts`). */
const FACE_TEXTURE_PATTERN = /(^|\/)(textures\/entity\/[^/]+_faces)\.png$/;
/** A resource-pack animation file (`animations/<id>.animation.json`). */
const ANIMATION_FILE_PATTERN = /(^|\/)animations\/[^/]+\.json$/;

/** Pull the files the preview reads out of a built `.mcaddon` (a zip of the BP and RP folders). */
export async function readAddonPreviewFiles(mcaddon: ArrayBuffer): Promise<AddonPreviewFiles> {
  const behaviour = (name: string): boolean => /(^|\/)(scripts\/(placement|coaster|pinball|interactives)\.js|craftmatic-diagnostics\.json|craftmatic-treads\.json)$/.test(name);
  const wanted = (name: string): boolean => behaviour(name) || APPEARANCE_FILE_PATTERN.test(name) || BEHAVIOR_ENTITY_FILE_PATTERN.test(name) || FACE_TEXTURE_PATTERN.test(name) || ANIMATION_FILE_PATTERN.test(name);
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
  const animationSources = new Map<string, string>();
  for (const [name, data] of found) if (ANIMATION_FILE_PATTERN.test(name)) animationSources.set(name, utf8.decode(data));
  // Texture-set image references are arbitrary names. Resolve the JSON first,
  // then extract exactly those images in a second ZIP pass.
  const pbrPaths = appearancePbrPngPaths(appearanceSources);
  const pbrPngs = new Map<string, Uint8Array>();
  if (pbrPaths.size) {
    for (const [name, data] of await extractMatching(mcaddon, candidate => pbrPaths.has(candidate))) pbrPngs.set(name, new Uint8Array(data));
  }
  const appearancePbr = await readAppearancePbrMaterials(appearanceSources, pbrPngs);
  return {
    placementScript: text(/scripts\/placement\.js$/),
    coasterScript: text(/scripts\/coaster\.js$/),
    pinballScript: text(/scripts\/pinball\.js$/),
    interactivesScript: text(/scripts\/interactives\.js$/),
    diagnosticsJson: text(/craftmatic-diagnostics\.json$/),
    treadsJson: text(/craftmatic-treads\.json$/),
    appearanceSources,
    appearancePbr,
    behaviorEntitySources,
    faceTextures,
    animationSources,
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
  // The whole-model shell or one of its lattice chunks (`…_shell_c<ix>_<iy>_<iz>`): one classifier, shared with the audits.
  if (isShellEntityId(id)) return 'shell';
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
      if (camera && (mode === 'loop' || mode === 'reflect' || mode === 'roll' || mode === 'clamp' || mode === 'over' || mode === 'off')) {
        coasterCamera = { mode, lookYaw: num(camera['lookYaw'], 70), lookPitch: num(camera['lookPitch'], 50), ease: num(camera['ease'], 0.1), maxTurn: num(camera['maxTurn'], 40), lookLag: num(camera['lookLag'], 0), animLag: num(camera['animLag'], 3.5), animTail: num(camera['animTail'], 6), tickLag: num(camera['tickLag'], 1.5), handbackBlend: num(camera['handbackBlend'], 4), ratchet: camera['ratchet'] === true };
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
    appearance = buildAddonAppearance(files.appearanceSources, files.appearancePbr);
    notes.push(...appearance.notes);
    if (!appearance.cubeCount) { notes.push('The pack ships geometry the preview could not read: no model layer.'); appearance = null; }
  }

  const entityCollision = files.behaviorEntitySources?.size ? entityCollisionFromSources(files.behaviorEntitySources) : new Map<string, { width: number; height: number }>();
  const animations = readClientAnimations(files.appearanceSources ?? new Map(), files.animationSources ?? new Map(), notes);

  return {
    id: String(config['id'] ?? 'addon'), label: String(config['label'] ?? config['id'] ?? 'Add-on'),
    dims, cells, colliders, keptCells: colliders ? num(colliders.keptCells) : 0,
    entities, routes, doorCandidates, sizes, access, accessDetail, treadReport, provenance, pack,
    appearance, faceTextures: files.faceTextures ?? new Map(), coasterTypes, ...(coasterCamera ? { coasterCamera } : {}), pinball, interactives, entityCollision, animations, notes,
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

/**
 * One world block of the laid grid: `[x, x+1] × [y + lo/16, y + hi/16] × [z, z+1]`
 * from the pin - or, with `form`, a clearance form's boxes inside that block
 * (collider-form.ts; `lo`/`hi` are then the form's vertical extent).
 */
export interface LaidBlock { x: number; y: number; z: number; lo: number; hi: number; tread: boolean; form?: ColliderForm }

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
  const key = (x: number, y: number, z: number): number => (x * laid.height + y) * laid.length + z;
  // Every cell's pieces (the runtime's own `cellPieces`), then one covering form per block.
  const pieces = new Map<number, { x: number; y: number; z: number; boxes: Box16[] }>();
  for (const c of cells) {
    COLLIDER_KIT.cellPieces(c.x, c.y, c.z, c.v ?? 0, c.lo, c.hi, dims, f, rotation, (wx, wy, wz, box) => {
      if (wx < 0 || wz < 0 || wx >= laid.width || wz >= laid.length || wy < 0 || wy >= laid.height) return;
      const k = key(wx, wy, wz);
      const at = pieces.get(k);
      if (at) at.boxes.push(box); else pieces.set(k, { x: wx, y: wy, z: wz, boxes: [box] });
    });
  }
  const byKey = new Map<number, LaidBlock>();
  for (const [k, p] of pieces) {
    const form = COLLIDER_KIT.cover(p.boxes);
    if (!form) continue;
    const boxes = COLLIDER_KIT.formBoxes(form.v, form.lo, form.hi);
    byKey.set(k, { x: p.x, y: p.y, z: p.z, lo: Math.min(...boxes.map(q => q[2])), hi: Math.max(...boxes.map(q => q[3])), tread: false, ...(form.v ? { form } : {}) });
  }
  for (const t of treads) {
    if (t.x < 0 || t.z < 0 || t.y < 0 || t.x >= laid.width || t.z >= laid.length || t.y >= laid.height) continue;
    byKey.set(key(t.x, t.y, t.z), { x: t.x, y: t.y, z: t.z, lo: t.lo, hi: t.hi, tread: true });
  }
  const blocks = [...byKey.values()].sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
  return { blocks, dims: laid };
}

/**
 * An axis-aligned box in world blocks, the unit the preview draws and the
 * walk engine collides with: column `x, z`, and - for a clearance form's box -
 * its footprint inside the column in sixteenths (`fx0..fx1`, `fz0..fz1`,
 * absent = the whole column).
 */
export interface LaidBox { x: number; z: number; y0: number; y1: number; tread: boolean; fx0?: number; fx1?: number; fz0?: number; fz1?: number }

/**
 * Merge a column's consecutive blocks into boxes: a full block (`lo` 0, `hi`
 * 16) sitting on another that reaches 16 joins it. Partial blocks and treads
 * stay their own box so a slab top reads as one. Input order is `laidColliderBlocks`'s.
 */
export function columnBoxes(blocks: readonly LaidBlock[]): LaidBox[] {
  const out: LaidBox[] = [];
  let open: LaidBox | null = null, openY = -1;
  for (const b of blocks) {
    if (b.form) {
      // A clearance form is drawn as its own boxes, never merged into a column.
      for (const q of COLLIDER_KIT.formBoxes(b.form.v, b.form.lo, b.form.hi)) out.push({ x: b.x, z: b.z, y0: b.y + q[2] / 16, y1: b.y + q[3] / 16, tread: false, fx0: q[0], fx1: q[1], fz0: q[4], fz1: q[5] });
      open = null; openY = -1;
      continue;
    }
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

// ─── Client animations: the pack's own Molang, drawn by the walker ────────────

/**
 * A compiled Molang expression or statement list: evaluates to its last
 * value over an entity's state. Molang's own semantics where they matter
 * here: booleans are 1 / 0, an unset variable is 0, trig takes DEGREES,
 * a division by zero is 0.
 */
export type MolangProgram = (env: MolangEnv) => number;

/** What an expression may read: the entity's actor properties, the client queries, its variables. */
export interface MolangEnv {
  /** `query.property('name')`; undefined when the entity has no such property (reads as 0). */
  property(name: string): number | boolean | string | undefined;
  /** A client query by name (`is_riding`, `life_time`, `movement_direction` with its index...); undefined = not modelled. */
  query(name: string, args: number[]): number | undefined;
  /** `v.` / `variable.` / `t.` / `temp.` variables, kept per entity across frames. */
  vars: Map<string, number>;
  /** A query without an answer (reported once per entity by the caller; the value is 0). */
  unknown?(name: string): void;
}

type Tok = { k: 'num'; v: number } | { k: 'str'; v: string } | { k: 'id'; v: string } | { k: 'op'; v: string };

const MOLANG_OPS = ['==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '(', ')', ',', ';', '?', ':', '!', '<', '>', '='];

function tokenizeMolang(src: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < src.length;) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?f?/.exec(src.slice(i));
    if (num && /[0-9.]/.test(c)) { out.push({ k: 'num', v: Number(num[0].replace(/f$/, '')) }); i += num[0].length; continue; }
    if (c === '\'' || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`unterminated string at ${i}`);
      out.push({ k: 'str', v: src.slice(i + 1, end) }); i = end + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0] }); i += m[0].length; continue;
    }
    const op = MOLANG_OPS.find(o => src.startsWith(o, i));
    if (!op) throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
    out.push({ k: 'op', v: op }); i += op.length;
  }
  return out;
}

type Node = (env: MolangEnv) => number;
const bool = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0);
const varKey = (id: string): string | null => {
  const m = /^(?:v|variable|t|temp|c|context)\.(.+)$/.exec(id);
  return m ? m[1]! : null;
};
const MATH_FN: Record<string, (a: number[]) => number> = {
  abs: a => Math.abs(a[0]!), ceil: a => Math.ceil(a[0]!), floor: a => Math.floor(a[0]!), round: a => Math.round(a[0]!), trunc: a => Math.trunc(a[0]!),
  sqrt: a => Math.sqrt(a[0]!), exp: a => Math.exp(a[0]!), ln: a => Math.log(a[0]!), pow: a => Math.pow(a[0]!, a[1]!), mod: a => (a[1] ? a[0]! % a[1] : 0),
  min: a => Math.min(...a), max: a => Math.max(...a), clamp: a => Math.max(a[1]!, Math.min(a[2]!, a[0]!)),
  lerp: a => a[0]! + (a[1]! - a[0]!) * a[2]!, lerprotate: a => { const d = ((a[1]! - a[0]! + 180) % 360 + 360) % 360 - 180; return a[0]! + d * a[2]!; },
  sin: a => Math.sin(a[0]! * Math.PI / 180), cos: a => Math.cos(a[0]! * Math.PI / 180),
  atan: a => Math.atan(a[0]!) * 180 / Math.PI, atan2: a => Math.atan2(a[0]!, a[1]!) * 180 / Math.PI,
  asin: a => Math.asin(a[0]!) * 180 / Math.PI, acos: a => Math.acos(a[0]!) * 180 / Math.PI,
  // The random family is drawn at its mean: a preview must repeat, and nothing the packs animate uses it.
  die_roll: a => a[0]! * (a[1]! + a[2]!) / 2, random: a => (a[0]! + a[1]!) / 2, random_integer: a => Math.round((a[0]! + a[1]!) / 2),
  hermite_blend: a => 3 * a[0]! * a[0]! - 2 * a[0]! * a[0]! * a[0]!,
};

/**
 * Compile a Molang expression or `;`-separated statement list (the forms the
 * compiled packs write: `query.property('x')`, `v.a = v.a + math.clamp(...)`,
 * ternaries, comparisons, `math.*`, `q.delta_time`, `q.movement_direction(0)`).
 * A parse error throws; the reader notes it and the bone stays still.
 */
export function compileMolang(src: string): MolangProgram {
  const toks = tokenizeMolang(src);
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const isOp = (v: string): boolean => { const t = toks[i]; return !!t && t.k === 'op' && t.v === v; };
  const opAt = (): string => (toks[i] as { v: string }).v;
  const take = (v: string): void => { if (!isOp(v)) throw new Error(`expected ${v} at token ${i} of ${JSON.stringify(src)}`); i++; };
  const program = (): Node => {
    const stmts: Node[] = [];
    while (i < toks.length) {
      stmts.push(statement());
      if (isOp(';')) i++;
    }
    if (stmts.length === 1) return stmts[0]!;
    return env => { let v = 0; for (const s of stmts) v = s(env); return v; };
  };
  const statement = (): Node => {
    const t = peek(), next = toks[i + 1];
    if (t && t.k === 'id' && next && next.k === 'op' && next.v === '=') {
      const key = varKey(t.v);
      if (!key) throw new Error(`cannot assign to ${t.v}`);
      i += 2;
      const rhs = ternary();
      return env => { const v = rhs(env); env.vars.set(key, v); return v; };
    }
    if (t && t.k === 'id' && t.v === 'return') { i++; return ternary(); }
    return ternary();
  };
  const ternary = (): Node => {
    const cond = orExpr();
    if (!isOp('?')) return cond;
    i++;
    const a = ternary();
    take(':');
    const b = ternary();
    return env => (cond(env) ? a(env) : b(env));
  };
  const orExpr = (): Node => {
    let l = andExpr();
    while (isOp('||')) { i++; const r = andExpr(); const ll = l; l = env => (ll(env) || r(env) ? 1 : 0); }
    return l;
  };
  const andExpr = (): Node => {
    let l = eqExpr();
    while (isOp('&&')) { i++; const r = eqExpr(); const ll = l; l = env => (ll(env) && r(env) ? 1 : 0); }
    return l;
  };
  const eqExpr = (): Node => {
    let l = relExpr();
    while (isOp('==') || isOp('!=')) { const op = opAt(); i++; const r = relExpr(); const ll = l; l = op === '==' ? env => (ll(env) === r(env) ? 1 : 0) : env => (ll(env) !== r(env) ? 1 : 0); }
    return l;
  };
  const relExpr = (): Node => {
    let l = addExpr();
    while (isOp('<') || isOp('>') || isOp('<=') || isOp('>=')) {
      const op = opAt(); i++; const r = addExpr(); const ll = l;
      l = op === '<' ? env => (ll(env) < r(env) ? 1 : 0) : op === '>' ? env => (ll(env) > r(env) ? 1 : 0) : op === '<=' ? env => (ll(env) <= r(env) ? 1 : 0) : env => (ll(env) >= r(env) ? 1 : 0);
    }
    return l;
  };
  const addExpr = (): Node => {
    let l = mulExpr();
    while (isOp('+') || isOp('-')) { const op = opAt(); i++; const r = mulExpr(); const ll = l; l = op === '+' ? env => ll(env) + r(env) : env => ll(env) - r(env); }
    return l;
  };
  const mulExpr = (): Node => {
    let l = unary();
    while (isOp('*') || isOp('/')) { const op = opAt(); i++; const r = unary(); const ll = l; l = op === '*' ? env => ll(env) * r(env) : env => { const d = r(env); return d ? ll(env) / d : 0; }; }
    return l;
  };
  const unary = (): Node => {
    if (isOp('-')) { i++; const e = unary(); return env => -e(env); }
    if (isOp('!')) { i++; const e = unary(); return env => (e(env) ? 0 : 1); }
    if (isOp('+')) { i++; return unary(); }
    return primary();
  };
  const args = (): Array<Node | string> => {
    const out: Array<Node | string> = [];
    take('(');
    while (!isOp(')')) {
      const t = peek();
      if (t && t.k === 'str') { out.push(t.v); i++; } else out.push(ternary());
      if (isOp(',')) i++; else break;
    }
    take(')');
    return out;
  };
  const primary = (): Node => {
    const t = peek();
    if (!t) throw new Error(`unexpected end of ${JSON.stringify(src)}`);
    if (t.k === 'num') { i++; const v = t.v; return () => v; }
    if (t.k === 'op' && t.v === '(') { i++; const e = ternary(); take(')'); return e; }
    if (t.k === 'str') throw new Error(`a string is only a property name: ${JSON.stringify(t.v)}`);
    if (t.k !== 'id') throw new Error(`unexpected ${t.v} at token ${i} of ${JSON.stringify(src)}`);
    i++;
    const id = t.v.toLowerCase();
    if (id === 'true') return () => 1;
    if (id === 'false') return () => 0;
    const mathName = /^math\.(.+)$/.exec(id)?.[1];
    if (mathName) {
      if (mathName === 'pi') return () => Math.PI;
      const fn = MATH_FN[mathName];
      if (!fn) throw new Error(`unknown math.${mathName}`);
      const a = args().map(x => (typeof x === 'string' ? ((): number => 0) : x));
      return env => fn(a.map(x => x(env)));
    }
    const query = /^(?:q|query)\.(.+)$/.exec(id)?.[1];
    if (query) {
      const a = isOp('(') ? args() : [];
      if (query === 'property') {
        const name = typeof a[0] === 'string' ? a[0] : '';
        return env => bool(env.property(name));
      }
      const nums = a.map(x => (typeof x === 'string' ? ((): number => 0) : x));
      return env => { const v = env.query(query, nums.map(x => x(env))); if (v === undefined) { env.unknown?.(query); return 0; } return v; };
    }
    const key = varKey(id);
    if (key) return env => env.vars.get(key) ?? 0;
    throw new Error(`unknown name ${t.v}`);
  };
  return program();
}

/** One bone's animated channels, compiled; each channel is three expressions (a scalar scale is spread to three). */
export interface ClientBoneChannel { rotation?: [MolangProgram, MolangProgram, MolangProgram]; position?: [MolangProgram, MolangProgram, MolangProgram]; scale?: [MolangProgram, MolangProgram, MolangProgram] }

/** One animation clip an entity plays, with the `scripts.animate` condition that turns it on (none = always). */
export interface ClientAnimationClip { name: string; id: string; when?: MolangProgram; bones: Map<string, ClientBoneChannel> }

/** Everything the client runs for one entity type: `initialize` once, `pre_animation` every frame, then the clips. */
export interface ClientAnimationSet { typeId: string; initialize: MolangProgram[]; preAnimation: MolangProgram[]; clips: ClientAnimationClip[] }

/** A bone's pose this frame: rotation degrees and position units added to the bind pose, a scale multiplied in. */
export interface BonePose { rotation: [number, number, number]; position: [number, number, number]; scale: [number, number, number] }

const triple = (v: unknown, notes: string[], where: string): [MolangProgram, MolangProgram, MolangProgram] | undefined => {
  const parts = Array.isArray(v) ? v : [v, v, v];
  if (parts.length < 3) return undefined;
  try {
    return parts.slice(0, 3).map(p => (typeof p === 'number' ? ((): number => p) : compileMolang(String(p)))) as [MolangProgram, MolangProgram, MolangProgram];
  } catch (e) { notes.push(`${where}: ${e instanceof Error ? e.message : String(e)}`); return undefined; }
};

/**
 * Compile every entity type's client animations from the RP entity files
 * (`appearanceSources` already holds them) and the animation files.
 * A clip or a script line that does not parse is noted and left out, never
 * silently drawn still.
 */
export function readClientAnimations(entitySources: ReadonlyMap<string, string>, animationSources: ReadonlyMap<string, string>, notes: string[] = []): Map<string, ClientAnimationSet> {
  // Every clip by its id, across the animation files.
  const clipsById = new Map<string, Record<string, unknown>>();
  for (const [path, text] of animationSources) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { notes.push(`${path} is not valid JSON; its animations are not drawn.`); continue; }
    const anims = (parsed as { animations?: Record<string, unknown> }).animations;
    if (anims && typeof anims === 'object') for (const [id, clip] of Object.entries(anims)) if (clip && typeof clip === 'object') clipsById.set(id, clip as Record<string, unknown>);
  }
  const out = new Map<string, ClientAnimationSet>();
  for (const [path, text] of entitySources) {
    if (!/\.entity\.json$/.test(path)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    const desc = (parsed as { 'minecraft:client_entity'?: { description?: Record<string, unknown> } })['minecraft:client_entity']?.description;
    const typeId = desc?.['identifier'];
    if (!desc || typeof typeId !== 'string') continue;
    const names = (desc['animations'] ?? {}) as Record<string, string>;
    const scripts = (desc['scripts'] ?? {}) as { initialize?: unknown[]; pre_animation?: unknown[]; animate?: unknown[] };
    const compileLines = (lines: unknown[] | undefined, label: string): MolangProgram[] => (lines ?? []).flatMap(l => {
      try { return [compileMolang(String(l))]; } catch (e) { notes.push(`${typeId} ${label}: ${e instanceof Error ? e.message : String(e)}`); return []; }
    });
    const initialize = compileLines(scripts.initialize, 'initialize'), preAnimation = compileLines(scripts.pre_animation, 'pre_animation');
    const clips: ClientAnimationClip[] = [];
    for (const entry of scripts.animate ?? []) {
      const [name, cond] = typeof entry === 'string' ? [entry, undefined] : Object.entries(entry as Record<string, string>)[0] ?? [undefined, undefined];
      if (!name) continue;
      const id = names[name];
      const clip = id ? clipsById.get(id) : undefined;
      if (!id || !clip) { notes.push(`${typeId} animates "${name}" but the pack ships no such clip${id ? ` (${id})` : ''}.`); continue; }
      let when: MolangProgram | undefined;
      if (cond !== undefined) { try { when = compileMolang(String(cond)); } catch (e) { notes.push(`${typeId} animate ${name}: ${e instanceof Error ? e.message : String(e)}`); continue; } }
      const bones = new Map<string, ClientBoneChannel>();
      for (const [bone, ch] of Object.entries((clip['bones'] ?? {}) as Record<string, Record<string, unknown>>)) {
        const c: ClientBoneChannel = {};
        const rot = ch['rotation'] !== undefined ? triple(ch['rotation'], notes, `${typeId} ${name} ${bone} rotation`) : undefined;
        const pos = ch['position'] !== undefined ? triple(ch['position'], notes, `${typeId} ${name} ${bone} position`) : undefined;
        const sc = ch['scale'] !== undefined ? triple(ch['scale'], notes, `${typeId} ${name} ${bone} scale`) : undefined;
        if (rot) c.rotation = rot;
        if (pos) c.position = pos;
        if (sc) c.scale = sc;
        if (c.rotation || c.position || c.scale) bones.set(bone, c);
      }
      clips.push({ name, id, ...(when ? { when } : {}), bones });
    }
    if (initialize.length || preAnimation.length || clips.length) out.set(typeId, { typeId, initialize, preAnimation, clips });
  }
  return out;
}

/** Run a type's `initialize` lines once for an entity (its variables start from them). */
export function initializeClientAnimations(set: ClientAnimationSet, env: MolangEnv): void {
  for (const line of set.initialize) line(env);
}

/**
 * One frame of a type's animations for an entity: `pre_animation` first (it
 * updates the variables), then every clip whose condition holds. Rotations
 * and positions of several clips ADD on a bone, scales multiply - Bedrock
 * blends the clips in `animate` order the same way.
 */
export function evaluateClientAnimations(set: ClientAnimationSet, env: MolangEnv): Map<string, BonePose> {
  for (const line of set.preAnimation) line(env);
  const out = new Map<string, BonePose>();
  for (const clip of set.clips) {
    if (clip.when && !clip.when(env)) continue;
    for (const [bone, ch] of clip.bones) {
      let pose = out.get(bone);
      if (!pose) out.set(bone, pose = { rotation: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] });
      if (ch.rotation) for (let k = 0; k < 3; k++) pose.rotation[k] += ch.rotation[k]!(env);
      if (ch.position) for (let k = 0; k < 3; k++) pose.position[k] += ch.position[k]!(env);
      if (ch.scale) for (let k = 0; k < 3; k++) pose.scale[k] *= ch.scale[k]!(env);
    }
  }
  return out;
}
