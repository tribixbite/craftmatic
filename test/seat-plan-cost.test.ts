/**
 * A-21 (audit 2026-11-15, FID-02 / PROC-19): the driver's-seat planner must stay cheap on a large vehicle.
 * 42172 compiled as a whole-model car at 100 % (3,899 placements, ~17 blocks long, a guessed `none` seat whose eye
 * starts inside the body) took 2,353 s to export where the same model at 0.25 took 98 s: the `none` search scores
 * every surface top along the car with `forwardView`, which marched each of its 15 rays in 0.05-block steps and
 * tested EVERY box at every step. This builds a synthetic car of that size and box count and bounds the plan's
 * wall time: the slow path takes ~56 s here, the indexed one ~2 s.
 */
import { describe, expect, it } from 'vitest';
import { forwardView, planSeat, type BoxBlocks } from '../web/src/engine/cockpit-seat.js';

/** A deterministic car-sized heap of boxes: 12 x 32 columns of 0.5-block cells, each a stack of thin slabs (0.03 thick, every 0.06) to a varying roof - about the 11k-21k cubes a big car ships. */
function syntheticCar(): BoxBlocks[] {
  const boxes: BoxBlocks[] = [];
  let seed = 7;
  const rand = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let x = -3; x < 3; x += 0.5) for (let z = -8; z < 8; z += 0.5) {
    const roof = 1 + Math.round(rand() * 15) / 10;
    for (let y = 0; y < roof - 1e-9; y += 0.06) {
      boxes.push({ min: [x, y, z], max: [x + 0.5, Math.min(roof, y + 0.03), z + 0.5], ...(rand() < 0.03 ? { glass: true } : {}) });
    }
  }
  return boxes;
}

describe('seat planner cost on a large vehicle (A-21)', () => {
  it('plans a guessed seat on an 11,000-box, 16-block car within a bounded time', () => {
    const boxes = syntheticCar();
    expect(boxes.length).toBeGreaterThan(11000);
    const eye: [number, number, number] = [0, 1.4, 0];
    // The eye starts inside the body: the `none` search over the whole car runs.
    expect(forwardView(boxes, eye)).toBeLessThan(0.9);
    const t0 = performance.now();
    const plan = planSeat(boxes, eye, [0, 0.28, 0], 'none');
    const ms = performance.now() - t0;
    expect(plan.view?.before).toBeLessThan(0.9);
    // Measured 2026-11-15 on this box: 56 s with every box scanned at every ray step and probe, 2.1 s indexed (the
    // plan identical, sha1 of its JSON compared). The bound leaves room for a loaded machine and fails the slow path.
    expect(ms).toBeLessThan(15000);
  }, 600000);
});
