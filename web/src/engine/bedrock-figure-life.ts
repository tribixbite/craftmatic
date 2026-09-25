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
 *    re-seated if it is knocked off); a figure whose floor offers fewer than
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

/** Dynamic property holding a figure's home record (JSON string; see `FigureHome`). */
export const FIGURE_HOME_PROPERTY = 'craftmatic:fig';

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
  /** A player this close (blocks) to a figure's borrowed seat makes it stand up. */
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
 * column when a body fits there, else the nearest standable column within two
 * cells on the same floor. A LEGO figure stands a hair from a wall, a counter
 * or a lamp post, and the 1-block collider column it stands in often holds
 * that part at head height (the Winter Chalet's "stuck" walkers: 1.8 blocks
 * of body under 0.55-0.7 blocks of headroom); the figure is then planned out
 * of that column into the first free one. Pure (serialised into the runtime).
 */
export function startCell(spanAt: SpanLookup, x: number, z: number, feet: number, body: number, maxUp: number, maxDown: number, stand: typeof standFeetAt,
  allowed: (x: number, z: number, feet: number) => boolean = () => true): { x: number; z: number; feet: number } | null {
  const cx = Math.floor(x), cz = Math.floor(z);
  const own = stand(spanAt, cx, cz, feet, body, 0.3, maxDown);
  if (own !== null) return { x: cx, z: cz, feet: own };
  let best: { x: number; z: number; feet: number } | null = null, bestD = Infinity;
  for (let r = 1; r <= 2 && !best; r++) {
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
}

/**
 * The runtime, serialised into `scripts/figures.js`. It may reference nothing
 * outside itself and its arguments.
 */
export function figureLifeRuntime(mc: { world: any; system: any }, config: FigureLifeConfig, planner: FigurePlanner, homeProperty: string): void {
  const { world, system } = mc;
  const T = config.tuning;
  const types = new Set(config.figureTypes);
  interface Life {
    e: any; home: FigureHome; state: 'idle' | 'turn' | 'walk' | 'sit' | 'stay' | 'return';
    until: number; path: WalkCell[]; i: number; yaw: number; seat?: any; checkAt: number; checkPos?: any;
    stuck: number; outsideSince: number; nextSeatAt: number; cells: number;
    /** The last plan started beside its own column (it stands in a collider); `unwedged` once it was walked out. */
    wedged?: boolean; unwedged?: boolean; unwedging?: boolean;
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
          if (C && b.typeId === C.block) { lo = Number(b.permutation.getState(C.loState)); hi = Number(b.permutation.getState(C.hiState)); }
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
    const start = planner.startCell(span, loc.x, loc.z, loc.y, body, T.maxUp, T.maxDown, planner.standFeetAt, allowed);
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
    if (cells.length < T.minRoamCells) {
      // Standing inside a collider column (a LEGO figure a hair from a cupboard):
      // step once into the free column beside it, then stay there.
      if (l.wedged && !l.unwedged && cells.length >= 2) { l.unwedged = true; l.unwedging = true; startPath(l, [cells[1]!], 'walk'); return; }
      l.state = 'stay'; l.until = tick + 600; return;
    }
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
        const here = (e.location.x - sl.x) ** 2 + (e.location.z - sl.z) ** 2 < 1.6 * 1.6;
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
      // Stay on the source's seat; after a knock-off, take it back when it is free.
      if (!riding(e) && tick >= l.until) {
        l.until = tick + 100;
        try {
          const seats = e.dimension.getEntities({ location: { x: h.home[0], y: h.home[1], z: h.home[2] }, maxDistance: 1.5 })
            .filter((s: any) => config.seatTypes.includes(s.typeId));
          const r = seats[0]?.getComponent('minecraft:rideable');
          if (r && (r.getRiders?.() ?? []).length === 0) r.addRider(e);
        } catch { /* try later */ }
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
        if (!types.has(e.typeId) || lives.has(e.id)) continue;
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
    if (tick % 40 === 1) adopt();
    for (const [id, l] of lives) {
      let valid = false;
      try { valid = l.e.isValid; } catch { valid = false; }
      if (!valid) { lives.delete(id); continue; }
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
  const planner = `{ standFeetAt: ${standFeetAt.toString()}, exploreWalkable: ${exploreWalkable.toString()}, pathTo: ${pathTo.toString()}, blockSpan: ${blockSpan.toString()}, startCell: ${startCell.toString()} }`;
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${figureLifeRuntime.toString()})({ world, system }, CONFIG, ${planner}, ${JSON.stringify(FIGURE_HOME_PROPERTY)});\n`;
}
