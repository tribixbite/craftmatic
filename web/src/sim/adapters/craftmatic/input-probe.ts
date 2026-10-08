/**
 * The INPUT scenarios (`bun scripts/sim.ts <packs> --scenario=input`): the
 * client's hand on craftmatic packs, with the real input paths of
 * `input/**` - a touch drag routed by the control scheme, the touch sneak
 * toggle, the mount snap, screen-space taps, and the replay of an adb round's
 * own tool scripts.
 *
 *   input-<vehicle>       every scripted car, hover craft, ship and boat: the
 *                         child climbs on looking at its face (the mount snap
 *                         must open the chase camera behind the nose), drags
 *                         90 degrees at rest (the vehicle's yaw must not move,
 *                         the view must, and hold), drives (the view eases back
 *                         within 2 s), drags the pitch (ASSUMED rule), and is
 *                         forced into `player_relative` (the drag must be inert
 *                         there, as on the Saga in 30k);
 *   input-flyer           a flyer mount (the Nimbus): summoned by a tap, one
 *                         400-px swipe at rest - the cloud must STOP turning
 *                         (FIG-08, Saga 30l) - then a look down to 52 degrees
 *                         by a drag and Jump: it must descend (Saga 30l);
 *   tap-occlusion         every moving part from the spot a child taps it from,
 *                         a screen tap at its DRAWN centre must pick the part
 *                         itself, not a neighbour's box (910004 Door 4 opened
 *                         Window 3, IX-01); every part's drawn samples tallied;
 *   device-script         an adb round's finger sequence replayed
 *                         (`input/device-script.ts`) after the placement, with
 *                         each world touch and what it moved.
 */

import type { AnyStep, Scenario, Step, StepContext, StepHandler } from '../../scenario/types.js';
import { CORE_HANDLERS, findEntity } from '../../scenario/runner.js';
import type { SimEntity } from '../../entity/entity.js';
import type { Vec3 } from '../../core/vec.js';
import type { Addon } from '../../pack/pack.js';
import { FLAT_GROUND_Y } from '../../world/voxel-world.js';
import { teleport } from '../../script-host/facades.js';
import { interact, lookAt } from '../../input/touch.js';
import { findApproach } from '../../scenario/approach.js';
import { dragOver } from '../../input/steps.js';
import { dragRecords, dragPixels, dragReach } from '../../input/drag.js';
import { PIXEL_VIEWPORT, projectToScreen, screenCamera, screenPick, tapScreen, touchModeOf } from '../../input/screen.js';
import { PIXEL_LAYOUT, PhoneScreen, runDeviceScript, translateCommand, type ReplayEvent } from '../../input/device-script.js';
import { quirkValue } from '../../quirks/registry.js';
import { IX_KEYS } from '../../../engine/bedrock-interactives.js';
import { CRAFTMATIC_ALLOWED_LINES, CRAFTMATIC_YIELDING_LINES } from './child-play.js';
import type { CraftmaticPack } from './pack-facts.js';
import { MOUNT_STILL_DEG_PER_TICK, MOUNT_TURN_SLACK_DEG, placedOf } from './play.js';
import { scriptedVehicleTypes, type ScriptedTypeFacts } from './vehicle-course.js';
import { entityDrawn, packAppearance } from './drawn.js';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;
const rel = (v: Vec3, a: Vec3): Vec3 => ({ x: r2(v.x - a.x), y: r2(v.y - a.y), z: r2(v.z - a.z) });

/** The view drags the vehicle probe makes (raw Saga pixels at `touch-drag-degrees-per-pixel`): ~90 degrees of yaw, ~21 of pitch. */
const YAW_DRAG_PX = Math.round(90 / quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel'));
const PITCH_DRAG_PX = 100;
/** The chase camera may open this far off the nose after the mount snap (degrees; the course's `free-look` bound). */
const CHASE_OFF_NOSE_DEG = 5;
/** Ticks the view is given to ease back behind the nose while driving (2 s, the free look's design and the Saga 30j reading). */
const EASE_TICKS = 40;
/** The look the Nimbus's driver descends at (degrees down; Saga 30l: `descending` true at 52). */
const NIMBUS_DESCEND_PITCH = 52;

/** The input scenarios for one pack (see the module header). */
export function inputScenarios(pack: CraftmaticPack): Scenario[] {
  const common = { allowLines: [...CRAFTMATIC_ALLOWED_LINES, /CAR|HOVER|FLY|PLANE|BOAT|mph|Hotbar slot 9|CMVT/], yieldingLines: [...CRAFTMATIC_YIELDING_LINES] };
  const out: Scenario[] = [];
  for (const t of scriptedVehicleTypes(pack)) out.push({ name: `input-${t.typeId.replace(/^craftmatic:/, '')}`, description: `${t.typeId}: mount snap, drag at rest and driving, pitch drag, player_relative inert (VEH-06).`, steps: [{ kind: 'inputVehicle', type: t.typeId }], ...common });
  if (pack.flyers.length) out.push({ name: 'input-flyer', description: 'The flyer mount: one swipe at rest stops (FIG-08), look down + Jump descends.', steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'inputFlyer' }], ...common });
  if (pack.interactives?.items.length) out.push({ name: 'tap-occlusion', description: 'Each moving part, tapped on the screen at its drawn centre from where a child taps it, picks itself (IX-01).', steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'tapOcclusion' }], ...common });
  return out;
}

/**
 * The child-play scenarios with the touch sneak TOGGLE (`--sneak-toggle`, quirk `touch-sneak-toggle`): every
 * scenario that walks doorways is run again (`<name>-sneak`) with the sneak control in toggle mode and one press
 * of it just before the doorway lines - sneak left ON, as a seat's "Sneak" left it on the Pixel in 30j - so the
 * lines walk sneaking (slow, never stepping off a drop).
 */
export function sneakToggleScenarios(scenarios: readonly Scenario[]): Scenario[] {
  return scenarios.filter(s => s.steps.some(st => st.kind === 'doorwayLines')).map(s => {
    const steps: Step[] = [];
    for (const st of s.steps) {
      if (st.kind === 'doorwayLines') steps.push({ kind: 'sneakMode', mode: 'toggle' }, { kind: 'sneakToggle', label: 'sneak left on (a seat exit)' });
      steps.push(st);
    }
    return { ...s, name: `${s.name}-sneak`, description: `${s.description ?? s.name} With the touch sneak toggle left ON before the doorway lines.`, steps };
  });
}

/** The free camera's yaw and pitch (from its location toward the point it faces), or undefined when no script camera stands. */
function chaseView(ctx: StepContext): { yaw: number; pitch: number } | undefined {
  const c = ctx.sim.host.playerState(ctx.player).camera;
  if (!c.location || !c.facing) return c.rotation ? { yaw: c.rotation.y, pitch: c.rotation.x } : undefined;
  const dx = c.facing.x - c.location.x, dy = c.facing.y - c.location.y, dz = c.facing.z - c.location.z;
  return { yaw: Math.atan2(-dx, dz) * 180 / Math.PI, pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI };
}

/**
 * One swipe on a flyer mount at rest, with a REAL drag (`dragPixels`): summon the mount by a tap on its companion,
 * let the seat settle 3 s, drag `dxPx` raw pixels over `ticks` ticks, then hands off for `watchTicks`. Records the
 * mount's turn and the look's (`state.dragMount`, the shape `play.ts` `dragMount` records) and judges it as that step
 * does: `mount-steer-stops` (still turning a second after), `mount-steer-by-drag` (the view's turn is not the swipe's,
 * or the body's neither the swipe's nor nothing). The regression `nimbus-spin-30l` swipes with this since 2026-10-08.
 * TODO(sim-input): `play.ts` `dragMount` (the world package's file) sets the look directly; fold it onto this.
 */
export async function swipeMount(ctx: StepContext, pack: CraftmaticPack, opts: { dxPx?: number; ticks?: number; watchTicks?: number } = {}): Promise<SimEntity | undefined> {
  const mount = pack.flyers[0];
  if (!mount) throw new Error('swipeMount: the pack has no flyer mount');
  const companion = findEntity(ctx.sim, ctx.player, { where: e => mount.summonTypes.includes(e.typeId) && e.typeId !== mount.cloudType });
  if (!companion) throw new Error('swipeMount: no companion to tap');
  await CORE_HANDLERS['tap']!({ kind: 'tap', target: { where: (e: SimEntity) => e === companion, label: companion.typeId } }, ctx);
  for (let t = 0; t < 20 && !ctx.player.ridingOn; t++) await ctx.run(1);
  const v = ctx.player.ridingOn;
  if (!v) { ctx.violate({ invariant: 'mount-summoned', message: `a tap on ${companion.typeId} put the player on no mount` }); return undefined; }
  await ctx.run(60);
  const dxPx = opts.dxPx ?? 400, ticks = Math.max(1, opts.ticks ?? 16), watchTicks = opts.watchTicks ?? 100;
  const dragDeg = r2(dxPx * quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel'));
  let last = v.rotation.y, turned = 0, lastLook = ctx.player.rotation.y, lookTurned = 0;
  const rates: number[] = [];
  const tick = async (): Promise<void> => {
    await ctx.run(1);
    const d = wrap(v.rotation.y - last); last = v.rotation.y; turned += d; rates.push(Math.abs(d));
    lookTurned += wrap(ctx.player.rotation.y - lastLook); lastLook = ctx.player.rotation.y;
  };
  for (let t = 0; t < ticks; t++) { dragPixels(ctx.sim.controls, ctx.player.id, dxPx / ticks, 0); await tick(); }
  const duringSwipe = r2(turned);
  for (let t = 0; t < watchTicks; t++) await tick();
  const lastSecond = rates.slice(-20), rate = r2(lastSecond.reduce((a, b) => a + b, 0) / Math.max(1, lastSecond.length));
  const out = { dragDeg, dragPx: dxPx, dragTicks: ticks, watchTicks, duringSwipe, turned: r2(turned), lookTurned: r2(lookTurned), lastSecondRatePerTick: rate, lookOffset: r2(wrap(ctx.player.rotation.y - v.rotation.y)), byDrag: true };
  ctx.state['dragMount'] = out;
  ctx.note(`${v.typeId} after one ${dxPx}-px swipe (${dragDeg} degrees, a real drag): the body turned ${out.turned} degrees (${duringSwipe} during the swipe), the view ${out.lookTurned}; ${rate} degrees/tick over the last second; the look ${out.lookOffset} off the heading`);
  if (rate > MOUNT_STILL_DEG_PER_TICK) ctx.violate({ invariant: 'mount-steer-stops', message: `${v.typeId} is still turning ${rate} degrees a tick ${(watchTicks / 20).toFixed(1)} s after a ${dxPx}-px swipe ended (the Saga's Nimbus spun at 6.5 for 40 s)`, evidence: out });
  else {
    const bodyOk = Math.abs(turned) <= MOUNT_TURN_SLACK_DEG || Math.abs(turned - dragDeg) <= MOUNT_TURN_SLACK_DEG;
    if (Math.abs(lookTurned - dragDeg) > MOUNT_TURN_SLACK_DEG || !bodyOk) ctx.violate({ invariant: 'mount-steer-by-drag', message: `${v.typeId}: a ${dragDeg}-degree swipe turned the view ${out.lookTurned} degrees and the body ${out.turned} (the view must turn by the swipe; the body by the swipe or not at all)`, evidence: out });
  }
  return v;
}

/** What a device-script replay is given: the script, its arguments, how to read the tools it calls, and the pin. */
export interface DeviceScriptInput {
  /** The script's path (for `$0` and `dirname`) and text. */
  file: string;
  text: string;
  args: string[];
  /** A tool's text by the path a script names (the CLI reads files, and an older revision with `--tool-rev`). */
  readTool(path: string): string | undefined;
  /** The device's pinned corner of the placement (world blocks): its `/tp` coordinates map onto the simulated anchor. */
  pin?: Vec3;
  /** Placement size and turn the round used (default 100, 0). */
  size?: number;
  rotation?: 0 | 90 | 180 | 270;
}

/** The device-script replay scenario (the CLI's `--device-script=`). */
export function deviceScriptScenario(input: DeviceScriptInput): Scenario {
  return {
    name: `device-script-${input.file.split(/[\\/]/).pop()}`,
    description: `Replay ${input.file}${input.args.length ? ` ${input.args.join(' ')}` : ''} on the Pixel's screen model after the placement.`,
    steps: [{ kind: 'place', size: input.size ?? 100, rotation: input.rotation ?? 0 }, { kind: 'wait', ticks: 40 }, { kind: 'deviceScript' }],
    allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES],
  };
}

/** The input steps' handlers for one pack (`deviceScript` needs `input`). */
export function inputProbeHandlers(pack: CraftmaticPack, addon: Addon, device?: DeviceScriptInput): Record<string, StepHandler> {
  let appearance: ReturnType<typeof packAppearance> | undefined;
  const look = (): ReturnType<typeof packAppearance> => (appearance ??= packAppearance(addon));
  const typeOf = (step: AnyStep): ScriptedTypeFacts => {
    const t = scriptedVehicleTypes(pack).find(x => x.typeId === step['type']);
    if (!t) throw new Error(`no scripted vehicle ${String(step['type'])}`);
    return t;
  };
  return {
    /** VEH-06 on one scripted vehicle (see the module header): `{ type }`. */
    async inputVehicle(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step), p = ctx.player;
      // A low car's seated rider has its feet under the road (the course quiets these too).
      ctx.quiet(['player-not-in-solid', 'nothing-below-ground']);
      const v = ctx.sim.engine.spawnEntity(f.typeId, 'overworld', { x: 60.5, y: FLAT_GROUND_Y, z: 600.5 });
      v.rotation = { x: 0, y: -90 };
      await ctx.run(2);
      // The child climbs on looking at the vehicle's FACE (half round from its heading): the seat's snap (quirk
      // `mount-snaps-rider-yaw`, the riders system) turns them onto the heading; nothing else does.
      p.rotation = { x: 0, y: wrap(v.rotation.y + 180) };
      const seated = v.addRider(p, ctx.sim.engine.tick);
      if (!seated.ok) throw new Error(`could not seat the child on ${f.typeId}: ${seated.why}`);
      await ctx.run(20);
      const off = (): number | undefined => { const c = chaseView(ctx); return c ? r2(wrap(c.yaw - v.rotation.y)) : undefined; };
      const out: Record<string, unknown> = { type: f.typeId, mode: f.mode, riderYawAfterSnap: r2(wrap(p.rotation.y - v.rotation.y)), chaseStart: off() };
      const start = Number(out['chaseStart'] ?? 999);
      if (!(Math.abs(start) < CHASE_OFF_NOSE_DEG)) ctx.violate({ invariant: 'mount-snap-chase', message: `${f.typeId}: a child who climbed on looking at its face got a chase camera ${start} degrees off the nose after the seat's snap`, evidence: { ...out } });
      // One drag at rest, ~90 degrees over 15 ticks (a slow finger), through the real input path.
      const yaw0 = v.rotation.y;
      await dragOver(ctx, { dx: YAW_DRAG_PX, dy: 0, ticks: 15 });
      out['dragged'] = off();
      out['vehicleTurnedAtRest'] = r2(wrap(v.rotation.y - yaw0));
      await ctx.run(40);
      out['restAfter2s'] = off();
      out['vehicleTurnedAfterRest'] = r2(wrap(v.rotation.y - yaw0));
      const dragged = Number(out['dragged'] ?? 0), rest = Number(out['restAfter2s'] ?? 0);
      if (Math.abs(Number(out['vehicleTurnedAfterRest'])) > 1) ctx.violate({ invariant: 'drag-vehicle-still', message: `${f.typeId}: a drag at rest turned the scripted vehicle ${String(out['vehicleTurnedAfterRest'])} degrees (the script owns its yaw; the Saga's did not move, 30j)`, evidence: { ...out } });
      if (!(Math.abs(dragged) > 60)) ctx.violate({ invariant: 'drag-view', message: `${f.typeId}: a ${YAW_DRAG_PX}-px drag turned the chase view ${dragged} degrees`, evidence: { ...out } });
      else if (!(Math.abs(rest - dragged) < 5)) ctx.violate({ invariant: 'drag-view-holds', message: `${f.typeId}: at rest the view moved from ${dragged} to ${rest} after the drag (it should stay where the child left it)`, evidence: { ...out } });
      // Drive: the view eases back behind the nose within 2 s.
      const trace: Array<number | undefined> = [];
      for (let t = 0; t < EASE_TICKS; t++) { ctx.sim.controls.set(p.id, { forward: 1, strafe: 0, jump: false }); await ctx.run(1); if (t % 10 === 9) trace.push(off()); }
      ctx.sim.controls.set(p.id, { forward: 0, strafe: 0, jump: false });
      out['driving'] = trace;
      const end = Math.abs(Number(trace.at(-1) ?? 999));
      if (Math.abs(dragged) > 60 && !(end < CHASE_OFF_NOSE_DEG)) ctx.violate({ invariant: 'drag-eases', message: `${f.typeId}: ${EASE_TICKS / 20} s of driving left the view ${end} degrees off the nose (it should ease back within ~2 s)`, evidence: { ...out } });
      await ctx.run(40);
      // The pitch drag (ASSUMED rule on a scripted 181 seat: the rider's pitch follows the finger, quirk `rider-free-look`).
      const pitch0 = p.rotation.x, camPitch0 = chaseView(ctx)?.pitch;
      await dragOver(ctx, { dx: 0, dy: PITCH_DRAG_PX, ticks: 10 });
      await ctx.run(2);
      out['riderPitchDrag'] = r2(p.rotation.x - pitch0);
      out['cameraPitchDrag'] = camPitch0 === undefined ? null : r2((chaseView(ctx)?.pitch ?? camPitch0) - camPitch0);
      const askedPitch = PITCH_DRAG_PX * quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel');
      if (Math.abs(Number(out['riderPitchDrag'])) < askedPitch / 2) ctx.violate({ invariant: 'pitch-drag', message: `${f.typeId}: a ${PITCH_DRAG_PX}-px vertical drag moved the rider's pitch ${String(out['riderPitchDrag'])} degrees (asked ${r2(askedPitch)}; the rule is ASSUMED on a scripted vehicle)`, evidence: { ...out } });
      // Forced into `player_relative` (the Nimbus's 30k scheme): a drag must not reach the look there.
      ctx.quiet(['player-not-in-solid', 'nothing-below-ground', 'rider-drag-reaches-look']);
      ctx.sim.host.runCommand('overworld', 'controlscheme @s set player_relative', p);
      const before = dragRecords(ctx.sim.engine).length;
      await dragOver(ctx, { dx: YAW_DRAG_PX / 2, dy: 0, ticks: 5 });
      const recs = dragRecords(ctx.sim.engine).slice(before).filter(r => r.playerId === p.id);
      const reach = recs.length ? r2(recs.reduce((a, r) => a + dragReach(r), 0) / recs.length) : null;
      out['playerRelative'] = { routes: [...new Set(recs.map(r => r.route))], reach };
      if (reach === null || reach > 0.1) ctx.violate({ invariant: 'scheme-routing', message: `${f.typeId}: under player_relative a drag reached the rider's look (reach ${String(reach)}); the device's drag turns only the camera there (Saga 30k)`, evidence: { ...out } });
      ctx.sim.host.runCommand('overworld', 'controlscheme @s clear', p);
      ctx.quiet(['player-not-in-solid', 'nothing-below-ground']);
      ctx.state['input'] = { ...((ctx.state['input'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: out };
      ctx.note(`${f.typeId} input: ${JSON.stringify(out)}`);
      v.removeRider(p);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },

    /** FIG-08 on the pack's flyer mount: a real swipe must stop; a look down to 52 degrees + Jump must descend. */
    async inputFlyer(_step: AnyStep, ctx: StepContext) {
      const v = await swipeMount(ctx, pack);
      if (!v) return;
      const p = ctx.player;
      // Look down by a drag to the driver's descend pitch, then hold Jump (Saga 30l: `riderPitch` 52, `descending` true).
      const k = quirkValue('touch-drag-degrees-per-pixel', 'degreesPerPixel');
      await dragOver(ctx, { dx: 0, dy: (NIMBUS_DESCEND_PITCH - p.rotation.x) / k, ticks: 10 });
      await ctx.run(10);
      const y0 = v.location.y, pitch = r2(p.rotation.x);
      ctx.sim.controls.set(p.id, { jump: true });
      await ctx.run(40);
      ctx.sim.controls.set(p.id, { jump: false });
      await ctx.run(4);
      const dy = r2(v.location.y - y0);
      ctx.state['flyerDescend'] = { pitch, dy };
      ctx.note(`${v.typeId}: looked down to ${pitch} degrees by a drag, Jump 2 s: the mount moved ${dy} blocks vertically`);
      if (!(dy < -0.5)) ctx.violate({ invariant: 'look-down-jump-descends', message: `${v.typeId}: looking ${pitch} degrees down by a drag, Jump moved it ${dy} blocks (it must descend: Saga 30l, FIG-08)`, evidence: { pitch, dy } });
    },

    /**
     * IX-01 tap occlusion: for every moving part, stand where a child taps it from (in front of it), tap the screen
     * with the crosshair on its DRAWN geometry's centre, and require the pick to be the part itself (`tap-occluded` when
     * it is another entity's box); every drawn cube's centre is also tapped and tallied (own / other / block / nothing),
     * with the crosshair and (`touchModeTally`) as Split Controls OFF would pick it from the one look.
     */
    async tapOcclusion(_step: AnyStep, ctx: StepContext) {
      const p = ctx.player, a = placedOf(ctx).anchor;
      const parts = [...ctx.sim.engine.entities.values()].filter(e => e.valid && typeof e.dynamic.get(IX_KEYS.index) === 'number');
      const rows: Array<Record<string, unknown>> = [];
      for (const part of parts) {
        const idx = Number(part.dynamic.get(IX_KEYS.index));
        const label = pack.interactives?.items[idx]?.label ?? part.typeId;
        const drawn = entityDrawn(look(), part)?.filter(d => !d.glass) ?? [];
        const spot = findApproach(ctx.sim.engine, p, part, undefined, [], { inFront: true }) ?? findApproach(ctx.sim.engine, p, part);
        if (!spot || !drawn.length) { rows.push({ part: label, spot: null, note: spot ? 'nothing drawn' : 'no spot within reach' }); continue; }
        teleport(ctx.sim.host, p, spot.feet);
        p.onGround = true;
        await ctx.run(1);
        // The drawn centre: the middle of the part's opaque cubes (what a child's finger aims at).
        const lo = { x: Math.min(...drawn.map(d => d.box.x0)), y: Math.min(...drawn.map(d => d.box.y0)), z: Math.min(...drawn.map(d => d.box.z0)) };
        const hi = { x: Math.max(...drawn.map(d => d.box.x1)), y: Math.max(...drawn.map(d => d.box.y1)), z: Math.max(...drawn.map(d => d.box.z1)) };
        const centre = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 };
        lookAt(p, centre);
        // The phones play with the crosshair (quirk `touch-screen-pick`): a child taps a point by turning the crosshair onto
        // it, so each sample is the centre pick with the look on that point. Split Controls OFF (`touchMode` 'touch') would
        // instead tap the point where it is drawn from one look: the row's `touchModeTally` is that reading.
        const look0 = { ...p.rotation }, cam = screenCamera(p), centreOf = { x: PIXEL_VIEWPORT.width / 2, y: PIXEL_VIEWPORT.height / 2 };
        const classify = (q: Vec3, mode: 'crosshair' | 'touch' = 'crosshair'): string => {
          let r: ReturnType<typeof screenPick>;
          if (mode === 'crosshair') { lookAt(p, q); r = screenPick(ctx.sim.engine, p, centreOf, PIXEL_VIEWPORT); p.rotation = { ...look0 }; }
          else {
            const s = projectToScreen(cam, q, PIXEL_VIEWPORT);
            if (!s || s.x < 0 || s.y < 0 || s.x > PIXEL_VIEWPORT.width || s.y > PIXEL_VIEWPORT.height) return 'off-screen';
            r = screenPick(ctx.sim.engine, p, s, touchModeOf(PIXEL_VIEWPORT, 'touch'));
          }
          if (r.entity === part) return 'own';
          if (r.entity) { const j = r.entity.dynamic.get(IX_KEYS.index); return `other:${typeof j === 'number' ? pack.interactives?.items[j]?.label ?? r.entity.typeId : r.entity.typeId}`; }
          if (r.blockedBy) return 'block';
          return r.outOfReach ? 'out-of-reach' : 'nothing';
        };
        const centreHit = classify(centre);
        const tally = new Map<string, number>();
        for (const d of drawn) { const c = classify({ x: (d.box.x0 + d.box.x1) / 2, y: (d.box.y0 + d.box.y1) / 2, z: (d.box.z0 + d.box.z1) / 2 }); tally.set(c, (tally.get(c) ?? 0) + 1); }
        const touchTally = new Map<string, number>();
        for (const d of drawn) { const c = classify({ x: (d.box.x0 + d.box.x1) / 2, y: (d.box.y0 + d.box.y1) / 2, z: (d.box.z0 + d.box.z1) / 2 }, 'touch'); touchTally.set(c, (touchTally.get(c) ?? 0) + 1); }
        const row = { part: label, spot: rel(spot.feet, a), centre: centreHit, samples: drawn.length, tally: Object.fromEntries(tally), touchModeTally: Object.fromEntries(touchTally) };
        rows.push(row);
        if (centreHit.startsWith('other:')) ctx.violate({ invariant: 'tap-occluded', message: `${label}: from where a child taps it (${JSON.stringify(row.spot)}, anchor-relative) a screen tap at its drawn centre picks ${centreHit.slice(6)} (IX-01: 910004 Door 4 opened Window 3)`, evidence: row });
      }
      ctx.state['tapOcclusion'] = rows;
      for (const r of rows) ctx.note(`tap-occlusion ${JSON.stringify(r)}`);
    },

    /** Replay the CLI's device script on the Pixel's screen model (`input/device-script.ts`), recording every touch and what it moved. */
    async deviceScript(_step: AnyStep, ctx: StepContext) {
      if (!device) throw new Error('deviceScript: no script given (--device-script=)');
      const p = ctx.player, anchor = placedOf(ctx).anchor;
      const events: ReplayEvent[] = [], effects: string[] = [];
      const parts = (): Array<[string, boolean]> => [...ctx.sim.engine.entities.values()].filter(e => e.valid && typeof e.dynamic.get(IX_KEYS.index) === 'number').map(e => [pack.interactives?.items[Number(e.dynamic.get(IX_KEYS.index))]?.label ?? e.typeId, e.dynamic.get(IX_KEYS.open) === true]);
      let lastOpen = new Map(parts()), lastEvent = '(placement)', top = p.location.y;
      const watch = (): void => {
        for (const [label, open] of parts()) if (lastOpen.get(label) !== open) effects.push(`tick ${ctx.sim.engine.tick}: ${label} ${open ? 'OPENED' : 'CLOSED'} (last touch: ${lastEvent})`);
        lastOpen = new Map(parts());
        if (p.onGround) { if (top - p.location.y > 3) effects.push(`tick ${ctx.sim.engine.tick}: the player FELL ${r2(top - p.location.y)} blocks to ${JSON.stringify(rel(p.location, anchor))} (anchor-relative; last touch: ${lastEvent})`); top = p.location.y; }
        else top = Math.max(top, p.location.y);
      };
      const io = {
        advance: async (n: number) => { for (let i = 0; i < n; i++) { await ctx.run(1); watch(); } },
        worldTap: (x: number, y: number) => {
          const r = tapScreen(ctx.sim.engine, p, { x, y }, PIXEL_VIEWPORT, ctx.sim.host.playerState(p).camera);
          const j = r.entity?.dynamic.get(IX_KEYS.index);
          const what = r.entity ? `${r.entity.typeId}${typeof j === 'number' ? ` (${pack.interactives?.items[j]?.label ?? '?'})` : ''} at ${r2(r.distance ?? 0)} blocks via the ${r.camera}` : r.blockedBy ? `the block ${r.blockedBy}` : r.outOfReach ? `${r.outOfReach.entity} out of reach (${r.outOfReach.eyeDistance})` : 'nothing';
          lastEvent = `tap (${x},${y}) -> ${what}`;
          return what;
        },
        worldHold: (x: number, y: number) => {
          // A press held on an entity is the interact (quirk `hold-is-interact`): the before-event, a vanilla seat's mount, the after-event.
          const r = screenPick(ctx.sim.engine, p, { x, y }, PIXEL_VIEWPORT, ctx.sim.host.playerState(p).camera);
          lastEvent = `hold (${x},${y}) -> ${r.entity?.typeId ?? 'nothing'}`;
          if (!r.entity) return 'nothing';
          const res = interact(ctx.sim.engine, p, r.entity, (pl, t) => ctx.sim.host.before('playerInteractWithEntity', { player: ctx.sim.host.entity(pl), target: ctx.sim.host.entity(t) }));
          return `${r.entity.typeId}: ${res.cancelled ? 'interact cancelled by a script' : res.mounted ? 'mounted it' : 'interacted'}`;
        },
        worldDrag: (dx: number, dy: number) => { dragPixels(ctx.sim.controls, p.id, dx, dy); },
        stick: (forward: number, strafe: number) => { ctx.sim.controls.set(p.id, { forward, strafe }); },
        chatCommand: (line: string) => {
          const cmd = translateCommand(line, device.pin, anchor);
          let res = '';
          try { res = `successCount ${ctx.sim.host.runCommand(p.dimension, cmd, p).successCount}`; } catch (e) { res = `refused: ${(e as Error).message}`; }
          lastEvent = `command ${line}`;
          // A teleport's set-down: the fall tracker starts again from where it put the player.
          top = p.location.y;
          return `${cmd === line ? line : `${line} -> ${cmd}`}: ${res}; player at ${JSON.stringify(rel(p.location, anchor))} (anchor-relative)`;
        },
        log: (e: Omit<ReplayEvent, 'tick'>) => { events.push({ tick: ctx.sim.engine.tick, ...e }); },
      };
      const screen = new PhoneScreen(PIXEL_LAYOUT, io);
      ctx.quiet(['player-not-in-solid']);
      await runDeviceScript(device.text, device.args, device.file, { readTool: device.readTool, screen });
      await io.advance(40);
      ctx.state['deviceReplay'] = { events, effects };
      for (const e of events.filter(x => x.route !== 'ignored')) ctx.note(`replay tick ${e.tick} [${e.route}] ${e.command}${e.detail ? ` => ${e.detail}` : ''}`);
      for (const e of effects) ctx.note(`replay effect ${e}`);
    },
  };
}
