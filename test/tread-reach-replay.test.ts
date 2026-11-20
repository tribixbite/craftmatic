/**
 * The scaled tread planner on the RECORDED inputs of five favourites (IX-05, PROC-19, branch gen-reach 2026-11-19).
 *
 * `test/fixtures/treads/<set>-inputs.json.gz` is what the export handed the planner for that set at `9f5bdf2e`
 * (`CRAFTMATIC_TREAD_INPUTS`, `treadInputs`): the shipped colliders, the doorways' closed cells and approaches, the
 * fine reach walk and the carve source. Replayed with the real lane walk (`planTreadsFromInputs`) by
 * `scripts/_tread_replay.ts --plans=` in a CHILD process: one 400 % plan runs 20-40 s synchronously, and inside the
 * vitest worker that blocked its event loop past 60 s under the full suite ("Timeout calling onTaskUpdate").
 *
 * Each case is a plan that reached LESS than the base build of `f134493e` (`.worktrees/gen-door2/output/gd2/
 * base-packs2/`, before the doorway-approach rule) after gen-door2, or after a first fix of it: the floor numbers are
 * that base plan's (surfaces after the treads, highest reached surface in blocks at 100 %), so a favourite never
 * reaches less than it did.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { colliderSourceCells, decodeTreadPlan, sizeCarveFor, treadInputsRead, walkDoorLine, type PlacementTreadReport, type TreadInputs } from '../web/src/engine/bedrock-placement-pack.js';
import { WalkWorld, tickPlayer, type PlayerState } from '../web/src/engine/addon-walk.js';
import { doorApproachLines, type QuarterTurn } from '../web/src/engine/bedrock-collider-scale.js';

const fixture = (set: string): string => fileURLToPath(new URL(`./fixtures/treads/${set}-inputs.json.gz`, import.meta.url));
const inputsOf = (set: string): TreadInputs => JSON.parse(gunzipSync(readFileSync(fixture(set))).toString('utf8')) as TreadInputs;
const REPLAY = fileURLToPath(new URL('../scripts/_tread_replay.ts', import.meta.url));
const OUT = mkdtempSync(join(tmpdir(), 'tread-replay-'));

type PlanRow = PlacementTreadReport['plans'][number];
/** Plan one size and turn from a set's recorded inputs in a child process: the report's row and the plan's blocks. */
async function replayed(set: string, pct: number, r: QuarterTurn): Promise<{ plan: PlanRow; blocks: string }> {
  const out = join(OUT, `${set}-${pct}-${r}.json`);
  await promisify(execFile)('bun', [REPLAY, fixture(set), `--sizes=${pct}`, `--turns=${r}`, `--plans=${out}`], { maxBuffer: 1 << 24 });
  const row = (JSON.parse(readFileSync(out, 'utf8')) as Record<string, { report: PlanRow; blocks: string }>)[`${pct}:${r}`]!;
  return { plan: row.report, blocks: row.blocks };
}
const planOf = async (set: string, pct: number, r: QuarterTurn): Promise<PlanRow> => (await replayed(set, pct, r)).plan;

/** A set's plan at one size (turn 0) and the walk world over it: what the pack lays (no doors drawn shut). */
async function plannedWorld(set: string, pct: number): Promise<{ world: WalkWorld; plan: PlanRow }> {
  const inputs = inputsOf(set);
  const { plan, blocks } = await replayed(set, pct, 0);
  const cells = colliderSourceCells(inputs.colliders);
  const dims = { width: inputs.colliders.width, height: inputs.colliders.height, length: inputs.colliders.length };
  return { plan, world: new WalkWorld({ cells, dims, sizePct: pct, rotation: 0, treads: decodeTreadPlan(blocks), carve: sizeCarveFor(cells, dims, pct, 0, treadInputsRead(inputs).carve) }) };
}

/**
 * A straight walk in from 1.5 blocks outside one side of the footprint along a lane, jumping whenever it is blocked
 * (the SCALE-06 fan walk, `output/scale06-1015/carve1/tools/fan_walk.ts`): the highest feet and the deepest fall.
 */
function fanLane(world: WalkWorld, side: 'N' | 'S' | 'W' | 'E', lane: number): { top: number; fall: number } {
  const start = side === 'N' ? { x: lane, z: -1.5 } : side === 'S' ? { x: lane, z: world.length + 1.5 } : side === 'W' ? { x: -1.5, z: lane } : { x: world.width + 1.5, z: lane };
  const dir = side === 'N' ? { x: 0, z: 1 } : side === 'S' ? { x: 0, z: -1 } : side === 'W' ? { x: 1, z: 0 } : { x: -1, z: 0 };
  const axis = dir.x ? 'x' : 'z';
  let s: PlayerState = { ...start, y: 0, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
  let jump = false, top = 0, lastFloor = 0, fall = 0;
  for (let t = 0; t < 400; t++) {
    const r = tickPlayer(world, s, { move: dir, jump, sneak: false });
    if (s.onGround) lastFloor = s.y;
    if (r.state.onGround && !s.onGround) fall = Math.max(fall, lastFloor - r.state.y);
    s = r.state; jump = r.collided[axis] && s.onGround; top = Math.max(top, s.y);
  }
  return { top, fall };
}

describe('the scaled tread planner never reaches less than the base build on the favourites\' recorded inputs', () => {
  it('41732 at 400 % turn 0: a refused merge puts the earlier run back where it stood, so a later undo cannot take it (7746 -> at least 7780 surfaces)', async () => {
    const plan = await planOf('41732', 400, 0);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(7780);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(3);
  }, 300_000);

  it('41732 at 300 % turn 90: a run refused across an approach is retried with the runs that took its columns lifted (4352 -> at least 4359)', async () => {
    const plan = await planOf('41732', 300, 90);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(4359);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(2.79);
  }, 300_000);

  it('41732 at 200 % turn 270: a swap that costs reach in the later passes is planned again without it (top 6.81 blocks kept)', async () => {
    const plan = await planOf('41732', 200, 270);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(2028);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(6.81);
  }, 300_000);

  it('42670 at 300 % turn 270: the refused edge whose foot no plan reached is reached again (3857 -> at least 3884 surfaces)', async () => {
    const plan = await planOf('42670', 300, 270);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(3884);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(5.81);
  }, 300_000);

  it('10326 at 150 % turn 180: the swap pass gives back the level a run order took (at least 422 surfaces, 3.58 blocks)', async () => {
    const plan = await planOf('10326', 150, 180);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(422);
    expect(plan.after.highestBlocks).toBeGreaterThanOrEqual(3.58);
  }, 300_000);

  it('21063 at 300 % turn 0: the east flank lanes the Pixel climbed on auto-jump (x 30.5 to 6.25, x 31.5 to 9.13; rounds 30zm/30zn) climb as high', async () => {
    const { world, plan } = await plannedWorld('21063', 300);
    expect(plan.verified).toBe(true);
    /** The highest feet of a straight auto-jump walk north from past the south edge (`_walk_line.ts --jump=auto`). */
    const climb = (x: number): number => {
      let s: PlayerState = { x, y: 0, z: world.length + 1.5, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 }, top = 0;
      for (let t = 0; t < 400; t++) { s = tickPlayer(world, s, { move: { x: 0, z: -1 }, jump: false, sneak: false, autoJump: true }).state; top = Math.max(top, s.y); }
      return top;
    };
    // The base build: lane 30.5 6.38 (feet 6.25 where it stops, the device's 6.25), lane 31.5 9.19.
    expect(climb(30.5)).toBeGreaterThanOrEqual(6.25);
    expect(climb(31.5)).toBeGreaterThanOrEqual(9.13);
  }, 300_000);

  it('21063 at 400 % turn 0: an edge run from the ground is judged by the walks it walls (south lanes x 36.5-38.5 climb to the base build 3.38 / 4.25 / 7.56, no 4-block fall off its top)', async () => {
    const { world, plan } = await plannedWorld('21063', 400);
    expect(plan.verified).toBe(true);
    expect(fanLane(world, 'S', 36.5).top).toBeGreaterThanOrEqual(3.38 - 0.01);
    expect(fanLane(world, 'S', 37.5).top).toBeGreaterThanOrEqual(4.25 - 0.01);
    expect(fanLane(world, 'S', 38.5).top).toBeGreaterThanOrEqual(7.56 - 0.01);
    expect(fanLane(world, 'E', 91.5).fall).toBeLessThanOrEqual(3);
    // The north side's gains stay (the base build: 2.5 and 2.5).
    expect(fanLane(world, 'N', 2.5).top).toBeGreaterThanOrEqual(7.25 - 0.01);
    expect(fanLane(world, 'N', 3.5).top).toBeGreaterThanOrEqual(6 - 0.01);
  }, 300_000);

  it('76419 at 200 % turn 0: a swap lays back the runs it lifted but does not need (south lanes x 1.5 / 2.5 and west lane z 15.5 climb as the base build: 2.69 / 3.25 / 4.83)', async () => {
    const { world, plan } = await plannedWorld('76419', 200);
    expect(plan.verified).toBe(true);
    expect(plan.after.surfaces).toBeGreaterThanOrEqual(984);
    expect(fanLane(world, 'S', 1.5).top).toBeGreaterThanOrEqual(2.69 - 0.01);
    expect(fanLane(world, 'S', 2.5).top).toBeGreaterThanOrEqual(3.25 - 0.01);
    expect(fanLane(world, 'W', 15.5).top).toBeGreaterThanOrEqual(4.83 - 0.01);
  }, 300_000);
});

/**
 * 71043 (fixture recorded at main 0499ce42): the simulator's `place-400-0` and `place-400-90` failed with 32
 * violations each since gen-reach (ceaec7f1): a run refused across Door 1's and Door 2's approach was retried by the
 * approach pass with the runs holding its columns lifted, and kept because it opened the floor over the doors - an
 * 8-tread run along the row in front of both leaves (turn 0: x 32-39, z 43, 14.1-17.6 blocks) that left no line in
 * from their - side.
 */
describe('the scaled tread planner never stops a doorway column line that crosses without treads', () => {
  for (const r of [0, 90] as const) {
    it(`71043 at 400 % turn ${r}: every column line of Door 1 and Door 2 that crosses over the bare colliders still crosses with the plan's treads (sim place-400-${r})`, async () => {
      const inputs = inputsOf('71043');
      const { plan, blocks } = await replayed('71043', 400, r);
      expect(plan.verified).toBe(true);
      const cells = colliderSourceCells(inputs.colliders);
      const dims = { width: inputs.colliders.width, height: inputs.colliders.height, length: inputs.colliders.length };
      const carve = sizeCarveFor(cells, dims, 400, r, treadInputsRead(inputs).carve);
      const world = (treads: ReturnType<typeof decodeTreadPlan>): WalkWorld => new WalkWorld({ cells, dims, sizePct: 400, rotation: r, treads, ...(carve ? { carve } : {}) });
      const bare = world([]), laid = world(decodeTreadPlan(blocks));
      let crossing = 0;
      const stopped: string[] = [];
      for (const [d, a] of inputs.approaches.entries()) {
        const { floorY, k, sides } = doorApproachLines(a, dims, 4, r);
        for (const s of sides) for (const c of s.columns) {
          if (!walkDoorLine(bare, c, s.dir, floorY, k)) continue;
          crossing++;
          if (!walkDoorLine(laid, c, s.dir, floorY, k)) stopped.push(`approach ${d} side ${s.side} column ${c.x},${c.z}`);
        }
      }
      expect(stopped).toEqual([]);
      // The - side lines of both doors (the ones the simulator found stopped) cross over the bare colliders: not vacuous.
      expect(crossing).toBeGreaterThanOrEqual(32);
    }, 300_000);
  }
});
