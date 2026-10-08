/**
 * Auto-jump (sim/physics/body.ts `autoJumpWanted`, `WalkInput.autoJump`): Bedrock's touch default, modelled
 * on Java's `LocalPlayer.updateAutoJump` (quirk `auto-jump`). A child on touch, and the adb harness driving one
 * finger, climb with it alone: the Pixel's walk up 10261's lift hill at 200 % stopped in front of a 1.25 riser
 * that a pressed jump clears (round 30k, pin + 28.2), and the tread planner's lane pass is judged by this walk.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTO_JUMP_MAX_RISE, AUTO_JUMP_MIN_RISE, JUMP_PEAK, tickPlayer, type Box, type PlayerState, type SolidQuery } from '../web/src/sim/physics/body.js';

/** Solids as plain boxes (a flat ground under y 0 plus the given boxes). */
function world(boxes: Box[]): SolidQuery {
  const all = [{ x0: -50, y0: -1, z0: -50, x1: 50, y1: 0, z1: 50 }, ...boxes];
  return { solidsNear: (b, dx, dy, dz) => all.filter(s => s.x1 >= Math.min(b.x0, b.x0 + dx) - 1 && s.x0 <= Math.max(b.x1, b.x1 + dx) + 1 && s.y1 >= Math.min(b.y0, b.y0 + dy) - 1 && s.y0 <= Math.max(b.y1, b.y1 + dy) + 1 && s.z1 >= Math.min(b.z0, b.z0 + dz) - 1 && s.z0 <= Math.max(b.z1, b.z1 + dz) + 1) };
}
/** Walk +x for `ticks` with the stick forward and nothing pressed; the furthest x and the highest feet. */
function walk(w: SolidQuery, opts: { autoJump: boolean; sneak?: boolean; facing?: { x: number; z: number }; dir?: number; ticks?: number }): { x: number; y: number; jumps: number } {
  // `y`: where the feet stand at the end (on the ground), not the top of a jump's arc.
  let s: PlayerState = { x: 0.5, y: 0, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: true, sneaking: false, tick: 0 };
  let best = s.x, jumps = 0;
  const dir = opts.dir ?? 1;
  for (let t = 0; t < (opts.ticks ?? 100); t++) {
    const wasGround = s.onGround;
    s = tickPlayer(w, s, { move: { x: dir, z: 0 }, jump: false, sneak: !!opts.sneak, autoJump: opts.autoJump, ...(opts.facing ? { facing: opts.facing } : {}) }).state;
    if (wasGround && s.vy > 0.3) jumps++;
    best = dir > 0 ? Math.max(best, s.x) : Math.min(best, s.x);
  }
  return { x: best, y: s.y, jumps };
}
/** A step up of `rise` blocks starting at x 2 (a platform past the walk's reach), one box per block (as a world reports them). */
const step = (rise: number, extra: Box[] = []): SolidQuery => {
  const blocks: Box[] = [];
  for (let x = 2; x < 40; x++) for (let z = -2; z < 3; z++) blocks.push({ x0: x, y0: 0, z0: z, x1: x + 1, y1: rise, z1: z + 1 });
  return world([...blocks, ...extra]);
};

describe('auto-jump (quirk auto-jump)', () => {
  it('climbs a one-block step with nothing pressed, and nothing past its 1.2', () => {
    expect(AUTO_JUMP_MAX_RISE).toBeLessThan(JUMP_PEAK);
    const one = walk(step(1), { autoJump: true });
    expect(one.y).toBeCloseTo(1, 5);
    expect(one.jumps).toBe(1);
    expect(walk(step(1.2), { autoJump: true }).y).toBeCloseTo(1.2, 5);
    // A 1.25 riser (10261's lift hill at 200 %, x 28.5): a pressed jump would clear it, auto-jump never tries.
    const tall = walk(step(1.25), { autoJump: true });
    expect(tall.jumps).toBe(0);
    expect(tall.x).toBeCloseTo(1.7, 5);
    // Without auto-jump the player stops at every rise over the 9/16 step.
    expect(walk(step(1), { autoJump: false }).x).toBeCloseTo(1.7, 5);
  });

  it('a rise the step takes is walked, not jumped', () => {
    expect(AUTO_JUMP_MIN_RISE).toBe(0.5);
    const low = walk(step(0.5), { autoJump: true });
    expect(low.jumps).toBe(0);
    expect(low.y).toBeCloseTo(0.5, 5);
  });

  it('needs the two cells over the head free, and never jumps a two-high wall', () => {
    // A ceiling in the cell over the head (the box's top at 1.8 lies in row 1): no jump onto the step.
    const roofed = walk(step(1, [{ x0: -2, y0: 2.5, z0: -2, x1: 2, y1: 3, z1: 3 }]), { autoJump: true });
    expect(roofed.jumps).toBe(0);
    // A block stacked over the obstacle's own: the wall is 2 high.
    const wall = walk(step(1, [-2, -1, 0, 1, 2].map(z => ({ x0: 2, y0: 1, z0: z, x1: 3, y1: 2, z1: z + 1 }))), { autoJump: true });
    expect(wall.jumps).toBe(0);
  });

  it('not when sneaking, nor walking backward', () => {
    expect(walk(step(1), { autoJump: true, sneak: true, ticks: 300 }).jumps).toBe(0);
    // Facing -x while the stick takes the player +x (walking backward).
    expect(walk(step(1), { autoJump: true, facing: { x: -1, z: 0 } }).jumps).toBe(0);
  });
});

/**
 * The device's stop, reproduced offline (Pixel round 30k, 2026-10-07): the 30k pack's lift hill at 200 % from
 * its foot (pin + 15.6, 4.6, lanes z 4.85 / 5.2 / 5.6 facing +x): auto-jump stops at pin + (28.2, 9.88), as the
 * phone did on three tries. Local only: the pack is a device round's output.
 */
const PACK_30K = 'C:/git/craftmatic/output/device-round-2026-10-07k/packs-78e06246/10261-roller-coaster.mcaddon';
describe.skipIf(!existsSync(PACK_30K))('10261\'s lift hill at 200 % on the 30k pack (Pixel 30k)', () => {
  it('the auto-jump walk stops where the phone stopped; the jump-whenever-blocked walk does not', async () => {
    const { loadAddonPreviewModel, treadBlocksAt } = await import('../web/src/ui/addon-preview-data.js');
    const { WalkWorld } = await import('../web/src/engine/addon-walk.js');
    const bytes = readFileSync(PACK_30K);
    const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const w = new WalkWorld({ cells: model.cells, dims: model.dims, sizePct: 200, rotation: 0, treads: 'shipped', shippedTreads: (s, q) => treadBlocksAt(model, s, q) });
    for (const z of [4.85, 5.2, 5.6]) {
      for (const mode of ['auto', 'blocked'] as const) {
        let s: PlayerState = { x: 15.6, y: 4.6, z, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
        let best = s, jump = false;
        for (let t = 0; t < 600; t++) {
          const r = tickPlayer(w, s, { move: { x: 1, z: 0 }, jump, sneak: false, autoJump: mode === 'auto' });
          s = r.state; jump = mode === 'blocked' && r.collided.x && s.onGround;
          if (s.x > best.x) best = s;
        }
        if (mode === 'auto') { expect(best.x, `lane ${z}`).toBeCloseTo(28.2, 1); expect(best.y).toBeCloseTo(9.88, 1); }
        else expect(best.x, `lane ${z}`).toBeGreaterThan(39);
      }
    }
  }, 60_000);
});
