/**
 * "Child play": the scenarios a five-year-old runs on a placed model, built
 * from a craftmatic pack's own facts. Per pack:
 *
 *   place-<size>-<turn>  for 100 % and 150 % at turns 0 and 90 (150 % only when
 *                        the pack's blocks resize): place with the wand, tap
 *                        every moving part, walk every doorway's device lines
 *                        from both sides, Undo (nothing may be left);
 *   play-100-0           place at 100 %, board every ride by a tap and ride it
 *                        to the end, board every vehicle and drive 30 s (then
 *                        sneak off), summon and fly a flyer mount (sneak off in
 *                        the air), let the figures live 5 minutes (a seated one
 *                        is approached so it yields, then left so it retakes),
 *                        Undo.
 */

import type { Scenario, Step, StepContext, StepHandler, AnyStep } from '../../scenario/types.js';
import { teleport } from '../../script-host/facades.js';
import { approachSpots, findApproach, SIGHT_MARGIN } from '../../scenario/approach.js';
import { DEV_NAMESPACE, ixKeys, nsId } from './namespace.js';
import type { Addon } from '../../pack/pack.js';
import { readCraftmaticPack, type CraftmaticPack } from './pack-facts.js';
import { wandHandlers } from './wand.js';
import { COLLIDER_SLACK, FIGURE_TYPE, playHandlers, placedOf, staticDrawn, tapPart } from './play.js';
import { registerAppearance, vehicleCourseHandlers } from './vehicle-course.js';
import { drawnReaches, drawnTopOver, packAppearance } from './drawn.js';
import { firstPersonSnapshot } from './snapshot.js';
import { lookAt, pick } from '../../input/touch.js';
import { pickBoxes } from '../../input/ray.js';
import { rayBox, type Vec3 } from '../../core/vec.js';
import { PLAYER_EYE_HEIGHT, PLAYER_HEIGHT } from '../../physics/body.js';
import { quirkValue } from '../../quirks/registry.js';
import { rayParallelepiped } from '../../../engine/oriented-box.js';
import type { SimEntity } from '../../entity/entity.js';
import type { DrawnBox } from './drawn.js';
import type { AddonAppearance } from './appearance.js';

/** Lines a craftmatic pack prints that are not faults (the wand's own progress and the pack's diagnostics it shows on purpose). */
export const CRAFTMATIC_ALLOWED_LINES: readonly RegExp[] = [/BRICK_WAND_READY/, /CRAFTMATIC_[A-Z_]+_READY/];

/**
 * Action-bar lines of a craftmatic pack another script may replace at once: the wand's closing progress line.
 * Its news is told in the chat ("Placed ...", `finalHoldTicks` later); 11374's pinball prompt ("press Play
 * pinball") replacing it after 13 ticks is the next instruction, not a stolen one (simulator triage 2026-09-30).
 */
export const CRAFTMATIC_YIELDING_LINES: readonly RegExp[] = [/\[Brick Wand\].*100 percent · done$/];

/** How long figures live in the play scenario (5 simulated minutes). */
export const FIGURE_LIFE_TICKS = 6000;

/** The adapter's step handlers for one pack (wand + play + the child-play extras). */
export function craftmaticHandlers(pack: CraftmaticPack, addon: Addon): Record<string, StepHandler> {
  const appearance = packAppearance(addon);
  // The course's handlers read a boat's drawn hull through this (they are built from the pack's facts alone).
  registerAppearance(pack.pack, appearance);
  // The vehicle course's steps too, so a regression case can drive a ship into the device's obstacle.
  return { ...wandHandlers(pack), ...playHandlers(pack, appearance), ...extraHandlers(pack, appearance), ...vehicleCourseHandlers(pack) };
}

/** A first-person picture a scenario took (`snapshot` step), for the CLI's `--shots`. */
export interface Snapshot { name: string; width: number; height: number; rgb: Uint8Array }

function extraHandlers(pack: CraftmaticPack, appearance: AddonAppearance): Record<string, StepHandler> {
  return {
    /** A first-person picture: from where the child placed, looking at the model's centre (or from where it stands: `{ here: true }`). */
    async snapshot(step: AnyStep, ctx: StepContext) {
      const placed = placedOf(ctx);
      if (!step['here']) {
        const start = ctx.state['craftmatic.start'] as { x: number; y: number; z: number } | undefined;
        if (start) teleport(ctx.sim.host, ctx.player, start);
        lookAt(ctx.player, { x: (placed.from.x + placed.to.x + 1) / 2, y: (placed.from.y + placed.to.y) / 2, z: (placed.from.z + placed.to.z + 1) / 2 });
        await ctx.run(1);
      }
      const size = { width: 480, height: 270 };
      const shot: Snapshot = { name: String(step['name'] ?? 'shot'), ...size, rgb: firstPersonSnapshot(ctx.sim.engine, appearance, ctx.player, size) };
      ctx.state['snapshots'] = [...((ctx.state['snapshots'] as Snapshot[] | undefined) ?? []), shot];
    },
    /** Tap every moving part once; each must change its state (open/closed, turned). */
    async tapInteractives(_step: AnyStep, ctx: StepContext) {
      // Read the drawn geometry the static colliders stand for while every part is still as placed (closed).
      staticDrawn(ctx, appearance, pack);
      const IX = ixKeys(pack.namespace);
      const parts = [...ctx.sim.engine.entities.values()].filter(e => e.valid && typeof e.dynamic.get(IX.index) === 'number');
      for (const part of parts) {
        const idx = e2n(part.dynamic.get(IX.index));
        const label = pack.interactives?.items[idx]?.label ?? part.typeId;
        const state = (): string => JSON.stringify([part.dynamic.get(IX.open), part.properties.get(nsId(pack.namespace, 'angle'))]);
        const before = state();
        // No spot over the pack's colliders picks the part: when the MODEL itself offers none either (no drawn floor
        // within reach with a clear line to it), the part is out of reach by the model's own geometry - noted, never
        // tapped from wherever the child happens to stand (that tap picks whatever is in front, a second false finding).
        if (!ctx.player.ridingOn && pick(ctx.sim.engine, ctx.player).entity !== part && !findApproach(ctx.sim.engine, ctx.player, part)) {
          const why = outOfReachByModel(ctx, part, staticDrawn(ctx, appearance, pack), parts);
          if (why) { ctx.note(`${label}: no standing spot within reach picks it - the MODEL's: ${why}`); await ctx.run(8); continue; }
        }
        if (!await tapPart(ctx, part, label, () => state() !== before, pack)) {
          const refused = part.dynamic.get(nsId(pack.namespace, 'ix_refused'));
          const text = `no tap on ${label} from any spot within reach changed it${refused ? ` (the part refused: ${String(refused)})` : ''}`;
          // A refusal ("behind a wall") is the runtime's line of sight over its colliders. When the MODEL's own drawn
          // geometry stands between the eye and the part from EVERY spot a tap picks it from, the part is hidden by
          // the model within reach (76417's Door 1 at 150 %, set back behind its arch): the model's, noted.
          const hidden = refused ? hiddenByModel(ctx, part, staticDrawn(ctx, appearance, pack)) : undefined;
          if (hidden) ctx.note(`${text} - the MODEL's: from all ${hidden} spots a tap picks it from, the model's own geometry stands between the eye and it`);
          else ctx.violate({ invariant: 'tap-moves-part', message: text, evidence: { part: part.typeId, state: before, at: part.location } });
        }
        // A double door's second leaf moves with the first: close the pair again so each leaf is tapped from rest.
        await ctx.run(8);
      }
      ctx.note(`tapped ${parts.length} moving parts`);
    },

    /** Walk up to each seated figure (it yields its seat), step away (it should take it back). */
    async visitSeatedFigures(_step: AnyStep, ctx: StepContext) {
      const placed = placedOf(ctx);
      // Only a figure the SOURCE sat on a chair (`craftmatic:fig` mode `seated`) takes its seat back; a walker that sat
      // down on its own stands up for the child and walks on (figures.js `sit`). Until 2026-09-30 every riding figure
      // was expected to retake, and 10303's fig4 and 910032's fig3 - walkers on a bench - failed for doing as designed.
      const seated = [...ctx.sim.engine.entities.values()].filter(e => e.valid && FIGURE_TYPE.test(e.typeId) && e.ridingOn && figureMode(e, pack.namespace) === 'seated');
      const walkersSitting = [...ctx.sim.engine.entities.values()].filter(e => e.valid && FIGURE_TYPE.test(e.typeId) && e.ridingOn && figureMode(e, pack.namespace) !== 'seated');
      if (walkersSitting.length) ctx.note(`${walkersSitting.length} walking figure(s) sitting down of their own accord (${walkersSitting.map(e => e.typeId).join(', ')}): not visited, they do not retake a seat`);
      for (const fig of seated.slice(0, 4)) {
        const seat = fig.ridingOn!;
        // Walk up to it: a spot within reach from which a tap would pick it (where a child stands to look at it).
        const spot = findApproach(ctx.sim.engine, ctx.player, fig);
        if (!spot) { ctx.note(`${fig.typeId}: no standing spot within reach of it; not visited`); continue; }
        teleport(ctx.sim.host, ctx.player, spot.feet);
        await ctx.run(100);
        const yielded = !fig.ridingOn;
        teleport(ctx.sim.host, ctx.player, { x: placed.from.x - 6.5, y: placed.from.y, z: placed.from.z - 6.5 });
        let back = false;
        for (let t = 0; t < 900 && !back; t += 10) { await ctx.run(10); back = fig.ridingOn === seat; }
        ctx.note(`${fig.typeId}: ${yielded ? 'yielded its seat' : 'did not yield'} with the child beside it; ${back ? 'took it back' : 'did not take it back'} within 45 s`);
        if (yielded && !back) ctx.violate({ invariant: 'seated-figure-retakes', message: `${fig.typeId} yielded its seat and did not take it back within 45 s`, evidence: { seat: seat.typeId, at: seat.location } });
      }
    },
  };
}

const e2n = (v: unknown): number => (typeof v === 'number' ? v : -1);

/** A figure's life mode as the placement wrote it (`craftmatic:fig`): `seated` (the source sat it) or `roam`. */
export function figureMode(e: SimEntity, namespace: string = DEV_NAMESPACE): string | undefined {
  const raw = e.dynamic.get(nsId(namespace, 'fig'));
  if (typeof raw !== 'string') return undefined;
  try { return (JSON.parse(raw) as { mode?: string }).mode; } catch { return undefined; }
}

/**
 * How many spots a tap picks `part` from, when the model's drawn (opaque) geometry blocks the line from the eye
 * to the aimed point from EVERY one of them (short of the last `SIGHT_MARGIN`, the part's own frame); undefined
 * when there is no such spot or any one of them sees the part.
 */
function hiddenByModel(ctx: StepContext, part: SimEntity, drawn: readonly DrawnBox[]): number | undefined {
  const spots = approachSpots(ctx.sim.engine, ctx.player, part);
  if (!spots.length) return undefined;
  const opaque = drawn.filter(d => !d.glass).map(d => d.box);
  for (const s of spots) {
    const eye = { x: s.feet.x, y: s.feet.y + PLAYER_EYE_HEIGHT, z: s.feet.z };
    const d = { x: s.aim.x - eye.x, y: s.aim.y - eye.y, z: s.aim.z - eye.z }, len = Math.hypot(d.x, d.y, d.z);
    const u = { x: d.x / len, y: d.y / len, z: d.z / len };
    if (!opaque.some(b => rayBox(eye, u, b, len - SIGHT_MARGIN) !== undefined)) return undefined;
  }
  return spots.length;
}

/** The lattice step (blocks) `outOfReachByModel` stands the child on, across the reach round a part. */
export const MODEL_REACH_STEP = 0.25;

/**
 * Why no child could tap `part` whatever the pack's colliders did, judged over what the MODEL draws: every standing
 * spot within tap reach - a lattice over the reach round the part's pick boxes, on every drawn opaque top and the
 * ground the model stands on, with a player's box free of drawn opaque geometry - either has its eye out of reach of
 * the nearest pick box or something between the eye and it: an opaque static drawn cube, or ANOTHER moving part's
 * pick box (a tap is picked by hit box: it takes that part). Returns the reason, or undefined when some spot sees the part in reach: the
 * pack then denies a spot the model offers, its own fault (`tap-target-reachable` stands).
 *
 * The census case (2026-11-07): two recon_v3 brick-tub reconstructions stack 9-11 windows in one column, a block
 * apart (5482's Windows 1-11, 5508's 5-13): the upper ones hang over no floor, and from the floors in reach of them
 * the windows below stand in the line.
 */
export function outOfReachByModel(ctx: StepContext, part: SimEntity, statics: readonly DrawnBox[], parts: readonly SimEntity[]): string | undefined {
  const boxes = pickBoxes(part);
  if (!boxes.length) return undefined;
  const reach = quirkValue('tap-is-hit', 'reachBlocks') - 0.5;
  const lo = { x: Math.min(...boxes.map(b => b.x0)) - reach, y: Math.min(...boxes.map(b => b.y0)) - reach - PLAYER_EYE_HEIGHT, z: Math.min(...boxes.map(b => b.z0)) - reach };
  const hi = { x: Math.max(...boxes.map(b => b.x1)) + reach, y: Math.max(...boxes.map(b => b.y1)) + reach, z: Math.max(...boxes.map(b => b.z1)) + reach };
  const near = (b: DrawnBox['box']): boolean => b.x1 > lo.x && b.x0 < hi.x && b.y1 > lo.y && b.y0 < hi.y && b.z1 > lo.z && b.z0 < hi.z;
  const opaque = statics.filter(d => !d.glass && near(d.box));
  // Another moving part takes a tap aimed through its PICK box (the tap is picked by hit box, glass or not).
  const others = parts.filter(e => e !== part && e.valid).flatMap(e => pickBoxes(e)).filter(near);
  const ground = placedOf(ctx).from.y;
  const blocks = (eye: Vec3, aim: Vec3): boolean => {
    const d = { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z }, len = Math.hypot(d.x, d.y, d.z);
    if (len <= SIGHT_MARGIN) return false;
    const u = { x: d.x / len, y: d.y / len, z: d.z / len }, max = len - SIGHT_MARGIN;
    const hit = (b: DrawnBox): boolean => b.solid ? rayParallelepiped([eye.x, eye.y, eye.z], [u.x, u.y, u.z], b.solid, max) !== undefined : rayBox(eye, u, b.box, max) !== undefined;
    return opaque.some(hit) || others.some(b => rayBox(eye, u, b, max) !== undefined);
  };
  let floors = 0, inReach = 0;
  for (let x = lo.x; x <= hi.x + 1e-9; x += MODEL_REACH_STEP) for (let z = lo.z; z <= hi.z + 1e-9; z += MODEL_REACH_STEP) {
    const tops = new Set<number>([ground]);
    for (const d of opaque) { const t = drawnTopOver(d, x - 0.3, x + 0.3, z - 0.3, z + 0.3); if (t !== undefined && t >= lo.y && t <= hi.y) tops.add(t); }
    for (const t of tops) {
      // The player's box with the colliders' superset slack round it: a spot the drawn cubes leave free only by less
      // than a collider's slack is the model's to deny, as a doorway stop is (`COLLIDER_SLACK`, `modelsObstacle`).
      const g = COLLIDER_SLACK;
      const body = { x0: x - 0.3 - g, x1: x + 0.3 + g, y0: t + 0.01, y1: t + PLAYER_HEIGHT, z0: z - 0.3 - g, z1: z + 0.3 + g };
      if (opaque.some(d => drawnReaches(d, body, 0.001))) continue;
      floors++;
      const eye = { x, y: t + PLAYER_EYE_HEIGHT, z };
      // The finger lands on the nearest pick box, inside it (as `nearPickPoint` aims).
      for (const b of boxes) {
        const aim = { x: Math.max(b.x0, Math.min(eye.x, b.x1)), y: Math.max(b.y0, Math.min(eye.y, b.y1)), z: Math.max(b.z0, Math.min(eye.z, b.z1)) };
        if (Math.hypot(aim.x - eye.x, aim.y - eye.y, aim.z - eye.z) > reach) continue;
        inReach++;
        if (!blocks(eye, aim)) return undefined;
      }
    }
  }
  return inReach
    ? `from all ${inReach} spots on a floor the model draws within reach of it, the model's own geometry or another moving part stands between the eye and it`
    : `no floor the model draws puts the eye within reach of it (${floors} floors searched round it)`;
}

/** The Overworld build height the wand allows, blocks (-64..319). */
const WORLD_HEIGHT_BLOCKS = 384;

/** What child play builds: `quick` (short drives and lives), `shots` (pictures), `sizes` (the wand sizes placed; default 100 and 150). */
export interface ChildPlayOptions { quick?: boolean; shots?: boolean; sizes?: readonly number[] }

/** The wand sizes child play places at by default (COL-01 / SCALE-05 ask 300 and 400 too: `--sizes=100,150,200,300,400`). */
export const CHILD_PLAY_SIZES: readonly number[] = [100, 150];

/** The child-play scenarios for one pack. */
export function childPlayScenarios(pack: CraftmaticPack, options: ChildPlayOptions = {}): Scenario[] {
  const out: Scenario[] = [];
  const variants: Array<[number, 0 | 90]> = [];
  // 100 % always; another size only where the pack's blocks resize and the wand offers it.
  for (const size of options.sizes ?? CHILD_PLAY_SIZES) {
    if (size !== 100 && !(pack.placement.resizable && pack.placement.sizes.includes(size))) continue;
    variants.push([size, 0], [size, 90]);
  }
  const common = { allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES] };
  for (const [size, rot] of variants) {
    const steps: Step[] = [{ kind: 'place', size, rotation: rot }, { kind: 'wait', ticks: 40 }];
    if (pack.interactives?.items.length) steps.push({ kind: 'tapInteractives' }, { kind: 'doorwayLines' });
    steps.push({ kind: 'undo' });
    out.push({ name: `place-${size}-${rot}`, description: `Place at ${size} percent, turn ${rot}; tap every moving part; walk every doorway; Undo.`, steps, ...common });
  }
  const play: Step[] = [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }];
  if (options.shots) play.push({ kind: 'snapshot', name: 'placed' });
  for (const r of pack.rides?.rides ?? []) {
    if (r.kind === 'slide') play.push({ kind: 'rideSlide', index: r.index, board: 'tap' });
    if (r.kind === 'lift') play.push({ kind: 'rideLift', index: r.index, trips: 3 });
  }
  for (const r of pack.funfair?.rides ?? []) play.push({ kind: 'rideFunfair', index: r.index, riders: 2 });
  // A flyer's cloud is a vehicle type too, but none is placed: it is SUMMONED by a tap, and `flyMount` flies it.
  const summoned = new Set(pack.flyers.map(f => f.cloudType));
  for (const t of pack.vehicleTypes) if (!summoned.has(t)) play.push({ kind: 'driveVehicle', type: t, ticks: options.quick ? 200 : 600 });
  if (pack.flyers.length) play.push({ kind: 'flyMount' });
  play.push({ kind: 'figuresLive', ticks: options.quick ? 1200 : FIGURE_LIFE_TICKS });
  if (options.shots) play.push({ kind: 'snapshot', name: 'figures-lived' });
  play.push({ kind: 'visitSeatedFigures' }, { kind: 'undo' });
  out.push({ name: 'play-100-0', description: 'Ride every ride by a tap, drive every vehicle 30 s, fly the mount, let the figures live 5 minutes, visit the seated ones, Undo.', steps: play, ...common });
  // A drop tower or sky swing at every wand size placed, with two riders each on a seat of their own (BIZ-20: every
  // length of the ride scales with the size and no time does).
  if (pack.funfair?.rides.length) {
    for (const [size, rot] of variants) {
      // The wand refuses a build taller than the world (384 blocks, -64..319): a tower of 100 blocks has no 400 percent.
      if (rot !== 0 || pack.placement.height * size / 100 > WORLD_HEIGHT_BLOCKS) continue;
      out.push({ name: `funfair-${size}`, description: `Place at ${size} percent; ride every drop tower and sky swing with two riders by a tap; Undo.`, steps: [{ kind: 'place', size, rotation: 0 }, { kind: 'wait', ticks: 40 }, ...pack.funfair.rides.map(r => ({ kind: 'rideFunfair', index: r.index, riders: 2 }) as Step), { kind: 'undo' }], ...common });
    }
  }
  // Every rideable's seat at every wand step (25-400 %), from the JSON: the fault grows with the size
  // (76286's rider was inside the hull's envelope at 150 % and six blocks over it at 200 %, Saga 30k),
  // so the sizes a scenario places at cannot stand for the rest.
  out.push({ name: 'seats-every-size', description: 'Every rideable seat, as the device realises it, in or on the drawn vehicle at every wand size (SEAT-01).', steps: [{ kind: 'seatsEverySize' }], ...common });
  return out;
}

/** Read a pack and build its child-play scenarios with their handlers (undefined for a non-craftmatic pack). */
export function childPlay(addon: Addon, options: ChildPlayOptions = {}): { pack: CraftmaticPack; scenarios: Scenario[]; handlers: Record<string, StepHandler> } | undefined {
  const pack = readCraftmaticPack(addon);
  if (!pack) return undefined;
  return { pack, scenarios: childPlayScenarios(pack, options), handlers: craftmaticHandlers(pack, addon) };
}

