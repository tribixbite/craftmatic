/**
 * The simulator's client HAND (package C, docs/sim-engine.md "Input"): the touch sneak toggle, drags routed by
 * the control scheme and MEASURED by `rider-drag-reaches-look`, the mount snap, the native mount's bursts,
 * screen-space taps (crosshair and touch modes), the device-script interpreter and the per-tick cost model.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ControlState } from '../web/src/sim/input/controls.js';
import { dragRoute } from '../web/src/sim/input/scheme.js';
import { dragPixels, dragRecords } from '../web/src/sim/input/drag.js';
import { PIXEL_VIEWPORT, projectToScreen, screenCamera, screenPick, screenRay, touchModeOf } from '../web/src/sim/input/screen.js';
import { PIXEL_LAYOUT, PhoneScreen, runDeviceScript, translateCommand, type PhoneIO, type ReplayEvent } from '../web/src/sim/input/device-script.js';
import { COST_CALIBRATION_LOGS, COST_FITS, TICK_BUDGET_WARN_MS, fitCost, parseCmvtSamples, predictedMsPerTick, summarizeCost } from '../web/src/sim/quirks/cost.js';
import { quirkValue } from '../web/src/sim/quirks/registry.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';
import { INPUT_HANDLERS } from '../web/src/sim/input/steps.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { deviceScriptScenario, inputProbeHandlers } from '../web/src/sim/adapters/craftmatic/input-probe.js';
import { simHost, solidBelow } from './_sim-host.js';

const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
const SEAT = (lock: number) => ({ components: {
  'minecraft:collision_box': { width: 1, height: 0.6 }, 'minecraft:physics': { has_gravity: false, has_collision: false },
  'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: [0, 0.5, 0], lock_rider_rotation: lock }] },
} });

describe('the touch sneak button is a toggle (quirk touch-sneak-toggle)', () => {
  it('flips on each press, ignores the release, and makes every press a dismount edge; hold mode is unchanged', () => {
    const c = new ControlState();
    c.set('p', { sneak: true }); c.set('p', { sneak: false });
    expect(c.get('p').sneak).toBe(false);
    expect(c.takeSneakEdge('p')).toBe(true);
    c.setSneakMode('p', 'toggle');
    c.set('p', { sneak: true }); c.set('p', { sneak: false });
    expect(c.get('p').sneak).toBe(true); // left ON after the release (Pixel 30j: the seat's Sneak left it lit)
    expect(c.takeSneakEdge('p')).toBe(true);
    expect(c.sneakToggle('p')).toBe(false);
    expect(c.takeSneakEdge('p')).toBe(true); // the press that turns it off is a dismount edge too
    c.sneakToggle('p');
    c.setSneakMode('p', 'hold');
    expect(c.get('p').sneak).toBe(true); // switching modes presses nothing
  });
});

describe('a drag is routed by the control scheme and measured (quirk control-scheme-drag-to-camera)', () => {
  it('routes by scheme, seat lock and script camera', () => {
    expect(dragRoute({ scheme: undefined, seatLock: undefined, riding: false, scriptCamera: false })).toBe('look');
    expect(dragRoute({ scheme: 'locked_player_relative_strafe', seatLock: 181, riding: true, scriptCamera: true })).toBe('look');
    expect(dragRoute({ scheme: undefined, seatLock: 0, riding: true, scriptCamera: false })).toBe('pitch-only');
    expect(dragRoute({ scheme: 'player_relative', seatLock: 181, riding: true, scriptCamera: false })).toBe('orbit');
    expect(dragRoute({ scheme: 'camera_relative', seatLock: 181, riding: true, scriptCamera: true })).toBe('none');
  });

  it('turns a walking player by the touch sensitivity (the Saga\'s 400 px = 84 degrees) and clamps the pitch', () => {
    const h = simHost({ terrain: solidBelow(64) });
    const p = h.addPlayer('P', { x: 0.5, y: 64, z: 0.5 });
    dragPixels(h.sim.controls, p.id, 400, 0);
    h.run(1);
    expect(p.rotation.y).toBeCloseTo(400 * quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel'), 6);
    h.sim.controls.drag(p.id, { yawDeg: 0, pitchDeg: 500 });
    h.run(1);
    expect(p.rotation.x).toBe(90);
    expect(dragRecords(h.engine).map(r => r.route)).toEqual(['look', 'look']);
  });

  it('holds a lock-0 seat\'s yaw to the seat and moves only the pitch (pinball, Pixel 2026-09-25)', () => {
    const h = simHost({ entities: { 'x:seat': SEAT(0) }, terrain: solidBelow(64) });
    const seat = h.spawn('x:seat', { x: 0.5, y: 64, z: 0.5 }, { yaw: 30 });
    const p = h.addPlayer('P', seat.location);
    h.seat(p, seat);
    h.run(14);
    h.sim.controls.drag(p.id, { yawDeg: 40, pitchDeg: 20 });
    h.run(1);
    expect(p.rotation.y).toBeCloseTo(30, 6);
    expect(p.rotation.x).toBeCloseTo(20, 6);
  });

  it('fails a riding player\'s drag that does not reach its look (player_relative), and passes the default scheme - measured, not inferred', async () => {
    const enc = new TextEncoder();
    const { createZip } = await import('../web/src/engine/zip-utils.js');
    const manifest = { format_version: 2, header: { name: 'mini', uuid: '00000000-0000-0000-0000-0000000000a1', version: [1, 0, 0] }, modules: [{ type: 'data', uuid: '00000000-0000-0000-0000-0000000000a2', version: [1, 0, 0] }, { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: '00000000-0000-0000-0000-0000000000a3', version: [1, 0, 0] }], dependencies: [{ module_name: '@minecraft/server', version: '2.9.0' }] };
    const seat = { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 'x:mount' }, components: SEAT(181).components } };
    const addon = async (scheme: string) => readAddon(await createZip([
      { name: 'mini_BP/manifest.json', data: enc.encode(JSON.stringify(manifest)) },
      { name: 'mini_BP/entities/mount.json', data: enc.encode(JSON.stringify(seat)) },
      { name: 'mini_BP/scripts/main.js', data: enc.encode("import { world, system } from '@minecraft/server';\nsystem.runTimeout(() => { const p = world.getAllPlayers()[0]; const m = world.getDimension('overworld').spawnEntity('x:mount', p.location); system.runTimeout(() => { m.getComponent('minecraft:rideable').addRider(p); p.runCommand('controlscheme @s " + scheme + "'); }, 2); }, 2);\n") },
    ]), 'mini');
    const run = async (scheme: string) => runScenario({ name: 'drag', steps: [{ kind: 'wait', ticks: 30 }, { kind: 'drag', dx: 200, dy: 0, ticks: 4 }, { kind: 'wait', ticks: 2 }] }, [await addon(scheme)], { handlers: INPUT_HANDLERS });
    const held = await run('set player_relative');
    const v = held.violations.filter(x => x.invariant === 'rider-drag-reaches-look');
    expect(v.some(x => /route orbit/.test(x.message))).toBe(true);
    expect((await run('clear')).violations.map(x => x.invariant)).not.toContain('rider-drag-reaches-look');
  });
});

describe('the seat snaps a new rider onto the heading (quirk mount-snaps-rider-yaw)', () => {
  it('takes out the offset at mounting over the snap ticks, keeping the pitch and a drag made meanwhile', () => {
    const h = simHost({ entities: { 'x:seat': SEAT(181) }, terrain: solidBelow(64) });
    const seat = h.spawn('x:seat', { x: 0.5, y: 64, z: 0.5 }, { yaw: -90 });
    const p = h.addPlayer('P', seat.location, { yaw: 90, pitch: 12 });
    h.run(1);
    h.seat(p, seat);
    h.run(4);
    // Saga 30k: 54.8 -> -82.8 four ticks later at -90 (5 % left); here within 10 % after 4 ticks.
    expect(Math.abs(wrap(p.rotation.y - seat.rotation.y))).toBeLessThan(18);
    h.run(12);
    expect(wrap(p.rotation.y - seat.rotation.y)).toBeCloseTo(0, 6);
    expect(p.rotation.x).toBe(12);
    // A drag during a fresh snap is kept on top of it.
    h.unseat(p); h.run(1); p.rotation = { x: 0, y: 0 };
    h.seat(p, seat); h.run(2);
    h.sim.controls.drag(p.id, { yawDeg: 30, pitchDeg: 0 });
    h.run(20);
    expect(wrap(p.rotation.y - seat.rotation.y)).toBeCloseTo(30, 6);
  });
});

describe('a native hover mount moves in bursts (quirk native-mount-bursts)', () => {
  it('stands between bursts and covers the same ground', () => {
    const h = simHost({ entities: { 'x:cloud': { components: {
      'minecraft:collision_box': { width: 1, height: 0.5 }, 'minecraft:physics': { has_gravity: false, has_collision: false },
      'minecraft:movement.hover': {}, 'minecraft:free_camera_controlled': {}, 'minecraft:flying_speed': { value: 0.1 },
      'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: [0, 0.5, 0], lock_rider_rotation: 181 }] },
    } } }, terrain: solidBelow(10) });
    const cloud = h.spawn('x:cloud', { x: 0.5, y: 64, z: 0.5 });
    const p = h.addPlayer('P', cloud.location);
    h.seat(p, cloud);
    h.run(20);
    const z0 = cloud.location.z, moves: number[] = [];
    h.controls(p, { forward: 1 });
    let last = z0;
    for (let t = 0; t < 16; t++) { h.run(1); moves.push(cloud.location.z - last); last = cloud.location.z; }
    const burst = quirkValue('native-mount-bursts', 'burstTicks');
    expect(moves.filter(m => m !== 0).length).toBe(16 / burst);
    const perTick = (quirkValue('hover-controller-speed', 'blocksPerSecondPerFlyingSpeed') * 0.1 + quirkValue('hover-controller-speed', 'offsetBlocksPerSecond')) / 20;
    expect(cloud.location.z - z0).toBeCloseTo(perTick * 16, 6);
  });
});

describe('a native hover mount moves in its BODY\'s frame (quirk hover-stick-body-frame)', () => {
  it('flies forward along the body\'s heading while the rider looks 90 degrees off it (Saga 30m: look 107, body 0, flew 94 off the look)', () => {
    const h = simHost({ entities: { 'x:cloud': { components: {
      'minecraft:collision_box': { width: 1, height: 0.5 }, 'minecraft:physics': { has_gravity: false, has_collision: false },
      'minecraft:movement.hover': {}, 'minecraft:free_camera_controlled': {}, 'minecraft:flying_speed': { value: 0.1 },
      'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: [{ position: [0, 0.5, 0], lock_rider_rotation: 181 }] },
    } } }, terrain: solidBelow(10) });
    const cloud = h.spawn('x:cloud', { x: 0.5, y: 64, z: 0.5 });
    const p = h.addPlayer('P', cloud.location);
    h.seat(p, cloud);
    h.run(20);
    // The look 90 degrees right of the body (Bedrock: yaw 90 faces -X); the body held at 0 every tick, as the 30m
    // driver writes its heading (its `carried` verdict never turns it), so the controller's chase never lands.
    // The controller's per-tick chase (`hover-turn-chase`) turns the body ~13 degrees toward the look inside a tick
    // before it moves, so the travel is judged by its heading, not to the last digit.
    const travel = (stick: { forward?: number; strafe?: number }): { yaw: number; moved: number } => {
      p.rotation = { x: 0, y: 90 };
      const x0 = cloud.location.x, z0 = cloud.location.z;
      h.controls(p, { forward: stick.forward ?? 0, strafe: stick.strafe ?? 0 });
      for (let t = 0; t < 16; t++) { cloud.rotation = { x: 0, y: 0 }; h.run(1); }
      h.controls(p, { forward: 0, strafe: 0 });
      const dx = cloud.location.x - x0, dz = cloud.location.z - z0;
      return { yaw: Math.atan2(-dx, dz) * 180 / Math.PI, moved: Math.hypot(dx, dz) };
    };
    const fwd = travel({ forward: 1 });
    expect(fwd.moved).toBeGreaterThan(5);
    expect(Math.abs(wrap(fwd.yaw - 0))).toBeLessThan(20); // along the body (+Z)
    expect(Math.abs(wrap(fwd.yaw - 90))).toBeGreaterThan(60); // not along the look (-X)
    // A positive strafe (the stick's left) goes to the BODY's left (+X, yaw -90), not the look's left (+Z).
    const left = travel({ strafe: 1 });
    expect(Math.abs(wrap(left.yaw + 90))).toBeLessThan(20);
  });
});

describe('screen-space touch (quirk touch-screen-pick)', () => {
  it('casts the rasteriser\'s rays: the centre is the view, a projected point casts back onto itself', () => {
    const cam = { eye: { x: 0, y: 70, z: 0 }, forward: { x: 0, y: 0, z: 1 }, source: 'eye' as const };
    const c = screenRay(cam, { x: PIXEL_VIEWPORT.width / 2, y: PIXEL_VIEWPORT.height / 2 }, PIXEL_VIEWPORT).dir;
    expect(c.z).toBeCloseTo(1, 9);
    const q = { x: -2, y: 71.5, z: 4 };
    const s = projectToScreen(cam, q, PIXEL_VIEWPORT)!;
    const d = screenRay(cam, s, PIXEL_VIEWPORT).dir;
    const t = (q.z - cam.eye.z) / d.z;
    expect(cam.eye.x + d.x * t).toBeCloseTo(q.x, 6);
    expect(cam.eye.y + d.y * t).toBeCloseTo(q.y, 6);
    // Facing +Z (south), screen-left is east (+X): Minecraft's +yaw turns right, toward -X.
    expect(s.x).toBeGreaterThan(PIXEL_VIEWPORT.width / 2);
  });

  it('with the crosshair a tap anywhere picks the centre target; with Split Controls off it picks under the finger, within reach of the eye', () => {
    const h = simHost({ entities: { 'x:box': { components: { 'minecraft:collision_box': { width: 1, height: 1 }, 'minecraft:physics': { has_gravity: false, has_collision: false } } } }, terrain: solidBelow(64) });
    const p = h.addPlayer('P', { x: 0.5, y: 64, z: 0.5 });
    const ahead = h.spawn('x:box', { x: 0.5, y: 65, z: 3.5 });
    const left = h.spawn('x:box', { x: 3.5, y: 65, z: 3.5 });
    h.run(1);
    const corner = { x: 45, y: 39 };
    expect(screenPick(h.engine, p, corner, PIXEL_VIEWPORT).entity).toBe(ahead);
    const s = projectToScreen(screenCamera(p), { x: 3.5, y: 65.5, z: 3.5 }, PIXEL_VIEWPORT)!;
    expect(screenPick(h.engine, p, s, touchModeOf(PIXEL_VIEWPORT, 'touch')).entity).toBe(left);
    expect(screenPick(h.engine, p, corner, touchModeOf(PIXEL_VIEWPORT, 'touch')).entity).toBeUndefined();
    // From a chase camera 7 blocks behind, the ray reaches past the player: a box 3 blocks ahead of the eye is picked;
    // one the camera sees beside and behind the player, 6 blocks from the eye, is on the ray but out of the EYE's reach.
    const chase = { preset: 'minecraft:free', location: { x: 0.5, y: 66, z: -6.5 }, facing: { x: 0.5, y: 65.5, z: 3.5 } };
    expect(screenPick(h.engine, p, corner, PIXEL_VIEWPORT, chase).camera).toBe('script-camera');
    expect(screenPick(h.engine, p, corner, PIXEL_VIEWPORT, chase).entity).toBe(ahead);
    left.location = { x: 6, y: 65, z: -3 };
    expect(screenPick(h.engine, p, corner, PIXEL_VIEWPORT, { ...chase, facing: { x: 6, y: 65.5, z: -3 } }).outOfReach?.entity).toBe('x:box');
  });
});

/** A phone that records what reaches it, for the interpreter tests (no world). */
function recordingPhone(): { screen: PhoneScreen; events: ReplayEvent[]; sticks: Array<[number, number]>; commands: string[]; ticks: () => number } {
  const events: ReplayEvent[] = [], sticks: Array<[number, number]> = [], commands: string[] = [];
  let tick = 0;
  const io: PhoneIO = {
    advance: async n => { tick += n; },
    worldTap: (x, y) => `world ${x},${y}`, worldHold: () => 'hold', worldDrag: () => undefined,
    stick: (f, s) => { sticks.push([f, s]); }, chatCommand: line => { commands.push(line); return 'ok'; },
    log: e => { events.push({ tick, ...e }); },
  };
  return { screen: new PhoneScreen(PIXEL_LAYOUT, io), events, sticks, commands, ticks: () => tick };
}

describe('device-script replay: the round tools, interpreted (input/device-script.ts)', () => {
  const pixelCmd = readFileSync(new URL('../scripts/_pixel_cmd.sh', import.meta.url), 'utf8');
  it('types a chat command with today\'s _pixel_cmd.sh and taps no world corner once the chat closed', async () => {
    const ph = recordingPhone();
    await runDeviceScript(pixelCmd, ['/say hi'], '/c/git/craftmatic/scripts/_pixel_cmd.sh', { readTool: () => undefined, screen: ph.screen });
    expect(ph.commands).toEqual(['/say hi']);
    expect(ph.events.map(e => e.route)).toEqual(['chat-button', 'chat', 'command']);
    expect(ph.screen.chatOpen).toBe(false);
  });
  it('the round-30k _pixel_cmd.sh (an unconditional Exit tap) sends that tap to the world', async () => {
    let old: string | undefined;
    try { old = execFileSync('git', ['show', '2a3ee69b:scripts/_pixel_cmd.sh'], { encoding: 'utf8' }); } catch { old = undefined; }
    if (!old) return expect.soft(old, 'git history for 2a3ee69b is not available here').toBeUndefined();
    const ph = recordingPhone();
    await runDeviceScript(old, ['/tp @s 1 2 3 180 10'], '/c/git/craftmatic/scripts/_pixel_cmd.sh', { readTool: () => undefined, screen: ph.screen });
    expect(ph.events.map(e => e.route)).toEqual(['chat-button', 'chat', 'command', 'world-tap']);
    expect(ph.events.at(-1)!.detail).toBe('world 45,39');
  });
  it('walk.sh holds the stick at full deflection for its seconds; an unknown construct throws', async () => {
    const walk = '#!/usr/bin/env bash\ndy=${2:--150}; dx=${3:-0}\nx=$((337+dx)); y=$((554+dy))\nadb shell "input motionevent DOWN 337 554; input motionevent MOVE $((337+dx/2)) $((554+dy/2)); input motionevent MOVE $x $y; sleep $1; input motionevent UP $x $y"\n';
    const ph = recordingPhone();
    await runDeviceScript(walk, ['2'], '/t/walk.sh', { readTool: () => undefined, screen: ph.screen });
    expect(ph.sticks.at(-2)).toEqual([1, -0]);
    expect(ph.sticks.at(-1)).toEqual([0, 0]);
    expect(ph.ticks()).toBe(40);
    await expect(runDeviceScript('curl http://x', [], '/t/x.sh', { readTool: () => undefined, screen: recordingPhone().screen })).rejects.toThrow(/cannot replay/);
  });
  it('moves a typed /tp from the device world onto the simulated anchor as float32 (quirk position-float32)', () => {
    expect(translateCommand('/tp @s 7511.7 -42.9 7153.3 180 10', { x: 7500, y: -60, z: 7150 }, { x: 7, y: -60, z: -13 })).toBe(`/tp @s ${Math.fround(7511.7) - 7500 + 7} ${Math.fround(-42.9) + 60 - 60} ${Math.fround(7153.3) - 7150 - 13} 180 10`);
    expect(translateCommand('/tp @s ~ ~1 ~', { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 })).toBe('/tp @s ~ ~1 ~');
  });
});

const PACK_30K = 'C:/git/craftmatic/output/device-round-2026-10-07k/packs-78e06246/76417-gringotts-wizarding-bank-collectors-edition.mcaddon';
const SESSION_30K = 'C:/git/craftmatic/output/engine-c-20261008/replay-30k-gate1.sh';
describe.skipIf(!existsSync(PACK_30K) || !existsSync(SESSION_30K))('the 30k Gate 1 throw-out, replayed from the round\'s own tools', () => {
  const replay = async (toolRev?: string) => {
    const readTool = (path: string): string | undefined => {
      const p = path.replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`);
      if (toolRev && /[\\/]craftmatic[\\/]scripts[\\/][^\\/]+$/.test(p)) return execFileSync('git', ['show', `${toolRev}:scripts/${p.split('/').pop()}`], { encoding: 'utf8' });
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    };
    const b = readFileSync(PACK_30K);
    const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, PACK_30K);
    const pack = readCraftmaticPack(addon)!;
    const device = { file: SESSION_30K, text: readFileSync(SESSION_30K, 'utf8'), args: [], readTool, pin: { x: 7500, y: -60, z: 7150 } };
    return runScenario(deviceScriptScenario(device), [addon], { handlers: { ...craftmaticHandlers(pack, addon), ...INPUT_HANDLERS, ...inputProbeHandlers(pack, addon, device) } });
  };
  it('the stray Exit tap of the round\'s _pixel_cmd.sh closes Gate 1 on the player and drops it 17 blocks where the Pixel landed; today\'s tool does not tap', async () => {
    let old: string | undefined;
    try { old = execFileSync('git', ['show', '2a3ee69b:scripts/_pixel_cmd.sh'], { encoding: 'utf8' }); } catch { old = undefined; }
    if (!old) return;
    const r = await replay('2a3ee69b');
    const effects = (r.state['deviceReplay'] as { effects: string[] }).effects;
    expect(effects.some(e => /Gate 1 CLOSED \(last touch: tap \(45,39\)/.test(e))).toBe(true);
    // The Pixel landed at 7513.33,-60,7151.67 = pin + (13.33, 0, 1.67).
    expect(effects.some(e => /FELL 17 blocks to \{"x":13\.33,"y":0,"z":1\.67\}/.test(e))).toBe(true);
    const now = await replay();
    expect((now.state['deviceReplay'] as { effects: string[] }).effects.some(e => /CLOSED|FELL/.test(e))).toBe(false);
  }, 60000);
});

describe('the per-tick cost model (quirks/cost.ts: PREDICTED)', () => {
  it('predicts the rounds\' own readings from the frozen fits', () => {
    expect(predictedMsPerTick('pixel', 770)).toBeCloseTo(14.2, 1); // Pixel 30j: 14.5 median at 770
    expect(predictedMsPerTick('saga', 770)).toBeCloseTo(14.8, 1); // Saga 30l: 13.4
    expect(predictedMsPerTick('saga', 1532)).toBeCloseTo(27.0, 1); // Saga 30k: 26-27 blocked
    const s = summarizeCost([{ type: 't', id: '1', t: 20, sweepChecks: 1600, msPerTick: 0 }, { type: 't', id: '1', t: 40, sweepChecks: 1600, msPerTick: 0 }]);
    expect(s.warnings.length).toBe(2);
    expect(s.predicted.saga.p95).toBeGreaterThan(TICK_BUDGET_WARN_MS);
    expect(summarizeCost([]).warnings).toEqual([]);
  });
  const logs = COST_CALIBRATION_LOGS.map(([d, rel]) => [d, `C:/git/craftmatic/output/${rel}`] as const);
  it.skipIf(!logs.every(([, f]) => existsSync(f)))('re-derives the frozen fits from the device content logs', () => {
    for (const device of ['pixel', 'saga'] as const) {
      const samples = logs.filter(([d]) => d === device).flatMap(([, f]) => parseCmvtSamples(readFileSync(f, 'utf8')));
      // One vehicle's tick is one sample even when two logs of a round repeat it.
      const unique = [...new Map(samples.map(s => [`${s.id}|${s.t}`, s])).values()];
      const fit = fitCost(unique);
      expect(fit.samples).toBe(COST_FITS[device].samples);
      expect(fit.interceptMs).toBeCloseTo(COST_FITS[device].interceptMs, 3);
      expect(fit.msPerCheck).toBeCloseTo(COST_FITS[device].msPerCheck, 5);
    }
  });
  it('counts the scripts\' facade calls per tick by script when asked', () => {
    const h = simHost({ script: "import { world, system } from '@minecraft/server';\nsystem.runInterval(() => { const d = world.getDimension('overworld'); d.getBlock({ x: 0, y: 0, z: 0 }); d.getBlock({ x: 1, y: 0, z: 0 }); d.getEntities({}); }, 1);\n", terrain: solidBelow(0) });
    // simHost builds its own Simulation: turn the counters on through its options object (the host reads it each call).
    (h.host.options as { costCounters?: boolean }).costCounters = true;
    h.run(3);
    const last = h.host.costLog.at(-1)!;
    expect(last.bySource['scripts/main.js']).toEqual({ getBlock: 2, getEntities: 1 });
  });
});
