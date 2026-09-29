/**
 * Rider-camera probe: replay a pack's SHIPPED ride runtime (`scripts/coaster.js`)
 * on the replay's mock host with a rider whose head FOLLOWS the car (Bedrock
 * turns a rider with its vehicle, so a rider who never touches the screen
 * reports the car's yaw), and print everything the runtime asks of the camera
 * tick by tick: every `setCamera` (yaw, pitch, ease) and every `playAnimation`
 * with its rotation keyframes (yaw, pitch = -x, roll = z) and progress
 * keyframes, plus the car's own pose (pitch, up.y) on the same tick so a
 * camera fault can be read against the track.
 *
 * `_coaster_replay.ts` boards a rider whose rotation is fixed at 0, which
 * looks like a head turned up to ±70 degrees whenever the car has turned since
 * boarding; that is the wrong rider for reading the baseline view.
 *
 * Usage: bun scripts/_coaster_cam_probe.ts <pack.mcaddon | coaster.js> [--ticks=3000] [--from=T] [--to=T] [--rebuild] [--out=file.tsv]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { coasterScript, type CoasterRuntimeConfig } from '../web/src/engine/bedrock-coaster.ts';

interface CamEvent { tick: number; kind: 'set' | 'anim' | 'clear'; yaw?: number; pitch?: number; ease?: number; x?: number; y?: number; z?: number; keys?: Array<{ t: number; yaw: number; pitch: number; roll: number; alpha: number }>; total?: number; points?: number }

export function probeCoasterCamera(script: string, ticks: number, boardTick = 200): { events: CamEvent[]; car: Map<number, { yaw: number; pitch: number; x: number; y: number; z: number }> } {
  const configMatch = /^const CONFIG = (\{.*\});$/m.exec(script);
  if (!configMatch) throw new Error('coaster.js: no `const CONFIG = {...};` line');
  const config = JSON.parse(configMatch[1]!) as { typeId: string; routes: any[]; types: Record<string, { role: string }> };
  const events: CamEvent[] = [];
  const car = new Map<number, { yaw: number; pitch: number; x: number; y: number; z: number }>();
  let tickNo = 0;
  const entities: any[] = [];
  const makeEntity = (id: string, typeId: string, props: Record<string, unknown>) => {
    const properties = new Map<string, unknown>(Object.entries(props));
    const riders: any[] = [];
    const rotation = { x: 0, y: 0 };
    const e: any = {
      id, typeId,
      getDynamicProperty: (k: string) => properties.get(k),
      setDynamicProperty: (k: string, v: unknown) => { properties.set(k, v); },
      setProperty: (k: string, v: unknown) => { if (id === 'r0c0' && k === 'craftmatic:coaster_pitch') pitchProp = Number(v); },
      getRotation: () => ({ ...rotation }),
      isValid: () => true,
      getComponent: (name: string) => name === 'minecraft:rideable' ? { getRiders: () => [...riders], ejectRiders: () => { riders.length = 0; } } : undefined,
      tryTeleport: (p: any, o: any) => {
        if (o?.rotation) { rotation.x = o.rotation.x; rotation.y = o.rotation.y; }
        if (id === 'r0c0') car.set(tickNo, { yaw: rotation.y, pitch: pitchProp, x: p.x, y: p.y, z: p.z });
        return true;
      },
      dimension: { getBlock: () => ({}) },
    };
    e.riders = riders; e.properties = properties; e.rotation = rotation;
    entities.push(e);
    return e;
  };
  let pitchProp = 0;
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
  const car0 = entities[0];
  const rider: any = {
    id: 'rider0', typeId: 'minecraft:player', name: 'rider0',
    // The head follows the car: what Bedrock reports for a rider who does not look around.
    getRotation: () => ({ x: 0, y: car0.rotation.y }), getHeadLocation: () => ({ x: 0, y: 0, z: 0 }),
    onScreenDisplay: { setActionBar: () => undefined },
    camera: {
      setCamera: (_p: string, o: any) => { events.push({ tick: tickNo, kind: 'set', yaw: o?.rotation?.y, pitch: o?.rotation?.x, ease: o?.easeOptions?.easeTime, x: o?.location?.x, y: o?.location?.y, z: o?.location?.z }); },
      clear: () => { events.push({ tick: tickNo, kind: 'clear' }); },
      playAnimation: (spline: any, o: any) => {
        const rot = o?.animation?.rotationKeyFrames ?? [], prog = o?.animation?.progressKeyFrames ?? [];
        events.push({ tick: tickNo, kind: 'anim', total: o?.totalTimeSeconds, points: spline?.controlPoints?.length,
          keys: rot.map((k: any, i: number) => ({ t: k.timeSeconds, yaw: k.rotation.y, pitch: -k.rotation.x, roll: k.rotation.z, alpha: prog[i]?.alpha })) });
      },
    },
    addEffect: () => undefined, removeEffect: () => undefined,
    inputInfo: { getMovementVector: () => ({ x: 0, y: 0 }), getButtonState: () => 'Released' },
  };
  const world = { getDimension: (name: string) => ({ getEntities: () => name === 'overworld' ? entities : [] }), getAllPlayers: () => [rider], getPlayers: () => [rider] };
  let tick = () => {};
  const system = { runInterval: (cb: () => void) => { tick = cb; }, runTimeout: () => 0, afterEvents: { scriptEventReceive: { subscribe: () => undefined } } };
  class LinearSpline { controlPoints: unknown[] = []; }
  const body = script.replace(/^import .*;\n/, '');
  new Function('world', 'system', 'LinearSpline', body)(world, system, LinearSpline);
  for (tickNo = 1; tickNo <= ticks; tickNo++) {
    if (tickNo === boardTick && car0) car0.riders.push(rider);
    tick();
  }
  return { events, car };
}

if (import.meta.main) {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: bun scripts/_coaster_cam_probe.ts <pack.mcaddon | coaster.js> [--ticks=N] [--from=T] [--to=T] [--rebuild] [--out=file.tsv]'); process.exit(2); }
  const flag = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  let script: string;
  if (/\.mcaddon$/i.test(file)) {
    const bytes = readFileSync(file);
    const entries = await extractMatching(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, n => /\/scripts\/coaster\.js$/.test(n));
    const found = [...entries.values()][0];
    if (!found) { console.error(`${file}: no scripts/coaster.js`); process.exit(1); }
    script = new TextDecoder().decode(found);
  } else script = readFileSync(file, 'utf8');
  // `--camera=<json>` merges camera constants into the pack's config (with --rebuild): a what-if without a pack build.
  const cameraOverride = flag('camera');
  if (process.argv.includes('--rebuild') || cameraOverride) {
    const m = /^const CONFIG = (\{.*\});$/m.exec(script);
    if (!m) { console.error('no CONFIG line'); process.exit(1); }
    const config = JSON.parse(m[1]!) as CoasterRuntimeConfig;
    if (cameraOverride) config.camera = { ...config.camera!, ...JSON.parse(cameraOverride) };
    script = coasterScript(config);
  }
  const ticks = Number(flag('ticks') ?? 3000), from = Number(flag('from') ?? 0), to = Number(flag('to') ?? ticks);
  const { events, car } = probeCoasterCamera(script, ticks);
  const f = (v: number | undefined, d = 1) => v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(d);
  const lines: string[] = ['tick\tkind\tcam_yaw\tcam_pitch\tease\tcar_yaw\tcar_pitch\tcar_y\tdetail'];
  for (const e of events) {
    if (e.tick < from || e.tick > to) continue;
    const c = car.get(e.tick);
    if (e.kind === 'anim') {
      lines.push(`${e.tick}\tanim\t\t\t\t${f(c?.yaw)}\t${f(c?.pitch)}\t${f(c?.y, 2)}\ttotal ${e.total}s points ${e.points} keys ${e.keys!.length}`);
      for (const k of e.keys!) lines.push(`${e.tick}\t  key\t${f(k.yaw)}\t${f(k.pitch)}\t\t\t\t\tt ${k.t.toFixed(2)} roll ${f(k.roll)} alpha ${f(k.alpha, 3)}`);
    } else if (e.kind === 'set') lines.push(`${e.tick}\tset\t${f(e.yaw)}\t${f(e.pitch)}\t${e.ease ?? '-'}\t${f(c?.yaw)}\t${f(c?.pitch)}\t${f(c?.y, 2)}\t`);
    else lines.push(`${e.tick}\tclear`);
  }
  const out = flag('out');
  if (out) writeFileSync(out, lines.join('\n') + '\n');
  else console.log(lines.join('\n'));
}
