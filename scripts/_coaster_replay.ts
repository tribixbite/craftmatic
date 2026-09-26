/**
 * Replay a pack's SHIPPED ride runtime (`scripts/coaster.js`) on a mock
 * Bedrock host and print a digest of everything it did: every teleport
 * (position + rotation), every actor-property write and every rider-camera
 * call, tick by tick. Two packs whose runtimes behave identically print the
 * same digest, so a refactor of `coasterRuntime` can be proved to leave the
 * device behaviour of 10261/10303 unchanged (the rail-vehicle round,
 * 2026-09-25) without trusting that two different source texts are equal.
 *
 * The host places one entity per car slot of every route (and the platform and
 * counterweight of a lift route) exactly where the Brick Wand would record
 * them, boards a rider on car 0 of route 0 at tick 200 and takes them off at
 * tick 2400, and gives the rider a stick input script (forward, idle, back) so
 * a driver-mode route is exercised by the same replay.
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

export interface ReplayResult { digest: string; events: number; ticks: number; routes: number; cars: number; final: Array<{ id: string; distance: unknown; speed: unknown; direction: unknown }> }

/**
 * Run a coaster.js text for `ticks` ticks on the mock host and digest what it did.
 * `options.events` delivers `/scriptevent`s at given ticks (the stick hook a GameTest
 * drives a train with); `options.rider: false` never boards the scripted rider.
 */
export function replayCoasterScript(script: string, ticks = 3000, trace?: unknown[], options: { events?: Array<{ tick: number; id: string; message: string }>; rider?: boolean } = {}): ReplayResult {
  const configMatch = /^const CONFIG = (\{.*\});$/m.exec(script);
  if (!configMatch) throw new Error('coaster.js: no `const CONFIG = {...};` line');
  const config = JSON.parse(configMatch[1]!) as { typeId: string; routes: any[]; types: Record<string, { role: string }> };
  const events: unknown[] = trace ?? [];
  let tickNo = 0;
  const log = (...e: unknown[]) => { events.push([tickNo, ...e]); };
  const entities: any[] = [];
  const makeEntity = (id: string, typeId: string, props: Record<string, unknown>) => {
    const properties = new Map<string, unknown>(Object.entries(props));
    const riders: any[] = [];
    const rotation = { x: 0, y: 0 };
    const e: any = {
      id, typeId,
      getDynamicProperty: (k: string) => properties.get(k),
      setDynamicProperty: (k: string, v: unknown) => { properties.set(k, v); log('dyn', id, k, v); },
      setProperty: (k: string, v: unknown) => log('prop', id, k, v),
      getRotation: () => ({ ...rotation }),
      isValid: () => true,
      getComponent: (name: string) => name === 'minecraft:rideable' ? { getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } } : undefined,
      tryTeleport: (p: any, o: any) => { if (o?.rotation) { rotation.x = o.rotation.x; rotation.y = o.rotation.y; } log('tp', id, p.x, p.y, p.z, o?.rotation?.y); return true; },
      dimension: { getBlock: () => ({}) },
    };
    e.riders = riders; e.properties = properties;
    entities.push(e);
    return e;
  };
  const origin = { x: 100, y: 64, z: 200 };
  config.routes.forEach((route, r) => {
    const base = { 'craftmatic:coaster_origin': origin, 'craftmatic:coaster_rotation': 0, 'craftmatic:coaster_scale': 1, 'craftmatic:coaster_route': r };
    const slots: Array<{ type: string }> = route.cars?.slots ?? Array.from({ length: (route.cars?.count ?? 1) * (route.cars?.trains ?? 1) }, () => ({ type: config.typeId }));
    slots.forEach((slot, k) => makeEntity(`r${r}c${k}`, slot.type, { ...base, 'craftmatic:coaster_car': k }));
    if (route.lift) {
      makeEntity(`r${r}platform`, route.lift.type, base);
      if (route.lift.counterweightType) makeEntity(`r${r}cw`, route.lift.counterweightType, base);
    }
  });
  // The rider: a player object with the camera, effects and the stick the runtimes read.
  let stick = { x: 0, y: 0 };
  const rider: any = {
    id: 'rider0', typeId: 'minecraft:player', name: 'rider0',
    getRotation: () => ({ x: 0, y: 0 }), getHeadLocation: () => ({ x: 0, y: 0, z: 0 }),
    onScreenDisplay: { setActionBar: (t: string) => log('bar', t) },
    camera: { setCamera: (p: string, o: any) => log('cam', p, o?.location?.x, o?.location?.y, o?.location?.z, o?.rotation?.x, o?.rotation?.y), clear: () => log('camclear'), playAnimation: () => log('anim') },
    addEffect: () => undefined, removeEffect: () => undefined,
    inputInfo: { getMovementVector: () => ({ ...stick }), getButtonState: () => 'Released' },
  };
  const world = { getDimension: (name: string) => ({ getEntities: () => name === 'overworld' ? entities : [] }), getAllPlayers: () => [rider], getPlayers: () => [rider] };
  let tick = () => {};
  const subscribers: Array<(ev: unknown) => void> = [];
  const system = { runInterval: (cb: () => void) => { tick = cb; }, runTimeout: () => 0, afterEvents: { scriptEventReceive: { subscribe: (fn: (ev: unknown) => void) => { subscribers.push(fn); } } } };
  class LinearSpline { controlPoints: unknown[] = []; }
  const body = script.replace(/^import .*;\n/, '');
  new Function('world', 'system', 'LinearSpline', body)(world, system, LinearSpline);
  const car0 = entities[0];
  for (tickNo = 1; tickNo <= ticks; tickNo++) {
    if (tickNo === 200 && car0 && options.rider !== false) car0.riders.push(rider);
    for (const ev of options.events ?? []) if (ev.tick === tickNo) for (const fn of subscribers) fn({ id: ev.id, message: ev.message });
    // The stick: forward for 20 s, idle 10 s, back 10 s, idle (only a driver route reads it).
    stick = tickNo < 600 ? { x: 0, y: 1 } : tickNo < 800 ? { x: 0, y: 0 } : tickNo < 1000 ? { x: 0, y: -1 } : { x: 0, y: 0 };
    if (tickNo === 2400 && car0) car0.riders.length = 0;
    tick();
  }
  const digest = createHash('sha256').update(JSON.stringify(events)).digest('hex');
  return {
    digest, events: events.length, ticks, routes: config.routes.length, cars: entities.length,
    final: entities.map(e => ({ id: e.id, distance: e.properties.get('craftmatic:coaster_distance'), speed: e.properties.get('craftmatic:coaster_speed'), direction: e.properties.get('craftmatic:coaster_direction') })),
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
  if (process.argv.includes('--rebuild')) {
    const m = /^const CONFIG = (\{.*\});$/m.exec(script);
    if (!m) { console.error('no CONFIG line'); process.exit(1); }
    script = coasterScript(JSON.parse(m[1]!) as CoasterRuntimeConfig);
  }
  const trace: unknown[] = [];
  const result = replayCoasterScript(script, Number(flag('ticks') ?? 3000), trace);
  if (flag('trace')) writeFileSync(flag('trace')!, JSON.stringify(trace));
  console.log(JSON.stringify(result, null, 1));
}
