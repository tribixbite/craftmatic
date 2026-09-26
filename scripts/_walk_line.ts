/**
 * Walk the per-tick player (engine/addon-walk.ts: 0.6 x 1.8, step, jump,
 * gravity) in a straight line across a built pack's shipped colliders and
 * report where it stops - the offline form of "the player stops at an
 * invisible edge here" from a device round. It jumps whenever a move is
 * clipped, as a player trying to get past would.
 *
 * Usage: bun scripts/_walk_line.ts <pack.mcaddon> [--x=13.8,14.2,...] [--from=9.5] [--to=3.9] [--size=100] [--turn=0] [--open=Door 1,Door 2]
 *   Walks along -z (toward `--to`) from z `--from` at each x, in model blocks
 *   from the pin (a device position minus the placement origin). Every door is
 *   closed unless named in `--open`. Exits 0; read the table.
 *
 * Found 76457's sweet-stand rim (device round 2026-09-26a): the shipped pack
 * stopped at z 7.30 at x 13.8-15.0, the device's own reading
 * (docs/bedrock-interactivity.md, "Clearance", rule 4's exception).
 */
import { readFileSync } from 'node:fs';
import { loadAddonPreviewModel, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { WalkWorld, tickPlayer, type PlayerState } from '../web/src/engine/addon-walk.ts';
import { ixClosedBlocks } from '../web/src/engine/bedrock-interactives.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_walk_line.ts <pack.mcaddon> [--x=..] [--from=9.5] [--to=3.9] [--size=100] [--turn=0] [--open=labels]'); process.exit(2); }
const xs = (flag('x') ?? '13.8,14.2,14.6,15.0,15.5,16.0,16.5,16.9').split(',').map(Number);
const from = Number(flag('from') ?? 9.5), to = Number(flag('to') ?? 3.9);
const sizePct = Number(flag('size') ?? 100), rotation = Number(flag('turn') ?? 0) as QuarterTurn;
const open = (flag('open') ?? '').split(',').map(s => s.trim()).filter(Boolean);

const b = readFileSync(file);
const model = await loadAddonPreviewModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const world = new WalkWorld({ cells: model.cells, dims: model.dims, sizePct, rotation, treads: 'shipped', shippedTreads: (s, q) => treadBlocksAt(model, s, q) });
const items = model.interactives?.items ?? [];
if (model.interactives) world.setOverlayBlocks(ixClosedBlocks(items, model.dims, sizePct / 100, rotation, i => open.includes(items[i]!.label)));
console.log(`${model.label}: walking -z from z ${from} to ${to} at ${sizePct} % turn ${rotation}${open.length ? `, open: ${open.join(', ')}` : ''}`);
for (const x of xs) {
  let s: PlayerState = { x, y: 0.5, z: from, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
  let jump = false, minZ = Infinity, jumps = 0, topY = 0;
  for (let t = 0; t < 300; t++) {
    const r = tickPlayer(world, s, { move: { x: 0, z: -1 }, jump, sneak: false });
    s = r.state;
    jump = r.collided.z && s.onGround; if (jump) jumps++;
    minZ = Math.min(minZ, s.z); topY = Math.max(topY, s.y);
    if (s.z <= to) break;
  }
  console.log(`x ${x.toFixed(2)}: ${minZ <= to ? 'REACHED' : 'stopped at'} z ${minZ.toFixed(2)} (feet y ${s.y.toFixed(2)}, highest ${topY.toFixed(2)}, ${jumps} jumps)`);
}
