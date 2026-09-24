/**
 * Pinball TABLE detection: read a LEGO pinball machine's own geometry into the
 * 2D world a ball rolls in, so a Bedrock add-on can play it.
 *
 * WHAT IS READ, ALL FROM THE MODEL:
 *   - the PLAYFIELD PLANE: the orientation most plates/tiles share. 11374
 *     Arcade Pinball Machine tilts it 8.6 degrees (`sin = 0.15` in every
 *     playfield placement's rotation); a flat model gets a nominal tilt.
 *   - the FLOOR the ball rolls on: the up-facing triangles at the dominant
 *     height along the plane normal, rasterised into a mask;
 *   - the WALLS, posts and bumpers: every triangle that crosses the band the
 *     ball occupies above that floor, projected onto the plane. Together with
 *     the floor mask this becomes a signed distance field (`sdf`): positive
 *     in free space, negative inside anything solid or off the floor;
 *   - the FLIPPERS: two mirror-image clusters of parts near the front,
 *     turned about the plane normal (11374: white 6 x 0.5 beams at +/-21.7
 *     degrees on liftarm pivots). Their parts are listed so the exporter can
 *     lift them out of the static shell and swing them;
 *   - the BALL: a sphere part (52629 Technic Ball 19 mm); its radius sets
 *     the band and the collision radius. None found -> 19 mm;
 *   - the LAUNCH LANE: the column along the right wall with the longest free
 *     run up the table, where the plunger fires from.
 *
 * FRAME. Plane coordinates are LDU: `u` runs DOWN the table toward the player
 * (the direction gravity pulls along the plane), `w` runs across it (right
 * when facing the backbox from the front: w = n x u), `h` is height along the
 * normal `n` above the model origin. A model point is
 * `origin + u*U + w*W + h*N` with U, W, N the unit axes in LDraw coordinates.
 *
 * Pure: no DOM, no Bedrock. The mesh map is whatever the caller resolved.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import { partStem } from './part-id.js';
import { createPinballSim, type PinballSimTable } from './pinball-physics.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PinballFlipper {
  side: 'left' | 'right';
  /** Pivot in plane coordinates (u, w), LDU. */
  pivot: [number, number];
  /** Pivot-to-tip length, LDU. */
  length: number;
  /** Capsule radius at the pivot and at the tip, LDU. */
  pivotRadius: number;
  tipRadius: number;
  /** Rest angle of pivot->tip in the (u, w) plane, radians (atan2(du, dw)). */
  restAngle: number;
  /** Raised angle: the rest direction mirrored about the across-table axis. */
  activeAngle: number;
  /** Indices into the source brick list: the parts this flipper carries. */
  bricks: number[];
}

export interface PinballBumper {
  /** Centre (u, w) and radius, LDU. */
  centre: [number, number];
  radius: number;
  part: string;
}

export interface PinballTable {
  /** Unit axes in LDraw model coordinates. */
  axisU: Vec3;
  axisW: Vec3;
  axisN: Vec3;
  /** Degrees between the plane normal and model up. */
  tiltDeg: number;
  /** True when the model's playfield is flat and the tilt is nominal. */
  nominalTilt: boolean;
  /** Floor height along N (LDU) and the ball's radius. */
  floorH: number;
  ballRadius: number;
  /** Signed distance field over the playfield, row-major [row = u][col = w], LDU. */
  grid: { u0: number; w0: number; cell: number; rows: number; cols: number; sdf: Float32Array };
  flippers: PinballFlipper[];
  bumpers: PinballBumper[];
  /** Where a fresh ball sits before launch (u, w), the unit direction it is fired in, and how far that shot runs clear (LDU). */
  launch: { at: [number, number]; dir: [number, number]; clearRun: number; laneTopU: number };
  /** A ball whose u passes this, inside `drainSpan` (w), has drained. */
  drainU: number;
  drainSpan: [number, number];
  /** Indices of the spare ball parts (removed from the shell; the runtime draws its own). */
  ballBricks: number[];
  warnings: string[];
}

export interface PinballDetectOptions {
  /** Grid cell, LDU (default 4). */
  cell?: number;
  /** Tilt used when the playfield is flat, degrees (default 6.5, a real table's). */
  nominalTiltDeg?: number;
  /** Receives one line per detection stage (probe scripts print it). */
  debug?: (line: string) => void;
  /** Plane points (u, w) whose floor/solid/owner the debug line reports. */
  debugPoints?: Array<[number, number]>;
}

// ─── Small vector helpers ───────────────────────────────────────────────────

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** World position of a part-local point. */
function place(b: ParsedBrick, p: Vec3): Vec3 {
  const r = b.rot ?? IDENTITY;
  return [
    b.x + r[0]! * p[0] + r[1]! * p[1] + r[2]! * p[2],
    b.y + r[3]! * p[0] + r[4]! * p[1] + r[5]! * p[2],
    b.z + r[6]! * p[0] + r[7]! * p[1] + r[8]! * p[2],
  ];
}

/** A part's local up (-Y in LDraw) in model coordinates. */
function partUp(b: ParsedBrick): Vec3 {
  const r = b.rot ?? IDENTITY;
  return norm([-r[1]!, -r[4]!, -r[7]!]);
}

const MODEL_UP: Vec3 = [0, -1, 0];
const MODEL_DOWN: Vec3 = [0, 1, 0];

// ─── Detection ───────────────────────────────────────────────────────────────

/** The ball part: a sphere. 52629 is the 19 mm Technic ball the 2026 set ships. */
const BALL_RE = /\bball\b(?!\s*joint)|sphere/i;
/** Round parts that act as bumpers/posts when they stand in the ball's band. */
const ROUND_RE = /round|cylinder|dome|cone/i;
const FLAT_RE = /^(plate|tile)\b/i;

/**
 * Read a pinball table out of a model. Returns null when the model has no
 * pair of mirror-image flipper clusters on a common plane — i.e. it is not a
 * pinball machine this reader understands.
 */
export function detectPinballTable(
  bricks: readonly ParsedBrick[],
  meshes: ReadonlyMap<string, LdrawPartMesh | null>,
  options: PinballDetectOptions = {},
): PinballTable | null {
  const cell = options.cell ?? 4;
  const warnings: string[] = [];
  const debug = options.debug ?? ((): void => {});
  const meshOf = (b: ParsedBrick): LdrawPartMesh | null => meshes.get(partStem(b.part)) ?? meshes.get(b.part) ?? null;
  const descOf = (b: ParsedBrick): string => meshOf(b)?.description ?? '';

  // 1. Playfield normal: the most common up among flat parts that is not
  //    model-up; model-up itself when nothing is tilted.
  const ups = new Map<string, { up: Vec3; n: number }>();
  for (const b of bricks) {
    if (!FLAT_RE.test(descOf(b))) continue;
    const up = partUp(b);
    if (dot(up, MODEL_UP) < 0.9) continue; // walls and upright tiles are not the playfield
    const key = up.map(v => v.toFixed(2)).join(',');
    const slot = ups.get(key) ?? { up, n: 0 };
    slot.n++;
    ups.set(key, slot);
  }
  const tilted = [...ups.values()].filter(s => dot(s.up, MODEL_UP) < 0.9995).sort((a, b) => b.n - a.n)[0];
  const flatCount = [...ups.values()].filter(s => dot(s.up, MODEL_UP) >= 0.9995).reduce((n, s) => n + s.n, 0);
  let axisN: Vec3;
  let nominalTilt = false;
  debug(`plane: ${ups.size} flat-part orientations; tilted ${tilted ? `${tilted.n} x (${tilted.up.map(v => v.toFixed(3))})` : 'none'}; flat ${flatCount}`);
  if (tilted && tilted.n >= 20) axisN = tilted.up;
  else { axisN = MODEL_UP; nominalTilt = true; }
  if (tilted && tilted.n >= 20 && flatCount > tilted.n * 3) warnings.push(`more flat than tilted plates (${flatCount} vs ${tilted.n}); the tilted set was taken as the playfield`);

  // 2. Bricks by role: balls out, then flipper clusters.
  const ballBricks: number[] = [];
  let ballRadius = 23.75; // 19 mm / 0.4 mm per LDU / 2
  bricks.forEach((b, i) => {
    const m = meshOf(b);
    if (!m || !BALL_RE.test(m.description)) return;
    const size = sub(m.bounds.max, m.bounds.min);
    const spread = Math.max(...size) - Math.min(...size);
    if (Math.min(...size) < 20 || spread > 4) return; // a sphere is as deep as it is wide
    ballBricks.push(i);
    ballRadius = Math.max(...size) / 2;
  });
  if (!ballBricks.length) warnings.push('no ball part found; a 19 mm ball is assumed');

  // Provisional U/W from the tilt (flat tables fixed up after flippers).
  let axisU: Vec3 = norm(sub(MODEL_DOWN, scale(axisN, dot(MODEL_DOWN, axisN))));
  if (nominalTilt) axisU = [0, 0, -1]; // replaced once the flippers say where the front is

  // 3. Floor height: the up-facing triangle area at each height along N,
  //    within the tilted parts' footprint.
  const heightArea = new Map<number, number>();
  const tris: Array<{ i: number; a: Vec3; b: Vec3; c: Vec3 }> = [];
  bricks.forEach((b, i) => {
    const m = meshOf(b);
    if (!m) return;
    for (const t of m.triangles) tris.push({ i, a: place(b, t.a), b: place(b, t.b), c: place(b, t.c) });
  });
  for (const t of tris) {
    if (ballBricks.includes(t.i)) continue;
    const nrm = cross(sub(t.b, t.a), sub(t.c, t.a));
    const area = Math.hypot(...nrm) / 2;
    if (area < 1e-6) continue;
    if (Math.abs(dot(norm(nrm), axisN)) < 0.995) continue;
    const h = Math.round((dot(t.a, axisN) + dot(t.b, axisN) + dot(t.c, axisN)) / 3);
    heightArea.set(h, (heightArea.get(h) ?? 0) + area);
  }
  // The ball rolls on the TOP broad layer. Covered plate tops under a tile
  // skin are up-facing too (11374: plates at h 307, 452k LDU2; the tile skin
  // at h 327, 416k), so take the highest height carrying at least 40 % of the
  // largest area rather than the largest.
  const maxArea = Math.max(0, ...heightArea.values());
  const floorH = [...heightArea.entries()].filter(([, a]) => a >= maxArea * 0.4).sort((a, b) => b[0] - a[0])[0]?.[0];
  debug(`floor: ${[...heightArea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h, a]) => `h ${h} area ${Math.round(a)}`).join('; ')}`);
  if (floorH === undefined) return null;

  // 4. Flippers: parts standing in the ball band whose rotation about N is
  //    neither 0 nor a multiple of 90 degrees, grouped into two clusters.
  // A part lower than ~0.62 r above the floor is something the ball rolls
  // OVER, not a wall: the obstacle band starts there. 11374 has two such
  // classes: 84 round-ended 1 x 2 plates (rollover lights, 8 LDU high) and
  // the drain lip under the flipper tips — a 1 x 16 brick and a red slope
  // "heart", both topping out 14 LDU above the playfield. Read as walls they
  // closed the drain: a dropped ball came to rest between flipper and heart.
  const bandLo = floorH + 0.62 * ballRadius, bandHi = floorH + 2 * ballRadius;
  const turned: number[] = [];
  bricks.forEach((b, i) => {
    if (ballBricks.includes(i)) return;
    const m = meshOf(b);
    if (!m) return;
    const up = partUp(b);
    if (Math.abs(dot(up, axisN)) < 0.99) return; // not lying on the plane
    const h = dot([b.x, b.y, b.z], axisN);
    if (h < floorH - 30 || h > bandHi + 30) return;
    const r = b.rot ?? IDENTITY;
    const localX: Vec3 = [r[0]!, r[3]!, r[6]!];
    const ang = Math.atan2(dot(localX, axisU), dot(localX, cross(axisN, axisU))) * 180 / Math.PI;
    const off = Math.abs(((ang % 90) + 90) % 90);
    if (off > 8 && off < 82) turned.push(i);
  });
  const clusters = clusterBricks(bricks, turned, 70);
  debug(`flippers: ${turned.length} turned parts in ${clusters.length} clusters: ${clusters.map(c => `${c.members.length}@(${c.centre.map(v => Math.round(v))})`).join(' ')}`);
  const pair = pickFlipperPair(bricks, clusters, axisN);
  if (!pair) return null;

  // A flat table: the flippers are at the FRONT; U points from table centre toward them.
  const centreAll = centroid(bricks.map(b => [b.x, b.y, b.z] as Vec3));
  const flipMid = scale([...pair[0].centre].map((v, k) => v + pair[1].centre[k]!) as Vec3, 0.5);
  if (nominalTilt) {
    const toFront = sub(flipMid, centreAll);
    axisU = norm(sub(toFront, scale(axisN, dot(toFront, axisN))));
    const tiltRad = (options.nominalTiltDeg ?? 6.5) * Math.PI / 180;
    warnings.push(`the playfield is flat in the model; a ${(options.nominalTiltDeg ?? 6.5).toFixed(1)} degree tilt is simulated toward the flippers`);
    void tiltRad;
  } else if (dot(sub(flipMid, centreAll), axisU) < 0) {
    warnings.push('the flippers sit UP the slope from the table centre; the model may be reversed');
  }
  const axisW = norm(cross(axisN, axisU));
  const toPlane = (p: Vec3): [number, number] => [dot(p, axisU), dot(p, axisW)];

  // 5. Rasterise floor and solids into the grid over the floor's extent.
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  const floorTris: Array<[Vec3, Vec3, Vec3]> = [];
  const solidTris: Array<{ i: number; t: [Vec3, Vec3, Vec3] }> = [];
  // A flipper is every part inside its capsule, not only the turned ones:
  // pins, bushes and axle-aligned plates on the same arm swing with it.
  for (const cl of pair) {
    const rough = flipperFromCluster(bricks, meshOf, cl.members, toPlane, dot(flipMid, axisW));
    // Reach past the capsule's tip centre: the tip parts themselves (11374: a
    // white 1-stud beam and two rounded tiles per flipper) sit there and,
    // left in the static field, read as a post in the drain gap.
    const reach = rough.length + rough.tipRadius * 2 + 10;
    const tip: [number, number] = [rough.pivot[0] + Math.sin(rough.restAngle) * reach, rough.pivot[1] + Math.cos(rough.restAngle) * reach];
    bricks.forEach((b, i) => {
      if (cl.members.includes(i) || ballBricks.includes(i)) return;
      const h = dot([b.x, b.y, b.z], axisN);
      if (h < floorH - 4 || h > bandHi + 20) return;
      const [pu, pw] = toPlane([b.x, b.y, b.z]);
      if (segmentDistance(pu, pw, rough.pivot, tip) <= rough.pivotRadius) cl.members.push(i);
    });
  }
  const flipperSet = new Set([...pair[0].members, ...pair[1].members]);
  for (const t of tris) {
    if (ballBricks.includes(t.i) || flipperSet.has(t.i)) continue;
    const hs = [dot(t.a, axisN), dot(t.b, axisN), dot(t.c, axisN)];
    // FLOOR is anything whose top is at the playfield level and that fills
    // the space just under it: flat tile tops, but also the sloped faces of
    // parts set flush with it. 11374's red slope "heart" between the flipper
    // tips tops out at the playfield level with no flat face there, and a
    // flat-faces-only rule left it a hole that trapped every drained ball.
    const top = Math.max(...hs);
    if (top <= floorH + 1.5 && top >= floorH - 1.5 && Math.min(...hs) >= floorH - 30) {
      floorTris.push([t.a, t.b, t.c]);
      for (const p of [t.a, t.b, t.c]) {
        const [pu, pw] = toPlane(p);
        u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); w0 = Math.min(w0, pw); w1 = Math.max(w1, pw);
      }
      continue;
    }
    if (Math.max(...hs) > bandLo && Math.min(...hs) < bandHi) solidTris.push({ i: t.i, t: [t.a, t.b, t.c] });
  }
  if (!floorTris.length) return null;
  const rows = Math.ceil((u1 - u0) / cell) + 1;
  const cols = Math.ceil((w1 - w0) / cell) + 1;
  const floor = new Uint8Array(rows * cols);
  const solid = new Uint8Array(rows * cols);
  const owner = new Int32Array(rows * cols).fill(-1);
  const raster = (t: [Vec3, Vec3, Vec3], hit: (k: number) => void): void => {
    const p = t.map(toPlane) as Array<[number, number]>;
    const r0 = Math.max(0, Math.floor((Math.min(p[0]![0], p[1]![0], p[2]![0]) - u0) / cell));
    const r1 = Math.min(rows - 1, Math.ceil((Math.max(p[0]![0], p[1]![0], p[2]![0]) - u0) / cell));
    const c0 = Math.max(0, Math.floor((Math.min(p[0]![1], p[1]![1], p[2]![1]) - w0) / cell));
    const c1 = Math.min(cols - 1, Math.ceil((Math.max(p[0]![1], p[1]![1], p[2]![1]) - w0) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (pointInTriangle2(u0 + (r + 0.5) * cell, w0 + (c + 0.5) * cell, p, cell * 0.35)) hit(r * cols + c);
    }
  };
  for (const t of floorTris) raster(t, k => { floor[k] = 1; });
  // A ball bridges any floor gap narrower than itself: close the mask with a
  // disc of the ball's radius. 11374 has a 44 x 32 LDU opening above its
  // flipper tips that otherwise read as a hole and caught every drain.
  closeMask(rows, cols, floor, Math.max(1, Math.round(ballRadius / cell)));
  for (const { i, t } of solidTris) raster(t, k => { solid[k] = 1; owner[k] = i; });
  // Fill enclosed solids: a wall mesh projects its skin; its hollow interior
  // must read solid too, or the SDF puts a free pocket inside every brick.
  // Everything not reachable from a floor cell through non-solid cells is solid.
  for (const [pu, pw] of options.debugPoints ?? []) {
    const r = Math.floor((pu - u0) / cell), c = Math.floor((pw - w0) / cell);
    const k = r * cols + c;
    const i = owner[k] ?? -1;
    debug(`point (${pu}, ${pw}): floor ${floor[k]} solid ${solid[k]} owner ${i >= 0 ? `#${i} ${bricks[i]!.part} ${descOf(bricks[i]!)}` : '-'}`);
  }
  const free = floodFree(rows, cols, floor, solid);
  const sdf = signedDistance(rows, cols, free, cell);

  // 6. Bumpers: round parts whose cells are solid in the band.
  const bumpers: PinballBumper[] = [];
  const seen = new Set<number>();
  for (let k = 0; k < owner.length; k++) {
    const i = owner[k]!;
    if (i < 0 || seen.has(i)) continue;
    seen.add(i);
    const b = bricks[i]!;
    const m = meshOf(b);
    if (!m || !ROUND_RE.test(m.description)) continue;
    const size = sub(m.bounds.max, m.bounds.min);
    const diameter = Math.max(size[0], size[2]);
    if (diameter < 18) continue;
    const c = place(b, scale([m.bounds.min[0] + m.bounds.max[0], m.bounds.min[1] + m.bounds.max[1], m.bounds.min[2] + m.bounds.max[2]] as Vec3, 0.5));
    const centre = toPlane(c);
    const gr = Math.floor((centre[0] - u0) / cell), gc = Math.floor((centre[1] - w0) / cell);
    if (gr < 0 || gc < 0 || gr >= rows || gc >= cols) continue;
    // Keep it only if free space touches it: a bumper the ball can reach.
    const reach = Math.ceil((diameter / 2 + ballRadius) / cell);
    let touches = false;
    for (let dr = -reach; dr <= reach && !touches; dr++) for (let dc = -reach; dc <= reach; dc++) {
      const rr = gr + dr, cc = gc + dc;
      if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && free[rr * cols + cc]) { touches = true; break; }
    }
    if (touches) bumpers.push({ centre, radius: diameter / 2, part: partStem(b.part) });
  }

  // 7. Flippers in plane terms.
  const centreW = (w0 + w1) / 2;
  const flippers = pair.map(cl => flipperFromCluster(bricks, meshOf, cl.members, toPlane, centreW)) as PinballFlipper[];
  flippers.sort((a, b) => a.pivot[1] - b.pivot[1]);
  flippers[0]!.side = 'left';
  flippers[1]!.side = 'right';

  // 8. Launch lane: the free column near the right wall with the longest run
  //    upward from the flipper line; the ball waits at its bottom.
  const flipU = Math.max(flippers[0]!.pivot[0], flippers[1]!.pivot[0]);
  const drainU = flipU + ballRadius * 2;
  const launch = findLaunchLane(rows, cols, free, sdf, u0, w0, cell, ballRadius, flipU);
  // No lane: serve from the free spot above the flipper line whose shot up
  // the table runs clear the longest. 11374's roomiest spot sits under its
  // ramp, where a straight-up shot hits the ramp base at once; the ray test
  // finds a shot that reaches the upper playfield.
  const clearRun = (u: number, w: number, du: number, dw: number): number => {
    let run = 0;
    for (; run < rows * cell * 1.5; run += cell) {
      const r = Math.floor((u + du * run - u0) / cell), c = Math.floor((w + dw * run - w0) / cell);
      if (r < 0 || c < 0 || r >= rows || c >= cols || sdf[r * cols + c]! < ballRadius) break;
    }
    return run;
  };
  // The serve spot must DRAIN when dropped: a ball released there rolls down
  // to the flippers. 11374's longest shot starts in a basin under the ramp,
  // which is also where a returning ball would come to rest. Spots are
  // drop-tested on a coarse grid first, then the best shot is chosen among
  // the ones that drain.
  const simTable0 = {
    u0, w0, cell, rows, cols, sdf2: Array.from(sdf, v => Math.round(v * 2)), ballRadius,
    flippers: flippers.map(f => ({ side: f.side, pivot: f.pivot, length: f.length, pivotRadius: f.pivotRadius, tipRadius: f.tipRadius, restAngle: f.restAngle, activeAngle: f.activeAngle })),
    bumpers: [] as Array<{ centre: [number, number]; radius: number }>, launch: [0, 0] as [number, number], drainU,
  };
  const drains = (at: [number, number]): boolean => {
    // The plunger is parked far away so the plunger-return rule cannot fire.
    const sim = createPinballSim({ ...simTable0, launch: [-1e6, -1e6] });
    sim.state.phase = 'play';
    sim.state.u = at[0]; sim.state.w = at[1];
    for (let t = 0; t < 20 * 6; t++) {
      const ev = sim.step({ left: false, right: false, launch: false }, 0.05);
      if (ev.some(e => e.kind === 'drain') || sim.state.u > flipU) return true;
      if (ev.some(e => e.kind === 'kickout' || e.kind === 'rescue')) return false;
    }
    return false;
  };
  let fallbackLaunch = { at: [flipU - ballRadius * 6, flippers[1]!.pivot[1] - ballRadius * 2] as [number, number], dir: [-1, 0] as [number, number], clearRun: 0, laneTopU: u0 };
  let bestScore = -Infinity, tested = 0, draining = 0;
  for (let r = 0; r < rows; r += 3) {
    const u = u0 + (r + 0.5) * cell;
    if (u < flipU - ballRadius * 12 || u > flipU - ballRadius * 3) continue;
    for (let c = 0; c < cols; c += 3) {
      if (sdf[r * cols + c]! < ballRadius * 1.1) continue;
      const w = w0 + (c + 0.5) * cell;
      tested++;
      if (!drains([u, w])) continue;
      draining++;
      for (const deg of [0, -10, 10, -20, 20, -30, 30]) {
        const a = deg * Math.PI / 180;
        const du = -Math.cos(a), dw = Math.sin(a);
        const run = clearRun(u, w, du, dw);
        // Prefer the right half (where a player expects the plunger) on a near-tie.
        const score = run + (w > (w0 + w1) / 2 ? cell * 4 : 0) - Math.abs(deg) * 0.5;
        if (score > bestScore) { bestScore = score; fallbackLaunch = { at: [u, w], dir: [du, dw], clearRun: run, laneTopU: u + du * run }; }
      }
    }
  }
  const tried = { size: `${draining} of ${tested}` };
  debug(`serve: ${tried.size} spots drop-tested; best in-field serve (${fallbackLaunch.at.map(v => v.toFixed(0))}) firing ${fallbackLaunch.clearRun} LDU clear`);
  // A serve must PLAY: a full-charge shot has to reach the upper table and
  // cross into the field. 11374's shooter lane (below the right flipper) runs
  // up the right wall to a post at its mouth where the real set has a gate;
  // in the plane the ball hits the post and falls back down the lane every
  // time, so the lane is only used when a simulated shot gets out of it.
  const plays = (cand: { at: [number, number]; dir: [number, number] }): boolean => {
    const sim = createPinballSim({ ...simTable0, launch: cand.at, launchDir: cand.dir });
    sim.step({ left: false, right: false, launch: true }, 1);
    sim.step({ left: false, right: false, launch: false }, 0.05);
    let high = false;
    for (let t = 0; t < 20 * 5; t++) {
      const ev = sim.step({ left: false, right: false, launch: false }, 0.05);
      if (sim.state.u < u0 + (rows * cell) * 0.4) high = true;
      if (high && Math.abs(sim.state.w - cand.at[1]) > ballRadius * 4) return true;
      if (ev.some(e => e.kind === 'drain' || e.kind === 'rescue' || e.kind === 'return')) return false;
    }
    return false;
  };
  // Round parts in the shooter lane or below the flipper line are guides, not
  // bumpers: 11374 has one beside the plunger (it scored every launch) and a
  // post at the lane mouth whose kick threw every shot back down the lane.
  // They stay solid in the field; they just do not kick or score.
  const isGuide = (b: PinballBumper, lane: { at: [number, number]; laneTopU: number } | null): boolean =>
    b.centre[0] > flipU || (lane !== null && Math.abs(b.centre[1] - lane.at[1]) < ballRadius * 2.5 && b.centre[0] > lane.laneTopU - ballRadius * 3);
  const kickers = (lane: { at: [number, number]; laneTopU: number } | null): PinballBumper[] => bumpers.filter(b => !isGuide(b, lane));
  simTable0.bumpers = kickers(launch).map(b => ({ centre: b.centre, radius: b.radius }));
  const laneOk = launch ? plays(launch) : false;
  const fieldOk = plays(fallbackLaunch);
  debug(`serve: lane ${launch ? (laneOk ? 'plays' : 'does NOT reach the field') : 'none'}; in-field serve ${fieldOk ? 'plays' : 'does NOT reach the upper table'}`);
  if (launch && !laneOk) warnings.push('the shooter lane does not open into the field in the plane (its mouth is gated in the real set); the ball is served above the right flipper instead');
  if (!fieldOk && !laneOk) warnings.push('no serve reaches the upper table on a full-charge shot');
  const chosenLaunch = launch && laneOk ? launch : fallbackLaunch;
  const playBumpers = kickers(launch && laneOk ? launch : null);
  return {
    axisU, axisW, axisN,
    tiltDeg: Math.acos(Math.min(1, Math.abs(dot(axisN, MODEL_UP)))) * 180 / Math.PI || (nominalTilt ? options.nominalTiltDeg ?? 6.5 : 0),
    nominalTilt, floorH, ballRadius,
    grid: { u0, w0, cell, rows, cols, sdf },
    flippers, bumpers: playBumpers,
    launch: chosenLaunch,
    drainU,
    drainSpan: [flippers[0]!.pivot[1] - flippers[0]!.pivotRadius, flippers[1]!.pivot[1] + flippers[1]!.pivotRadius],
    ballBricks,
    warnings,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function centroid(ps: readonly Vec3[]): Vec3 {
  const s: Vec3 = [0, 0, 0];
  for (const p of ps) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
  return scale(s, 1 / Math.max(1, ps.length));
}

interface Cluster { members: number[]; centre: Vec3 }

/** Single-link clusters of brick ORIGINS within `link` LDU. */
function clusterBricks(bricks: readonly ParsedBrick[], idx: readonly number[], link: number): Cluster[] {
  const parent = idx.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
    const p = bricks[idx[a]!]!, q = bricks[idx[b]!]!;
    if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) <= link) parent[find(a)] = find(b);
  }
  const groups = new Map<number, number[]>();
  idx.forEach((i, k) => { const r = find(k); groups.set(r, [...(groups.get(r) ?? []), i]); });
  return [...groups.values()].map(members => ({ members, centre: centroid(members.map(i => [bricks[i]!.x, bricks[i]!.y, bricks[i]!.z] as Vec3)) }));
}

/**
 * The two clusters that look like a flipper PAIR: same height along N, same
 * number of parts (within one), mirror images across the table.
 */
function pickFlipperPair(bricks: readonly ParsedBrick[], clusters: readonly Cluster[], axisN: Vec3): [Cluster, Cluster] | null {
  let best: [Cluster, Cluster] | null = null;
  let bestScore = Infinity;
  const big = clusters.filter(c => c.members.length >= 3);
  for (let a = 0; a < big.length; a++) for (let b = a + 1; b < big.length; b++) {
    const A = big[a]!, B = big[b]!;
    const dh = Math.abs(dot(A.centre, axisN) - dot(B.centre, axisN));
    const dn = Math.abs(A.members.length - B.members.length);
    const apart = Math.hypot(...sub(A.centre, B.centre));
    if (dh > 12 || dn > 1 || apart < 60) continue;
    const parts = (c: Cluster): string => c.members.map(i => partStem(bricks[i]!.part)).sort().join(',');
    const same = parts(A) === parts(B) ? 0 : 1;
    const score = same * 1000 + dh * 10 + dn * 50 - apart * 0.01;
    if (score < bestScore) { bestScore = score; best = [A, B]; }
  }
  return best;
}

/** Pivot at the OUTER end of the cluster's long axis, tip at the inner end. */
function flipperFromCluster(
  bricks: readonly ParsedBrick[],
  meshOf: (b: ParsedBrick) => LdrawPartMesh | null,
  members: number[],
  toPlane: (p: Vec3) => [number, number],
  centreW: number,
): PinballFlipper {
  const pts: Array<[number, number]> = [];
  for (const i of members) {
    const b = bricks[i]!;
    const m = meshOf(b);
    if (!m) { pts.push(toPlane([b.x, b.y, b.z])); continue; }
    for (const t of m.triangles) for (const p of [t.a, t.b, t.c]) pts.push(toPlane(place(b, p)));
  }
  const cu = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cw = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  // Principal axis of the point cloud in the plane.
  let suu = 0, sww = 0, suw = 0;
  for (const [u, w] of pts) { suu += (u - cu) ** 2; sww += (w - cw) ** 2; suw += (u - cu) * (w - cw); }
  const theta = 0.5 * Math.atan2(2 * suw, suu - sww);
  const du = Math.cos(theta), dw = Math.sin(theta);
  let lo = Infinity, hi = -Infinity;
  for (const [u, w] of pts) { const s = (u - cu) * du + (w - cw) * dw; lo = Math.min(lo, s); hi = Math.max(hi, s); }
  const endA: [number, number] = [cu + du * lo, cw + dw * lo];
  const endB: [number, number] = [cu + du * hi, cw + dw * hi];
  // The pivot is the end farther from the table's centre line.
  const pivotIsA = Math.abs(endA[1] - centreW) > Math.abs(endB[1] - centreW);
  const outer = pivotIsA ? endA : endB;
  const inner = pivotIsA ? endB : endA;
  const span = hi - lo;
  // Unit axis from the outer end toward the inner end.
  const au = (inner[0] - outer[0]) / (span || 1), aw = (inner[1] - outer[1]) / (span || 1);
  // Half-width at each end: the widest point within a quarter of the span.
  let pivotRadius = 0, tipRadius = 0;
  for (const [u, w] of pts) {
    const along = (u - outer[0]) * au + (w - outer[1]) * aw;
    const across = Math.abs((u - outer[0]) * -aw + (w - outer[1]) * au);
    if (along <= span * 0.25) pivotRadius = Math.max(pivotRadius, across);
    if (along >= span * 0.75) tipRadius = Math.max(tipRadius, across);
  }
  pivotRadius = Math.max(6, pivotRadius);
  tipRadius = Math.max(4, Math.min(tipRadius, pivotRadius));
  // The capsule must END where the parts end: its centres sit one radius in
  // from each extreme, and the pivot (the hinge) is the outer centre. A capsule
  // drawn on the raw extremes grows by its radius at both ends and closed
  // 11374's drain gap from 54 LDU to 25 against a 47.5 LDU ball.
  const pivot: [number, number] = [outer[0] + au * pivotRadius, outer[1] + aw * pivotRadius];
  const tip: [number, number] = [inner[0] - au * tipRadius, inner[1] - aw * tipRadius];
  const restAngle = Math.atan2(tip[0] - pivot[0], tip[1] - pivot[1]);
  return {
    side: 'left',
    pivot,
    length: Math.hypot(tip[0] - pivot[0], tip[1] - pivot[1]),
    pivotRadius,
    tipRadius,
    restAngle,
    // Mirror about the across-table axis: the tip swings from below the
    // pivot's line to the same angle above it.
    activeAngle: Math.atan2(-(tip[0] - pivot[0]), tip[1] - pivot[1]),
    bricks: members,
  };
}

/** Point-in-triangle in 2D with a tolerance (cells straddling an edge count). */
function pointInTriangle2(u: number, w: number, p: Array<[number, number]>, tol: number): boolean {
  const [a, b, c] = p as [[number, number], [number, number], [number, number]];
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) {
    // A sliver (a wall face seen edge-on): distance to its longest edge.
    const segs: Array<[[number, number], [number, number]]> = [[a, b], [b, c], [c, a]];
    return segs.some(([s, e]) => segmentDistance(u, w, s, e) <= tol);
  }
  const s = Math.sign(area);
  const e0 = ((b[0] - a[0]) * (w - a[1]) - (b[1] - a[1]) * (u - a[0])) * s;
  const e1 = ((c[0] - b[0]) * (w - b[1]) - (c[1] - b[1]) * (u - b[0])) * s;
  const e2 = ((a[0] - c[0]) * (w - c[1]) - (a[1] - c[1]) * (u - c[0])) * s;
  if (e0 >= 0 && e1 >= 0 && e2 >= 0) return true;
  return segmentDistance(u, w, a, b) <= tol || segmentDistance(u, w, b, c) <= tol || segmentDistance(u, w, c, a) <= tol;
}

function segmentDistance(u: number, w: number, s: [number, number], e: [number, number]): number {
  const du = e[0] - s[0], dw = e[1] - s[1];
  const l2 = du * du + dw * dw;
  const t = l2 ? Math.max(0, Math.min(1, ((u - s[0]) * du + (w - s[1]) * dw) / l2)) : 0;
  return Math.hypot(u - (s[0] + du * t), w - (s[1] + dw * t));
}

/**
 * Free cells: floor, not solid, and connected to the largest such region.
 * Isolated pockets (inside a hollow brick's projected skin, or a floor patch
 * the ball can never reach) are solid.
 */
function floodFree(rows: number, cols: number, floor: Uint8Array, solid: Uint8Array): Uint8Array {
  const open = (k: number): boolean => floor[k] === 1 && solid[k] === 0;
  const label = new Int32Array(rows * cols).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let k = 0; k < rows * cols; k++) {
    if (!open(k) || label[k]! >= 0) continue;
    const id = sizes.length;
    let n = 0;
    label[k] = id; stack.push(k);
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const r = Math.floor(q / cols), c = q % cols;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const nk = rr * cols + cc;
        if (open(nk) && label[nk]! < 0) { label[nk] = id; stack.push(nk); }
      }
    }
    sizes.push(n);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const free = new Uint8Array(rows * cols);
  for (let k = 0; k < free.length; k++) free[k] = label[k] === main ? 1 : 0;
  return free;
}

/** Morphological CLOSE (dilate then erode) of a 0/1 mask by a disc of `k` cells, in place. */
function closeMask(rows: number, cols: number, mask: Uint8Array, k: number): void {
  const disc: Array<[number, number]> = [];
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (dr * dr + dc * dc <= k * k) disc.push([dr, dc]);
  const pass = (src: Uint8Array, want: 0 | 1): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      // dilate: 1 if any neighbour is 1; erode: 1 only if every neighbour is 1
      let v: 0 | 1 = want === 1 ? 0 : 1;
      for (const [dr, dc] of disc) {
        const rr = r + dr, cc = c + dc;
        const x = rr < 0 || cc < 0 || rr >= rows || cc >= cols ? 0 : src[rr * cols + cc]!;
        if (want === 1 && x) { v = 1; break; }
        if (want === 0 && !x) { v = 0; break; }
      }
      out[r * cols + c] = v;
    }
    return out;
  };
  const closed = pass(pass(mask, 1), 0);
  mask.set(closed);
}

/** 1D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number): Float64Array {
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    d[q] = (q - v[k]!) ** 2 + f[v[k]!]!;
  }
  return d;
}

/** Exact Euclidean distance (in cells, squared) to the nearest cell where `target` is 1. */
function edt2d(rows: number, cols: number, target: Uint8Array): Float64Array {
  const INF = 1e12;
  const g = new Float64Array(rows * cols);
  for (let k = 0; k < g.length; k++) g[k] = target[k] ? 0 : INF;
  const col = new Float64Array(rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) col[r] = g[r * cols + c]!;
    const d = edt1d(col, rows);
    for (let r = 0; r < rows; r++) g[r * cols + c] = d[r]!;
  }
  const row = new Float64Array(cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) row[c] = g[r * cols + c]!;
    const d = edt1d(row, cols);
    for (let c = 0; c < cols; c++) g[r * cols + c] = d[c]!;
  }
  return g;
}

/** Positive = distance to the nearest solid cell edge; negative = depth inside a solid. LDU. */
function signedDistance(rows: number, cols: number, free: Uint8Array, cell: number): Float32Array {
  const solidMask = new Uint8Array(free.length);
  for (let k = 0; k < free.length; k++) solidMask[k] = free[k] ? 0 : 1;
  const toSolid = edt2d(rows, cols, solidMask);
  const toFree = edt2d(rows, cols, free);
  const out = new Float32Array(free.length);
  for (let k = 0; k < free.length; k++) {
    out[k] = free[k] ? (Math.sqrt(toSolid[k]!) - 0.5) * cell : -(Math.sqrt(toFree[k]!) - 0.5) * cell;
  }
  return out;
}

/**
 * The launch lane: a free column within the right fifth of the table whose
 * clearance fits the ball, with the longest free run up from the flipper line.
 */
function findLaunchLane(
  rows: number, cols: number, free: Uint8Array, sdf: Float32Array,
  u0: number, w0: number, cell: number, ballRadius: number, flipU: number,
): { at: [number, number]; dir: [number, number]; clearRun: number; laneTopU: number } | null {
  const startRow = Math.min(rows - 1, Math.max(0, Math.floor((flipU - u0) / cell)));
  let best: { c: number; run: number; bottom: number } | null = null;
  for (let c = Math.floor(cols * 0.8); c < cols; c++) {
    // lowest free row at or below the flipper line with room for the ball
    let bottom = -1;
    for (let r = rows - 1; r >= Math.floor(rows * 0.5); r--) {
      const k = r * cols + c;
      if (free[k] && sdf[k]! >= ballRadius * 0.8) { bottom = r; break; }
    }
    if (bottom < 0 || bottom < startRow - 2) continue;
    let run = 0;
    for (let r = bottom; r >= 0; r--) {
      const k = r * cols + c;
      if (!free[k] || sdf[k]! < ballRadius * 0.8) break;
      run++;
    }
    if (!best || run > best.run) best = { c, run, bottom };
  }
  if (!best || best.run * cell < ballRadius * 8) return null;
  return {
    at: [u0 + (best.bottom + 0.5) * cell, w0 + (best.c + 0.5) * cell],
    dir: [-1, 0],
    clearRun: best.run * cell,
    laneTopU: u0 + (best.bottom - best.run + 0.5) * cell,
  };
}

// ─── Simulation input ────────────────────────────────────────────────────────


/** The plain-JSON table the simulation (and the add-on script) runs on. */
export function pinballSimTable(table: PinballTable): PinballSimTable {
  const { grid } = table;
  return {
    u0: grid.u0, w0: grid.w0, cell: grid.cell, rows: grid.rows, cols: grid.cols,
    sdf2: Array.from(grid.sdf, v => Math.max(-32000, Math.min(32000, Math.round(v * 2)))),
    ballRadius: table.ballRadius,
    flippers: table.flippers.map(f => ({ side: f.side, pivot: f.pivot, length: f.length, pivotRadius: f.pivotRadius, tipRadius: f.tipRadius, restAngle: f.restAngle, activeAngle: f.activeAngle })),
    bumpers: table.bumpers.map(b => ({ centre: b.centre, radius: b.radius })),
    launch: table.launch.at,
    launchDir: table.launch.dir,
    drainU: table.drainU,
    drainSpan: table.drainSpan,
  };
}
