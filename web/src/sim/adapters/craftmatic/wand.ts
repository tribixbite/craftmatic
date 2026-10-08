/**
 * The Brick Wand, used as a child uses it: select it (the preview follows the
 * aim), look at a spot on the ground, use it, read the menu, turn and size
 * with its buttons, Place, confirm "Place now"; later, Undo. Every form is the
 * pack's own (`scripts/placement.js`), answered by reading its buttons; the
 * step only decides which button a child would press.
 *
 * Steps (registered with the runner):
 *   { kind: 'place', size?: 100, rotation?: 0, distance?: blocks ahead }
 *   { kind: 'undo' }
 */

import type { StepContext, StepHandler, AnyStep } from '../../scenario/types.js';
import type { FormAnswer, ShownForm } from '../../script-host/ui-module.js';
import { plainText } from '../../script-host/text.js';
import { lookAt } from '../../input/touch.js';
import { teleport } from '../../script-host/facades.js';
import { FLAT_GROUND_Y } from '../../world/voxel-world.js';
import type { CraftmaticPack, Placed } from './pack-facts.js';
import type { PlacementRotation } from '../../../engine/bedrock-placement-pack.js';

/** The adapter's scenario state key for the placement. */
export const PLACED_KEY = 'craftmatic.placed';
/** Where the player stood to place (Undo is taken from there). */
const START_KEY = 'craftmatic.start';
/** The snapshot of the placement's box taken before placing (for the Undo check). */
const SNAPSHOT_KEY = 'craftmatic.snapshot';

/** How long a placement may take before the step gives up (ticks). */
const PLACE_TIMEOUT_TICKS = 6000;

/** A wand menu's state, read from its form like a player reads it. */
function menuState(f: ShownForm): { rotation?: number; size?: number } {
  const rot = /·\s*(\d+)°/.exec(plainText(f.body));
  const sizeButton = f.buttons.map(plainText).find(b => /^Size \d+ percent/.test(b));
  const size = sizeButton ? Number(/^Size (\d+) percent/.exec(sizeButton)![1]) : undefined;
  return { ...(rot ? { rotation: Number(rot[1]) } : {}), ...(size !== undefined ? { size } : {}) };
}

/** Parse the confirm form's summary: `W × H × L blocks` and `Origin: x, y, z`. */
function confirmSummary(f: ShownForm): { dims?: { w: number; h: number; l: number }; origin?: { x: number; y: number; z: number } } {
  const body = plainText(f.body);
  const d = /(\d+) × (\d+) × (\d+) blocks/.exec(body), o = /Origin: (-?\d+), (-?\d+), (-?\d+)/.exec(body);
  return { ...(d ? { dims: { w: Number(d[1]), h: Number(d[2]), l: Number(d[3]) } } : {}), ...(o ? { origin: { x: Number(o[1]), y: Number(o[2]), z: Number(o[3]) } } : {}) };
}

/** Wait until a chat line matches, or the timeout. */
async function waitForChat(ctx: StepContext, re: RegExp, maxTicks: number, since: number, stop: () => boolean = () => false): Promise<string | undefined> {
  // Scanned from where the last tick left off: a long placement's timeline is not re-read every tick.
  let from = since;
  for (let t = 0; t < maxTicks && !stop(); t++) {
    const entries = ctx.sim.engine.timeline.entries;
    for (; from < entries.length; from++) { const e = entries[from]!; if (e.kind === 'chat' && re.test(plainText(e.text))) return plainText(e.text); }
    await ctx.run(1);
  }
  return undefined;
}

/**
 * How many times the menu may come back after a child pressed Place before the pack is taken to refuse the
 * placement. The runtime's `confirmPlace` answers a refused one (`validate` throws) by telling the reason and
 * reopening the menu; a chooser that pressed Place again recursed for ever - an unbounded async chain that grew past
 * 64 GB on 76457 at 300 % and crashed Bun (`TODO(seat-sweep-memory)`, found 2026-10-08 with
 * `scripts/_sim_memory_probe.ts`: the stack was menu -> confirmPlace -> menu -> ...).
 */
const MAX_PLACE_PRESSES = 3;
/**
 * How far (blocks) the wand's aim reaches: `getBlockFromViewDirection({ maxDistance: 96 })` in the placement
 * runtime, less a margin. A spot farther ahead - where a model at 300-400 % must be centred to miss the child - is
 * entered through the menu's "Edit coordinates" instead, as a child who cannot aim that far would.
 */
const WAND_AIM_REACH = 90;

/** Select the wand in the hotbar (slot 0) or put it away (slot 1). */
function holdWand(ctx: StepContext, pack: CraftmaticPack, hold: boolean): void {
  const st = ctx.sim.host.playerState(ctx.player);
  st.items[0] = pack.placement.itemId;
  st.selectedSlot = hold ? 0 : 1;
}

/**
 * Open the wand's menu as a child does: select the wand (with an anchor, the
 * selection itself opens the menu; a fresh wand only starts following the
 * aim), then use it if no menu came up. The chooser answers what opens.
 */
async function openMenu(ctx: StepContext, pack: CraftmaticPack, since: number): Promise<void> {
  const menuShown = (): boolean => ctx.sim.engine.timeline.entries.slice(since).some(e => e.kind === 'form' && / · Brick Wand \|/.test(plainText(e.text)));
  holdWand(ctx, pack, true);
  await ctx.run(12);
  for (let tries = 0; tries < 2 && !menuShown(); tries++) {
    ctx.sim.engine.emit('itemUse', { source: ctx.player, itemTypeId: pack.placement.itemId });
    await ctx.run(4);
  }
}

/** The wand steps for one craftmatic pack. */
export function wandHandlers(pack: CraftmaticPack): Record<string, StepHandler> {
  return {
    async place(step: AnyStep, ctx: StepContext) {
      const size = Number(step['size'] ?? 100), rotation = Number(step['rotation'] ?? 0) as PlacementRotation;
      const f = size / 100;
      const turned = rotation % 180 ? { w: pack.placement.length, l: pack.placement.width } : { w: pack.placement.width, l: pack.placement.length };
      // Stand clear of the footprint: aim at a ground block far enough ahead (+X) that the model, centred there, misses the player.
      const ahead = Number(step['distance'] ?? Math.ceil(Math.max(turned.w, turned.l) * f / 2) + 6);
      const p = ctx.player;
      ctx.state[START_KEY] = { ...p.location };
      p.rotation = { x: 0, y: -90 };
      // Aim at the ground's TOP face: a point inside the block (y - 0.5) is met by the grazing view ray where it
      // first crosses the top, 11 blocks short at 45 ahead, and 76457 (77 wide) was placed over the child's feet.
      const target = { x: Math.floor(p.location.x) + ahead + 0.5, y: FLAT_GROUND_Y, z: Math.floor(p.location.z) + 0.5 };
      lookAt(p, target);
      let confirmed: ShownForm | undefined;
      let presses = 0, refused = false, entered = false;
      // Beyond the aim's reach, the origin is entered as coordinates (the runtime anchors at the block under the aim).
      const typed = Math.hypot(target.x - p.location.x, target.z - p.location.z) > WAND_AIM_REACH;
      ctx.sim.host.chooser = (form: ShownForm): FormAnswer => {
        const title = plainText(form.title);
        // The coordinates are the model's CORNER (the aim centres it there instead: `pinCentredAt`), on the ground.
        if (/· Coordinates$/.test(title)) { entered = true; return { values: [String(Math.floor(target.x - turned.w * f / 2)), String(target.y), String(Math.floor(target.z - turned.l * f / 2))] }; }
        if (/· Brick Wand$/.test(title)) {
          const s = menuState(form);
          if (form.buttons.some(b => b.startsWith('Cancel placement'))) return { cancel: true };
          if (typed && !entered && form.buttons.some(b => plainText(b) === 'Edit coordinates')) return { button: 'Edit coordinates' };
          if (s.rotation !== undefined && s.rotation !== rotation) return { button: 'Rotate' };
          if (s.size !== undefined && s.size !== size) return { button: 'Size' };
          // The menu back again after Place, again and again: the pack refuses this placement (a child would stop).
          if (++presses > MAX_PLACE_PRESSES) { refused = true; return { cancel: true }; }
          return { button: 'Place' };
        }
        if (/^Place .*\?$/.test(title) && form.buttons.includes('Place now')) {
          confirmed = form;
          const sum = confirmSummary(form);
          // Snapshot the box before it changes: the Undo check compares against it.
          if (sum.origin && sum.dims) {
            const w = ctx.sim.engine.dimension(p.dimension), ids: number[] = [];
            for (let x = 0; x < sum.dims.w; x++) for (let y = 0; y < sum.dims.h; y++) for (let z = 0; z < sum.dims.l; z++) ids.push(w.rawId(sum.origin.x + x, sum.origin.y + y, sum.origin.z + z));
            ctx.state[SNAPSHOT_KEY] = { origin: sum.origin, dims: sum.dims, ids };
          }
          return { button: 'Place now' };
        }
        return { cancel: true };
      };
      const since = ctx.sim.engine.timeline.entries.length;
      await openMenu(ctx, pack, since);
      const line = await waitForChat(ctx, /Placed |Placement stopped/, PLACE_TIMEOUT_TICKS, since, () => refused);
      holdWand(ctx, pack, false);
      ctx.sim.host.chooser = () => ({ cancel: true });
      if (refused) {
        // What the pack told the child (its `tell`: chat or action bar) is the reason.
        const said = ctx.sim.engine.timeline.entries.slice(since).filter(e => e.kind === 'chat' || e.kind === 'actionbar').map(e => plainText(e.text)).filter(t => !/Brick Wand.*percent/.test(t)).slice(-2).join(' / ');
        throw new Error(`place: the pack refused ${size} percent turn ${rotation}${said ? `: ${said}` : ''} (the menu came back after Place ${MAX_PLACE_PRESSES} times)`);
      }
      if (!line) throw new Error(`place: no "Placed" line within ${PLACE_TIMEOUT_TICKS} ticks`);
      if (/stopped/.test(line)) ctx.violate({ invariant: 'placement-completes', message: line });
      const sum = confirmed ? confirmSummary(confirmed) : {};
      if (!sum.origin || !sum.dims) throw new Error('place: the confirm form named no origin');
      const placed: Placed = { anchor: sum.origin, rotation, sizePct: size, from: sum.origin, to: { x: sum.origin.x + sum.dims.w - 1, y: sum.origin.y + sum.dims.h - 1, z: sum.origin.z + sum.dims.l - 1 } };
      ctx.state[PLACED_KEY] = placed;
      ctx.note(`placed at ${sum.origin.x},${sum.origin.y},${sum.origin.z} ${size} % turn ${rotation}: ${line}`);
    },

    async undo(_step: AnyStep, ctx: StepContext) {
      const p = ctx.player;
      ctx.sim.host.chooser = (form: ShownForm): FormAnswer => (/· Brick Wand$/.test(plainText(form.title)) ? { button: 'Undo last placement' } : { cancel: true });
      // The child walks back out to where it placed from before undoing (an Undo taken standing inside the
      // model drops the player with the building - true, but not what this step checks).
      const start = ctx.state[START_KEY] as { x: number; y: number; z: number } | undefined;
      if (start) teleport(ctx.sim.host, p, start); else if (p.ridingOn) p.ridingOn.removeRider(p);
      const since = ctx.sim.engine.timeline.entries.length;
      await openMenu(ctx, pack, since);
      const line = await waitForChat(ctx, /Undo complete|Nothing to undo|Undo stopped/, PLACE_TIMEOUT_TICKS, since);
      holdWand(ctx, pack, false);
      ctx.sim.host.chooser = () => ({ cancel: true });
      await ctx.run(4);
      if (!line) throw new Error('undo: no "Undo complete" line');
      if (!/Undo complete/.test(line)) ctx.violate({ invariant: 'nothing-left-after-undo', message: line });
      // Nothing of the pack may be left: its entities, and any block of the box not as it was.
      // The placement tags every entity it spawns (`cmu_...`); one still standing is a leftover. The pack's other
      // entities (a summoned cloud, which fades by itself) are noted, not failed.
      const ours = new Set(ctx.sim.engine.definitions.all().map(d => d.identifier));
      const placementActors = () => [...ctx.sim.engine.entities.values()].filter(e => e.valid && ours.has(e.typeId) && [...e.tags].some(t => t.startsWith('cmu_')));
      const remote = placementActors().filter(e => !ctx.sim.engine.isEntityLoaded(e));
      // Undo deliberately defers a driven/flown actor outside the placement box
      // until its chunk loads. Load every surviving actor's actual chunk and
      // require the runtime's entityLoad cleanup to finish; a loaded leftover
      // still fails the same invariant below.
      const auditAreas: string[] = [];
      for (const [i, e] of remote.entries()) {
        const name = `cm_undo_audit_${ctx.sim.engine.tick}_${i}`, x = Math.floor(e.location.x) & ~15, z = Math.floor(e.location.z) & ~15;
        ctx.sim.engine.tickingAreas.set(name, { name, dimension: e.dimension, x0: x, z0: z, x1: x + 15, z1: z + 15 });
        auditAreas.push(name);
      }
      if (auditAreas.length) {
        await ctx.run(2);
        for (const name of auditAreas) ctx.sim.engine.tickingAreas.delete(name);
        await ctx.run(1);
      }
      const alive = [...ctx.sim.engine.entities.values()].filter(e => e.valid && ours.has(e.typeId));
      const left = alive.filter(e => [...e.tags].some(t => t.startsWith('cmu_')));
      const others = alive.filter(e => !left.includes(e));
      if (remote.length && !left.length) ctx.note(`after Undo, loaded ${remote.length} remote placement actor chunk${remote.length === 1 ? '' : 's'}; deferred cleanup removed every actor`);
      if (others.length) ctx.note(`after Undo, ${others.length} entit${others.length === 1 ? 'y' : 'ies'} the placement did not spawn remain: ${[...new Set(others.map(e => e.typeId))].join(', ')}`);
      if (left.length) ctx.violate({ invariant: 'nothing-left-after-undo', message: `${left.length} entit${left.length === 1 ? 'y' : 'ies'} left after Undo: ${[...new Set(left.map(e => e.typeId))].slice(0, 6).join(', ')}`, evidence: { entities: left.slice(0, 10).map(e => ({ type: e.typeId, at: e.location })) } });
      const snap = ctx.state[SNAPSHOT_KEY] as { origin: { x: number; y: number; z: number }; dims: { w: number; h: number; l: number }; ids: number[] } | undefined;
      if (snap) {
        const w = ctx.sim.engine.dimension(p.dimension);
        let changed = 0, i = 0;
        const sample: string[] = [];
        for (let x = 0; x < snap.dims.w; x++) for (let y = 0; y < snap.dims.h; y++) for (let z = 0; z < snap.dims.l; z++, i++) {
          const now = w.rawId(snap.origin.x + x, snap.origin.y + y, snap.origin.z + z);
          if (now !== snap.ids[i]) { changed++; if (sample.length < 5) sample.push(`${snap.origin.x + x},${snap.origin.y + y},${snap.origin.z + z} ${w.palette.get(now).typeId}`); }
        }
        if (changed) ctx.violate({ invariant: 'nothing-left-after-undo', message: `${changed} block${changed === 1 ? '' : 's'} of the placement's box differ after Undo`, evidence: { sample } });
      }
      delete ctx.state[PLACED_KEY];
    },
  };
}
