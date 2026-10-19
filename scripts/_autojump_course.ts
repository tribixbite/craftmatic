/**
 * Print the AUTO-JUMP probe course (web/src/sim/quirks/autojump-course.ts, quirk `auto-jump`) for one origin:
 *   - the chat commands that build it (`/fill` walls, `/setblock` collider-form obstacles) and the one that clears it;
 *   - per lane: its start, what it tests, the simulator's walk (stick held north, auto-jump on: the highest feet
 *     over the run-up, where it ends, CLIMBS or STOPS) and the Pixel's verdict (round 30zo).
 * The collider blocks are invisible on the device: a lane is found by its coordinates, between visible stone walls.
 *
 * Usage: bun scripts/_autojump_course.ts [--origin=20200,-60,6400] [--ticks=160]
 *   origin = the x of lane 0's centre column, the ground's top (feet height on the ground), the obstacle's z.
 */
import { AUTO_JUMP_LANES, LANE_STEP, START_DZ, autoJumpCourseBoxes, autoJumpCourseCommands, walkAutoJumpLane } from '../web/src/sim/quirks/autojump-course.ts';
import type { SolidQuery } from '../web/src/sim/physics/body.ts';

const arg = (k: string): string | undefined => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const o = (arg('origin') ?? '20200,-60,6400').split(',').map(Number);
if (o.length !== 3 || o.some(n => !Number.isFinite(n))) throw new Error('--origin=x,y,z');
const origin: [number, number, number] = [o[0]!, o[1]!, o[2]!];
const ticks = Number(arg('ticks') ?? 160);

const boxes = autoJumpCourseBoxes();
const world: SolidQuery = { solidsNear: () => boxes };
const { build, clear } = autoJumpCourseCommands(origin);
console.log(`# Auto-jump course at ${origin.join(',')} (${AUTO_JUMP_LANES.length} lanes, ${build.length} build commands)`);
console.log('\n## Build (type each in chat)');
for (const c of build) console.log(c);
console.log('\n## Clear afterwards (one command)');
console.log(clear);
console.log(`\n## Lanes and the simulator's prediction (${ticks} ticks, stick held north from z ${origin[2] + START_DZ})`);
console.log('lane | start (tp, facing north) | what it is | sim: highest feet over the run-up | sim: end z | sim verdict | Pixel 30zo');
AUTO_JUMP_LANES.forEach((lane, i) => {
  const { highest, endZ, verdict } = walkAutoJumpLane(world, i, ticks);
  const start = `${origin[0] + i * LANE_STEP + 0.5} ${origin[1] + lane.floor16 / 16} ${origin[2] + START_DZ}`;
  console.log(`${i} ${lane.name} | ${start} | ${lane.note} | +${(highest - lane.floor16 / 16).toFixed(3)} | ${(origin[2] + endZ).toFixed(2)} | ${verdict} | ${lane.device}${verdict === lane.device ? '' : '  <- DIFFERS'}`);
});
