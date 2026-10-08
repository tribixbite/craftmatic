/**
 * The client's eye (web/src/sim/client, package B): the camera state machine
 * against the device facts it encodes, the drawn-pose history, the render
 * rules in the rasteriser, and - where this machine has the round-30m packs -
 * the coaster camera ridden on both client profiles.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../web/src/sim/core/simulation.js';
import { SimEntity } from '../web/src/sim/entity/entity.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { createZip } from '../web/src/engine/zip-utils.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';
import { quirk, quirkValue } from '../web/src/sim/quirks/registry.js';
import { COASTER_RIDER_VIEW, coasterRuntimeConfig, coasterScript, type CoasterRoute, type CoasterRiderViewConfig } from '../web/src/engine/bedrock-coaster.js';
import { FREE_LOOK, cockpitEyeLead } from '../web/src/engine/vehicle-free-look.js';
import { PoseHistory } from '../web/src/sim/client/draw-lag.js';
import { attachClient, cameraFrame, ClientView, clientProfile, drawnCameraLead, easeSteadyLagTicks, sampleAnimation, TICK_SECONDS } from '../web/src/sim/client/camera.js';
import { CAMERA_MAX_TURN_DEG, cameraFrameDelta, clientInvariants, scriptMeansContinuity } from '../web/src/sim/client/invariants.js';
import { CameraTrace } from '../web/src/sim/client/steps.js';
import { rasterizeDetailed, type RasterQuad } from '../web/src/sim/render/rasterizer.js';
import { buildAddonAppearance, lodDistanceOf } from '../web/src/sim/adapters/craftmatic/appearance.js';
import { actorLodState } from '../web/src/sim/adapters/craftmatic/snapshot.js';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { packAppearance } from '../web/src/sim/adapters/craftmatic/drawn.js';
import { clientSteps, coasterCameraScenarios, craftmaticSeatCamera } from '../web/src/sim/adapters/craftmatic/client-steps.js';
import { coasterReplayWorld } from '../scripts/_coaster_replay.js';
import { COASTER_TEST_ORIGIN } from '../web/src/sim/adapters/craftmatic/coaster.js';

const enc = new TextEncoder();
const entityJson = (identifier: string, components: Record<string, unknown>): string =>
  JSON.stringify({ format_version: '1.26.30', 'minecraft:entity': { description: { identifier }, components } });

/** A tiny add-on with no scripts and one rideable box (the camera is driven from the test through the facade). */
async function miniAddon(entities: Record<string, string>): Promise<Uint8Array> {
  const manifest = { format_version: 2, header: { name: 'mini', uuid: '00000000-0000-0000-0000-00000000c001', version: [1, 0, 0] }, modules: [{ type: 'data', uuid: '00000000-0000-0000-0000-00000000c002', version: [1, 0, 0] }] };
  const files = [{ name: 'mini_BP/manifest.json', data: enc.encode(JSON.stringify(manifest)) }];
  for (const [p, t] of Object.entries(entities)) files.push({ name: `mini_BP/entities/${p}`, data: enc.encode(t) });
  return createZip(files);
}

const SEAT_BOX = { 'minecraft:collision_box': { width: 1, height: 1 }, 'minecraft:physics': { has_gravity: false, has_collision: false }, 'minecraft:rideable': { seat_count: 1, seats: [{ position: [0, 0.5, 0], lock_rider_rotation: 181 }] } };

/** A world with a player, the client attached, and the script-side camera facade of that player. */
async function world(profile: 'pixel' | 'saga' = 'pixel') {
  const sim = new Simulation();
  sim.loadAddon(await readAddon(await miniAddon({ 'seat.json': entityJson('x:seat', SEAT_BOX) }), 'client'));
  const player = sim.addPlayer('Viewer', { x: 0, y: 0, z: 0 });
  const client = attachClient(sim, player, profile);
  const camera = (sim.host.entity(player) as { camera: { setCamera: (p: string, o?: unknown) => void; playAnimation: (s: unknown, o?: unknown) => void; clear: () => void } }).camera;
  return { sim, player, client, camera };
}

describe('the client model: numbers and derivations', () => {
  it('a 0.1 s ease re-issued every tick settles two ticks behind its target; no ease, none', () => {
    expect(easeSteadyLagTicks(0.1)).toBe(2);
    expect(easeSteadyLagTicks(0)).toBe(0);
    expect(quirkValue('camera-ease-lag', 'ticks')).toBe(2);
  });

  it('the Pixel: the eased per-tick coaster camera at lag 1.5 and the animation at 3.5 both ride the drawn seat under ONE entity lag', () => {
    const pixel = clientProfile('pixel');
    expect(pixel.entityLagTicks).toBe(3.5);
    expect(pixel.easeFactor).toBe(1);
    expect(pixel.basis).toBe('measured');
    expect(drawnCameraLead(23, COASTER_RIDER_VIEW.tickLag, COASTER_RIDER_VIEW.ease, pixel)).toBeCloseTo(0, 9);
    expect(drawnCameraLead(23, COASTER_RIDER_VIEW.animLag, 0, pixel)).toBeCloseTo(0, 9);
  });

  it('the Saga: entity lag 4 with the ease not played reproduces BOTH cockpit brackets (30k led at camera lag 1.5, 30l trailed at 4) through the camera-first order; the Pixel\'s numbers do not; (6, ease 2) fits them alike and only the coaster tells the two apart', () => {
    const saga = clientProfile('saga'), pixel = clientProfile('pixel');
    expect(saga.basis).toBe('derived');
    expect(saga.entityLagTicks).toBe(4); expect(saga.easeFactor).toBe(0);
    // The packs' order: vehicle-camera.js reads the vehicle before vehicles.js moves it (+1 tick on the server's clock).
    const cameraFirst = 1;
    // Each device reading is +-0.3 block (quirk `cockpit-draw-lag`): the brackets widened by that.
    const brackets = [
      { speed: 19.2, lag: 1.5, lo: 1.5 - 0.3, hi: 2.5 + 0.3 }, // McLaren 30k, `r19-cmp.jpg`: over the hood
      { speed: 17.9, lag: 1.5, lo: 1.5 - 0.3, hi: 2.0 + 0.3 }, // X-wing 30k, `r20-strip.jpg`: up the nose
      { speed: 19.2, lag: 4, lo: -1.0 - 0.3, hi: -1.0 + 0.3 }, // McLaren 30l, `r17-mcl-ck-sheet.jpg` f007-f011: the picture at -1
      { speed: 17.9, lag: 4, lo: -1.5 - 0.3, hi: -1.0 + 0.3 }, // X-wing 30l, `r18-xw-ck-sheet.jpg`: inside the fuselage, -1..-1.5
    ];
    const fits = (client: { entityLagTicks: number; easeFactor: number }) => brackets.filter(b => { const l = drawnCameraLead(b.speed, b.lag + cameraFirst, FREE_LOOK.COCKPIT_EASE_SECONDS, client); return l >= b.lo && l <= b.hi; }).length;
    expect(fits(saga)).toBe(4);
    expect(fits(pixel)).toBe(0);
    // The brackets are blind to the split between the entity lag and the ease: (6, played) fits them as well.
    expect(fits({ entityLagTicks: 6, easeFactor: 1 })).toBe(4);
    // The registry's cockpit lag (3) is the Saga's 4 less the order's tick less the ease it plays: the quirk rows agree.
    expect(quirkValue('cockpit-draw-lag', 'ticks')).toBe(saga.entityLagTicks - cameraFirst - easeSteadyLagTicks(FREE_LOOK.COCKPIT_EASE_SECONDS, saga.easeFactor));
    // And `cockpitEyeLead` (the lag arithmetic the course judged by) is the same line for the shipped camera.
    expect(drawnCameraLead(19.2, FREE_LOOK.COCKPIT_TICK_LAG + cameraFirst, FREE_LOOK.COCKPIT_EASE_SECONDS, saga)).toBeCloseTo(cockpitEyeLead(19.2, FREE_LOOK.COCKPIT_TICK_LAG, quirkValue('cockpit-draw-lag', 'ticks')), 9);
  });

  it('the invariants\' per-frame turn cap is the coaster camera\'s own', () => {
    expect(CAMERA_MAX_TURN_DEG).toBe(COASTER_RIDER_VIEW.maxTurn);
  });

  it('the quirk rows the client reads are modelled or partial with their gap stated', () => {
    expect(quirk('client-entity-lag').simulated).toBe('modelled');
    expect(quirk('camera-roll-animation-only').simulated).toBe('partial');
    expect(quirk('box-uv-sub-unit-faces').simulated).toBe('modelled');
    expect(quirk('coplanar-hatching').simulated).toBe('partial');
    expect(quirk('coplanar-hatching').gap).toContain('winner');
    expect(quirk('camera-animation-cut').simulated).toBe('modelled');
  });
});

describe('the camera frame and the animation sampling', () => {
  it('yaw 0 pitch 0 looks +Z with +Y up; a continuous pitch of 180 looks back upside down; a roll of 180 turns the up over', () => {
    const level = cameraFrame(0, 0, 0);
    expect(level.dir.z).toBeCloseTo(1); expect(level.up.y).toBeCloseTo(1);
    const over = cameraFrame(0, 180, 0);
    expect(over.dir.z).toBeCloseTo(-1); expect(over.up.y).toBeCloseTo(-1);
    const rolled = cameraFrame(0, 0, 180);
    expect(rolled.dir.z).toBeCloseTo(1); expect(rolled.up.y).toBeCloseTo(-1);
    // Pitch 90 looks straight down.
    expect(cameraFrame(0, 90, 0).dir.y).toBeCloseTo(-1);
  });

  it('interpolates Euler keyframes LINEARLY (the yaw never the short way round, the pitch continuous past 90) and the eye by arc', () => {
    const anim = { points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 3 }], arcs: [0, 1, 4], progress: [{ alpha: 0, t: 0 }, { alpha: 1, t: 0.2 }], rotation: [{ x: 0, y: 170, z: 0, t: 0 }, { x: 360, y: -170, z: 0, t: 0.2 }] };
    const mid = sampleAnimation(anim, 0.1);
    // Half way: 2 blocks along the 4-block path (past the corner), the yaw through 0 (a 340-degree swing: the chart flip the Pixel drew as a spin), the pitch -180.
    expect(mid.eye).toEqual({ x: 1, y: 0, z: 1 });
    expect(mid.yaw).toBeCloseTo(0);
    expect(mid.pitch).toBeCloseTo(-180);
    expect(sampleAnimation(anim, 0).yaw).toBe(170);
    expect(sampleAnimation(anim, 1).eye).toEqual({ x: 1, y: 0, z: 3 }); // clamped past the end
  });
});

describe('the drawn poses', () => {
  it('reads an entity a fractional lag back, interpolated, the yaw the short way round', async () => {
    const sim = new Simulation();
    sim.loadAddon(await readAddon(await miniAddon({ 'seat.json': entityJson('x:seat', SEAT_BOX) }), 'poses'));
    sim.addPlayer('P', { x: 0, y: 0, z: 0 });
    const e = sim.engine.spawnEntity('x:seat', 'overworld', { x: 0, y: 5, z: 0 });
    const h = new PoseHistory();
    for (let t = 1; t <= 10; t++) { await sim.run(1); e.location = { x: t, y: 5, z: 0 }; e.rotation.y = t < 6 ? 170 : -170; h.record(sim.engine); }
    const now = sim.engine.tick;
    expect(h.at(e, now - 3.5)?.x).toBeCloseTo(10 - 3.5);
    expect(h.at(e, now - 100)?.x).toBe(1); // before the history: the oldest
    expect(h.at(e, now + 5)?.x).toBe(10); // after it: the newest
    // Between yaw 170 (tick 5) and -170 (tick 6): through 180, not through 0.
    const y = h.at(e, 5.5 + (now - 10))!.yaw;
    expect(Math.abs(Math.abs(y) - 180)).toBeLessThan(1e-9);
    expect(h.velocityAt(e, now - 3)!.x).toBeCloseTo(1);
  });

  it('draws a rider on its drawn mount\'s seat, the mount `entityLagTicks` behind the server', async () => {
    const { sim, player, client } = await world('pixel');
    const mount = sim.engine.spawnEntity('x:seat', 'overworld', { x: 0, y: 5, z: 0 });
    await sim.run(2);
    expect(mount.addRider(player, sim.engine.tick).ok).toBe(true);
    for (let t = 1; t <= 12; t++) { mount.location = { x: t, y: 5, z: 0 }; mount.placeRiders(); await sim.run(1); }
    const drawn = client.drawnPose(mount);
    expect(drawn.x).toBeCloseTo(12 - 3.5);
    const feet = client.drawnPose(player);
    // The seat (0, 0.5, 0) on the drawn mount, the player's feet eyeAboveSeat - eye height below the seat point.
    expect(feet.x).toBeCloseTo(12 - 3.5);
    expect(feet.y).toBeCloseTo(5 + 0.5 + quirkValue('rider-eye-above-seat', 'eyeAboveSeatBlocks') - 1.62);
    expect(client.drawnVelocity(player).x).toBeCloseTo(1, 6);
  });
});

describe('the camera state machine', () => {
  it('an eased per-tick camera chasing a target moving a block a tick settles exactly two blocks behind it', async () => {
    const { sim, player, client, camera } = await world();
    let x = 0;
    for (let t = 0; t < 30; t++) {
      camera.setCamera('minecraft:free', { location: { x, y: 3, z: 0 }, rotation: { x: 0, y: 90 }, easeOptions: { easeTime: 0.1, easeType: 'Linear' } });
      await sim.run(1);
      x += 1;
    }
    const d = client.drawn(player);
    expect(d.mode).toBe('free');
    // The last target was x = 29; the drawn eye trails it by the ease's steady lag of 2.
    expect(29 - d.eye.x).toBeCloseTo(2, 3);
    expect(d.yaw).toBeCloseTo(90);
  });

  it('a setCamera without an ease is drawn at its target on the same frame', async () => {
    const { sim, player, client, camera } = await world();
    camera.setCamera('minecraft:free', { location: { x: 7, y: 3, z: 0 }, rotation: { x: 10, y: 45 } });
    await sim.run(1);
    const d = client.drawn(player);
    expect(d.eye).toEqual({ x: 7, y: 3, z: 0 }); expect(d.pitch).toBe(10); expect(d.yaw).toBe(45);
  });

  it('an animation plays from the frame it is issued, is cut by a setCamera, and shows the own view when it runs out first', async () => {
    const { sim, player, client, camera } = await world();
    const anim = (total: number) => camera.playAnimation({ controlPoints: [{ x: 0, y: 10, z: 0 }, { x: 0, y: 10, z: 10 }] }, { totalTimeSeconds: total, animation: { progressKeyFrames: [{ alpha: 0, timeSeconds: 0 }, { alpha: 1, timeSeconds: total }], rotationKeyFrames: [{ rotation: { x: 0, y: 0, z: 0 }, timeSeconds: 0 }, { rotation: { x: 360, y: 0, z: 0 }, timeSeconds: total }] } });
    anim(0.5);
    await sim.run(1);
    expect(client.drawn(player).mode).toBe('animation');
    expect(client.drawn(player).eye.z).toBeCloseTo(0);
    await sim.run(5);
    const half = client.drawn(player);
    expect(half.eye.z).toBeCloseTo(5); expect(half.pitch).toBeCloseTo(-180); // half way: upside down, looking back
    // A setCamera takes over on its frame (the cut).
    camera.setCamera('minecraft:free', { location: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0 }, easeOptions: { easeTime: 0.1, easeType: 'Linear' } });
    await sim.run(1);
    expect(client.drawn(player).mode).toBe('free');
    // Left alone past its end, an animation reverts to the own view (the flash).
    anim(0.2);
    await sim.run(4);
    expect(client.drawn(player).mode).toBe('animation');
    await sim.run(2);
    expect(client.drawn(player).mode).toBe('own');
    expect(client.animationEndedTick(player)).toBe(sim.engine.tick);
    camera.clear();
    await sim.run(1);
    expect(client.drawn(player).mode).toBe('own');
    expect(client.requests(player).at(-1)?.kind).toBe('clear');
  });

  it('a continuity judgement: the script\'s own target decides whether a jump is a cut by design', () => {
    const base = { eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, ...cameraFrame(0, 0, 0), tick: 1, mode: 'free' as const };
    const near = { ...base, eye: { x: 0.5, y: 0, z: 0 } };
    const far = { ...base, eye: { x: 5, y: 0, z: 0 } };
    expect(scriptMeansContinuity(base, near)).toBe(true);
    expect(scriptMeansContinuity(base, far)).toBe(false);
    expect(scriptMeansContinuity(base, { ...base, ...cameraFrame(90, 0, 0) })).toBe(false);
    expect(cameraFrameDelta({ camera: base, seat: { x: 0, y: 0, z: 0 } }, { camera: far, seat: { x: 5, y: 0, z: 0 } }).jumpBlocks).toBeCloseTo(0);
  });
});

describe('the rasteriser\'s device rules', () => {
  const quad = (y: number, key: string, owner: number, x0 = 0, x1 = 16, z0 = 0, z1 = 16): RasterQuad => ({
    // An upward-facing square at height y (model units), seen from above.
    corners: [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], normal: [0, 1, 0], key, owner,
  });
  // Straight down from two blocks over a one-block square: it covers ~17 x 17 of the 40 x 40 pixels.
  const cam = { eye: [0.5, 2, 0.5] as [number, number, number], at: [0.5, 0, 0.5] as [number, number, number], fovDeg: 60, width: 40, height: 40 };
  const paint = (q: RasterQuad) => ({ rgb: [q.key === 'red' ? 1 : 0, q.key === 'green' ? 1 : 0, 0] as [number, number, number], alpha: 1 });
  const count = (a: Uint8Array): number => a.reduce((n, v) => n + (v ? 1 : 0), 0);

  it('flags two coplanar faces of different colour that both reach a pixel as hatch, by actor', () => {
    const same = rasterizeDetailed([quad(0, 'red', 0), quad(0, 'green', 0)], paint, cam);
    expect(count(same.hatch)).toBeGreaterThan(100);
    expect(same.hatch.every(v => v === 0 || v === 1)).toBe(true);
    const cross = rasterizeDetailed([quad(0, 'red', 0), quad(0, 'green', 1)], paint, cam);
    expect(cross.hatch.some(v => v === 2)).toBe(true);
  });

  it('does not flag the same colour, faces separated by the export\'s 0.15 units, faces that only abut, or a fight hidden behind a nearer face', () => {
    expect(count(rasterizeDetailed([quad(0, 'red', 0), quad(0, 'red', 1)], paint, cam).hatch)).toBe(0);
    expect(count(rasterizeDetailed([quad(0, 'red', 0), quad(0.15, 'green', 0)], paint, cam).hatch)).toBe(0);
    expect(count(rasterizeDetailed([quad(0, 'red', 0, 0, 8), quad(0, 'green', 0, 8, 16)], paint, cam).hatch)).toBe(0);
    expect(count(rasterizeDetailed([quad(0, 'red', 0), quad(0, 'green', 0), quad(8, 'red', 2)], paint, cam).hatch)).toBe(0);
  });

  it('leaves a dropped face out of the picture and counts the pixels it would have covered', () => {
    const res = rasterizeDetailed([quad(0, 'red', 0), quad(4, 'green', 0)], paint, cam, { dropped: i => i === 1 });
    expect(count(res.dropped)).toBeGreaterThan(100);
    // Behind the dropped green face the red one shows: every pixel it would have covered that the red face reaches is
    // red, none green (the nearer green face projects a little larger: its rim shows the sky, as on the device).
    let covered = 0;
    for (let k = 0; k < res.width * res.height; k++) if (res.dropped[k] && Number.isFinite(res.depth[k])) { covered++; expect(res.rgb[k * 3]).toBeGreaterThan(100); expect(res.rgb[k * 3 + 1]).toBe(0); }
    expect(covered).toBeGreaterThan(100);
    expect(count(res.translucent)).toBe(0);
    const glass = rasterizeDetailed([quad(0, 'red', 0), quad(4, 'glass', 0)], q => ({ rgb: [0, 0, 1], alpha: q.key === 'glass' ? 0.4 : 1 }), cam);
    expect(count(glass.translucent)).toBeGreaterThan(100);
  });
});

describe('the LOD switch and the cull from the camera', () => {
  it('reads a controller\'s switch distance either side of it', () => {
    expect(lodDistanceOf({ geometry: 'Array.g[query.distance_from_camera > 54]' })).toBe(54);
    expect(lodDistanceOf({ geometry: 'Array.g[query.distance_from_camera <= 54]' })).toBe(54);
    expect(lodDistanceOf({ geometry: 'Geometry.mesh_0' })).toBeUndefined();
  });

  it('an appearance carries each group\'s switch distance and whether it is the hull', () => {
    const sources = new Map<string, string>([
      ['rp/entity/x.entity.json', JSON.stringify({ 'minecraft:client_entity': { description: { identifier: 'x:lod', geometry: { mesh_0: 'geometry.x.mesh_0', hull: 'geometry.x.hull' }, textures: { t: 'textures/entity/craftmatic_swatch_4' }, render_controllers: ['controller.render.x.full', 'controller.render.x.hull'] } } })],
      ['rp/render_controllers/x.render_controllers.json', JSON.stringify({ render_controllers: {
        'controller.render.x.full': { arrays: { geometries: { 'Array.g': ['Geometry.mesh_0', 'Geometry.empty'] } }, geometry: 'Array.g[query.distance_from_camera > 54]', textures: ['Texture.t'] },
        'controller.render.x.hull': { arrays: { geometries: { 'Array.g': ['Geometry.hull', 'Geometry.empty'] } }, geometry: 'Array.g[query.distance_from_camera <= 54]', textures: ['Texture.t'] },
      } })],
      ['rp/models/entity/x.geo.json', JSON.stringify({ 'minecraft:geometry': [
        { description: { identifier: 'geometry.x.mesh_0' }, bones: [{ name: 'b', pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [16, 16, 16] }] }] },
        { description: { identifier: 'geometry.x.hull' }, bones: [{ name: 'b', pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [16, 16, 16] }] }] },
      ] })],
    ]);
    const app = buildAddonAppearance(sources);
    const entry = app.byType.get('x:lod')!;
    expect(entry.groups.map(g => [g.lodDistance, !!g.far])).toEqual([[54, false], [54, true]]);
    expect(actorLodState(entry, 70, 30, 30, true).state).toBe('full');
    expect(actorLodState(entry, 70, 60, 60, true).state).toBe('hull');
    expect(actorLodState(entry, 70, 60, 60, false).state).toBe('full');
    expect(actorLodState(entry, 70, 75, 75, true).state).toBe('gone');
    // A tall root: culled in 3-D, drawn horizontally - reported, the 3-D verdict taken.
    const tall = actorLodState(entry, 70, 75, 50, true);
    expect(tall.state).toBe('gone'); expect(tall.cullDisagree).toBe(true);
  });
});

// ─── The coaster camera on a synthetic loop course (no corpus) ───

/** A 60-block station straight, one slightly helical vertical loop (radius 4), a 30-block exit straight: the coaster tests' `loopCourse`. */
function loopCourse(): CoasterRoute {
  const points: Array<[number, number, number]> = [];
  for (let z = 0; z <= 60 + 1e-9; z += 0.25) points.push([0, 0, z]);
  const r = 4, n = 120;
  for (let k = 1; k <= n; k++) { const a = k / n * 2 * Math.PI; points.push([1.5 * k / n, r - r * Math.cos(a), 60 + r * Math.sin(a)]); }
  for (let z = 60.25; z <= 90 + 1e-9; z += 0.25) points.push([1.5, 0, z]);
  return { label: 'Loop course', points, closed: false, maxSegmentLength: 0.5 };
}

/**
 * Ride the loop course on a client profile with the shipped coaster runtime (`coasterScript`) and an optional
 * camera override; the rider's head follows the car as the device reports it. Returns the drawn camera's trace.
 */
function rideLoop(profile: 'pixel' | 'saga', camera: Partial<CoasterRiderViewConfig> = {}, ticks = 700) {
  const config = coasterRuntimeConfig('craftmatic:test_cart', [loopCourse()]);
  config.types['craftmatic:test_cart']!.seat = [0, 0.35, 0];
  config.camera = { ...config.camera!, ...camera };
  const { h, entities, start } = coasterReplayWorld(coasterScript(config));
  const car = entities[0]!;
  const riderSim = h.addPlayer('rider0', { x: COASTER_TEST_ORIGIN.x, y: 0, z: COASTER_TEST_ORIGIN.z });
  const client = attachClient(h.sim, riderSim, profile);
  const rider = h.api(riderSim);
  // The head follows the car (quirk `rider-yaw-lag` is the riders system's; here the look is the car's).
  rider.getRotation = () => ({ x: 0, y: car.sim.rotation.y });
  start();
  h.run(1);
  h.seat(riderSim, car.sim);
  const trace = new CameraTrace(client, riderSim);
  for (let t = 0; t < ticks; t++) { h.run(1); trace.sample(); }
  return { trace, client, car: car.sim, rider: riderSim };
}

describe('the coaster camera drawn on each client (synthetic loop course)', () => {
  it('on the Pixel both cameras ride the drawn seat and the hand-back is continuous: no own view, the eye within half a block along the heading, and only the hand-back\'s own transient', () => {
    const { trace } = rideLoop('pixel');
    const s = trace.summary(2);
    expect(s.animations).toBeGreaterThanOrEqual(1);
    expect(s.ownFrames).toBe(0);
    // The eased camera sits on the seat (lag 1.5 + ease 2 = 3.5) and so does the animation (3.5).
    const steady = trace.rows.filter(r => r.mode === 'free' && (r.speed ?? 0) > 2 && r.lead !== undefined && r.tick - trace.lastHandbackTick > 10);
    expect(steady.length).toBeGreaterThan(100);
    for (const r of steady) expect(Math.abs(r.lead!), `tick ${r.tick}`).toBeLessThan(0.5);
    for (const r of trace.rows.filter(r => r.mode === 'animation' && (r.speed ?? 0) > 2)) expect(Math.abs(r.lead!), `anim tick ${r.tick}`).toBeLessThan(0.75);
  }, 60_000);

  it('the hand-back blend (3.5 -> 1.5 over 4 ticks) drops the DRAWN camera behind the seat for a few frames even on the Pixel: the eased camera restarts from the un-eased hand-back pose', () => {
    // The shipped `handbackBlend` (4): the targets run from lag 3.5 to 1.5 while the ease adds its own 2, so the drawn
    // camera falls back ~1.25 ticks (0.3 block at the loop exit's ~5 blocks/s here, ~1.4 at a coaster's 23) and
    // catches up over ~6 ticks. An ease-aware hand-back - the first eased target one tick AHEAD of the steady lag
    // (0.5, then 1.5) - keeps the drawn camera on the seat. NOT a pack change here (the runtime is not package B's);
    // the measurement that says what to change (TODO(handback-ease), bedrock-coaster.ts `HANDBACK_BLEND`).
    const shipped = rideLoop('pixel');
    const after = (t: { trace: CameraTrace }) => t.trace.rows.filter(r => r.tick > t.trace.lastHandbackTick && r.tick <= t.trace.lastHandbackTick + 8 && r.lead !== undefined).map(r => r.lead!);
    const worstShipped = Math.max(...after(shipped).map(Math.abs));
    const noBlend = rideLoop('pixel', { handbackBlend: 1 });
    const worstNoBlend = Math.max(...after(noBlend).map(Math.abs));
    expect(after(shipped).length).toBeGreaterThan(0);
    // The blend's transient is worse than a plain hand-back's; both are behind the seat (negative lead).
    expect(Math.min(...after(shipped))).toBeLessThan(0);
    expect(worstShipped).toBeGreaterThan(worstNoBlend * 0.9);
  }, 60_000);

  it('on the Saga (entity lag 4, the ease not played) the per-tick camera rides 2.5 ticks AHEAD of the drawn car and the animation 0.5: a 2-tick cut at the animation\'s start (the 30g entry jump) and the blend\'s walk forward at the hand-back (the exit swing)', () => {
    const { trace, client } = rideLoop('saga');
    expect(client.profile.entityLagTicks).toBe(4);
    const steady = trace.rows.filter(r => r.mode === 'free' && (r.speed ?? 0) > 2 && r.lead !== undefined && r.tick - trace.lastHandbackTick > 10);
    const speedAt = (r: { speed?: number }) => (r.speed ?? 0) * TICK_SECONDS;
    const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
    // Lead = speed x (4 - 1.5 - 0) ticks = 2.5 ticks of motion ahead; the animation (no ease) 4 - 3.5 = 0.5 ahead.
    expect(steady.length).toBeGreaterThan(100);
    expect(median(steady.map(r => r.lead! / speedAt(r)))).toBeCloseTo(2.5, 1);
    expect(steady.filter(r => Math.abs(r.lead! / speedAt(r) - 2.5) < 0.75).length / steady.length).toBeGreaterThan(0.8);
    const anim = trace.rows.filter(r => r.mode === 'animation' && (r.speed ?? 0) > 2);
    expect(anim.length).toBeGreaterThan(10);
    expect(median(anim.map(r => r.lead! / speedAt(r)))).toBeCloseTo(0.5, 0);
    // The switch into the animation is the device's one-frame jump: 2 ticks of motion back in one frame.
    const starts = trace.rows.filter((r, i) => r.mode === 'animation' && i > 0 && trace.rows[i - 1]!.mode === 'free');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    for (const r of starts) expect(r.jumpBlocks / speedAt(r), `tick ${r.tick}`).toBeGreaterThan(1.5);
    // And the Pixel shows none of it: both cameras on the seat, no jump at the start.
    const pixel = rideLoop('pixel');
    const pixelStarts = pixel.trace.rows.filter((r, i) => r.mode === 'animation' && i > 0 && pixel.trace.rows[i - 1]!.mode === 'free');
    for (const r of pixelStarts) expect(r.jumpBlocks, `pixel tick ${r.tick}`).toBeLessThan(0.5);
  }, 60_000);
});

// ─── The round-30m packs, when this machine has them ───

const PACKS = 'C:/git/craftmatic/output/device-round-2026-10-08m/packs-6a8c7121';
const havePacks = existsSync(`${PACKS}/10303-loop-coaster.mcaddon`);

describe.skipIf(!havePacks)('the coaster camera on the round-30m 10303 (corpus)', () => {
  const load = async () => { const b = readFileSync(`${PACKS}/10303-loop-coaster.mcaddon`); return readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, '10303'); };
  const ride = async (profile: 'pixel' | 'saga') => {
    const addon = await load();
    const pack = readCraftmaticPack(addon)!;
    const [scenario] = coasterCameraScenarios(pack, profile, 1);
    const steps = scenario!.steps.map(s => (s.kind === 'rideCoasterCamera' ? { ...s, frames: false, maxTicks: 1500 } : s));
    return runScenario({ ...scenario!, steps }, [addon], { handlers: { ...craftmaticHandlers(pack, addon), ...clientSteps(pack, packAppearance(addon), {}, profile) }, invariants: clientInvariants({ seatCamera: craftmaticSeatCamera() }), prepare: (sim, player) => { attachClient(sim, player, profile); } });
  };

  /** The 30m coaster cars' seat, Bedrock frame (`position` of the rideable): z 0.338 toward the nose. */
  const SEAT_Z = 0.338;

  it('rides on the Pixel client with no own-view flash and no continuity fault; the one seat offset it finds is the pack\'s: the camera eye 2 x the seat\'s z behind the drawn seat on level track', async () => {
    const r = await ride('pixel');
    const cc = r.state['coasterCamera'] as { ridden: number; animations: number; ownFrames: number; worstLead: number } | undefined;
    expect(cc, r.steps.filter(s => !s.ok).map(s => s.error).join('; ')).toBeDefined();
    expect(cc!.ridden).toBeGreaterThan(200);
    expect(cc!.animations).toBeGreaterThanOrEqual(1);
    expect(r.violations.filter(v => v.invariant === 'no-own-view-flash')).toHaveLength(0);
    expect(r.violations.filter(v => v.invariant === 'camera-continuous')).toHaveLength(0);
    // MEASURED 2026-10-08 on the 30m 10303: the coaster runtime reads the car's seat with +Z BACK (its `flat` seat,
    // bedrock-coaster.ts `carPose`) while the rideable component carries the same vector, which Bedrock reads with
    // +Z the NOSE (quirk `seat-z-is-nose`): the rider's drawn seat sits 2 x 0.338 = 0.676 blocks ahead of the camera's
    // eye on level track (0 on the vertical drop, where the heading has no horizontal part). The invariant reports it
    // as a seat offset of up to that size, never a lag (it does not grow with speed): a pack-side finding for the
    // coaster's seat frame (`renderSeatToEntity` is applied to vehicle seats, not the coaster car's), not the client's.
    const seat = r.violations.filter(v => v.invariant === 'camera-on-own-seat');
    for (const v of seat) {
      const lead = Number((v.evidence as { lead: number }).lead);
      expect(lead, v.message).toBeLessThan(0);
      expect(Math.abs(lead), v.message).toBeLessThanOrEqual(2 * SEAT_Z + 0.15);
    }
    const trace = r.state['cameraTrace'] as Array<{ mode: string; lead?: number; speed?: number; pitch: number }>;
    // In the straight vertical drop (pitch ~90, the fastest track) the drawn camera rides the drawn seat exactly.
    const drop = trace.filter(x => x.mode === 'free' && Math.abs(x.pitch) > 85 && (x.speed ?? 0) > 15 && x.lead !== undefined);
    expect(drop.length).toBeGreaterThan(5);
    for (const x of drop) expect(Math.abs(x.lead!)).toBeLessThan(0.15);
  }, 120_000);

  it('predicts the Saga\'s seat lead (2.5 ticks ahead on the per-tick camera at speed) that the Pixel never showed', async () => {
    const r = await ride('saga');
    const cc = r.state['coasterCamera'] as { worstLead: number } | undefined;
    expect(cc).toBeDefined();
    const trace = r.state['cameraTrace'] as Array<{ mode: string; lead?: number; speed?: number; pitch: number }>;
    const drop = trace.filter(x => x.mode === 'free' && Math.abs(x.pitch) > 85 && (x.speed ?? 0) > 15 && x.lead !== undefined);
    expect(drop.length).toBeGreaterThan(5);
    // 2.5 ticks of motion ahead at 20+ blocks/s: more than a block, the course's slack several times over.
    for (const x of drop) expect(x.lead! / (x.speed! * TICK_SECONDS)).toBeCloseTo(2.5, 0);
    expect(r.violations.some(v => v.invariant === 'camera-on-own-seat' && Number((v.evidence as { lead: number }).lead) > 0.5)).toBe(true);
  }, 120_000);
});

/** A SimEntity is importable (the facade path the client wraps is the host's): the type is used by the world helper. */
void SimEntity;
