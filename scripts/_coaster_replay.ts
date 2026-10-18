/**
 * Replay a pack's SHIPPED ride runtime (`scripts/coaster.js`) on the headless
 * simulator (`web/src/sim`, through `test/_sim-host.ts`) and print a digest of
 * everything it did: every teleport (position + rotation), every dynamic and
 * actor-property write and every rider-camera call, tick by tick. Two packs
 * whose runtimes behave identically print the same digest, so a refactor of
 * `coasterRuntime` can be proved to leave the device behaviour of 10261/10303
 * unchanged (the rail-vehicle round, 2026-09-25) without trusting that two
 * different source texts are equal.
 *
 * The world (`coasterReplayWorld`) places one entity per car slot of every
 * route (and the platform and counterweight of a lift route) exactly where the
 * Brick Wand would record them, each of the type the pack declares (the
 * exporter's cart definition: `sim/adapters/craftmatic/coaster.ts`). The
 * replay boards a real player on car 0 of route 0 at tick 200 and takes them
 * off at tick 2400, and holds a stick input script (forward, idle, back) so a
 * driver-mode route is exercised by the same replay.
 *
 * `--rebuild` replays the pack's CONFIG through THIS tree's `coasterScript`
 * instead of the shipped text: the same ride data, the current runtime, so a
 * digest equal to the shipped one proves the runtime change is inert for it.
 *
 * Usage: bun scripts/_coaster_replay.ts <pack.mcaddon | coaster.js> [--ticks=3000] [--trace=out.json] [--rebuild]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { coasterScript, type CoasterRuntimeConfig } from '../web/src/engine/bedrock-coaster.ts';
import { COASTER_TEST_ORIGIN, coasterEntityTypes, coasterPlacementEntities, coasterScriptConfig } from '../web/src/sim/adapters/craftmatic/coaster.ts';
import type { SimEntity } from '../web/src/sim/entity/entity.ts';
import { simHost, solidBelow, type SimHost } from '../test/_sim-host.ts';

export interface ReplayResult { digest: string; events: number; ticks: number; routes: number; cars: number; final: Array<{ id: string; distance: unknown; speed: unknown; direction: unknown }> }

/** One placed coaster entity of a replay world: its trace id, the engine's entity and the facade the runtime holds. */
export interface ReplayEntity { id: string; sim: SimEntity; api: any }

/**
 * A coaster.js text loaded into a fresh simulator world with the placement's
 * entities spawned (ids `r<route>c<slot>`, `r<route>platform`, `r<route>cw`),
 * the world stone below y = 0 and loaded around the placement. The scripts
 * start only when `start()` is called, so a caller wraps the facades first.
 * `spline: false` is a client without `LinearSpline` (the loop camera then
 * rides on its per-tick camera alone).
 */
export function coasterReplayWorld(script: string, options: { scale?: number; spline?: boolean } = {}): { h: SimHost; config: CoasterRuntimeConfig; entities: ReplayEntity[]; start: () => void } {
  const config = coasterScriptConfig(script);
  const o = COASTER_TEST_ORIGIN;
  const h = simHost({
    script, entities: coasterEntityTypes(config), terrain: solidBelow(0), deferScripts: true,
    loadArea: { x0: o.x - 128, z0: o.z - 128, x1: o.x + 128, z1: o.z + 128 },
    ...(options.spline === false ? { absentExports: ['LinearSpline'] } : {}),
  });
  const entities = coasterPlacementEntities(config, options.scale ?? 1).map(p => {
    const sim = h.spawn(p.typeId, o, { dynamic: p.dynamic, id: p.id });
    return { id: p.id, sim, api: h.api(sim) };
  });
  return { h, config, entities, start: () => h.start() };
}

/**
 * Run a coaster.js text for `ticks` ticks on the simulator and digest what it did.
 * `options.events` delivers `/scriptevent`s at given ticks (the stick hook a GameTest
 * drives a train with); `options.rider: false` never boards the rider.
 */
export function replayCoasterScript(script: string, ticks = 3000, trace?: unknown[], options: { events?: Array<{ tick: number; id: string; message: string }>; rider?: boolean } = {}): ReplayResult {
  const { h, config, entities, start } = coasterReplayWorld(script);
  const events: unknown[] = trace ?? [];
  let tickNo = 0;
  const log = (...e: unknown[]) => { events.push([tickNo, ...e]); };
  // Every write and move the runtime makes, logged at the API it calls, then applied by the simulator.
  for (const { id, api } of entities) {
    const setDynamic = api.setDynamicProperty, setProperty = api.setProperty, tryTeleport = api.tryTeleport;
    api.setDynamicProperty = (k: string, v: unknown) => { log('dyn', id, k, v); return setDynamic(k, v); };
    api.setProperty = (k: string, v: unknown) => { log('prop', id, k, v); return setProperty(k, v); };
    api.tryTeleport = (p: any, o: any) => { log('tp', id, p.x, p.y, p.z, o?.rotation?.y); return tryTeleport(p, o); };
  }
  // The rider: a real player whose action bar and camera calls are logged, and whose stick the replay holds.
  const riderSim = h.addPlayer('rider0', { x: COASTER_TEST_ORIGIN.x, y: 0, z: COASTER_TEST_ORIGIN.z });
  const rider = h.api(riderSim);
  const setActionBar = rider.onScreenDisplay.setActionBar, camera = rider.camera;
  const setCamera = camera.setCamera, clear = camera.clear, playAnimation = camera.playAnimation;
  rider.onScreenDisplay.setActionBar = (t: string) => { log('bar', t); return setActionBar(t); };
  camera.setCamera = (p: string, o: any) => { log('cam', p, o?.location?.x, o?.location?.y, o?.location?.z, o?.rotation?.x, o?.rotation?.y); return setCamera(p, o); };
  camera.clear = () => { log('camclear'); return clear(); };
  camera.playAnimation = (s: unknown, o: unknown) => { log('anim'); return playAnimation(s, o); };
  start();
  const car0 = entities[0];
  for (tickNo = 1; tickNo <= ticks; tickNo++) {
    if (tickNo === 200 && car0 && options.rider !== false) h.seat(riderSim, car0.sim);
    for (const ev of options.events ?? []) if (ev.tick === tickNo) h.engine.emit('scriptEventReceive', { id: ev.id, message: ev.message });
    // The stick: forward for 20 s, idle 10 s, back 10 s, idle (only a driver route reads it).
    const y = tickNo < 600 ? 1 : tickNo < 800 ? 0 : tickNo < 1000 ? -1 : 0;
    h.controls(riderSim, { strafe: 0, forward: y });
    if (tickNo === 2400 && car0) for (const r of car0.sim.riderList()) h.unseat(r);
    h.run(1);
  }
  const digest = createHash('sha256').update(JSON.stringify(events)).digest('hex');
  return {
    digest, events: events.length, ticks, routes: config.routes.length, cars: entities.length,
    final: entities.map(e => ({ id: e.id, distance: e.sim.dynamic.get('craftmatic:coaster_distance'), speed: e.sim.dynamic.get('craftmatic:coaster_speed'), direction: e.sim.dynamic.get('craftmatic:coaster_direction') })),
  };
}

if (import.meta.main) {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: bun scripts/_coaster_replay.ts <pack.mcaddon | coaster.js> [--ticks=N] [--trace=out.json]'); process.exit(2); }
  const flag = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  let script: string;
  if (/\.mcaddon$/i.test(file)) {
    const bytes = readFileSync(file);
    const entries = await extractMatching(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, n => /\/scripts\/coaster\.js$/.test(n));
    const found = [...entries.values()][0];
    if (!found) { console.error(`${file}: no scripts/coaster.js`); process.exit(1); }
    script = new TextDecoder().decode(found);
  } else script = readFileSync(file, 'utf8');
  if (process.argv.includes('--rebuild')) script = coasterScript(coasterScriptConfig(script));
  const trace: unknown[] = [];
  const result = replayCoasterScript(script, Number(flag('ticks') ?? 3000), trace);
  if (flag('trace')) writeFileSync(flag('trace')!, JSON.stringify(trace));
  console.log(JSON.stringify(result, null, 1));
}
