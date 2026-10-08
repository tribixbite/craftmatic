/**
 * The craftmatic steps that look through the CLIENT's eye (web/src/sim/client):
 *
 *   snapshot           the picture the phone shows from the drawn camera with the device rules
 *                      (replaces child-play's server-eye `snapshot` when the CLI asks for the
 *                      rules): box-UV faces dropped (`uvFloor`), coplanar fights flagged as hatch
 *                      pixels, the LOD hull by the drawn camera's distance, the cull in 3-D with
 *                      the horizontal reading beside it; judges `no-visible-hatch-near` (a hatch
 *                      within 8 blocks inside ONE actor; a cross-actor pair is noted, as
 *                      `_render_fault_audit.ts` counts them) and `no-dropped-face-in-view`;
 *   rideCoasterCamera  board the nearest coaster car by a hold and ride `laps` laps with the
 *                      client invariants running (`camera-continuous`, `camera-on-own-seat`,
 *                      `no-own-view-flash`), a per-tick trace and frames through every inversion
 *                      (COAST-06's device findings as assertions);
 *   cockpitEye         the vehicle course's cockpit check judged from the DRAWN pose: the vehicle
 *                      at full stick in the cockpit view (hotbar slot 9), the drawn camera against
 *                      the cockpit eye on the drawn vehicle (quirk `cockpit-draw-lag`, the 30k /
 *                      30l brackets re-derived per client profile and per candidate lag);
 *   walkAway           snapshots at distances from the placed model, each entity's full / hull /
 *                      gone state from the drawn camera (`lod-switch-under-cull`: a hull whose
 *                      switch is not under its actor's cull is never seen; COL-03 at 200 %).
 *
 * `coasterCameraScenarios` builds the `coaster-camera` scenario of a pack; `scripts/sim.ts` runs
 * it once per client profile (Pixel 3.5 ticks, Saga ~6: quirk `client-entity-lag`).
 */

import type { AnyStep, Scenario, Step, StepContext, StepHandler } from '../../scenario/types.js';
import type { SimEntity } from '../../entity/entity.js';
import type { Vec3 } from '../../core/vec.js';
import { rotateYaw } from '../../core/vec.js';
import { CORE_HANDLERS } from '../../scenario/runner.js';
import { teleport } from '../../script-host/facades.js';
import { lookAt } from '../../input/touch.js';
import { FLAT_GROUND_Y } from '../../world/voxel-world.js';
import { packText } from '../../pack/pack.js';
import { extractJsonAfter } from '../../pack/script-config.js';
import { PLAYER_EYE_HEIGHT } from '../../physics/body.js';
import type { UvFloorModel } from '../../../engine/figure-holes.js';
import { entityRenderCullBlocks } from '../../../engine/bedrock-lod-hull.js';
import { attachClient, ClientView, drawnCameraLead, type ClientProfileName } from '../../client/camera.js';
import { CameraTrace } from '../../client/steps.js';
import { SEAT_EYE_SLACK, SEAT_SPEED_FLOOR, type ClientInvariantOptions } from '../../client/invariants.js';
import type { InvariantContext } from '../../scenario/invariants.js';
import type { AddonAppearance } from './appearance.js';
import type { CraftmaticPack } from './pack-facts.js';
import { clientSnapshot, NEAR_BLOCKS, type ClientSnapshotResult, type SnapshotEntity } from './snapshot.js';
import { placedOf } from './play.js';
import { CRAFTMATIC_ALLOWED_LINES, CRAFTMATIC_YIELDING_LINES, type Snapshot } from './child-play.js';

/** The family every coaster car carries (`COASTER_FAMILY` of bedrock-coaster.ts; the adapter reads the pack's JSON, not the runtime). */
export const COASTER_CAR_FAMILY = 'craftmatic_coaster';
/** The family every scripted vehicle carries. */
export const SCRIPTED_VEHICLE_FAMILY = 'craftmatic_vehicle';
/** The hotbar index of the cockpit view (slot 9). */
export const COCKPIT_SLOT = 8;
/** Ticks the cockpit check drives at full stick (the course's `COCKPIT_DRIVE_TICKS`). */
const COCKPIT_DRIVE_TICKS = 120;
/** A frame's size (small: a ride keeps a few hundred). */
const FRAME_SIZE = { width: 320, height: 180 };

/** What the client steps are asked to do. */
export interface ClientStepOptions {
  /** The box-UV floor rule for pictures (default `v`, the device's). */
  uvFloor?: UvFloorModel;
  /** Switch LOD hulls by the drawn camera (default true). */
  lod?: boolean;
  /** Paint hatch pixels into the pictures (the count is always taken). */
  paintHatch?: boolean;
  /** Keep frames (pictures) along a ride or a drive, in `state.frames`. */
  frames?: boolean;
  /** Candidate cockpit camera lags to re-derive the device brackets for (default 1.5, 3, 4: the two rounds' and the shipped one). */
  lags?: number[];
}

/** A picture a client step took: child-play's `Snapshot` plus what it measured and the camera it was drawn from. */
export interface ClientShot extends Snapshot { metrics: ClientSnapshotResult['metrics']; camera: { mode: string; eye: Vec3; yaw: number; pitch: number; roll: number } }

/** The craftmatic seat-camera rule for `camera-on-own-seat`: a coaster car, or a scripted vehicle in the cockpit view. */
export function craftmaticSeatCamera(): NonNullable<ClientInvariantOptions['seatCamera']> {
  return (player: SimEntity, mount: SimEntity, ctx: InvariantContext) => {
    const families = mount.families();
    if (families.includes(COASTER_CAR_FAMILY)) return true;
    const client = ClientView.of(ctx.engine);
    return families.includes(SCRIPTED_VEHICLE_FAMILY) && !!client && client.sim.host.playerState(player).selectedSlot === COCKPIT_SLOT;
  };
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const pt = (p: Vec3): Vec3 => ({ x: r2(p.x), y: r2(p.y), z: r2(p.z) });

/** Whether a pack has coaster cars (an entity declaring the coaster family). */
export function hasCoasterCars(pack: CraftmaticPack): boolean {
  for (const [path, data] of pack.pack.files) if (path.startsWith('entities/') && new TextDecoder().decode(data).includes(`"${COASTER_CAR_FAMILY}"`)) return true;
  return false;
}

/** The step handlers. `profile` names the client whose numbers the steps report (the client itself is attached by `prepare`, or here on first use). */
export function clientSteps(pack: CraftmaticPack, appearance: AddonAppearance, options: ClientStepOptions = {}, profile: ClientProfileName = 'pixel'): Record<string, StepHandler> {
  const client = (ctx: StepContext): ClientView => ClientView.of(ctx.sim.engine) ?? attachClient(ctx.sim, ctx.player, profile);
  const shotOf = (ctx: StepContext, name: string, size = { width: 480, height: 270 }): ClientShot => {
    const r = clientSnapshot(ctx.sim.engine, appearance, ctx.player, client(ctx), { ...size, uvFloor: options.uvFloor ?? 'v', lod: options.lod ?? true, paintHatch: !!options.paintHatch });
    return { name, width: r.width, height: r.height, rgb: r.rgb, metrics: r.metrics, camera: { mode: r.camera.mode, eye: pt(r.camera.eye), yaw: r2(r.camera.yaw), pitch: r2(r.camera.pitch), roll: r2(r.camera.roll) } };
  };
  const keep = (ctx: StepContext, key: 'snapshots' | 'frames', shot: ClientShot): void => { ctx.state[key] = [...((ctx.state[key] as ClientShot[] | undefined) ?? []), shot]; };
  /** Judge a picture's near hatch and dropped faces. */
  const judge = (ctx: StepContext, shot: ClientShot): void => {
    const m = shot.metrics;
    if (m.hatchNear.sameActor > 0) ctx.violate({ invariant: 'no-visible-hatch-near', message: `${shot.name}: ${m.hatchNear.sameActor} hatch pixel(s) within ${NEAR_BLOCKS} blocks inside one actor (${m.hatchPixels} in the picture, ${(100 * m.hatchShareOfImage).toFixed(2)} percent of its drawn pixels)`, evidence: { shot: shot.name, hatchNear: m.hatchNear, hatchPixels: m.hatchPixels, camera: shot.camera } });
    if (m.hatchNear.crossActor > 0) ctx.note(`${shot.name}: ${m.hatchNear.crossActor} cross-actor hatch pixel(s) within ${NEAR_BLOCKS} blocks (two placed actors sharing a plane: the placement's, reported as _render_fault_audit.ts counts them)`);
    if (m.droppedNearPixels > 0) ctx.violate({ invariant: 'no-dropped-face-in-view', message: `${shot.name}: ${m.droppedNearPixels} pixel(s) within ${NEAR_BLOCKS} blocks show a box-UV face the device drops (${(100 * m.droppedNearShare).toFixed(2)} percent of the near silhouette)`, evidence: { shot: shot.name, droppedNearPixels: m.droppedNearPixels, droppedNearShare: m.droppedNearShare, camera: shot.camera } });
    const disagree = m.entities.filter(e => e.cullDisagree);
    if (disagree.length) ctx.note(`${shot.name}: ${disagree.length} actor(s) culled by the 3-D camera-to-root distance but not horizontally, or the reverse (TODO(cull), unsettled): ${disagree.slice(0, 4).map(e => `${e.typeId.replace(/^craftmatic:/, '')} 3-D ${r2(e.dist3d)} / horizontal ${r2(e.distHorizontal)} vs cull ${r2(e.cullBlocks)}`).join('; ')}`);
  };
  /** A scripted vehicle's camera config in `scripts/vehicle-camera.js`: the cockpit eye and the runtime's cockpit lag. */
  const cameraCfg = (typeId: string): { eye?: [number, number, number]; cockpitLag: number; cameraFirst: boolean } | undefined => {
    const text = packText(pack.pack, 'scripts/vehicle-camera.js');
    const at = text ? text.indexOf('({"vehicles":') : -1;
    if (!text || at < 0) return undefined;
    const cfg = extractJsonAfter(text.slice(at), '(') as { vehicles?: Array<{ typeId?: string; eye?: [number, number, number] }>; freeLook?: { COCKPIT_TICK_LAG?: number } } | undefined;
    const v = cfg?.vehicles?.find(c => c.typeId === typeId);
    if (!v) return undefined;
    // The camera runtime reads the vehicle's pose when IT runs: imported before vehicles.js in main.js it reads the
    // pose before this tick's move (one more tick of lag on the server's clock; the course's `cameraFirst`).
    const main = packText(pack.pack, 'scripts/main.js') ?? '';
    const camAt = main.indexOf('vehicle-camera.js'), moveAt = main.indexOf('vehicles.js');
    return { ...(v.eye ? { eye: v.eye } : {}), cockpitLag: Number(cfg?.freeLook?.COCKPIT_TICK_LAG ?? 3), cameraFirst: camAt >= 0 && moveAt >= 0 && camAt < moveAt };
  };

  return {
    /** The picture the phone shows: from where the child placed, looking at the model's centre (or from here: `{ here: true }`); `{ name, width, height }`. */
    async snapshot(step: AnyStep, ctx: StepContext) {
      const placed = placedOf(ctx);
      if (!step['here']) {
        const start = ctx.state['craftmatic.start'] as Vec3 | undefined;
        if (start) teleport(ctx.sim.host, ctx.player, start);
        lookAt(ctx.player, { x: (placed.from.x + placed.to.x + 1) / 2, y: (placed.from.y + placed.to.y) / 2, z: (placed.from.z + placed.to.z + 1) / 2 });
        await ctx.run(1);
      }
      const shot = shotOf(ctx, String(step['name'] ?? 'shot'), { width: Number(step['width'] ?? 480), height: Number(step['height'] ?? 270) });
      keep(ctx, 'snapshots', shot);
      judge(ctx, shot);
      const m = shot.metrics;
      ctx.note(`${shot.name} (client ${client(ctx).profile.name}): ${m.drawnPixels} drawn px, hatch ${m.hatchPixels} (near same-actor ${m.hatchNear.sameActor}, cross ${m.hatchNear.crossActor}), dropped near ${m.droppedNearPixels}, translucent ${m.translucentPixels}; actors full ${m.entities.filter(e => e.state === 'full').length} / hull ${m.entities.filter(e => e.state === 'hull').length} / gone ${m.entities.filter(e => e.state === 'gone').length}`);
    },

    /**
     * Board the nearest coaster car (a hold: the vanilla rideable mounts on the interact) and ride `laps` laps
     * (default 3) with the client invariants running; `{ laps, maxTicks, frames }`. A lap is a return to within 3
     * blocks of the boarding point after the car has been 15 blocks away.
     */
    async rideCoasterCamera(step: AnyStep, ctx: StepContext) {
      const laps = Number(step['laps'] ?? 3), maxTicks = Number(step['maxTicks'] ?? 9000);
      const frames = step['frames'] !== undefined ? !!step['frames'] : !!options.frames;
      const sel = { family: COASTER_CAR_FAMILY, where: (e: SimEntity) => !!e.rideable() && !e.riderList().length, label: 'a coaster car' };
      const car = ctx.find(sel);
      if (!car) { ctx.note('no empty coaster car to board'); return; }
      await CORE_HANDLERS['hold']!({ kind: 'hold', target: sel, label: 'board the coaster' }, ctx);
      if (ctx.player.ridingOn !== car) { ctx.violate({ invariant: 'tap-boards-ride', message: `a hold on ${car.typeId} did not seat the child`, evidence: { car: car.typeId, at: pt(car.location) } }); return; }
      const view = client(ctx);
      const trace = new CameraTrace(view, ctx.player);
      const start = { ...car.location };
      let away = false, lapsDone = 0, t = 0;
      for (; t < maxTicks && ctx.player.ridingOn === car && lapsDone < laps; t++) {
        await ctx.run(1);
        const row = trace.sample();
        const d = Math.hypot(car.location.x - start.x, car.location.y - start.y, car.location.z - start.z);
        if (d > 15) away = true;
        else if (away && d < 3) { away = false; lapsDone++; ctx.note(`lap ${lapsDone} at tick ${ctx.sim.engine.tick}`); }
        if (frames && trace.interesting(row)) keep(ctx, 'frames', shotOf(ctx, `lap${lapsDone + 1}-t${String(t).padStart(5, '0')}-${row.mode}`, FRAME_SIZE));
      }
      const s = trace.summary(SEAT_SPEED_FLOOR);
      const out = { profile: view.profile.name, entityLagTicks: view.profile.entityLagTicks, laps: lapsDone, ...s, ridden: t, car: car.typeId, stillRiding: ctx.player.ridingOn === car };
      ctx.state['coasterCamera'] = out;
      ctx.state['cameraTrace'] = trace.rows.map(r => ({ ...r, ...(r.lead !== undefined ? { lead: r2(r.lead) } : {}), ...(r.speed !== undefined ? { speed: r2(r.speed) } : {}), turnDeg: r2(r.turnDeg), jumpBlocks: r2(r.jumpBlocks), pitch: r2(r.pitch), yaw: r2(r.yaw) }));
      ctx.note(`coaster camera (client ${view.profile.name}, entity lag ${view.profile.entityLagTicks}): ${lapsDone} lap(s) in ${t} ticks, ${s.animations} inversion animation(s); worst turn ${r2(s.worstTurnDeg)} deg/frame, worst eye jump ${r2(s.worstJumpBlocks)} blocks, worst seat lead ${r2(s.worstLead)} blocks at tick ${s.worstLeadAt}, own-view frames while riding ${s.ownFrames}`);
      if (lapsDone < laps) ctx.note(`only ${lapsDone} of ${laps} laps in ${t} ticks${ctx.player.ridingOn === car ? '' : ' (the child is no longer aboard)'}`);
    },

    /**
     * The cockpit view at full speed, judged from the DRAWN pose: the vehicle spawned on the flat world and driven
     * forward in hotbar slot 9; each tick the drawn camera against the cockpit eye on the vehicle's DRAWN pose,
     * along the heading; `{ type }`. Replaces the course's target-arithmetic `cockpitEye` when the client runs.
     */
    async cockpitEye(step: AnyStep, ctx: StepContext) {
      const typeId = String(step['type']);
      const cfg = cameraCfg(typeId);
      if (!cfg?.eye) { ctx.note(`${typeId}: no cockpit eye in vehicle-camera.js (the cockpit camera stands at the rider's head)`); return; }
      const view = client(ctx);
      // The course's `board`: a low car's seated rider has its feet under the road, judged by the vehicle's own band there.
      ctx.quiet(['player-not-in-solid', 'nothing-below-ground']);
      const v = ctx.sim.engine.spawnEntity(typeId, 'overworld', { x: 60.5, y: FLAT_GROUND_Y, z: -400.5 });
      v.rotation = { x: 0, y: -90 };
      await ctx.run(2);
      const r = v.addRider(ctx.player, ctx.sim.engine.tick);
      if (!r.ok) throw new Error(`could not seat the child on ${typeId}: ${r.why}`);
      ctx.player.rotation = { x: 0, y: -90 };
      await ctx.run(2);
      ctx.sim.host.playerState(ctx.player).selectedSlot = COCKPIT_SLOT;
      const eye = cfg.eye;
      let worst = 0, worstAt: Record<string, number> = {}, top = 0;
      const frames = step['frames'] !== undefined ? !!step['frames'] : !!options.frames;
      for (let t = 0; t < COCKPIT_DRIVE_TICKS; t++) {
        ctx.sim.controls.set(ctx.player.id, { forward: 1, strafe: 0, jump: false });
        await ctx.run(1);
        const camera = view.drawn(ctx.player);
        if (camera.mode === 'own') continue;
        // The cockpit eye on the DRAWN vehicle (its pose on the client), in the seat frame turned by the drawn yaw.
        const dp = view.drawnPose(v);
        const o = rotateYaw({ x: eye[0] * dp.scale, y: eye[1] * dp.scale, z: eye[2] * dp.scale }, dp.yaw);
        const drawnEye = { x: dp.x + o.x, y: dp.y + o.y, z: dp.z + o.z };
        const vel = view.drawnVelocity(v), speed = Math.hypot(vel.x, vel.y, vel.z) * 20;
        top = Math.max(top, speed);
        const yaw = dp.yaw * Math.PI / 180, fx = -Math.sin(yaw), fz = Math.cos(yaw);
        const lead = (camera.eye.x - drawnEye.x) * fx + (camera.eye.z - drawnEye.z) * fz;
        if (speed >= SEAT_SPEED_FLOOR && Math.abs(lead) > Math.abs(worst)) { worst = lead; worstAt = { t, speed: r2(speed), lead: r2(lead) }; }
        if (frames && t % 10 === 9) keep(ctx, 'frames', shotOf(ctx, `${typeId.replace(/^craftmatic:/, '')}-cockpit-t${String(t).padStart(3, '0')}`, FRAME_SIZE));
      }
      ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false });
      // The brackets re-derived: the lead this client would draw at the top speed for each candidate camera lag
      // (the pack's own first), with the camera-first order's extra tick and the ease's own 2 (quirk `camera-ease-lag`).
      const lags = options.lags ?? [cfg.cockpitLag, 1.5, 3, 4];
      const perLag = Object.fromEntries([...new Set(lags)].map(L => [String(L), r2(drawnCameraLead(top, L + (cfg.cameraFirst ? 1 : 0), 0.1, view.profile))]));
      const out = { profile: view.profile.name, entityLagTicks: view.profile.entityLagTicks, cockpitLag: cfg.cockpitLag, cameraFirst: cfg.cameraFirst, topSpeed: r2(top), worstLead: r2(worst), at: worstAt, predictedLeadPerLag: perLag };
      ctx.state['cockpitEye'] = { ...((ctx.state['cockpitEye'] as Record<string, unknown> | undefined) ?? {}), [typeId]: out };
      ctx.note(`${typeId} cockpit eye (DRAWN, client ${view.profile.name} lag ${view.profile.entityLagTicks}, camera lag ${cfg.cockpitLag}${cfg.cameraFirst ? ' +1 camera-first' : ''}) at up to ${out.topSpeed} blocks/s: worst ${out.worstLead} blocks ${worst >= 0 ? 'ahead of' : 'behind'} the drawn seat; predicted lead per camera lag at that speed: ${Object.entries(perLag).map(([L, l]) => `${L} -> ${l}`).join(', ')}`);
      if (Math.abs(worst) > SEAT_EYE_SLACK) ctx.violate({ invariant: 'cockpit-eye-on-seat', message: `${typeId}: the cockpit camera is DRAWN ${out.worstLead} blocks ${worst >= 0 ? 'AHEAD of' : 'behind'} the drawn seat at ${worstAt['speed']} blocks/s on the ${view.profile.name} client (entity lag ${view.profile.entityLagTicks}, camera lag ${cfg.cockpitLag}${cfg.cameraFirst ? ' + 1' : ''}, ease 2)`, evidence: out });
      ctx.sim.host.playerState(ctx.player).selectedSlot = 0;
      v.removeRider(ctx.player);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },

    /**
     * Pictures from `from` to `to` blocks (every `step`) away from the placed model's centre, the child standing on
     * the ground, looking at it: each actor's full / hull / gone state from the drawn camera; `{ from, to, step }`.
     */
    async walkAway(step: AnyStep, ctx: StepContext) {
      const from = Number(step['from'] ?? 40), to = Number(step['to'] ?? 120), stride = Math.max(1, Number(step['step'] ?? 10));
      const placed = placedOf(ctx);
      const centre = { x: (placed.from.x + placed.to.x + 1) / 2, y: (placed.from.y + placed.to.y) / 2, z: (placed.from.z + placed.to.z + 1) / 2 };
      const half = Math.hypot(placed.to.x + 1 - placed.from.x, placed.to.z + 1 - placed.from.z) / 2;
      const u = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };
      const rows: Array<{ distance: number; full: number; hull: number; gone: number; disagree: number; entities: SnapshotEntity[] }> = [];
      const hulls = new Map<string, { lodDistance: number; cullBlocks: number; seenHull: boolean }>();
      for (let d = from; d <= to + 1e-9; d += stride) {
        // `d` is the distance from the model's edge, as a child walks it; the camera-to-root distances are per actor.
        const feet = { x: centre.x + u.x * (half + d), y: placed.from.y, z: centre.z + u.z * (half + d) };
        teleport(ctx.sim.host, ctx.player, feet);
        ctx.player.onGround = true;
        lookAt(ctx.player, { x: centre.x, y: feet.y + PLAYER_EYE_HEIGHT, z: centre.z });
        await ctx.run(1);
        const shot = shotOf(ctx, `walk-away-${String(Math.round(d)).padStart(3, '0')}`);
        keep(ctx, 'frames', shot);
        const m = shot.metrics;
        for (const e of m.entities) {
          if (e.lodDistance === undefined) continue;
          const h = hulls.get(e.id) ?? { lodDistance: e.lodDistance, cullBlocks: e.cullBlocks, seenHull: false };
          if (e.state === 'hull') h.seenHull = true;
          hulls.set(e.id, h);
        }
        rows.push({ distance: d, full: m.entities.filter(e => e.state === 'full').length, hull: m.entities.filter(e => e.state === 'hull').length, gone: m.entities.filter(e => e.state === 'gone').length, disagree: m.entities.filter(e => e.cullDisagree).length, entities: m.entities });
      }
      ctx.state['walkAway'] = rows.map(r => ({ distance: r.distance, full: r.full, hull: r.hull, gone: r.gone, disagree: r.disagree }));
      // A hull is planned to be seen for a chunk of travel before its actor culls (bedrock-lod-hull.ts); a switch at or
      // past the REALISED cull (the box times the size) is a hull that never draws.
      for (const [id, h] of hulls) {
        if (h.lodDistance >= h.cullBlocks) ctx.violate({ invariant: 'lod-switch-under-cull', message: `${id}: the LOD hull switches at ${h.lodDistance} blocks but the actor culls at ${r2(h.cullBlocks)} (realised box): the hull is never drawn`, evidence: { id, lodDistance: h.lodDistance, cullBlocks: h.cullBlocks } });
      }
      const never = [...hulls].filter(([, h]) => !h.seenHull && h.lodDistance < h.cullBlocks).length;
      ctx.note(`walk-away ${from}..${to} by ${stride} (client ${client(ctx).profile.name}): ${rows.map(r => `${r.distance}: ${r.full}/${r.hull}/${r.gone}${r.disagree ? ` (${r.disagree} cull 3-D/horizontal disagree)` : ''}`).join('; ')} (full/hull/gone); ${hulls.size} actor(s) with a hull${never ? `, ${never} whose hull the walk never reached (switch under the cull, but past ${to} blocks from the edge)` : ''}`);
    },
  };
}

/** The `coaster-camera` scenario of a pack (none when it has no coaster cars): place, ride 3 laps with frames, Undo. */
export function coasterCameraScenarios(pack: CraftmaticPack, profile: ClientProfileName, laps = 3): Scenario[] {
  if (!hasCoasterCars(pack)) return [];
  const steps: Step[] = [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'rideCoasterCamera', laps, frames: true }, { kind: 'undo' }];
  return [{
    name: `coaster-camera-${profile}`,
    description: `Ride the coaster ${laps} laps watching the DRAWN camera on the ${profile} client: continuous frame to frame, on the drawn seat, never the rider's own view (COAST-06).`,
    steps, allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES],
  }];
}

/** The `walk-away` scenario: place at `size`, walk from `from` to `to` blocks off the model's edge (COL-03 / FID-03). */
export function walkAwayScenarios(pack: CraftmaticPack, size: number, from: number, to: number, stride = 10): Scenario[] {
  if (!pack.placement.sizes.includes(size)) return [];
  return [{
    name: `walk-away-${size}`,
    description: `Place at ${size} percent and look back from ${from} to ${to} blocks off the edge: each actor full / hull / gone from the drawn camera.`,
    steps: [{ kind: 'place', size, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'walkAway', from, to, step: stride }, { kind: 'undo' }],
    allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES],
  }];
}

/** The realised cull of an entity type at a wand size (for a report row): the 100 % box times the size. */
export function realisedCullBlocks(box: { width: number; height: number } | undefined, sizePct: number): number {
  const k = sizePct / 100;
  return entityRenderCullBlocks(box ? { width: box.width * k, height: box.height * k } : undefined);
}
