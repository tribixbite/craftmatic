/**
 * Sweep EVERY scenery seat of built packs on the headless simulator and count
 * the seats a child cannot get off (bedrock-figure-life.ts `safeSeatDismounts`,
 * docs/physics-architecture.md §4.8 "A scenery seat's set-down").
 *
 * Per pack: place at each `--sizes` percentage (turn 0), then for each seat
 * entity of the pack's figure config `seatTypes`: stand any figure off it, put
 * the player on it (`addRider`, the same mount a hold makes), press Sneak, let
 * it settle, and judge the outcome:
 *
 *   OK        off the seat, and a forward walk of 8 ticks moves the player at
 *             least one block in one of four headings (the egress probe's rule);
 *   RESEATED  still on the seat after `SNEAK_TRIES` presses of Sneak (the
 *             runtime refused every dismount): a TRAP;
 *   STUCK     off the seat but unable to walk one block: a TRAP;
 *   FELL      off the seat by a FALL of more than `FALL_LIMIT` blocks (the engine's `landed` fall
 *             distance; a teleport to the ground beside the model is not a fall).
 *
 * Each row also records `shift`, how far (horizontally) from the seat the player ended: a near set-down is
 * about a block, the last resort's exterior is the model's half-width or more.
 *
 * `--runtime=tree` rebuilds the pack's runtimes (figures.js among them) from
 * their shipped CONFIG with the CURRENT tree's code (`runtime-swap.ts`), so two
 * trees can be compared on identical worlds; `--runtime=pack` (default) runs
 * the scripts as shipped.
 *
 * Usage:
 *   bun scripts/_seat_egress_sweep.ts <pack.mcaddon | dir>… [--runtime=pack|tree] [--sizes=100,300]
 *        [--json=<out.json>] [--md=<out.md>]
 * Exit 1 when any seat is a trap (RESEATED or STUCK) or FELL.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readAddon, behaviorPacks, packText, type Addon } from '../web/src/sim/pack/pack.ts';
import { extractJsonAfter } from '../web/src/sim/pack/script-config.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { swapTreeRuntimes } from '../web/src/sim/adapters/craftmatic/runtime-swap.ts';
import type { FigureLifeConfig } from '../web/src/engine/bedrock-figure-life.ts';
import type { SimEntity } from '../web/src/sim/entity/entity.ts';
import type { StepContext } from '../web/src/sim/scenario/types.ts';

/** Sneak presses tried before a seat that keeps re-seating counts as a trap (a child presses again). */
const SNEAK_TRIES = 3;
/** Ticks after a Sneak before the outcome is read: the watcher acts the next tick, a fall lands within this. */
const SETTLE_TICKS = 20;
/** Ticks of a forward walk per heading, and the distance one must reach (the egress probe's rule). */
const WALK_TICKS = 8, WALK_BLOCKS = 1;
/** A landing this far under the seat entity is a fall, not a set-down (the rides' no-damage drop). */
const FALL_LIMIT = 3;
/** A landing farther than this from its seat (blocks) is printed even when OK: the last resort moved the player. */
const SHIFT_NOTE = 3;

type Verdict = 'OK' | 'RESEATED' | 'STUCK' | 'FELL';
interface SeatRow { pack: string; size: number; seat: number; type: string; at: { x: number; y: number; z: number }; verdict: Verdict; sneaks: number; landing?: { x: number; y: number; z: number }; walk?: number; shift?: number; fall?: number; lines: string[] }

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const runtime = flag('runtime') ?? 'pack';
const sizes = (flag('sizes') ?? '100').split(',').map(Number).filter(n => n > 0);
const inputs = args.filter(a => !a.startsWith('--'));
const files = inputs.flatMap(p => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(p, f)) : [p]));
if (!files.length || (runtime !== 'pack' && runtime !== 'tree')) {
  console.error('usage: bun scripts/_seat_egress_sweep.ts <pack.mcaddon | dir>… [--runtime=pack|tree] [--sizes=100,300] [--json=] [--md=]');
  process.exit(2);
}

const load = async (file: string): Promise<Addon> => {
  const b = readFileSync(file);
  const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
  if (runtime === 'tree') swapTreeRuntimes(addon);
  return addon;
};
/** The pack's scenery seat types: figures.js CONFIG `seatTypes`. */
const seatTypesOf = (addon: Addon): string[] => {
  for (const pack of behaviorPacks(addon)) {
    const text = packText(pack, 'scripts/figures.js');
    const config = text ? extractJsonAfter(text, 'const CONFIG') as FigureLifeConfig | undefined : undefined;
    if (config?.seatTypes?.length) return config.seatTypes;
  }
  return [];
};

/** Off the seat: how far a forward walk of `WALK_TICKS` gets in the best of four headings (the player is put back each time). */
const walkReach = async (ctx: StepContext): Promise<number> => {
  const landed = { ...ctx.player.location };
  let best = 0;
  for (const yaw of [0, 90, 180, 270]) {
    ctx.player.location = { ...landed };
    ctx.player.velocity = { x: 0, y: 0, z: 0 };
    ctx.player.rotation.y = yaw;
    ctx.sim.controls.set(ctx.player.id, { forward: 1, strafe: 0, jump: false });
    await ctx.run(WALK_TICKS);
    ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false });
    best = Math.max(best, Math.hypot(ctx.player.location.x - landed.x, ctx.player.location.z - landed.z));
  }
  ctx.player.location = { ...landed };
  ctx.player.velocity = { x: 0, y: 0, z: 0 };
  return best;
};

const rows: SeatRow[] = [];
for (const file of files) {
  const name = basename(file);
  const probe = await load(file);
  const pack = readCraftmaticPack(probe);
  const seatTypes = seatTypesOf(probe);
  if (!pack || !seatTypes.length) { console.log(`${name}: no scenery seats`); continue; }
  for (const size of sizes) {
    if (!pack.placement.sizes.includes(size) && size !== 100) { console.log(`${name}: ${size} % not offered`); continue; }
    const addon = await load(file);
    const p = readCraftmaticPack(addon)!;
    const result = await runScenario({
      name: `seat-egress-${size}`,
      // Only the outcome is judged here; the child-play invariants run in sim.ts.
      invariants: [],
      steps: [
        { kind: 'place', size, rotation: 0 },
        { kind: 'wait', ticks: 40 },
        {
          kind: 'expect', label: 'every-seat', check: async (ctx: StepContext) => {
            const tick = (): number => ctx.sim.engine.tick;
            // The largest fall the player lands from while one seat is judged.
            let fall = 0;
            ctx.sim.engine.on('landed', ev => { if (ev.entity === ctx.player) fall = Math.max(fall, ev.fallDistance); });
            const seats = [...ctx.sim.engine.entities.values()].filter((e: SimEntity) => e.valid && seatTypes.includes(e.typeId))
              .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
            for (const [i, seat] of seats.entries()) {
              for (const r of seat.riderList()) seat.removeRider(r); // a figure stands up for the child anyway
              const before = ctx.sim.engine.timeline.entries.length;
              const at = { ...seat.location };
              ctx.player.location = { x: at.x, y: at.y, z: at.z };
              fall = 0;
              const added = seat.addRider(ctx.player, tick());
              if (!added.ok) { console.log(`  ${name} ${size}% seat ${i}: addRider refused (${added.why})`); continue; }
              await ctx.run(2);
              let sneaks = 0;
              while (ctx.player.ridingOn && sneaks < SNEAK_TRIES) {
                sneaks++;
                ctx.sim.controls.set(ctx.player.id, { sneak: true });
                await ctx.run(1);
                ctx.sim.controls.set(ctx.player.id, { sneak: false });
                await ctx.run(SETTLE_TICKS);
              }
              const lines = ctx.sim.engine.timeline.entries.slice(before)
                .filter(e => e.kind === 'actionbar' || e.kind === 'console').map(e => `${e.kind}: ${e.text}`);
              const row: SeatRow = { pack: name, size, seat: i, type: seat.typeId, at, verdict: 'OK', sneaks, lines };
              if (ctx.player.ridingOn) {
                row.verdict = 'RESEATED';
                ctx.player.ridingOn.removeRider(ctx.player);
              } else {
                row.landing = { ...ctx.player.location };
                row.shift = Math.hypot(row.landing.x - at.x, row.landing.z - at.z);
                row.fall = fall;
                row.walk = await walkReach(ctx);
                row.verdict = fall > FALL_LIMIT ? 'FELL' : row.walk < WALK_BLOCKS ? 'STUCK' : 'OK';
              }
              rows.push(row);
              if (row.verdict !== 'OK' || (row.shift ?? 0) > SHIFT_NOTE) console.log(`  ${name} ${size}% seat ${i} ${row.verdict} at ${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}${row.landing ? ` landing ${row.landing.x.toFixed(2)},${row.landing.y.toFixed(2)},${row.landing.z.toFixed(2)} shift ${row.shift!.toFixed(2)} fall ${row.fall!.toFixed(2)} walk ${row.walk!.toFixed(2)}` : ''}${lines.length ? ` | ${lines.join(' | ').slice(0, 200)}` : ''}`);
            }
            return undefined;
          },
        },
      ],
    }, [addon], { handlers: craftmaticHandlers(p, addon) });
    const failed = result.steps.filter(s => !s.ok);
    if (failed.length) console.log(`  ${name} ${size}%: step error ${failed.map(s => `${s.label}: ${s.error}`).join('; ')}`);
    const mine = rows.filter(r => r.pack === name && r.size === size);
    console.log(`${name} ${size}%: ${mine.length} seat(s), ${mine.filter(r => r.verdict === 'OK').length} OK, ${mine.filter(r => r.verdict !== 'OK').length} not`);
  }
}

const count = (v: Verdict): number => rows.filter(r => r.verdict === v).length;
const traps = count('RESEATED') + count('STUCK');
const far = rows.filter(r => (r.shift ?? 0) > SHIFT_NOTE).length;
const summary = `runtime=${runtime} sizes=${sizes.join(',')}: ${rows.length} seat(s) over ${new Set(rows.map(r => r.pack)).size} pack(s): OK ${count('OK')}, RESEATED ${count('RESEATED')}, STUCK ${count('STUCK')}, FELL ${count('FELL')} -> ${traps} trapped; ${far} set down more than ${SHIFT_NOTE} blocks from the seat`;
console.log(`\n${summary}`);
if (flag('json')) writeFileSync(flag('json')!, JSON.stringify({ runtime, sizes, rows }, null, 1));
if (flag('md')) {
  const shown = rows.filter(r => r.verdict !== 'OK' || (r.shift ?? 0) > SHIFT_NOTE);
  writeFileSync(flag('md')!, `# Scenery seat egress sweep\n\n${summary}\n\nRows not OK, or set down more than ${SHIFT_NOTE} blocks from the seat:\n\n| pack | size | seat | verdict | seat at | landing | shift | fall | walk |\n|---|---|---|---|---|---|---|---|---|\n${shown.map(r => `| ${r.pack} | ${r.size} | ${r.seat} | ${r.verdict} | ${r.at.x.toFixed(2)}, ${r.at.y.toFixed(2)}, ${r.at.z.toFixed(2)} | ${r.landing ? `${r.landing.x.toFixed(2)}, ${r.landing.y.toFixed(2)}, ${r.landing.z.toFixed(2)}` : '-'} | ${r.shift?.toFixed(2) ?? '-'} | ${r.fall?.toFixed(2) ?? '-'} | ${r.walk?.toFixed(2) ?? '-'} |`).join('\n')}\n`);
}
process.exit(traps || count('FELL') ? 1 : 0);
