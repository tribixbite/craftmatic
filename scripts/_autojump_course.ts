/**
 * An AUTO-JUMP probe course (quirk `auto-jump`, SCALE-06): walls of one-block lanes, each with one obstacle
 * built from the collider forms every model pack ships, so a phone can find out which obstacles Bedrock's
 * touch auto-jump climbs and which it does not. Pixel round 30zn stopped a player at a chest-height overhang
 * on 21063 at 400 % (a lip 0.75-0.875 over the feet, with a step box under its far half) that the
 * simulator's Java rule (`autoJumpWanted`, sim/physics/body.ts) jumps; one point does not say which rule
 * Bedrock applies, so the lanes vary the overhang's depth and the lip's height around that one.
 *
 * Prints, for one course origin:
 *   - the chat commands that build it (`/fill` walls, `/setblock` obstacles) and the one that clears it;
 *   - the simulator's prediction per lane: a walk north (-z) from the lane's start with the stick held
 *     forward and auto-jump on (the touch default), its highest feet height and where it ends. A lane is
 *     CLIMBED when the walk passes the obstacle (it then ends at the end wall).
 *
 * The geometry is the collider kit's own (`COLLIDER_KIT.formBoxes`, world axes), so the course on the phone
 * and the course walked here are one definition. The collider blocks are invisible on the device: a lane
 * is found by its coordinates, between visible stone walls.
 *
 * Usage: bun scripts/_autojump_course.ts [--origin=20200,-60,6400] [--ticks=160]
 *   origin = the x of lane 0's centre column, the ground's top (feet height on the ground), the obstacle's z.
 */
import { COLLIDER_KIT, COLLIDER_STATES } from '../web/src/engine/collider-form.ts';
import { tickPlayer, type Box, type PlayerState, type SolidQuery } from '../web/src/sim/physics/body.ts';

/** One collider block of a lane, relative to the lane: column dz from the obstacle's row, row dy over the ground. */
interface LanePiece { dy: number; dz: number; id: string; lo: number; hi: number }

/** One lane: what it tests, and its pieces (the run-up floor, the obstacle, the cell beyond it). */
interface Lane { name: string; note: string; pieces: LanePiece[]; /** Feet height on the run-up (sixteenths): 0 on the ground. */ floor16: number }

const variant = (id: string): string => (id.startsWith('craftmatic:') ? id : `craftmatic:${id}`);
const piece = (dy: number, dz: number, id: string, lo: number, hi: number): LanePiece => ({ dy, dz, id: variant(id), lo, hi });
/** The cell beyond every ground-level obstacle: solid to the lip's top (0.875), so a climb has somewhere to land. */
const BEYOND = piece(0, -1, 'collider', 0, 14);

/**
 * The lanes. In a `_c<s>` (wall + ceiling) form, shape s runs from the block's bottom to `lo`, then the full
 * footprint from `lo` to `hi`: with lo 12 / hi 14 that is a box under part of the cell and a lip 0.75-0.875 over
 * the whole of it. Shapes (sixteenths along z, 0 = the north edge, the far side for a walk to -z): 9 = z 0-8 (far
 * half), 10 = z 0-12 (far three quarters), 8 = z 0-4 (far quarter), 12 = z 8-16 (near half).
 */
const LANES: Lane[] = [
  { name: 'solid', note: 'control: a solid block 0-0.875', floor16: 0, pieces: [piece(0, 0, 'collider', 0, 14), BEYOND] },
  { name: 'near-box', note: 'box 0-0.75 under the NEAR half, lip 0.75-0.875 (a solid face)', floor16: 0, pieces: [piece(0, 0, 'collider_c12', 12, 14), BEYOND] },
  { name: 'over-0.25', note: 'lip 0.75-0.875 overhanging a box 0-0.75 by 0.25', floor16: 0, pieces: [piece(0, 0, 'collider_c10', 12, 14), BEYOND] },
  { name: 'over-0.5', note: 'lip 0.75-0.875 overhanging a box 0-0.75 by 0.5 (the 30zn shape, in one cell)', floor16: 0, pieces: [piece(0, 0, 'collider_c9', 12, 14), BEYOND] },
  { name: 'over-0.75', note: 'lip 0.75-0.875 overhanging a box 0-0.75 by 0.75', floor16: 0, pieces: [piece(0, 0, 'collider_c8', 12, 14), BEYOND] },
  { name: 'lip-only', note: 'lip 0.75-0.875 over the whole cell, nothing under it (the face behind is the next cell)', floor16: 0, pieces: [piece(0, 0, 'collider', 12, 14), BEYOND] },
  { name: 'lip-0.5', note: 'lip 0.5-0.875 overhanging a box 0-0.5 by 0.5', floor16: 0, pieces: [piece(0, 0, 'collider_c9', 8, 14), BEYOND] },
  { name: 'lip-0.625', note: 'lip 0.625-0.875 overhanging a box 0-0.625 by 0.5', floor16: 0, pieces: [piece(0, 0, 'collider_c9', 10, 14), BEYOND] },
  {
    // 21063 at 400 %, x 31-32, as round 30zn met it: the floor 1.25 (here 0.25 over the ground), a box from the floor
    // to 0.75 over it under the far half of the next cell, and a lip 0.75-0.875 over the feet in the cell's row above.
    name: '30zn-replica', note: 'the 30zn overhang across two rows: floor 0.25, box 0.25-1.0 (far half), lip 1.0-1.125', floor16: 4,
    pieces: [
      ...[1, 2, 3, 4, 5, 6].map(dz => piece(0, dz, 'collider', 0, 4)),
      piece(0, 0, 'collider_f9', 0, 4), piece(1, 0, 'collider', 0, 2),
      piece(0, -1, 'collider', 0, 16), piece(1, -1, 'collider', 0, 2),
    ],
  },
];

/** Lane i's centre column is 2i east of the origin; walls stand on the odd columns between. */
const LANE_STEP = 2;
const START_DZ = 6.5, END_WALL_DZ = -5, BACK_DZ = 7;

function parseArgs(): { origin: [number, number, number]; ticks: number } {
  const arg = (k: string): string | undefined => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const o = (arg('origin') ?? '20200,-60,6400').split(',').map(Number);
  if (o.length !== 3 || o.some(n => !Number.isFinite(n))) throw new Error('--origin=x,y,z');
  return { origin: [o[0]!, o[1]!, o[2]!], ticks: Number(arg('ticks') ?? 160) };
}

/** Every solid of the course, relative to the origin (blocks): the ground, the walls, every lane's pieces. */
function courseBoxes(): Box[] {
  const out: Box[] = [{ x0: -50, x1: 50, y0: -1, y1: 0, z0: -50, z1: 50 }];
  const lastWall = LANES.length * LANE_STEP - 1;
  for (let x = -1; x <= lastWall; x += LANE_STEP) out.push({ x0: x, x1: x + 1, y0: 0, y1: 2, z0: END_WALL_DZ, z1: BACK_DZ + 1 });
  out.push({ x0: -1, x1: lastWall + 1, y0: 0, y1: 2, z0: END_WALL_DZ, z1: END_WALL_DZ + 1 });
  LANES.forEach((lane, i) => {
    for (const p of lane.pieces) {
      const v = COLLIDER_KIT.variantOf(p.id);
      if (v < 0) throw new Error(`not a collider: ${p.id}`);
      for (const [x0, x1, y0, y1, z0, z1] of COLLIDER_KIT.formBoxes(v, p.lo, p.hi)) {
        out.push({ x0: i * LANE_STEP + x0 / 16, x1: i * LANE_STEP + x1 / 16, y0: p.dy + y0 / 16, y1: p.dy + y1 / 16, z0: p.dz + z0 / 16, z1: p.dz + z1 / 16 });
      }
    }
  });
  return out;
}

/** The chat commands that build the course at `origin`, and the one that clears it. */
function commands([ox, oy, oz]: [number, number, number]): { build: string[]; clear: string } {
  const lastWall = LANES.length * LANE_STEP - 1;
  const build: string[] = [];
  for (let x = -1; x <= lastWall; x += LANE_STEP) build.push(`/fill ${ox + x} ${oy} ${oz + END_WALL_DZ} ${ox + x} ${oy + 1} ${oz + BACK_DZ} stone`);
  build.push(`/fill ${ox - 1} ${oy} ${oz + END_WALL_DZ} ${ox + lastWall} ${oy + 1} ${oz + END_WALL_DZ} stone`);
  LANES.forEach((lane, i) => {
    for (const p of lane.pieces) {
      build.push(`/setblock ${ox + i * LANE_STEP} ${oy + p.dy} ${oz + p.dz} ${p.id} ["${COLLIDER_STATES.lo}"=${p.lo},"${COLLIDER_STATES.hi}"=${p.hi}]`);
    }
  });
  return { build, clear: `/fill ${ox - 1} ${oy} ${oz + END_WALL_DZ} ${ox + lastWall} ${oy + 2} ${oz + BACK_DZ} air` };
}

/** The simulator's walk of one lane: stick forward (north), auto-jump on, from the lane's start. */
function walkLane(world: SolidQuery, i: number, ticks: number): { highest: number; endZ: number } {
  let s: PlayerState = { x: i * LANE_STEP + 0.5, y: LANES[i]!.floor16 / 16, z: START_DZ, vx: 0, vy: 0, vz: 0, onGround: true, sneaking: false, tick: 0 };
  let highest = s.y;
  for (let t = 0; t < ticks; t++) {
    s = tickPlayer(world, s, { move: { x: 0, z: -1 }, jump: false, sneak: false, autoJump: true, facing: { x: 0, z: -1 } }).state;
    highest = Math.max(highest, s.y);
  }
  return { highest, endZ: s.z };
}

const { origin, ticks } = parseArgs();
const boxes = courseBoxes();
const world: SolidQuery = { solidsNear: () => boxes };
const { build, clear } = commands(origin);
console.log(`# Auto-jump course at ${origin.join(',')} (${LANES.length} lanes, ${build.length} build commands)`);
console.log('\n## Build (type each in chat)');
for (const c of build) console.log(c);
console.log('\n## Clear afterwards (one command)');
console.log(clear);
console.log(`\n## Lanes and the simulator's prediction (Java's auto-jump rule, ${ticks} ticks, stick held north from z ${origin[2] + START_DZ})`);
console.log('lane | start (tp, facing north) | what it is | sim: highest feet over the run-up | sim: end z | sim verdict');
LANES.forEach((lane, i) => {
  const { highest, endZ } = walkLane(world, i, ticks);
  const start = `${origin[0] + i * LANE_STEP + 0.5} ${origin[1] + lane.floor16 / 16} ${origin[2] + START_DZ}`;
  const climbed = endZ < -0.5;
  console.log(`${i} ${lane.name} | ${start} | ${lane.note} | +${(highest - lane.floor16 / 16).toFixed(3)} | ${(origin[2] + endZ).toFixed(2)} | ${climbed ? 'CLIMBS' : 'STOPS'}`);
});
