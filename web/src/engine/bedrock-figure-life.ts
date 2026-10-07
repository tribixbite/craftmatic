/**
 * Minifig NPC life: how a set's figures move about once placed.
 *
 * WHY a script and not Bedrock's own mob AI. Until 2026-09-25 every figure ran
 * vanilla `random_stroll` + `navigation.walk` with a 12-block `minecraft:home`.
 * On the Pixel that failed both ways: in the Winter Chalet 0 of 7 figures
 * roamed (the walkers stand on floor-plate COLLIDER blocks under a ~2.25-block
 * ceiling, and the mob path-finder, which plans on whole block cells, never
 * found a path the player walks every day), while figures standing on plain
 * ground strolled up to 12 blocks off the model. The path-finder cannot be
 * told about the partial-height collider blocks, so this module plans over
 * the REAL collision spans (`craftmatic:collider[lo,hi]` sixteenths, and any
 * other block as a full cube) and walks the figure by velocity, which the
 * engine's own collision, gravity and step-up then carry out.
 *
 * Behaviour, per figure (state machine in `figureLifeRuntime`):
 *  - HOME AREA: the placement's footprint box, a radius around its spawn
 *    point and a height band around the floor it started on. It never plans a
 *    step outside it, never a rise above a step (0.6 blocks: no jumping, so a
 *    figure keeps to its floor) and never a drop below one (no falls).
 *  - STROLL: a short walk (2-6 cells) to a random reachable cell, turning on
 *    the spot first when the heading is far off, then facing its travel; a
 *    gentle speed (1.2 blocks/s at 100 %, less for a smaller placement).
 *  - PAUSE: 3-9 s idle between strolls, sometimes longer; vanilla
 *    `look_at_player` / `random_look_around` turn the head, and the body turns
 *    to face a player who comes close.
 *  - SEAT: now and then, walks to a free seat of its own pack in the area and
 *    sits for 20-40 s; it stands up when a player comes close to the seat.
 *  - DOORWAYS: never stops within 1.25 blocks of a door/window leaf (the
 *    interactives runtime refuses to close on a figure in the doorway).
 *  - RETURN: pushed or knocked out of the area, it plans back in; if no path
 *    exists within 10 s it is put back home.
 *  - STAY: a figure the source seated (`rideOf`) stays on its seat (and is
 *    re-seated if it is knocked off) - except that it gives the seat to a
 *    player who comes to it, standing up beside it, and takes it back once
 *    the player has gone: every chair in the build is the player's to sit
 *    on; a figure whose floor offers fewer than
 *    `minRoamCells` reachable cells (a display plinth, a cramped nook) stays
 *    where it stands and only looks about.
 *
 * The placement runtime writes each figure's home record as the dynamic
 * property `FIGURE_HOME_PROPERTY` when it spawns it (bedrock-placement-pack.ts);
 * the record survives a world reload, so this runtime re-adopts figures after
 * one. Only this pack's figure types are driven (several packs in one world
 * each run their own copy).
 *
 * The planner functions are pure and serialised into `scripts/figures.js`
 * with `.toString()` (the house pattern, see bedrock-coaster.ts), so they are
 * tested on the host against the same collider grid the pack ships
 * (test/bedrock-figure-life.test.ts, scripts/_figure_roam_census.ts).
 */

import { COLLIDER_STATES, ESCAPE_OPTIONS, colliderBodyProbe, colliderFormKit, type ColliderBodyProbe, type EscapeOptions } from './collider-form.js';

/**
 * The scenery-seat watcher's bounds (`safeSeatDismounts` in the runtime; docs/physics-architecture.md §9):
 *   - `NATIVE_REACH_BLOCKS` 2: Bedrock sets a dismounted player down one block from the seat entity, diagonals
 *     included (1.41), or 0.2 over it to fall (quirk `dismount-free-spot`); a player found farther than 2 blocks
 *     away the tick after was moved on purpose (a /tp out of the seat) and is left where it went;
 *   - `RESEAT_LIMIT` 2 within `RESEAT_WINDOW_TICKS` 100 (5 s): when nothing walkable can be found the player is put
 *     back on the seat, but a held Sneak dismounts again at once, so after two re-seats in a row the player is left
 *     where Bedrock set it down instead of looping seat, off, seat every tick.
 */
export const SEAT_EGRESS = { NATIVE_REACH_BLOCKS: 2, RESEAT_LIMIT: 2, RESEAT_WINDOW_TICKS: 100 } as const;

/** Dynamic property holding a figure's home record (JSON string; see `FigureHome`). */
export const FIGURE_HOME_PROPERTY = 'craftmatic:fig';

/**
 * Dynamic property the placement sets on a source-seated figure while it is
 * still spawning the model's actors (`Date.now()` in ms), and clears once its
 * own seating pass has seated the figure or given up: until then the seat may
 * not exist yet, so the figure runtime neither retakes nor reports a missing
 * seat. 10261's placement spawns its actors over ~2 minutes and its kiosk
 * figure before its seat; both phones logged FIGURE_RETAKE_NO_SEAT for it on
 * every placement (Saga round 2026-09-29c). The runtimes are serialised, so
 * both spell the literal; `test/bedrock-figure-life.test.ts` pins that.
 */
export const FIGURE_SEATING_PROPERTY = 'craftmatic:fig_seating';

/**
 * How long (ms) a seating mark holds the retake off. A placement stopped by
 * an error or a script reload never clears its mark; past this the figure
 * retakes as usual. 10261's placement takes ~2 minutes on the phones.
 */
export const FIGURE_SEATING_GRACE_MS = 10 * 60 * 1000;

/** A figure's home record, written by the placement runtime at spawn. World blocks. */
export interface FigureHome {
  /** Spawn feet position. */
  home: [number, number, number];
  /** The placement's world box [x0, z0, x1, z1], exclusive max (block edges). */
  area: [number, number, number, number];
  /** The pin plane the model stands on (world y). */
  ground: number;
  /** The wand's size factor (1 = 100 %). */
  f: number;
  /** `seated`: the source sat it on a chair; `roam`: it walks about. */
  mode: 'roam' | 'seated';
}

/** Numbers the runtime runs on; all distances in blocks at 100 % unless noted. */
export interface FigureTuning {
  /** Walking speed, blocks per tick at 100 % (0.06 = 1.2 blocks/s). */
  speed: number;
  /** Largest body turn per tick while walking, degrees. */
  turnPerTick: number;
  /** Heading error above which a figure turns on the spot before it walks, degrees. */
  turnInPlace: number;
  /** Largest rise a figure steps up (no jumping), and largest drop it steps down. */
  maxUp: number;
  maxDown: number;
  /** Radius around home a stroll may end in (world blocks, scaled by the size factor, capped at `radiusCap`). */
  radius: number;
  radiusCap: number;
  /** Height band around the home floor (world blocks at 100 %, scaled). */
  band: number;
  /** A stroll ends this many cells (path steps) away, at least / at most. */
  strollMin: number;
  strollMax: number;
  /** Idle between strolls, ticks; a long idle is taken with `longIdleChance`. */
  idleMin: number;
  idleMax: number;
  longIdleMin: number;
  longIdleMax: number;
  longIdleChance: number;
  /** Chance to head for a free seat instead of a stroll, when one is reachable. */
  seatChance: number;
  /** Sitting time, ticks. */
  sitMin: number;
  sitMax: number;
  /** A player this close (blocks) to the seat a figure sits on (borrowed or its own) makes it stand up. */
  yieldSeatDistance: number;
  /** A player this close turns an idle figure's body towards them. */
  facePlayerDistance: number;
  /** Fewer reachable cells than this: the figure stays put (a plinth, a nook). */
  minRoamCells: number;
  /** Largest number of cells one plan explores. */
  maxNodes: number;
  /** A stop cell this close (blocks, horizontal) to a door or window leaf is not chosen. */
  doorwayClearance: number;
  /** Ticks outside the home area before the figure is put back home. */
  returnTimeout: number;
}

export const FIGURE_TUNING: FigureTuning = {
  speed: 0.06, turnPerTick: 18, turnInPlace: 60, maxUp: 0.6, maxDown: 0.6,
  radius: 7, radiusCap: 14, band: 1.2, strollMin: 2, strollMax: 6,
  idleMin: 60, idleMax: 180, longIdleMin: 300, longIdleMax: 500, longIdleChance: 0.2,
  seatChance: 0.25, sitMin: 400, sitMax: 800, yieldSeatDistance: 2.5, facePlayerDistance: 5,
  minRoamCells: 4, maxNodes: 500, doorwayClearance: 1.25, returnTimeout: 200,
};

/** `scripts/figures.js` CONFIG. */
export interface FigureLifeConfig {
  /** This pack's figure entity types. */
  figureTypes: string[];
  /** This pack's seat entity types (a figure may borrow a free one). */
  seatTypes: string[];
  /** Family of door/window leaves (`bedrock-interactives.ts` INTERACTIVE_FAMILY). */
  interactiveFamily: string;
  /** The pack's collider block and its two sixteenth states, when it ships colliders. */
  colliders?: { block: string; loState: string; hiState: string } | undefined;
  /** Body height a figure needs clear, world blocks at 100 % (its collision box), per type; `bodyHeight` otherwise. */
  bodyHeights: Record<string, number>;
  bodyHeight: number;
  /**
   * Safe set-down search for players leaving this pack's scenery seats. `lift`/`reach`/`drop` come from the rides'
   * measured policy (`RIDE.SETDOWN_*`); the rest `figureLifeScript` fills from `SEAT_EGRESS` / `ESCAPE` when a
   * config (an older pack's) lacks them.
   */
  seatSafety?: {
    lift: number; reach: number; drop: number;
    /** The last-resort search (`ColliderBodyProbe.escape`). */
    escape?: EscapeOptions | undefined;
    /** `SEAT_EGRESS.NATIVE_REACH_BLOCKS`. */
    nativeReach?: number | undefined;
    /** `SEAT_EGRESS.RESEAT_LIMIT` / `RESEAT_WINDOW_TICKS`. */
    reseatLimit?: number | undefined;
    reseatWindowTicks?: number | undefined;
  } | undefined;
  /**
   * Types whose entities carry the Minifig Creator's `craftmatic:draft`
   * property: while it is true the figure is being dressed or edited by the
   * wand, and the runtime leaves it alone (it is re-adopted, with a new home
   * where it stands, once the wand releases it).
   */
  draftTypes?: string[] | undefined;
  tuning: FigureTuning;
}

/** A collision span [bottom, top] in world y, or null for a block nothing collides with. */
export type SpanLookup = (x: number, y: number, z: number) => number[] | null;

/** One standing place a figure can reach: block column (x, z) and feet height. */
export interface WalkCell { x: number; z: number; feet: number; steps: number; parent: number }

/**
 * The feet height a body of `body` blocks can stand at in column (x, z), the
 * nearest to `nearFeet` within `maxUp` above / `maxDown` below, or null. A
 * standing place is the top of a collision span with the body clear above it.
 * Pure (serialised into the runtime).
 */
export function standFeetAt(spanAt: SpanLookup, x: number, z: number, nearFeet: number, body: number, maxUp: number, maxDown: number): number | null {
  const clearAt = (feet: number): boolean => {
    for (let y = Math.floor(feet); y <= Math.floor(feet + body - 1e-9); y++) {
      const s = spanAt(x, y, z);
      if (s && s[0]! < feet + body - 1e-9 && s[1]! > feet + 1e-9) return false;
    }
    return true;
  };
  let best: number | null = null, bestD = Infinity;
  for (let y = Math.floor(nearFeet - maxDown) - 1; y <= Math.floor(nearFeet + maxUp); y++) {
    const s = spanAt(x, y, z);
    if (!s) continue;
    const top = s[1]!;
    if (top < nearFeet - maxDown - 1e-6 || top > nearFeet + maxUp + 1e-6) continue;
    const d = Math.abs(top - nearFeet);
    if (d < bestD && clearAt(top)) { best = top; bestD = d; }
  }
  return best;
}

/**
 * Every standing place reachable from `start` by 8-way steps, breadth first,
 * each step rising at most `maxUp` and dropping at most `maxDown`; a diagonal
 * step needs both of its orthogonal neighbours standable (a 0.6-wide body
 * sweeps them). `allowed(x, z, feet)` bounds the walk (the home area).
 * Returns the cells in visiting order with parent indices, so a path is read
 * back from any cell. Pure (serialised into the runtime).
 */
export function exploreWalkable(
  spanAt: SpanLookup, start: { x: number; z: number; feet: number }, body: number, maxUp: number, maxDown: number,
  allowed: (x: number, z: number, feet: number) => boolean, maxNodes: number,
  stand: typeof standFeetAt,
): WalkCell[] {
  const cells: WalkCell[] = [{ x: start.x, z: start.z, feet: start.feet, steps: 0, parent: -1 }];
  const seen = new Set<string>([`${start.x},${start.z}`]);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let head = 0; head < cells.length && cells.length < maxNodes; head++) {
    const c = cells[head]!;
    const ortho = new Map<string, number | null>();
    for (const [dx, dz] of dirs) {
      const nx = c.x + dx!, nz = c.z + dz!;
      const key = `${nx},${nz}`;
      let feet: number | null;
      if (dx !== 0 && dz !== 0) {
        const a = ortho.get(`${c.x + dx!},${c.z}`), b = ortho.get(`${c.x},${c.z + dz!}`);
        if (a === null || a === undefined || b === null || b === undefined) continue;
        if (seen.has(key)) continue;
        feet = stand(spanAt, nx, nz, c.feet, body, maxUp, maxDown);
        // The corner cells must sit at the same height band as the diagonal's ends.
        if (feet === null || Math.abs(a - c.feet) > maxUp || Math.abs(b - c.feet) > maxUp) continue;
      } else {
        feet = stand(spanAt, nx, nz, c.feet, body, maxUp, maxDown);
        ortho.set(key, feet !== null && allowed(nx, nz, feet) ? feet : null);
        if (feet === null || seen.has(key)) continue;
      }
      if (!allowed(nx, nz, feet)) continue;
      seen.add(key);
      cells.push({ x: nx, z: nz, feet, steps: c.steps + 1, parent: head });
      if (cells.length >= maxNodes) break;
    }
  }
  return cells;
}

/**
 * Where a figure standing at (x, feet, z) starts planning from: its own
 * column when a body fits there, else the nearest standable column within
 * `maxRing` cells on the same floor (1 in the runtime: a step it can walk). A LEGO figure stands a hair from a wall, a counter
 * or a lamp post, and the 1-block collider column it stands in often holds
 * that part at head height (the Winter Chalet's "stuck" walkers: 1.8 blocks
 * of body under 0.55-0.7 blocks of headroom); the figure is then planned out
 * of that column into the first free one. Pure (serialised into the runtime).
 */
export function startCell(spanAt: SpanLookup, x: number, z: number, feet: number, body: number, maxUp: number, maxDown: number, stand: typeof standFeetAt,
  allowed: (x: number, z: number, feet: number) => boolean = () => true, maxRing = 1): { x: number; z: number; feet: number } | null {
  const cx = Math.floor(x), cz = Math.floor(z);
  const own = stand(spanAt, cx, cz, feet, body, 0.3, maxDown);
  if (own !== null) return { x: cx, z: cz, feet: own };
  let best: { x: number; z: number; feet: number } | null = null, bestD = Infinity;
  for (let r = 1; r <= maxRing && !best; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const f = stand(spanAt, cx + dx, cz + dz, feet, body, maxUp, maxDown);
      if (f === null || !allowed(cx + dx, cz + dz, f)) continue;
      const d = (cx + dx + 0.5 - x) ** 2 + (cz + dz + 0.5 - z) ** 2 + (f - feet) ** 2;
      if (d < bestD) { bestD = d; best = { x: cx + dx, z: cz + dz, feet: f }; }
    }
  }
  return best;
}

/**
 * Where to set down a figure that stands inside a collider with no free
 * column beside it (Pixel 2026-09-25: a Winter Chalet figure pushed into a
 * cupboard's column, walls on three sides): the standable column within
 * `maxRing` cells whose own walkable floor is LARGEST (so it lands in the
 * room, not on a one-cell ledge behind the wall), nearest on a tie. Pure.
 */
export function refugeCell(spanAt: SpanLookup, x: number, z: number, feet: number, body: number, maxUp: number, maxDown: number, stand: typeof standFeetAt,
  explore: typeof exploreWalkable, allowed: (x: number, z: number, feet: number) => boolean, maxRing: number): { x: number; z: number; feet: number } | null {
  const cx = Math.floor(x), cz = Math.floor(z);
  let best: { x: number; z: number; feet: number } | null = null, bestRoom = 0, bestD = Infinity;
  for (let dx = -maxRing; dx <= maxRing; dx++) for (let dz = -maxRing; dz <= maxRing; dz++) {
    if (!dx && !dz) continue;
    const f = stand(spanAt, cx + dx, cz + dz, feet, body, maxUp, maxDown);
    if (f === null || !allowed(cx + dx, cz + dz, f)) continue;
    const room = explore(spanAt, { x: cx + dx, z: cz + dz, feet: f }, body, maxUp, maxDown, allowed, 64, stand).length;
    const d = (cx + dx + 0.5 - x) ** 2 + (cz + dz + 0.5 - z) ** 2;
    if (room > bestRoom || (room === bestRoom && d < bestD)) { best = { x: cx + dx, z: cz + dz, feet: f }; bestRoom = room; bestD = d; }
  }
  return best;
}

/**
 * Where the placement runtime puts a figure it spawns (bedrock-placement-pack.ts,
 * the `_fig` branch of the spawn loop, which carries its own copy): the body is
 * raised past every span it overlaps, span by span, and kept there when the
 * total rise is within `budget` blocks; otherwise it stays at `feet`.
 * Pure (host only: the export and the census predict the device spawn with it).
 */
export function spawnLift(spanAt: SpanLookup, x: number, z: number, feet: number, body: number, budget: number): number {
  const bx = Math.floor(x), bz = Math.floor(z);
  let f = feet;
  for (let guard = 0; guard < 64; guard++) {
    let lifted = false;
    for (let y = Math.floor(f); y <= Math.floor(f + body - 1e-9); y++) {
      const s = spanAt(bx, y, bz);
      if (s && s[0]! < f + body - 1e-9 && s[1]! > f + 1e-9) { f = s[1]!; lifted = true; break; }
    }
    if (!lifted) break;
  }
  return f - feet <= budget + 1e-9 ? f : feet;
}

/** What `resolveFigureSpawn` did with one figure. */
export interface FigureSpawn {
  /** Feet position to spawn at, world blocks. */
  x: number; y: number; z: number;
  /**
   * `kept`: its own column carries it (at most a step up, a hair down);
   * `grounded`: nothing under its feet, set down on the nearest surface
   * below in its own column; `moved`: its own column is blocked (it stood
   * inside a collider), set on the standable column nearby with the most room.
   */
  kind: 'kept' | 'grounded' | 'moved';
  /** Blocks it was lowered (positive) or raised (negative). */
  drop: number;
  /** Horizontal distance it was moved, blocks. */
  shift: number;
  /** Reachable cells from the chosen spot (capped at `ROOM_PROBE_CELLS`). */
  room: number;
}

/** Cells explored to rate a spawn candidate's room (enough to tell a floor from a ledge). */
export const ROOM_PROBE_CELLS = 64;

/**
 * Where a figure should stand when it is spawned, decided at export over the
 * collider grid the pack ships, so the placement's spawn lift has nothing to
 * do. Measured 2026-09-25 over the 40 favourites (`_figure_support_audit.ts`,
 * `_figure_roam_census.ts`): the 16 figures that fell at placement stood on
 * NO part at all - LEGO's box-art line-up of figures on the table beside the
 * model (21360, 42639, 43267, 77092), with the model's own base above or
 * beside them - and every figure the spawn lift raised more than a step
 * (71040, 31141, 42639, 77092: 1.2-2.6 blocks) stood INSIDE a collider column
 * (a 1-block cell holding a wall, a counter, the base it stood against) and
 * was put on the roof above it, where it had 2-6 cells to walk.
 *
 *  1. Its own column carries it within `maxUp` above / 0.25 below: kept.
 *  2. Otherwise every column within `radius` cells (its own included) where a
 *     body stands within `maxUp` above / `maxDrop` below its feet is rated by
 *     its room (cells reachable from it, `ROOM_PROBE_CELLS` at most), and the
 *     cheapest one with at least `minRoom` wins, else the cheapest of all:
 *     cost = distance + 1.5 x drop + 3 x rise. Its own column wins at equal
 *     cost, and keeps the source's exact x/z.
 *  3. Otherwise the highest standable top anywhere below it in its own column
 *     (a line-up far above the ground: 43267's model stands 5 blocks up on a
 *     few stray low parts): grounded.
 *  4. Nothing at all: kept where it is (the runtime's wedge and refuge logic).
 *
 * `allowed(x, z)` bounds the columns (the placement footprint). No collider
 * is added: a figure never stands on anything the player cannot. Pure.
 */
export function resolveFigureSpawn(
  spanAt: SpanLookup, at: { x: number; y: number; z: number }, body: number,
  allowed: (x: number, z: number) => boolean,
  opts: { maxUp: number; maxDown: number; minRoom: number; radius?: number; maxDrop?: number },
): FigureSpawn {
  const radius = opts.radius ?? 2, maxDrop = opts.maxDrop ?? 3;
  const cx = Math.floor(at.x), cz = Math.floor(at.z);
  const own = standFeetAt(spanAt, cx, cz, at.y, body, opts.maxUp, 0.25);
  const roomOf = (x: number, z: number, feet: number): number => exploreWalkable(spanAt, { x, z, feet }, body, opts.maxUp, opts.maxDown,
    (ax, az) => allowed(ax, az), ROOM_PROBE_CELLS, standFeetAt).length;
  if (own !== null) return { x: at.x, y: own, z: at.z, kind: 'kept', drop: at.y - own, shift: 0, room: roomOf(cx, cz, own) };
  let best: FigureSpawn | null = null, bestCost = Infinity, bestRoomy = false;
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const x = cx + dx, z = cz + dz;
    if ((dx || dz) && !allowed(x, z)) continue;
    const f = standFeetAt(spanAt, x, z, at.y, body, opts.maxUp, maxDrop);
    if (f === null) continue;
    const self = !dx && !dz;
    const px = self ? at.x : x + 0.5, pz = self ? at.z : z + 0.5;
    const shift = Math.hypot(px - at.x, pz - at.z);
    const cost = shift + 1.5 * Math.max(0, at.y - f) + 3 * Math.max(0, f - at.y) - (self ? 1e-6 : 0);
    const room = roomOf(x, z, f), roomy = room >= opts.minRoom;
    if ((roomy && !bestRoomy) || (roomy === bestRoomy && cost < bestCost)) {
      best = { x: px, y: f, z: pz, kind: self ? 'grounded' : 'moved', drop: at.y - f, shift, room };
      bestCost = cost; bestRoomy = roomy;
    }
  }
  if (best) return best;
  const below = standFeetAt(spanAt, cx, cz, at.y, body, 0, at.y + 1);
  if (below !== null) return { x: at.x, y: below, z: at.z, kind: 'grounded', drop: at.y - below, shift: 0, room: roomOf(cx, cz, below) };
  return { x: at.x, y: at.y, z: at.z, kind: 'kept', drop: 0, shift: 0, room: 0 };
}

/** Two standing figures closer than this (blocks, horizontally) share a body: one is moved. A figure's box is 0.6 wide. */
export const FIGURE_MIN_SEPARATION = 0.6;

/**
 * Figures a source records on ONE spot spawn inside each other and fight
 * until they walk apart (76435's figures 1 and 8: 804 coplanar face pairs in
 * the 2026-09-25 render audit). In order, every figure whose feet stand
 * within `FIGURE_MIN_SEPARATION` of an earlier one (and within a body's
 * height of it) is moved to the nearest standable spot - a column centre
 * within `radius` cells that `standFeetAt` carries within `maxUp` / `maxDown`
 * of its feet - clear of every other figure; the rest stay exactly where they
 * are. When no such spot exists the figure stays (reported, not dropped).
 * Returns the new positions and which were moved. Pure; host only, at export.
 */
export function separateFigureSpawns(
  spanAt: SpanLookup, figures: ReadonlyArray<{ x: number; y: number; z: number; body: number }>,
  allowed: (x: number, z: number) => boolean,
  opts: { maxUp: number; maxDown: number; radius?: number },
): { at: Array<{ x: number; y: number; z: number }>; moved: number[]; stuck: number[] } {
  const radius = opts.radius ?? 2;
  const at = figures.map(f => ({ x: f.x, y: f.y, z: f.z }));
  const moved: number[] = [], stuck: number[] = [];
  const clash = (p: { x: number; y: number; z: number }, body: number, skip: number, upTo: number): boolean => {
    for (let j = 0; j < upTo; j++) {
      if (j === skip) continue;
      const q = at[j]!;
      if (Math.hypot(p.x - q.x, p.z - q.z) < FIGURE_MIN_SEPARATION - 1e-9 && Math.abs(p.y - q.y) < Math.max(body, figures[j]!.body)) return true;
    }
    return false;
  };
  for (let i = 1; i < figures.length; i++) {
    const f = figures[i]!;
    if (!clash(at[i]!, f.body, i, i)) continue;
    const cx = Math.floor(f.x), cz = Math.floor(f.z);
    let best: { x: number; y: number; z: number } | null = null, bestCost = Infinity;
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      const x = cx + dx, z = cz + dz;
      if (!allowed(x, z)) continue;
      const feet = standFeetAt(spanAt, x, z, f.y, f.body, opts.maxUp, opts.maxDown);
      if (feet === null) continue;
      const p = { x: x + 0.5, y: feet, z: z + 0.5 };
      if (clash(p, f.body, i, figures.length)) continue;
      const cost = Math.hypot(p.x - f.x, p.z - f.z) + 3 * Math.abs(feet - f.y);
      if (cost < bestCost) { best = p; bestCost = cost; }
    }
    if (best) { at[i] = best; moved.push(i); } else stuck.push(i);
  }
  return { at, moved, stuck };
}

/** The cells from the start to `cells[index]`, start excluded. Pure. */
export function pathTo(cells: WalkCell[], index: number): WalkCell[] {
  const out: WalkCell[] = [];
  for (let i = index; i > 0; i = cells[i]!.parent) out.push(cells[i]!);
  return out.reverse();
}

/**
 * The collision span of one block for figure navigation: a collider is its
 * `[lo, hi]` sixteenths, air/liquid/plants/snow layers nothing, anything
 * else a full cube. Pure.
 */
export function blockSpan(typeId: string, isAir: boolean, isLiquid: boolean, y: number, collider: { block: string } | undefined, lo: number, hi: number): number[] | null {
  if (isAir || isLiquid || typeId === 'minecraft:air') return null;
  if (collider && typeId === collider.block) return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [y + lo / 16, y + hi / 16] : null;
  // A clearance form (collider-form.ts: `<block>_<w|f|c><shape>`) counts as its whole vertical extent -
  // what the full collider it replaced spanned; the planner is block-granular and never counts on the
  // freed part. A floor + wall form runs to the block top, a wall + ceiling form from its bottom.
  // TODO: let figures walk the part a form frees (the planner would need sub-block cells).
  if (collider && typeId.startsWith(`${collider.block}_`) && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
    const kind = typeId.charAt(collider.block.length + 1);
    return [y + (kind === 'c' ? 0 : lo) / 16, y + (kind === 'f' ? 16 : hi) / 16];
  }
  // Blocks a mob walks through: plants, flowers, torches, rails, signs, buttons...
  // Anchored on the whole name: `grass_block` and `mushroom_stem` are solid
  // ground (an unanchored /grass/ once made the whole flat world a hole).
  const name = typeId.replace(/^minecraft:/, '');
  if (/_carpet$|^carpet$|^moss_carpet$/.test(name)) return [y, y + 1 / 16];
  if (/^(short_grass|tall_grass|grass|fern|large_fern|dead_bush|seagrass|tall_seagrass|kelp|kelp_plant|vine|glow_lichen|sugar_cane|sweet_berry_bush|wheat|carrots|potatoes|beetroot|torch|soul_torch|redstone_torch|rail|golden_rail|detector_rail|activator_rail|lever|tripwire|trip_wire|redstone_wire|light_block|structure_void|snow_layer|brown_mushroom|red_mushroom|lily_of_the_valley|dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|wither_rose|sunflower|lilac|rose_bush|peony|pink_petals|torchflower)$|_tulip$|_sapling$|_button$|_pressure_plate$|_sign$|_banner$|_coral_fan$|^(light_block_\d+)$/.test(name)) return null;
  return [y, y + 1];
}

/** Small deterministic helpers the runtime is handed with the planner. */
export interface FigurePlanner {
  standFeetAt: typeof standFeetAt;
  exploreWalkable: typeof exploreWalkable;
  pathTo: typeof pathTo;
  blockSpan: typeof blockSpan;
  startCell: typeof startCell;
  refugeCell: typeof refugeCell;
}

/**
 * The runtime, serialised into `scripts/figures.js`. It may reference nothing
 * outside itself and its arguments.
 */
export function figureLifeRuntime(mc: { world: any; system: any }, config: FigureLifeConfig, planner: FigurePlanner, homeProperty: string, body?: ColliderBodyProbe): void {
  const { world, system } = mc;
  const T = config.tuning;
  const watchedSeats = new Map<string, { seat: any; dimension: any; at: { x: number; y: number; z: number }; k: number }>();
  /** Re-seats in a row per player (`seatSafety.reseatLimit` within `reseatWindowTicks`): a held Sneak must not loop. */
  const reseats = new Map<string, { n: number; tick: number }>();
  /**
   * A player who left a scenery seat must stand somewhere walkable (docs/physics-architecture.md §4.8, "A scenery
   * seat's set-down"). In order: Bedrock's own set-down when it (or the floor it falls onto within the drop) has a
   * walk exit; the nearest point within `reach` of the seat with a walk exit that the body WALKS to from the seat
   * (never through a wall); the last-resort `escape` (a walk-connected flood, then the model's exterior). Only
   * with none of those is the player put back on the seat, at most `reseatLimit` times in a row.
   */
  const safeSeatDismounts = (): void => {
    if (!body || !config.seatSafety || !config.seatTypes.length) return;
    const S = config.seatSafety;
    let players: any[] = [];
    try { players = world.getAllPlayers(); } catch { return; }
    const live = new Set(players.map((p: any) => p.id));
    for (const id of watchedSeats.keys()) if (!live.has(id)) watchedSeats.delete(id);
    for (const player of players) {
      let riding: any;
      try { riding = player.getComponent('minecraft:riding')?.entityRidingOn; } catch { riding = undefined; }
      if (riding && config.seatTypes.includes(riding.typeId)) {
        const l = riding.location;
        // The wand's size (`minecraft:scale`, at least 1) scales the search as it scales the rides' set-down: a 400 %
        // chair is four times as deep, and a 2-block reach never left its own seat cushion.
        let k = 1;
        try { const v = Number(riding.getComponent('minecraft:scale')?.value); if (Number.isFinite(v) && v > 1) k = v; } catch { k = 1; }
        watchedSeats.set(player.id, { seat: riding, dimension: player.dimension, at: { x: l.x, y: l.y, z: l.z }, k });
        continue;
      }
      const left = watchedSeats.get(player.id);
      if (!left) continue;
      watchedSeats.delete(player.id);
      if (riding) continue; // a hop/transfer already put the player on another mount
      if (player.dimension?.id !== left.dimension?.id) continue;
      let current: { x: number; y: number; z: number };
      try { current = player.location; } catch { continue; }
      // Bedrock sets a dismounted player down a block from the seat (or just over it, to fall): anything farther
      // is a deliberate move (a /tp out of the seat, a script) and is left alone. Scaled with the seat, since the
      // device's set-down at 300-400 % is not measured (quirk `dismount-free-spot` is 100 %).
      // (`figureLifeScript` always fills the `SEAT_EGRESS` fields; these literals only guard a hand-built config.)
      const nativeReach = (S.nativeReach ?? 2) * left.k;
      if (Math.hypot(current.x - left.at.x, current.z - left.at.z) > nativeReach || current.y > left.at.y + nativeReach || current.y < left.at.y - S.drop - 1) continue;
      const dim = player.dimension;
      try { if (body.hasWalkExit(dim, current, S.drop)) { reseats.delete(player.id); continue; } } catch { /* search from the remembered seat */ }
      const planned = { x: left.at.x, y: left.at.y + S.lift, z: left.at.z };
      const walkable = (q: { x: number; y: number; z: number }): boolean => body.routeClear(dim, planned, q, S.drop) && body.hasWalkExit(dim, q);
      let safe: { x: number; y: number; z: number } | undefined;
      try { const q = body.settle(dim, planned, S.reach * left.k, S.drop, walkable); if (walkable(q)) safe = q; } catch { safe = undefined; }
      if (!safe && S.escape) {
        try { safe = body.escape(dim, planned, { ...S.escape, seedReach: S.escape.seedReach * left.k })?.at; } catch { safe = undefined; }
      }
      if (safe) {
        let moved = false;
        try { moved = player.tryTeleport(safe, { dimension: dim, checkForBlocks: true, keepVelocity: false }) === true; } catch { moved = false; }
        if (moved) { reseats.delete(player.id); continue; }
      }
      // Nothing walkable anywhere the probe can read (an unloaded world): back on the known seat rather than a guess
      // through a wall - but never more than `reseatLimit` times in a row, or a held Sneak loops seat, off, seat.
      const tick = system.currentTick ?? 0;
      const prior = reseats.get(player.id);
      const n = prior && tick - prior.tick <= (S.reseatWindowTicks ?? 100) ? prior.n : 0;
      if (n >= (S.reseatLimit ?? 2)) {
        console.warn(`[craftmatic seat] no safe dismount for ${player.id} after ${n} re-seats; left where Bedrock set it down at ${current.x},${current.y},${current.z}`);
        reseats.delete(player.id);
        continue;
      }
      let restored = false;
      try {
        const valid = typeof left.seat.isValid === 'function' ? left.seat.isValid() : left.seat.isValid;
        const ride = valid ? left.seat.getComponent('minecraft:rideable') : undefined;
        restored = !!ride && (ride.getRiders?.() ?? []).length === 0 && ride.addRider?.(player) === true;
      } catch { restored = false; }
      if (restored) {
        reseats.set(player.id, { n: n + 1, tick });
        try { player.onScreenDisplay?.setActionBar?.('No safe place to get off here'); } catch { /* seated */ }
      } else console.warn(`[craftmatic seat] no safe dismount for ${player.id}; seat unavailable at ${left.at.x},${left.at.y},${left.at.z}`);
    }
  };
  /** How far from its home (blocks) a seated figure looks for the seat to retake: 10261's kiosk seat entity sits ~2 below its home. */
  const RETAKE_REACH = 4;
  /**
   * Retake checks in a row (5 s apart) that find no seat near home before the
   * content log hears of it: the first miss is a placement still spawning
   * its seats (the figure is adopted the tick it appears), not a fault.
   */
  const RETAKE_MISSES_TO_WARN = 2;
  /** `FIGURE_SEATING_PROPERTY` and `FIGURE_SEATING_GRACE_MS` (this function is serialised: literals). */
  const SEATING_PROPERTY = 'craftmatic:fig_seating', SEATING_GRACE_MS = 600000;
  /** Whether the placement is still seating this figure (its seat may not exist yet). */
  const beingSeated = (e: any): boolean => {
    let v: any;
    try { v = e.getDynamicProperty(SEATING_PROPERTY); } catch { return false; }
    return typeof v === 'number' && Date.now() - v < SEATING_GRACE_MS;
  };
  const types = new Set(config.figureTypes);
  const draftTypes = new Set(config.draftTypes ?? []);
  /** A creator figure the wand is dressing or editing (`craftmatic:draft`): not this runtime's to move. */
  const isDraft = (e: any): boolean => {
    if (!draftTypes.has(e.typeId)) return false;
    try { return e.getProperty('craftmatic:draft') === true; } catch { return false; }
  };
  interface Life {
    e: any; home: FigureHome; state: 'idle' | 'turn' | 'walk' | 'sit' | 'stay' | 'return';
    until: number; path: WalkCell[]; i: number; yaw: number; seat?: any; checkAt: number; checkPos?: any;
    stuck: number; outsideSince: number; nextSeatAt: number; cells: number;
    /**
     * `wedged`: the last plan started in the free column beside its own (it
     * stands in a collider); `walled`: no free column beside it at all.
     * `unwedged` once it was walked (or set) out.
     */
    wedged?: boolean; walled?: boolean; unwedged?: boolean; unwedging?: boolean;
    /** Its spawn point had nothing under it; it was re-homed where it landed. */
    rehomed?: boolean;
    /** A seated figure's retake was refused or found no seat, and the content log was told once. */
    retakeWarned?: boolean;
    /** Retake checks in a row that found no seat near home (reset when one is there). */
    retakeMisses?: number;
    /** The seat entity a seated figure rode, retaken by id once a player gives it back. */
    seatId?: string;
  }
  const lives = new Map<string, Life>();
  let tick = 0;
  const rand = (a: number, b: number): number => a + Math.random() * (b - a);
  const wrap = (a: number): number => ((a + 540) % 360) - 180;
  const yawTo = (dx: number, dz: number): number => Math.atan2(-dx, dz) * 180 / Math.PI;
  const sizeOf = (h: FigureHome): number => Math.min(1, h.f);

  const readHome = (e: any): FigureHome | undefined => {
    let raw: any;
    try { raw = e.getDynamicProperty(homeProperty); } catch { return undefined; }
    if (typeof raw === 'string') {
      try {
        const h = JSON.parse(raw);
        if (Array.isArray(h.home) && Array.isArray(h.area) && typeof h.f === 'number') return h;
      } catch { /* rewritten below */ }
    }
    // Summoned with a spawn egg or a command (no placement): home is where it stands now.
    try {
      const l = e.location, r = T.radius;
      const h: FigureHome = { home: [l.x, l.y, l.z], area: [l.x - r, l.z - r, l.x + r, l.z + r], ground: l.y - 0.5, f: 1, mode: 'roam' };
      e.setDynamicProperty(homeProperty, JSON.stringify(h));
      return h;
    } catch { return undefined; }
  };

  /** A span lookup over the live world, memoised for one plan. */
  const spans = (dim: any): SpanLookup => {
    const memo = new Map<string, number[] | null>();
    const C = config.colliders;
    return (x, y, z) => {
      const k = `${x},${y},${z}`;
      if (memo.has(k)) return memo.get(k)!;
      let s: number[] | null = null;
      try {
        const b = dim.getBlock({ x, y, z });
        if (!b) s = [y, y + 1]; // unloaded: treat as solid, never walk into it
        else {
          let lo = NaN, hi = NaN;
          if (C && (b.typeId === C.block || b.typeId.startsWith(`${C.block}_`))) { lo = Number(b.permutation.getState(C.loState)); hi = Number(b.permutation.getState(C.hiState)); }
          s = planner.blockSpan(b.typeId, b.isAir === true, b.isLiquid === true, y, C, lo, hi);
        }
      } catch { s = [y, y + 1]; }
      memo.set(k, s);
      return s;
    };
  };

  const radiusOf = (h: FigureHome): number => Math.min(T.radiusCap, T.radius * Math.max(1, h.f));
  const bandOf = (h: FigureHome): number => Math.max(0.6, T.band * h.f);
  const insideArea = (h: FigureHome, x: number, z: number, feet: number, slack: number): boolean => {
    const cx = x + 0.5, cz = z + 0.5;
    const [x0, z0, x1, z1] = h.area;
    if (cx < x0 - slack || cx > x1 + slack || cz < z0 - slack || cz > z1 + slack) return false;
    if (Math.abs(feet - h.home[1]) > bandOf(h) + slack) return false;
    const r = radiusOf(h) + slack;
    return (cx - h.home[0]) ** 2 + (cz - h.home[2]) ** 2 <= r * r;
  };
  const bodyOf = (l: Life): number => (config.bodyHeights[l.e.typeId] ?? config.bodyHeight) * sizeOf(l.home);

  /** Door and window leaves near a point: stop cells keep clear of them. */
  const leavesNear = (dim: any, at: any, r: number): any[] => {
    try { return dim.getEntities({ families: [config.interactiveFamily], location: at, maxDistance: r }).map((e: any) => e.location); } catch { return []; }
  };
  const reserved = (l: Life, cell: WalkCell): boolean => {
    for (const other of lives.values()) {
      if (other === l || other.state !== 'walk' || !other.path.length) continue;
      const end = other.path[other.path.length - 1]!;
      if (end.x === cell.x && end.z === cell.z) return true;
    }
    return false;
  };

  /** Explore from where the figure stands; `slack` > 0 lets a figure outside its area plan back in. */
  const explore = (l: Life, slack: number): WalkCell[] => {
    const e = l.e, h = l.home, loc = e.location;
    const span = spans(e.dimension);
    const body = bodyOf(l);
    const allowed = (cx: number, cz: number, cf: number): boolean => insideArea(h, cx, cz, cf, slack);
    const start = planner.startCell(span, loc.x, loc.z, loc.y, body, T.maxUp, T.maxDown, planner.standFeetAt, allowed, 1);
    l.walled = !start;
    if (!start) return [];
    const cells = planner.exploreWalkable(span, start, body, T.maxUp, T.maxDown, allowed, T.maxNodes, planner.standFeetAt);
    // Planned from a neighbouring column: walk into it first (pathTo drops the start cell).
    l.wedged = !(start.x === Math.floor(loc.x) && start.z === Math.floor(loc.z));
    if (!l.wedged) return cells;
    // Re-root on the figure's own column, so every path begins with the step out of it.
    const here: WalkCell = { x: Math.floor(loc.x), z: Math.floor(loc.z), feet: loc.y, steps: 0, parent: -1 };
    return [here, ...cells.map(c => ({ ...c, steps: c.steps + 1, parent: c.parent + 1 }))];
  };

  const setIdle = (l: Life, ticks: number): void => { l.state = 'idle'; l.until = tick + Math.round(ticks); l.path = []; };
  const stop = (e: any): void => { try { const v = e.getVelocity(); e.applyImpulse({ x: -v.x, y: 0, z: -v.z }); } catch { /* gone */ } };

  const startPath = (l: Life, path: WalkCell[], state: 'walk' | 'return'): void => {
    l.path = path; l.i = 0; l.stuck = 0; l.checkAt = tick + 20; l.checkPos = { ...l.e.location };
    const first = path[0]!;
    const want = yawTo(first.x + 0.5 - l.e.location.x, first.z + 0.5 - l.e.location.z);
    l.state = Math.abs(wrap(want - l.yaw)) > T.turnInPlace ? 'turn' : state;
    if (l.state === 'turn') l.until = tick + 30;
    (l as any).after = state;
  };

  /** Decide what to do next once an idle spell ends. */
  const decide = (l: Life): void => {
    const e = l.e, h = l.home;
    const cells = explore(l, 0);
    l.cells = cells.length;
    // Standing inside a collider column (a LEGO figure a hair from a cupboard):
    // first step once into the free column beside it; with none, set it down
    // on the nearest floor with the most room (it cannot walk through walls).
    if (!l.unwedged && l.wedged && cells.length >= 2) { l.unwedged = true; l.unwedging = true; startPath(l, [cells[1]!], 'walk'); return; }
    if (!l.unwedged && l.walled) {
      l.unwedged = true;
      const loc = e.location, span = spans(e.dimension), body = bodyOf(l);
      const allowed = (cx: number, cz: number, cf: number): boolean => insideArea(h, cx, cz, cf, 0);
      const r = planner.refugeCell(span, loc.x, loc.z, loc.y, body, T.maxUp, T.maxDown, planner.standFeetAt, planner.exploreWalkable, allowed, 3);
      if (r) { try { e.teleport({ x: r.x + 0.5, y: r.feet, z: r.z + 0.5 }); } catch { /* gone */ } }
      setIdle(l, rand(T.idleMin, T.idleMax));
      return;
    }
    if (cells.length < T.minRoamCells) { l.state = 'stay'; l.until = tick + 600; return; }
    const leaves = leavesNear(e.dimension, e.location, radiusOf(h) + 3);
    const nearLeaf = (c: WalkCell): boolean => leaves.some(p => (p.x - c.x - 0.5) ** 2 + (p.z - c.z - 0.5) ** 2 < T.doorwayClearance ** 2);
    // A free seat of this pack in reach, now and then.
    if (config.seatTypes.length && tick >= l.nextSeatAt && Math.random() < T.seatChance) {
      l.nextSeatAt = tick + 2400;
      let seats: any[] = [];
      for (const type of config.seatTypes) {
        try { seats = seats.concat(e.dimension.getEntities({ type, location: e.location, maxDistance: radiusOf(h) + 2 })); } catch { /* none */ }
      }
      for (const s of seats.sort(() => Math.random() - 0.5)) {
        let free = false;
        try { free = (s.getComponent('minecraft:rideable')?.getRiders?.() ?? []).length === 0; } catch { free = false; }
        if (!free) continue;
        const sl = s.location;
        let bestI = -1, bestD = Infinity;
        cells.forEach((c, i) => {
          if (i === 0) return;
          const d = (c.x + 0.5 - sl.x) ** 2 + (c.z + 0.5 - sl.z) ** 2;
          if (d < 1.6 * 1.6 && Math.abs(c.feet - sl.y) < 1.2 && d < bestD) { bestD = d; bestI = i; }
        });
        // Beside it on the SAME floor: on the Pixel (76269, 2026-09-25) a figure
        // 6 blocks over a seat on the storey below "sat" through the floor.
        const here = (e.location.x - sl.x) ** 2 + (e.location.z - sl.z) ** 2 < 1.6 * 1.6 && Math.abs(e.location.y - sl.y) < 1.2;
        if (bestI < 0 && !here) continue;
        l.seat = s;
        if (bestI < 0) { sit(l); return; }
        startPath(l, planner.pathTo(cells, bestI), 'walk');
        return;
      }
    }
    // A stroll: a random cell a few steps away, clear of doorways and of other figures' goals.
    const choices = cells.filter((c, i) => i > 0 && c.steps >= T.strollMin && c.steps <= T.strollMax && !nearLeaf(c) && !reserved(l, c));
    const pool = choices.length ? choices : cells.filter((c, i) => i > 0 && !nearLeaf(c) && !reserved(l, c));
    if (!pool.length) { setIdle(l, rand(T.idleMin, T.idleMax)); return; }
    const goal = pool[Math.floor(Math.random() * pool.length)]!;
    startPath(l, planner.pathTo(cells, cells.indexOf(goal)), 'walk');
  };

  const sit = (l: Life): void => {
    const s = l.seat;
    l.seat = undefined;
    try {
      const r = s.getComponent('minecraft:rideable');
      if (r && (r.getRiders?.() ?? []).length === 0 && r.addRider(l.e)) {
        l.seat = s; l.state = 'sit'; l.until = tick + Math.round(rand(T.sitMin, T.sitMax)); return;
      }
    } catch { /* seat gone */ }
    setIdle(l, rand(T.idleMin, T.idleMax));
  };
  const standUp = (l: Life): void => {
    try { l.seat?.getComponent('minecraft:rideable')?.ejectRider(l.e); } catch { /* seat gone */ }
    l.seat = undefined;
    setIdle(l, rand(T.idleMin, T.idleMax));
  };
  const riding = (e: any): boolean => { try { return !!e.getComponent('minecraft:riding'); } catch { return false; } };
  const nearestPlayer = (at: any, dim: any, r: number): any => {
    let best: any, bestD = r * r;
    for (const p of world.getAllPlayers()) {
      if (!p) continue;
      try {
        if (p.dimension.id !== dim.id) continue;
        const d = (p.location.x - at.x) ** 2 + (p.location.y - at.y) ** 2 + (p.location.z - at.z) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      } catch { /* left */ }
    }
    return best;
  };
  const turnToward = (l: Life, want: number, rate: number): number => {
    const d = wrap(want - l.yaw);
    l.yaw = wrap(l.yaw + Math.max(-rate, Math.min(rate, d)));
    try { l.e.setRotation({ x: 0, y: l.yaw }); } catch { /* gone */ }
    return Math.abs(d);
  };

  /** Out of the area: plan back in, or put it home after `returnTimeout`. */
  const outside = (l: Life): boolean => {
    const loc = l.e.location, h = l.home;
    const x = Math.floor(loc.x), z = Math.floor(loc.z);
    if (insideArea(h, x, z, loc.y, 0.5) && loc.y > h.ground - 0.5) { l.outsideSince = 0; return false; }
    // A home nothing supports (the source stood the figure on a part the
    // collider grid does not carry - 21360's and 42639's display rows, the
    // census found 7 and 4): it fell at spawn. Putting it back there would
    // only drop it again, so the floor it landed on becomes its home.
    if (!l.rehomed && loc.y >= h.ground - 0.5 && insideArea({ ...h, home: [h.home[0], loc.y, h.home[2]] }, x, z, loc.y, 0.5)) {
      const span = spans(l.e.dimension);
      const homeFeet = planner.standFeetAt(span, Math.floor(h.home[0]), Math.floor(h.home[2]), h.home[1], bodyOf(l), 0.3, 0.3);
      if (homeFeet === null) {
        l.rehomed = true;
        l.home = { ...h, home: [loc.x, loc.y, loc.z] };
        try { l.e.setDynamicProperty(homeProperty, JSON.stringify(l.home)); } catch { /* keeps the in-memory home */ }
        l.outsideSince = 0;
        return false;
      }
    }
    if (!l.outsideSince) l.outsideSince = tick;
    if (tick - l.outsideSince > T.returnTimeout || loc.y < h.ground - 2) {
      try { l.e.teleport({ x: h.home[0], y: h.home[1], z: h.home[2] }); } catch { /* gone */ }
      l.outsideSince = 0; setIdle(l, rand(T.idleMin, T.idleMax));
      return true;
    }
    if (l.state === 'return' || l.state === 'turn') return true;
    const cells = explore(l, radiusOf(h) + 6);
    let bestI = -1, bestD = Infinity;
    cells.forEach((c, i) => {
      if (!insideArea(h, c.x, c.z, c.feet, 0)) return;
      const d = (c.x + 0.5 - h.home[0]) ** 2 + (c.z + 0.5 - h.home[2]) ** 2 + c.steps;
      if (d < bestD) { bestD = d; bestI = i; }
    });
    if (bestI > 0) startPath(l, planner.pathTo(cells, bestI), 'return');
    else setIdle(l, 20);
    return true;
  };

  const step = (l: Life): void => {
    const e = l.e, h = l.home;
    if (l.state === 'sit') {
      if (!riding(e)) { l.seat = undefined; setIdle(l, rand(T.idleMin, T.idleMax)); return; }
      const p = l.seat ? nearestPlayer(l.seat.location, e.dimension, T.yieldSeatDistance) : undefined;
      if (tick >= l.until || p) standUp(l);
      return;
    }
    if (h.mode === 'seated') {
      // The source's seat is the PLAYER's too: a player who comes to it is
      // given it (the figure stands up beside it), and the figure takes it
      // back once it is free and nobody is at it. After a knock-off, the same.
      if (riding(e)) {
        let seat: any;
        try { seat = e.getComponent('minecraft:riding')?.entityRidingOn; } catch { seat = undefined; }
        // Its own seat, remembered to retake it by id once given up.
        if (seat && config.seatTypes.includes(seat.typeId)) l.seatId = seat.id;
        if (seat && config.seatTypes.includes(seat.typeId) && nearestPlayer(seat.location, e.dimension, T.yieldSeatDistance)) {
          try { seat.getComponent('minecraft:rideable')?.ejectRider(e); } catch { /* seat gone */ }
          l.until = tick + 100;
        }
        return;
      }
      if (tick >= l.until) {
        l.until = tick + 100;
        // The placement is still spawning the model (and seats it itself when done): no retake yet.
        if (beingSeated(e)) return;
        try {
          // Its own seat by id, else the nearest seat within `RETAKE_REACH` of
          // home. A 1.5-block search found nothing on both phones (round
          // 2026-09-29b: FIGURE_RETAKE_NO_SEAT for 10261's kiosk figure, whose
          // home is ~2 blocks above the seat entity it rode).
          const at = { x: h.home[0], y: h.home[1], z: h.home[2] };
          const d2 = (s: any): number => (s.location.x - at.x) ** 2 + (s.location.y - at.y) ** 2 + (s.location.z - at.z) ** 2;
          const seats = e.dimension.getEntities({ location: at, maxDistance: RETAKE_REACH })
            .filter((s: any) => config.seatTypes.includes(s.typeId))
            .sort((a: any, b: any) => (a.id === l.seatId ? -1 : b.id === l.seatId ? 1 : d2(a) - d2(b)));
          const r = seats[0]?.getComponent('minecraft:rideable');
          if (r && (r.getRiders?.() ?? []).length === 0 && !nearestPlayer(seats[0].location, e.dimension, T.yieldSeatDistance)) {
            // Onto the seat first: the retake failed on both phones (round
            // 2026-09-29a, 10261's kiosk, player 9-19 blocks away for 35-50 s)
            // with the figure standing beside it. `addRider` answers false
            // rather than throwing, so a refusal is logged, once per figure.
            try { e.teleport(seats[0].location); } catch { /* unloaded */ }
            const ok = r.addRider(e);
            if (!ok && !l.retakeWarned) { l.retakeWarned = true; console.warn(`FIGURE_RETAKE_REFUSED ${e.typeId} seat ${seats[0].typeId} at ${Math.round(seats[0].location.x)},${Math.round(seats[0].location.y)},${Math.round(seats[0].location.z)}`); }
          } else if (!seats.length) {
            // No seat near home. A placement still spawning its seats is held off
            // above (`beingSeated`: both phones logged FIGURE_RETAKE_NO_SEAT for
            // 10261's kiosk figure ~2 min into every placement, before its seat
            // existed, Saga round 2026-09-29c); a pack built before that mark, or a
            // seat entity reloading with its chunk, still misses once. The line is
            // written on the SECOND miss in a row (10 s with no seat), once per figure.
            l.retakeMisses = (l.retakeMisses ?? 0) + 1;
            if (l.retakeMisses >= RETAKE_MISSES_TO_WARN && !l.retakeWarned) {
              l.retakeWarned = true;
              console.warn(`FIGURE_RETAKE_NO_SEAT ${e.typeId} near ${h.home.map(Math.round).join(',')} (${l.retakeMisses} checks, ${Math.round(l.retakeMisses * 100 / 20)} s)`);
            }
          }
          if (seats.length) l.retakeMisses = 0;
        } catch (err) { if (!l.retakeWarned) { l.retakeWarned = true; console.warn(`FIGURE_RETAKE_ERROR ${e.typeId} ${String(err)}`); } }
      }
      return;
    }
    if (riding(e)) return; // a player sat it somewhere: leave it
    if (tick % 10 === 0 && outside(l)) { if (l.state !== 'return' && l.state !== 'turn') return; }
    if (l.state === 'idle' || l.state === 'stay') {
      if (tick % 5 === 0) {
        const p = nearestPlayer(e.location, e.dimension, T.facePlayerDistance);
        if (p) turnToward(l, yawTo(p.location.x - e.location.x, p.location.z - e.location.z), 12);
      }
      if (tick >= l.until) { if (l.state === 'stay') l.state = 'idle'; decide(l); }
      return;
    }
    if (l.state === 'turn') {
      const target = l.path[l.i]!;
      const left = turnToward(l, yawTo(target.x + 0.5 - e.location.x, target.z + 0.5 - e.location.z), T.turnPerTick * 0.6);
      if (left < 20 || tick >= l.until) { l.state = (l as any).after || 'walk'; l.checkAt = tick + 20; l.checkPos = { ...e.location }; }
      return;
    }
    // walk / return
    const loc = e.location;
    let target = l.path[l.i]!;
    let dx = target.x + 0.5 - loc.x, dz = target.z + 0.5 - loc.z;
    if (dx * dx + dz * dz < 0.2 * 0.2) {
      l.i++;
      if (l.i >= l.path.length) {
        stop(e); l.unwedging = false;
        if (l.seat) { sit(l); return; }
        setIdle(l, Math.random() < T.longIdleChance ? rand(T.longIdleMin, T.longIdleMax) : rand(T.idleMin, T.idleMax));
        return;
      }
      target = l.path[l.i]!;
      dx = target.x + 0.5 - loc.x; dz = target.z + 0.5 - loc.z;
    }
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const err = turnToward(l, yawTo(dx, dz), T.turnPerTick);
    // Slow into a sharp corner rather than sliding sideways through it.
    const speed = T.speed * sizeOf(h) * (err > 45 ? 0.35 : 1) * Math.min(1, d / 0.35 + 0.3);
    try {
      const v = e.getVelocity();
      e.applyImpulse({ x: dx / d * speed - v.x, y: 0, z: dz / d * speed - v.z });
    } catch { /* gone */ }
    if (tick >= l.checkAt) {
      const moved = Math.sqrt((loc.x - l.checkPos.x) ** 2 + (loc.z - l.checkPos.z) ** 2);
      l.checkAt = tick + 20; l.checkPos = { ...loc };
      if (moved < 0.15) {
        // Blocked by a player, another figure or a closed door: give up this stroll.
        if (++l.stuck >= 2) {
          stop(e); l.seat = undefined;
          // A wedged figure that cannot walk out of its column is set down beside it.
          if (l.unwedging) { const c = l.path[l.path.length - 1]!; try { e.teleport({ x: c.x + 0.5, y: c.feet, z: c.z + 0.5 }); } catch { /* gone */ } }
          l.unwedging = false;
          setIdle(l, rand(T.idleMin, T.idleMax) / 2);
        }
      } else l.stuck = 0;
    }
  };

  /** Adopt this pack's figures in every dimension a player is in (after a placement or a reload). */
  const adopt = (): void => {
    const dims = new Set<string>(['overworld']);
    for (const p of world.getAllPlayers()) { if (p) try { dims.add(p.dimension.id); } catch { /* left */ } }
    for (const id of dims) {
      let found: any[] = [];
      try { found = world.getDimension(id).getEntities({ families: ['craftmatic_figure'] }); } catch { continue; }
      for (const e of found) {
        if (!types.has(e.typeId) || lives.has(e.id) || isDraft(e)) continue;
        const home = readHome(e);
        if (!home) continue;
        let yaw = 0;
        try { yaw = e.getRotation().y; } catch { /* default */ }
        lives.set(e.id, { e, home, state: 'idle', until: tick + Math.round(rand(20, T.idleMax)), path: [], i: 0, yaw, checkAt: 0, stuck: 0, outsideSince: 0, nextSeatAt: tick + Math.round(rand(200, 1200)), cells: 0 });
      }
    }
  };

  system.runInterval(() => {
    tick++;
    safeSeatDismounts();
    if (tick % 40 === 1) adopt();
    for (const [id, l] of lives) {
      let valid = false;
      try { valid = l.e.isValid; } catch { valid = false; }
      if (!valid) { lives.delete(id); continue; }
      // Picked up by the Minifig Creator wand: let go (re-adopted after its release).
      if (tick % 10 === 0 && isDraft(l.e)) { lives.delete(id); continue; }
      try { step(l); } catch (err) {
        // Once per figure, to the content log: a fault here must not be silent.
        if (!(l as any).faulted) { (l as any).faulted = true; console.warn(`[craftmatic figures] ${l.e.typeId}: ${String(err && (err as Error).stack || err)}`); }
        setIdle(l, 100);
      }
    }
  }, 1);
}

/** `scripts/figures.js`. */
export function figureLifeScript(config: FigureLifeConfig): string {
  const planner = `{ standFeetAt: ${standFeetAt.toString()}, exploreWalkable: ${exploreWalkable.toString()}, pathTo: ${pathTo.toString()}, blockSpan: ${blockSpan.toString()}, startCell: ${startCell.toString()}, refugeCell: ${refugeCell.toString()} }`;
  const body = config.seatSafety
    ? `(${colliderBodyProbe.toString()})((${colliderFormKit.toString()})(), ${JSON.stringify(config.colliders?.loState ?? COLLIDER_STATES.lo)}, ${JSON.stringify(config.colliders?.hiState ?? COLLIDER_STATES.hi)})`
    : 'undefined';
  // The seat watcher's bounds that are not the rides' policy: this module's own, filled in where the config (an
  // older pack's, rebuilt by the simulator's runtime swap) does not carry them.
  const S = config.seatSafety;
  const shipped: FigureLifeConfig = S ? {
    ...config,
    seatSafety: {
      ...S,
      escape: S.escape ?? ESCAPE_OPTIONS,
      nativeReach: S.nativeReach ?? SEAT_EGRESS.NATIVE_REACH_BLOCKS,
      reseatLimit: S.reseatLimit ?? SEAT_EGRESS.RESEAT_LIMIT,
      reseatWindowTicks: S.reseatWindowTicks ?? SEAT_EGRESS.RESEAT_WINDOW_TICKS,
    },
  } : config;
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(shipped)};\n(${figureLifeRuntime.toString()})({ world, system }, CONFIG, ${planner}, ${JSON.stringify(FIGURE_HOME_PROPERTY)}, ${body});\n`;
}
