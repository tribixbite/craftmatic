/**
 * A host-side world for `scripts/figures.js` (bedrock-figure-life.ts): the
 * SERIALISED runtime runs against a fake `@minecraft/server` whose blocks are
 * a pack's own collider grid and whose entities move by the velocity the
 * script gives them, with a simple stand-in for Bedrock's collision (a 0.6
 * wide body, 0.6-block auto-step, gravity to the next floor, ground friction).
 *
 * It answers offline what the device answers slowly: does each figure of a
 * set find room to walk, stay on its model and floor, keep out of walls. It
 * is not Bedrock's physics - the device GameTest (`figures_<id>` in
 * gametest-pack.ts) is the ground truth - but the planner, the state machine
 * and the home record are the shipped code, not a copy.
 */
import type { SourceCell } from './bedrock-collider-scale.js';
import { FIGURE_HOME_PROPERTY, figureLifeScript, type FigureHome, type FigureLifeConfig } from './bedrock-figure-life.js';

export interface SimFigure {
  typeId: string;
  /** Spawn feet, world blocks. */
  at: { x: number; y: number; z: number };
  mode?: FigureHome['mode'];
  /** Its home, when it does not stand there (a figure pushed out of its area). */
  home?: { x: number; y: number; z: number };
}

export interface SimSeat { typeId: string; at: { x: number; y: number; z: number } }

export interface SimWorld {
  /** Collider cells, world blocks (lo/hi sixteenths). */
  cells: SourceCell[];
  /** Placement box [x0, z0, x1, z1] (exclusive max) and the pin plane. */
  area: [number, number, number, number];
  ground: number;
  /** Solid ground under `ground` everywhere (the flat world). */
  figures: SimFigure[];
  seats?: SimSeat[];
  /** Door/window leaves (positions only). */
  leaves?: Array<{ x: number; y: number; z: number }>;
  /** A player standing still somewhere, or none. */
  player?: { x: number; y: number; z: number };
  f?: number;
}

export interface SimSample { x: number; y: number; z: number; riding: boolean }

const COLLIDER = { block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi' };

/** Run the shipped runtime for `ticks` over a world; returns every figure's per-tick track. */
export function simulateFigureLife(world: SimWorld, config: Omit<FigureLifeConfig, 'colliders' | 'interactiveFamily'>, ticks: number, seed = 1): SimSample[][] {
  // Deterministic randomness for a reproducible census.
  let s = seed >>> 0 || 1;
  const random = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const grid = new Map<string, SourceCell>();
  for (const c of world.cells) grid.set(`${c.x},${c.y},${c.z}`, c);
  const block = (x: number, y: number, z: number): any => {
    const c = grid.get(`${x},${y},${z}`);
    if (c) return { typeId: COLLIDER.block, isAir: false, isLiquid: false, permutation: { getState: (k: string) => k === COLLIDER.loState ? c.lo : c.hi } };
    if (y < world.ground) return { typeId: 'minecraft:grass_block', isAir: false, isLiquid: false, permutation: { getState: () => undefined } };
    return { typeId: 'minecraft:air', isAir: true, isLiquid: false, permutation: { getState: () => undefined } };
  };
  const span = (x: number, y: number, z: number): number[] | null => {
    const c = grid.get(`${x},${y},${z}`);
    if (c) return c.hi > c.lo ? [y + c.lo / 16, y + c.hi / 16] : null;
    return y < world.ground ? [y, y + 1] : null;
  };
  const f = world.f ?? 1;

  interface E { id: string; typeId: string; location: any; v: any; yaw: number; props: Map<string, unknown>; rider?: E; riding?: E; family: string; valid: boolean; body: number }
  const entities: E[] = [];
  const dim: any = {
    id: 'overworld',
    getBlock: (p: any) => block(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    getEntities: (q: any) => entities.filter(e => {
      if (q.type && e.typeId !== q.type) return false;
      if (q.families && !q.families.includes(e.family)) return false;
      if (q.location && q.maxDistance !== undefined) {
        const d = (e.location.x - q.location.x) ** 2 + (e.location.y - q.location.y) ** 2 + (e.location.z - q.location.z) ** 2;
        if (d > q.maxDistance ** 2) return false;
      }
      return true;
    }).map(wrap),
  };
  const wrap = (e: E): any => ({
    get id() { return e.id; }, get typeId() { return e.typeId; }, get location() { return { ...e.location }; }, get isValid() { return e.valid; },
    dimension: dim,
    getVelocity: () => ({ ...e.v }),
    applyImpulse: (v: any) => { e.v.x += v.x; e.v.y += v.y; e.v.z += v.z; },
    clearVelocity: () => { e.v = { x: 0, y: 0, z: 0 }; },
    setRotation: (r: any) => { e.yaw = r.y; },
    getRotation: () => ({ x: 0, y: e.yaw }),
    teleport: (p: any) => { e.location = { ...p }; e.v = { x: 0, y: 0, z: 0 }; },
    getDynamicProperty: (k: string) => e.props.get(k),
    setDynamicProperty: (k: string, v: unknown) => e.props.set(k, v),
    getComponent: (name: string) => {
      if (name === 'minecraft:riding') return e.riding ? { entityRidingOn: wrap(e.riding) } : undefined;
      if (name === 'minecraft:rideable' && e.family === 'craftmatic_seat') return {
        getRiders: () => (e.rider ? [wrap(e.rider)] : []),
        addRider: (r: any) => { const re = entities.find(x => x.id === r.id)!; if (e.rider) return false; e.rider = re; re.riding = e; re.location = { ...e.location }; return true; },
        ejectRider: (r: any) => { const re = entities.find(x => x.id === r.id); if (re && e.rider === re) { e.rider = undefined; re.riding = undefined; re.location = { x: e.location.x + 0.8, y: e.location.y, z: e.location.z }; } },
      };
      return undefined;
    },
  });
  const areaOf = world.area;
  for (const [k, fig] of world.figures.entries()) {
    const props = new Map<string, unknown>();
    const hp = fig.home ?? fig.at;
    const home: FigureHome = { home: [hp.x, hp.y, hp.z], area: areaOf, ground: world.ground, f, mode: fig.mode ?? 'roam' };
    props.set(FIGURE_HOME_PROPERTY, JSON.stringify(home));
    entities.push({ id: `fig${k}`, typeId: fig.typeId, location: { ...fig.at }, v: { x: 0, y: 0, z: 0 }, yaw: 0, props, family: 'craftmatic_figure', valid: true, body: config.bodyHeights[fig.typeId] ?? config.bodyHeight });
  }
  for (const [k, seat] of (world.seats ?? []).entries()) entities.push({ id: `seat${k}`, typeId: seat.typeId, location: { ...seat.at }, v: { x: 0, y: 0, z: 0 }, yaw: 0, props: new Map(), family: 'craftmatic_seat', valid: true, body: 0.5 });
  for (const [k, leaf] of (world.leaves ?? []).entries()) entities.push({ id: `leaf${k}`, typeId: 'craftmatic:leaf', location: { ...leaf }, v: { x: 0, y: 0, z: 0 }, yaw: 0, props: new Map(), family: 'craftmatic_interactive', valid: true, body: 0 });
  // Seated-in-set figures start on their seat.
  for (const e of entities) {
    if (e.family !== 'craftmatic_figure') continue;
    const h = JSON.parse(String(e.props.get(FIGURE_HOME_PROPERTY))) as FigureHome;
    if (h.mode !== 'seated') continue;
    const seat = entities.find(x => x.family === 'craftmatic_seat' && !x.rider && (x.location.x - e.location.x) ** 2 + (x.location.z - e.location.z) ** 2 < 1.5 ** 2);
    if (seat) { seat.rider = e; e.riding = seat; }
  }
  const players = world.player ? [{ id: 'p', name: 'player', location: world.player, dimension: dim }] : [];
  let interval: (() => void) | undefined;
  const mc = {
    world: { getAllPlayers: () => players, getDimension: () => dim },
    system: { runInterval: (fn: () => void) => { interval = fn; } },
  };
  const script = figureLifeScript({ ...config, interactiveFamily: 'craftmatic_interactive', colliders: COLLIDER });
  const body = script.replace(/^import .*;\s*$/m, '').replace('({ world, system }, CONFIG,', '(__mc, CONFIG,');
  const realRandom = Math.random;
  Math.random = random;
  try {
    new Function('__mc', body)(mc);
    if (!interval) throw new Error('figures.js registered no interval');
    const tracks: SimSample[][] = entities.filter(e => e.family === 'craftmatic_figure').map(() => []);
    const figs = entities.filter(e => e.family === 'craftmatic_figure');
    /**
     * Stand-in collision: every column the body ENTERS must be within a step
     * (a column it already overlaps does not hold it - Minecraft's sweep only
     * tests the leading face, so a mob can walk out of a block it was spawned
     * touching); gravity drops it to the floor below.
     */
    const corners = [[-0.29, -0.29], [0.29, -0.29], [-0.29, 0.29], [0.29, 0.29]];
    const columnsOf = (x: number, z: number): Set<string> => new Set(corners.map(([ox, oz]) => `${Math.floor(x + ox!)},${Math.floor(z + oz!)}`));
    const feetAtBox = (x: number, z: number, feet: number, h: number, from: { x: number; z: number }): number | null => {
      let top = -Infinity;
      const had = columnsOf(from.x, from.z);
      for (const [ox, oz] of corners) {
        const cx = Math.floor(x + ox!), cz = Math.floor(z + oz!);
        if (had.has(`${cx},${cz}`)) continue;
        // Clear body above `feet` in this column?
        for (let y = Math.floor(feet); y <= Math.floor(feet + h - 1e-9); y++) {
          const sp = span(cx, y, cz);
          if (sp && sp[0]! < feet + h - 1e-9 && sp[1]! > feet + 1e-9) {
            // A low span is stepped onto; anything taller than a step is a wall.
            if (sp[1]! - feet > 0.6 + 1e-9) return null;
            top = Math.max(top, sp[1]!);
          }
        }
      }
      return top > -Infinity ? top : feet;
    };
    for (let t = 0; t < ticks; t++) {
      interval();
      for (const [k, e] of figs.entries()) {
        if (e.riding) { e.location = { ...e.riding.location }; e.v = { x: 0, y: 0, z: 0 }; }
        else {
          // Horizontal move, axis by axis, blocked by walls; auto-step onto low spans.
          for (const axis of ['x', 'z'] as const) {
            const next = { ...e.location, [axis]: e.location[axis] + e.v[axis] };
            const lifted = feetAtBox(next.x, next.z, e.location.y, e.body, e.location);
            if (lifted === null) { e.v[axis] = 0; continue; }
            e.location = { ...next, y: Math.max(e.location.y, lifted) };
          }
          // Gravity: fall to the highest floor under the body.
          let floor = -Infinity;
          for (const [ox, oz] of [[-0.29, -0.29], [0.29, -0.29], [-0.29, 0.29], [0.29, 0.29]]) {
            const cx = Math.floor(e.location.x + ox!), cz = Math.floor(e.location.z + oz!);
            for (let y = Math.floor(e.location.y + 1e-6); y >= Math.floor(e.location.y) - 40; y--) {
              const sp = span(cx, y, cz);
              if (sp && sp[1]! <= e.location.y + 1e-6) { floor = Math.max(floor, sp[1]!); break; }
            }
          }
          if (floor > -Infinity && floor < e.location.y) e.location.y = Math.max(floor, e.location.y - 0.4);
          e.v.x *= 0.546; e.v.z *= 0.546; e.v.y = 0;
        }
        tracks[k]!.push({ x: e.location.x, y: e.location.y, z: e.location.z, riding: !!e.riding });
      }
    }
    return tracks;
  } finally {
    Math.random = realRandom;
  }
}
