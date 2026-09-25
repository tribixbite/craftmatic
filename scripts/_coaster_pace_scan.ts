/**
 * Coaster pace / wand-size / energy scan over a corpus coaster, through the
 * SERIALISED ride runtime (the pack's own `scripts/coaster.js` text) on host.
 * The measurements behind docs/physics-architecture.md §1, §8 and §10.
 *
 *   bun scripts/_coaster_pace_scan.ts metrics [--paces=1.3,1.4,1.6] [--tangent]
 *       per pace: the two 10303 rider-view test metrics (worst per-tick car yaw
 *       over the loops; clamp camera off-nose ticks, worst degrees from
 *       vertical and off the nose). A fine pace sweep is a sampling-PHASE
 *       sweep: where the ticks land on the track moves with it. `--tangent`
 *       drops the cars' wheelbase (what `coasterRuntimeConfig` alone gives).
 *   bun scripts/_coaster_pace_scan.ts stats [--paces=...] [--scale=2] [--drag-per-scale]
 *       peak / mean moving speed, ticks at the ceiling, loop-top v/sqrt(g r f),
 *       intervals between stops. `--drag-per-scale` tries DRAG / size.
 *   bun scripts/_coaster_pace_scan.ts energy [--paces=1.41421] [--scale=2]
 *       lossless run (no drag, rolling, ceiling, floors, chain): drift of
 *       v²/2 + g h per moving run. Checks the gravity term itself.
 *
 * Options: --file=<ldr> (default 10303), --ldraw=<library root>. Pace p scales
 * the physics exactly as COASTER_RIDE_PACE does (speeds × p, accelerations
 * × p², MAX_SPEED = 20 p), so any pace can be scanned without editing code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { coasterRoutesFromAssemblies, coasterRuntimeConfig, coasterScript, COASTER_PHYSICS, COASTER_RIDER_VIEW, type CoasterPhysics, type CoasterRoute, type CoasterRuntimeConfig } from '../web/src/engine/bedrock-coaster.ts';
import { detectCoasterAssemblies } from '../web/src/engine/coaster-assemblies.ts';
import { extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.ts';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.ts';

const args = new Map(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k!, v ?? 'true'] as const; }));
const MODE = process.argv[2] ?? 'metrics';
const FILE = args.get('file') ?? 'C:/git/clego/lego_sets/IOModel2V2/10303.ldr';
const LDRAW = args.get('ldraw') ?? 'C:/git/clego/extracted/studio_release/app/ldraw';
const SCALE = Number(args.get('scale') ?? 1);
/** 10303's 24869 wheels are 50 LDU apart; the pack writes this into every car type. */
const WHEELBASE = args.has('tangent') ? undefined : 50 / LDU_PER_BLOCK;
const PACES = (args.get('paces') ?? (MODE === 'metrics' ? '1.3,1.35,1.4,1.41421356,1.45,1.5,1.55,1.6,1.62' : MODE === 'energy' ? '1.41421356' : '1,1.41421356,1.6')).split(',').map(Number);

/** `COASTER_PHYSICS` re-paced: identical to setting COASTER_RIDE_PACE = p. */
function physicsAt(p: number): CoasterPhysics {
  const paced = { ...COASTER_PHYSICS, GRAVITY: 9.8 * p * p, ROLLING: 0.12 * p * p, MIN_SPEED: 0.8 * p, MAX_SPEED: 20 * p, LIFT_SPEED: 2.5 * p, LIFT_ACCEL: 12 * p * p, STATION_BRAKE: 3.5 * p * p, DEPART_SPEED: 3 * p, PLATFORM_SPEED: 2.5 * p };
  if (args.has('drag-per-scale')) paced.DRAG = COASTER_PHYSICS.DRAG / SCALE;
  if (MODE === 'energy') Object.assign(paced, { DRAG: 0, ROLLING: 0, MAX_SPEED: 1e9, INVERSION_MARGIN: 0, MIN_SPEED: 1e-3, LIFT_SPEED: 0, STATION_BRAKE: 1e9 });
  return paced as CoasterPhysics;
}

/** A fake Bedrock entity: dynamic properties, teleports recorded, a rideable component. Loose types: it stands in for the engine's. */
interface FakeEntity { entity: any; properties: Map<string, unknown>; riders: any[]; teleports: Array<{ rotation?: { x: number; y: number } }> }

/** The serialised runtime over fake entities, one placement at `SCALE` (as test/bedrock-coaster.test.ts `liftHost`). */
function host(route: CoasterRoute, pace: number) {
  const bare = coasterRuntimeConfig('craftmatic:scan_cart', [route]);
  const types = Object.fromEntries(Object.entries(bare.types).map(([id, t]) => [id, t.role === 'car' && WHEELBASE !== undefined ? { ...t, wheelbase: WHEELBASE } : t]));
  const config: CoasterRuntimeConfig = { ...bare, types, physics: physicsAt(pace) };
  const runtime = config.routes[0]!;
  const make = (id: string, typeId: string, index?: number): FakeEntity => {
    const properties = new Map<string, unknown>([['craftmatic:coaster_origin', { x: 100, y: 64, z: 200 }], ['craftmatic:coaster_rotation', 0], ['craftmatic:coaster_scale', SCALE], ['craftmatic:coaster_route', 0]]);
    if (index !== undefined) properties.set('craftmatic:coaster_car', index);
    const riders: any[] = [], teleports: FakeEntity['teleports'] = [], rotation = { x: 0, y: 0 };
    const entity = {
      id, typeId, getDynamicProperty: (k: string) => properties.get(k), setDynamicProperty: (k: string, v: unknown) => properties.set(k, v), setProperty: () => {},
      getRotation: () => ({ ...rotation }), isValid: () => true, dimension: { getBlock: () => ({}) },
      getComponent: (n: string) => n === 'minecraft:rideable' ? { getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } } : undefined,
      tryTeleport: (_p: unknown, o?: { rotation?: { x: number; y: number } }) => { teleports.push({ ...(o?.rotation ? { rotation: { ...o.rotation } } : {}) }); if (o?.rotation) Object.assign(rotation, o.rotation); return true; },
    };
    return { entity, properties, riders, teleports };
  };
  const cars = runtime.cars.slots!.map((s, k) => make(`car${k}`, s.type, k));
  const others = [runtime.lift ? make('platform', runtime.lift.type) : undefined, runtime.lift?.counterweightType ? make('weight', runtime.lift.counterweightType) : undefined].filter((e): e is FakeEntity => !!e);
  const all = [...cars, ...others];
  const world = { getDimension: (n: string) => ({ getEntities: () => n === 'overworld' ? all.map(m => m.entity) : [] }) };
  let tick = (): void => {};
  new Function('world', 'system', coasterScript(config).replace(/^import .*;\n/, ''))(world, { runInterval: (cb: () => void) => { tick = cb; } });
  const lead = cars[0]!;
  return {
    config, route: runtime, cars, lead, tick: () => tick(),
    phase: () => String(lead.properties.get('craftmatic:coaster_phase') ?? 'track'),
    distance: () => Number(lead.properties.get('craftmatic:coaster_distance')),
    speed: () => Number(lead.properties.get('craftmatic:coaster_speed')),
  };
}

type Path = CoasterRuntimeConfig['routes'][number]['path'];
function pointAt(path: Path, value: number): number[] {
  const d = path.closed ? ((value % path.length) + path.length) % path.length : Math.max(0, Math.min(path.length, value));
  let i = 0; while (i < path.points.length - 2 && path.cumulative[i + 1]! <= d) i++;
  const t = (d - path.cumulative[i]!) / (path.cumulative[i + 1]! - path.cumulative[i]!);
  return [0, 1, 2].map(k => path.points[i]![k]! + (path.points[i + 1]![k]! - path.points[i]![k]!) * t);
}
/** The runtime's `chordAt`: between the wheel contacts, or the segment tangent with no wheelbase. */
function chord(path: Path, arc: number, wheelbase: number): number[] {
  const [f, r] = wheelbase > 0.01 ? [pointAt(path, arc + wheelbase / 2), pointAt(path, arc - wheelbase / 2)] : [pointAt(path, arc + 1e-4), pointAt(path, arc)];
  return [0, 1, 2].map(k => f[k]! - r[k]!);
}
function upY(route: CoasterRuntimeConfig['routes'][number], arc: number): number {
  const p = route.path; let i = 0; while (i < p.points.length - 2 && p.cumulative[i + 1]! <= arc) i++;
  const ratio = (arc - p.cumulative[i]!) / (p.cumulative[i + 1]! - p.cumulative[i]!);
  return route.up[i]![1] + (route.up[i + 1]![1] - route.up[i]![1]) * ratio;
}
const viewDirection = (r: { x: number; y: number }): number[] => { const y = r.y * Math.PI / 180, p = r.x * Math.PI / 180; return [-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]; };
const angleDeg = (a: number[], b: number[]): number => Math.acos(Math.max(-1, Math.min(1, (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(...a) * Math.hypot(...b))))) * 180 / Math.PI;
const turn = (a: number, b: number): number => Math.abs(((b - a) % 360 + 540) % 360 - 180);

/** The clamp-camera test's metrics over 1,400 ticks with a rider aboard car 0. */
function cameraMetrics(route: CoasterRoute, pace: number): string {
  const h = host(route, pace);
  const views: Array<{ x: number; y: number }> = [];
  const rider = {
    id: 'player', typeId: 'minecraft:player', onScreenDisplay: { setActionBar: () => {} }, addEffect: () => {}, removeEffect: () => {},
    camera: { setCamera: (_preset: string, options: { rotation: { x: number; y: number } }) => { views.push(options.rotation); }, clear: () => {} },
    // The client's rider yaw trails the car's by `lookLag` teleports (as the test's `cameraRider`).
    getRotation: () => { const t = h.lead.teleports; return { x: 0, y: t.length ? Number(t[Math.max(0, t.length - 1 - COASTER_RIDER_VIEW.lookLag)]!.rotation?.y ?? 0) : 0 }; },
  };
  h.tick(); h.lead.riders.push(rider);
  const wheelbase = h.config.types[h.route.cars.slots![0]!.type]!.wheelbase || 0;
  let off = 0, worstFromVertical = 0, worstError = 0;
  for (let t = 0; t < 1400; t++) {
    h.tick();
    const view = views.at(-1)!;
    if (h.phase() !== 'track') continue;
    const nose = chord(h.route.path, h.distance() + h.route.cars.extent / 2, wheelbase).map(v => v * (h.route.cars.heading || 1));
    if (Math.hypot(...nose) < 1e-9) continue;
    const e = angleDeg(viewDirection(view), nose);
    if (e > 0.5) { off++; worstFromVertical = Math.max(worstFromVertical, 90 - Math.abs(view.x)); worstError = Math.max(worstError, e); }
  }
  return `clamp off=${off} fromVertical=${worstFromVertical.toFixed(1)} offNose=${worstError.toFixed(1)}`;
}

/** The loops test's metrics: worst per-tick car yaw and yaw range within 3 blocks of each inversion, over 2,600 ticks. */
function loopMetrics(route: CoasterRoute, pace: number): string {
  const h = host(route, pace);
  // Train 0's cars only: their arcs follow from the lead's centre (train 1 has its own).
  const train0 = h.cars.slice(0, h.route.cars.count);
  const rows: Array<Array<{ arc: number; yaw: number; up: number }>> = train0.map(() => []);
  for (let t = 0; t < 2600; t++) {
    h.tick();
    if (h.phase() !== 'track') continue;
    for (const [slot, car] of train0.entries()) {
      const last = car.teleports.at(-1);
      if (!last?.rotation) continue;
      const arc = h.distance() + h.route.cars.extent / 2 - slot * h.route.cars.spacing;
      rows[slot]!.push({ arc, yaw: last.rotation.y, up: upY(h.route, arc) });
    }
  }
  let worstStep = 0, worstRange = 0;
  for (const log of rows) for (let k = 1; k < log.length; k++) {
    if (!(log[k]!.up < 0 && log[k - 1]!.up >= 0)) continue;
    let end = k; while (end < log.length - 1 && log[end + 1]!.up < 0) end++;
    if (end - k < 3) continue;
    let from = k, to = end;
    while (from > 0 && Math.abs(log[from - 1]!.arc - log[k]!.arc) < 3) from--;
    while (to < log.length - 1 && Math.abs(log[to + 1]!.arc - log[end]!.arc) < 3) to++;
    for (let j = from; j <= to; j++) {
      worstRange = Math.max(worstRange, turn(log[from]!.yaw, log[j]!.yaw));
      if (j > from) worstStep = Math.max(worstStep, turn(log[j - 1]!.yaw, log[j]!.yaw));
    }
  }
  return `loops worstYawStep=${worstStep.toFixed(1)} yawRange=${worstRange.toFixed(1)}`;
}

function rideStats(route: CoasterRoute, pace: number): string {
  const h = host(route, pace);
  const cap = h.config.physics!.MAX_SPEED, g = h.config.physics!.GRAVITY;
  let peak = 0, capped = 0, moving = 0, sum = 0, loopTop = Infinity, lastStop = -1, wasStopped = true;
  const intervals: number[] = [];
  for (let t = 0; t < 6000; t++) {
    h.tick();
    const v = h.speed();
    if (h.phase() === 'track' && v > 0) {
      moving++; sum += v; peak = Math.max(peak, v); if (v >= cap - 1e-9) capped++;
      if (upY(h.route, h.distance() + h.route.cars.extent / 2) < -0.9) loopTop = Math.min(loopTop, v / Math.sqrt(g * h.route.loopRadius! * SCALE));
    }
    const stopped = v === 0;
    if (stopped && !wasStopped) { if (lastStop >= 0) intervals.push((t - lastStop) / 20); lastStop = t; }
    wasStopped = stopped;
  }
  return `peak=${peak.toFixed(2)} mean=${(sum / moving).toFixed(2)} cappedTicks=${capped} loopTop=${loopTop.toFixed(2)} stopIntervals=${intervals.map(s => s.toFixed(1)).join('/')}`;
}

function energy(route: CoasterRoute, pace: number): string {
  const h = host(route, pace);
  const g = h.config.physics!.GRAVITY, cars = h.route.cars;
  const runs: string[] = [];
  let run: number[] = [];
  const close = (): void => {
    if (run.length > 40) { const lo = Math.min(...run), hi = Math.max(...run); runs.push(`${run.length} ticks drift ${((hi - lo) / Math.abs(hi) * 100).toFixed(2)}% (E ${lo.toFixed(1)}..${hi.toFixed(1)})`); }
    run = [];
  };
  for (let t = 0; t < 4000; t++) {
    h.tick();
    const v = h.speed();
    if (h.phase() !== 'track' || v <= 0.01) { close(); continue; }
    let y = 0;
    for (let k = 0; k < cars.count; k++) y += pointAt(h.route.path, h.distance() + cars.extent / 2 - k * cars.spacing)[1]!;
    run.push(v * v / 2 + g * (y / cars.count) * SCALE);
  }
  close();
  return [...new Set(runs)].join(' | ');
}

async function main(): Promise<void> {
  if (!existsSync(FILE) || !existsSync(LDRAW)) throw new Error(`needs the corpus: ${FILE} and ${LDRAW}`);
  setLDrawRoot(LDRAW);
  const doc = parseLDrawDocument(readFileSync(FILE, 'utf8'));
  const provider = createPartGeometryProvider({ document: doc });
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const tracks = extractCoasterTrackRoutes(doc.bricks, { isGeometryAvailable: (_id, b) => (meshes.get(b.part)?.triangles.length ?? 0) > 0 });
  const frame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
  const route = coasterRoutesFromAssemblies(tracks, detectCoasterAssemblies(doc.bricks, meshes, tracks), doc.bricks, frame).routes[0]!;
  console.log(`${MODE} ${FILE} scale=${SCALE} wheelbase=${WHEELBASE?.toFixed(4) ?? 'none (tangent)'}${args.has('drag-per-scale') ? ' DRAG/scale' : ''}`);
  for (const pace of PACES) {
    const line = MODE === 'metrics' ? `${loopMetrics(route, pace)} | ${cameraMetrics(route, pace)}` : MODE === 'stats' ? rideStats(route, pace) : energy(route, pace);
    console.log(`pace ${pace.toFixed(4)} (g ${(9.8 * pace * pace).toFixed(2)}): ${line}`);
  }
}

await main();
