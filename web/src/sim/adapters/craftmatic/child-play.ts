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
import { IX_KEYS } from '../../../engine/bedrock-interactives.js';
import type { Addon } from '../../pack/pack.js';
import { readCraftmaticPack, type CraftmaticPack } from './pack-facts.js';
import { wandHandlers } from './wand.js';
import { FIGURE_TYPE, playHandlers, placedOf, staticDrawn, tapPart } from './play.js';
import { registerAppearance, vehicleCourseHandlers } from './vehicle-course.js';
import { packAppearance } from './drawn.js';
import { firstPersonSnapshot } from './snapshot.js';
import { lookAt } from '../../input/touch.js';
import { rayBox } from '../../core/vec.js';
import { PLAYER_EYE_HEIGHT } from '../../physics/body.js';
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
      const parts = [...ctx.sim.engine.entities.values()].filter(e => e.valid && typeof e.dynamic.get(IX_KEYS.index) === 'number');
      for (const part of parts) {
        const idx = e2n(part.dynamic.get(IX_KEYS.index));
        const label = pack.interactives?.items[idx]?.label ?? part.typeId;
        const state = (): string => JSON.stringify([part.dynamic.get(IX_KEYS.open), part.properties.get('craftmatic:angle')]);
        const before = state();
        if (!await tapPart(ctx, part, label, () => state() !== before, pack)) {
          const refused = part.dynamic.get('craftmatic:ix_refused');
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
      const seated = [...ctx.sim.engine.entities.values()].filter(e => e.valid && FIGURE_TYPE.test(e.typeId) && e.ridingOn && figureMode(e) === 'seated');
      const walkersSitting = [...ctx.sim.engine.entities.values()].filter(e => e.valid && FIGURE_TYPE.test(e.typeId) && e.ridingOn && figureMode(e) !== 'seated');
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
export function figureMode(e: SimEntity): string | undefined {
  const raw = e.dynamic.get('craftmatic:fig');
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

/** The child-play scenarios for one pack. */
export function childPlayScenarios(pack: CraftmaticPack, options: { quick?: boolean; shots?: boolean } = {}): Scenario[] {
  const out: Scenario[] = [];
  const variants: Array<[number, 0 | 90]> = [[100, 0], [100, 90]];
  if (pack.placement.resizable && pack.placement.sizes.includes(150)) variants.push([150, 0], [150, 90]);
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
  // A flyer's cloud is a vehicle type too, but none is placed: it is SUMMONED by a tap, and `flyMount` flies it.
  const summoned = new Set(pack.flyers.map(f => f.cloudType));
  for (const t of pack.vehicleTypes) if (!summoned.has(t)) play.push({ kind: 'driveVehicle', type: t, ticks: options.quick ? 200 : 600 });
  if (pack.flyers.length) play.push({ kind: 'flyMount' });
  play.push({ kind: 'figuresLive', ticks: options.quick ? 1200 : FIGURE_LIFE_TICKS });
  if (options.shots) play.push({ kind: 'snapshot', name: 'figures-lived' });
  play.push({ kind: 'visitSeatedFigures' }, { kind: 'undo' });
  out.push({ name: 'play-100-0', description: 'Ride every ride by a tap, drive every vehicle 30 s, fly the mount, let the figures live 5 minutes, visit the seated ones, Undo.', steps: play, ...common });
  // Every rideable's seat at every wand step (25-400 %), from the JSON: the fault grows with the size
  // (76286's rider was inside the hull's envelope at 150 % and six blocks over it at 200 %, Saga 30k),
  // so the sizes a scenario places at cannot stand for the rest.
  out.push({ name: 'seats-every-size', description: 'Every rideable seat, as the device realises it, in or on the drawn vehicle at every wand size (SEAT-01).', steps: [{ kind: 'seatsEverySize' }], ...common });
  return out;
}

/** Read a pack and build its child-play scenarios with their handlers (undefined for a non-craftmatic pack). */
export function childPlay(addon: Addon, options: { quick?: boolean; shots?: boolean } = {}): { pack: CraftmaticPack; scenarios: Scenario[]; handlers: Record<string, StepHandler> } | undefined {
  const pack = readCraftmaticPack(addon);
  if (!pack) return undefined;
  return { pack, scenarios: childPlayScenarios(pack, options), handlers: craftmaticHandlers(pack, addon) };
}

