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
import { findApproach } from '../../scenario/approach.js';
import { IX_KEYS } from '../../../engine/bedrock-interactives.js';
import type { Addon } from '../../pack/pack.js';
import { readCraftmaticPack, type CraftmaticPack } from './pack-facts.js';
import { wandHandlers } from './wand.js';
import { playHandlers, placedOf, tapPart } from './play.js';
import { packAppearance } from './drawn.js';

/** Lines a craftmatic pack prints that are not faults (the wand's own progress and the pack's diagnostics it shows on purpose). */
export const CRAFTMATIC_ALLOWED_LINES: readonly RegExp[] = [/BRICK_WAND_READY/, /CRAFTMATIC_[A-Z_]+_READY/];

/** How long figures live in the play scenario (5 simulated minutes). */
export const FIGURE_LIFE_TICKS = 6000;

/** The adapter's step handlers for one pack (wand + play + the child-play extras). */
export function craftmaticHandlers(pack: CraftmaticPack, addon: Addon): Record<string, StepHandler> {
  const appearance = packAppearance(addon);
  return { ...wandHandlers(pack), ...playHandlers(pack, appearance), ...extraHandlers(pack) };
}

function extraHandlers(pack: CraftmaticPack): Record<string, StepHandler> {
  return {
    /** Tap every moving part once; each must change its state (open/closed, turned). */
    async tapInteractives(_step: AnyStep, ctx: StepContext) {
      const parts = [...ctx.sim.engine.entities.values()].filter(e => e.valid && typeof e.dynamic.get(IX_KEYS.index) === 'number');
      for (const part of parts) {
        const idx = e2n(part.dynamic.get(IX_KEYS.index));
        const label = pack.interactives?.items[idx]?.label ?? part.typeId;
        const state = (): string => JSON.stringify([part.dynamic.get(IX_KEYS.open), part.properties.get('craftmatic:angle')]);
        const before = state();
        if (!await tapPart(ctx, part, label, () => state() !== before)) {
          const refused = part.dynamic.get('craftmatic:ix_refused');
          ctx.violate({ invariant: 'tap-moves-part', message: `no tap on ${label} from any spot within reach changed it${refused ? ` (the part refused: ${String(refused)})` : ''}`, evidence: { part: part.typeId, state: before, at: part.location } });
        }
        // A double door's second leaf moves with the first: close the pair again so each leaf is tapped from rest.
        await ctx.run(8);
      }
      ctx.note(`tapped ${parts.length} moving parts`);
    },

    /** Walk up to each seated figure (it yields its seat), step away (it should take it back). */
    async visitSeatedFigures(_step: AnyStep, ctx: StepContext) {
      const placed = placedOf(ctx);
      const seated = [...ctx.sim.engine.entities.values()].filter(e => e.valid && /_fig\d+$/.test(e.typeId) && e.ridingOn);
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

/** The child-play scenarios for one pack. */
export function childPlayScenarios(pack: CraftmaticPack, options: { quick?: boolean } = {}): Scenario[] {
  const out: Scenario[] = [];
  const variants: Array<[number, 0 | 90]> = [[100, 0], [100, 90]];
  if (pack.placement.resizable && pack.placement.sizes.includes(150)) variants.push([150, 0], [150, 90]);
  const common = { allowLines: [...CRAFTMATIC_ALLOWED_LINES] };
  for (const [size, rot] of variants) {
    const steps: Step[] = [{ kind: 'place', size, rotation: rot }, { kind: 'wait', ticks: 40 }];
    if (pack.interactives?.items.length) steps.push({ kind: 'tapInteractives' }, { kind: 'doorwayLines' });
    steps.push({ kind: 'undo' });
    out.push({ name: `place-${size}-${rot}`, description: `Place at ${size} percent, turn ${rot}; tap every moving part; walk every doorway; Undo.`, steps, ...common });
  }
  const play: Step[] = [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }];
  for (const r of pack.rides?.rides ?? []) {
    if (r.kind === 'slide') play.push({ kind: 'rideSlide', index: r.index, board: 'tap' });
    if (r.kind === 'lift') play.push({ kind: 'rideLift', index: r.index, trips: 3 });
  }
  for (const t of pack.vehicleTypes) play.push({ kind: 'driveVehicle', type: t, ticks: options.quick ? 200 : 600 });
  if (pack.flyers.length) play.push({ kind: 'flyMount' });
  play.push({ kind: 'figuresLive', ticks: options.quick ? 1200 : FIGURE_LIFE_TICKS }, { kind: 'visitSeatedFigures' }, { kind: 'undo' });
  out.push({ name: 'play-100-0', description: 'Ride every ride by a tap, drive every vehicle 30 s, fly the mount, let the figures live 5 minutes, visit the seated ones, Undo.', steps: play, ...common });
  return out;
}

/** Read a pack and build its child-play scenarios with their handlers (undefined for a non-craftmatic pack). */
export function childPlay(addon: Addon, options: { quick?: boolean } = {}): { pack: CraftmaticPack; scenarios: Scenario[]; handlers: Record<string, StepHandler> } | undefined {
  const pack = readCraftmaticPack(addon);
  if (!pack) return undefined;
  return { pack, scenarios: childPlayScenarios(pack, options), handlers: craftmaticHandlers(pack, addon) };
}

