/**
 * The scaled tread planner on the RECORDED inputs of three favourites (IX-05, PROC-19, branch gen-reach 2026-11-19).
 *
 * `test/fixtures/treads/<set>-inputs.json.gz` is what the export handed the planner for that set at `9f5bdf2e`
 * (`CRAFTMATIC_TREAD_INPUTS`, `treadInputs`): the shipped colliders, the doorways' closed cells and approaches, the
 * fine reach walk and the carve source. Replayed here with the real lane walk (`planTreadsFromInputs`), one plan
 * takes seconds where a rebuild takes minutes.
 *
 * Each case is a plan that reached LESS than the base build of `f134493e` (`.worktrees/gen-door2/output/gd2/
 * base-packs2/`, before the doorway-approach rule) after gen-door2, or after a first fix of it: the floor numbers are
 * that base plan's (surfaces after the treads, highest reached surface in blocks at 100 %), so a favourite never
 * reaches less than it did.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { planTreadsFromInputs, type TreadInputs } from '../web/src/engine/bedrock-placement-pack.js';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.js';

const inputsOf = (set: string): TreadInputs =>
  JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/treads/${set}-inputs.json.gz`, import.meta.url))).toString('utf8')) as TreadInputs;

/** Plan one size and turn from a set's recorded inputs; the report's per-plan reach. */
const planOf = (inputs: TreadInputs, pct: number, r: QuarterTurn) => planTreadsFromInputs(inputs, [[pct, r]]).report.plans[0]!;

describe('the scaled tread planner never reaches less than the base build on the favourites\' recorded inputs', () => {
  it('41732 at 400 % turn 0: a refused merge puts the earlier run back where it stood, so a later undo cannot take it (7746 -> at least 7780 surfaces)', () => {
    const plan = planOf(inputsOf('41732'), 400, 0);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(7780);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(3);
  }, 300_000);

  it('41732 at 300 % turn 90: a run refused across an approach is retried with the runs that took its columns lifted (4352 -> at least 4359)', () => {
    const plan = planOf(inputsOf('41732'), 300, 90);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(4359);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(2.79);
  }, 300_000);

  it('41732 at 200 % turn 270: a swap that costs reach in the later passes is planned again without it (top 6.81 blocks kept)', () => {
    const plan = planOf(inputsOf('41732'), 200, 270);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(2028);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(6.81);
  }, 300_000);

  it('42670 at 300 % turn 270: the refused edge whose foot no plan reached is reached again (3857 -> at least 3884 surfaces)', () => {
    const plan = planOf(inputsOf('42670'), 300, 270);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(3884);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(5.81);
  }, 300_000);

  it('10326 at 150 % turn 180: the swap pass gives back the level a run order took (at least 422 surfaces, 3.58 blocks)', () => {
    const plan = planOf(inputsOf('10326'), 150, 180);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(422);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(3.58);
  }, 300_000);
});
