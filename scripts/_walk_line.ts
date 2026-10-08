/**
 * Walk the per-tick player (engine/addon-walk.ts: 0.6 x 1.8, step, jump,
 * gravity) in a straight line across a built pack's shipped colliders and
 * report where it stops - the offline form of "the player stops at an
 * invisible edge here" from a device round.
 *
 * Usage: bun scripts/_walk_line.ts <pack.mcaddon> [--x=13.8,14.2,...] [--from=9.5] [--to=3.9] [--y=0.5] [--size=100] [--turn=0] [--open=Door 1,Door 2]
 *                                   [--dir=-z|+z|-x|+x] [--jump=blocked|auto|none] [--ticks=300]
 *   Walks along `--dir` (default -z) from `--from` toward `--to` on that axis, one line per LANE: `--x` lists the
 *   lanes' other coordinate (x for a z walk, z for an x walk), in model blocks from the pin (a device position
 *   minus the placement origin), the feet starting at `--y` (0.5, the ground; an upper storey's floor height to
 *   walk a room the ground never reaches - 10788's floor 3 at 8.6). Every door is closed unless named in `--open`.
 *   `--jump`: `blocked` (default) jumps whenever a move is clipped, as a player trying to get past would;
 *   `auto` presses nothing and lets Bedrock's AUTO-JUMP decide (`autoJumpWanted` in sim/physics/body.ts: an
 *   obstacle over 0.5 and at most 1.2 over the feet, with two clear cells over the head) - the Pixel's own
 *   climb (adb drives one finger, the stick) and a 5-year-old's on touch; `none` never jumps. Exits 0; read the table.
 *
 * Found 76457's sweet-stand rim (device round 2026-09-26a): the shipped pack
 * stopped at z 7.30 at x 13.8-15.0, the device's own reading
 * (docs/bedrock-interactivity.md, "Clearance", rule 4's exception). With
 * `--dir=+x --jump=auto` it reproduces the Pixel's stop on 10261's lift hill
 * at 200 % (round 30k: pin + 28.2).
 */
import { readFileSync } from 'node:fs';
import { loadAddonPreviewModel, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { WalkWorld, tickPlayer, type PlayerState } from '../web/src/engine/addon-walk.ts';
import { ixClosedBlocks } from '../web/src/engine/bedrock-interactives.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_walk_line.ts <pack.mcaddon> [--x=..] [--from=9.5] [--to=3.9] [--y=0.5] [--size=100] [--turn=0] [--open=labels] [--dir=-z|+z|-x|+x] [--jump=blocked|auto|none] [--ticks=300]'); process.exit(2); }
const lanes = (flag('x') ?? '13.8,14.2,14.6,15.0,15.5,16.0,16.5,16.9').split(',').map(Number);
const from = Number(flag('from') ?? 9.5), to = Number(flag('to') ?? 3.9), startY = Number(flag('y') ?? 0.5);
const sizePct = Number(flag('size') ?? 100), rotation = Number(flag('turn') ?? 0) as QuarterTurn;
const open = (flag('open') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const dirFlag = flag('dir') ?? '-z';
if (!/^[+-][xz]$/.test(dirFlag)) { console.error('--dir is one of -z, +z, -x, +x'); process.exit(2); }
const jumpMode = flag('jump') ?? 'blocked';
if (!['blocked', 'auto', 'none'].includes(jumpMode)) { console.error('--jump is blocked, auto or none'); process.exit(2); }
const ticks = Number(flag('ticks') ?? 300);
const axis = dirFlag[1] as 'x' | 'z', sign = dirFlag[0] === '+' ? 1 : -1;

const b = readFileSync(file);
const model = await loadAddonPreviewModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const world = new WalkWorld({ cells: model.cells, dims: model.dims, sizePct, rotation, treads: 'shipped', shippedTreads: (s, q) => treadBlocksAt(model, s, q) });
const items = model.interactives?.items ?? [];
if (model.interactives) world.setOverlayBlocks(ixClosedBlocks(items, model.dims, sizePct / 100, rotation, i => open.includes(items[i]!.label)));
console.log(`${model.label}: walking ${dirFlag} from ${axis} ${from} to ${to}, feet from y ${startY}, at ${sizePct} % turn ${rotation}, jump ${jumpMode}${open.length ? `, open: ${open.join(', ')}` : ''}`);
const move = axis === 'x' ? { x: sign, z: 0 } : { x: 0, z: sign };
for (const lane of lanes) {
  let s: PlayerState = axis === 'x'
    ? { x: from, y: startY, z: lane, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 }
    : { x: lane, y: startY, z: from, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
  let jump = false, best = -Infinity, jumps = 0, topY = startY, lowY = startY, bestAt = { x: s.x, y: s.y, z: s.z };
  const along = (q: { x: number; z: number }): number => sign * (axis === 'x' ? q.x : q.z);
  for (let t = 0; t < ticks; t++) {
    const r = tickPlayer(world, s, { move, jump, sneak: false, autoJump: jumpMode === 'auto' });
    // Auto-jump presses nothing; count the jumps it made from the state's vertical start.
    if (jumpMode === 'auto' && s.onGround && r.state.vy > 0.3) jumps++;
    s = r.state;
    jump = jumpMode === 'blocked' && (r.collided[axis]) && s.onGround; if (jump) jumps++;
    if (along(s) > best) { best = along(s); bestAt = { x: s.x, y: s.y, z: s.z }; }
    topY = Math.max(topY, s.y); lowY = Math.min(lowY, s.y);
    if (along(s) >= sign * to) break;
  }
  const reached = best >= sign * to;
  // The lowest the feet went: a walk that starts on an upper floor and ends lower fell through it.
  console.log(`${axis === 'x' ? 'z' : 'x'} ${lane.toFixed(2)}: ${reached ? 'REACHED' : 'stopped at'} ${axis} ${(sign * best).toFixed(2)} (there feet y ${bestAt.y.toFixed(2)}; end ${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}, lowest ${lowY.toFixed(2)}, highest ${topY.toFixed(2)}, ${jumps} jumps)`);
}
