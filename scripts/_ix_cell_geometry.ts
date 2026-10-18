/**
 * Build a pack exactly as `_playable_ref.ts` does and ALSO write the part
 * geometry per collider cell that clearance reasons on (`ClearanceInput.layers`,
 * collider-clearance.ts): the sixteen layer footprints of every cell, in the
 * collider grid's frame (the pack's model blocks at 100 %, turn 0).
 *
 * The pack itself ships only the colliders; this is the truth they
 * approximate. `_ix_sealed_causes.ts` walks each doorway over it to say
 * whether a sealed doorway is sealed by the MODEL (a minifig could not pass
 * either) or by the COLLIDERS (the model's geometry lets a player through).
 *
 * Usage: bun scripts/_ix_cell_geometry.ts <geometry.json> <model> <out.mcaddon> [every _playable_ref.ts flag]
 * Output JSON: { width, height, length, cells: base64 of (int32 index, 64 layer bytes)* }
 * with index = (x·height + y)·length + z and each layer [x0, x1, z0, z1]
 * sixteenths (x0 = 255: empty), bottom layer first.
 */
import { writeFileSync } from 'node:fs';
import { clearanceDebug } from '../web/src/engine/collider-clearance.ts';

const [dumpPath, ...rest] = process.argv.slice(2);
if (!dumpPath || !rest.filter(a => !a.startsWith('--')).length) {
  console.error('usage: bun scripts/_ix_cell_geometry.ts <geometry.json> <model> <out.mcaddon> [_playable_ref flags]');
  process.exit(2);
}

clearanceDebug.capture = input => {
  const { grid, layers } = input;
  // One record per cell: its index (int32 LE) and its 64 layer bytes.
  const buf = Buffer.alloc(layers.size * 68);
  let at = 0;
  for (const [i, a] of layers) {
    buf.writeInt32LE(i, at);
    buf.set(a, at + 4);
    at += 68;
  }
  writeFileSync(dumpPath, JSON.stringify({ width: grid.width, height: grid.height, length: grid.length, cells: buf.toString('base64') }));
  console.error(`[cell-geometry] ${layers.size} cells with geometry -> ${dumpPath}`);
};

// `_playable_ref.ts` reads its own argv at import: hand it the build's arguments.
process.argv = [process.argv[0]!, 'scripts/_playable_ref.ts', ...rest];
await import('./_playable_ref.ts');
