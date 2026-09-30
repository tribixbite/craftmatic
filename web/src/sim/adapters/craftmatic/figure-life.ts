/**
 * `scripts/figures.js` (bedrock-figure-life.ts) on the headless simulator:
 * the SERIALISED runtime loaded as a pack entry and run over a sim world
 * built from a pack's own collider cells (the collider kit's real block
 * definitions, each cell's lo/hi as block states, a clearance form as its
 * variant), solid ground under `ground`, figures as mobs with
 * `minecraft:physics` and their collision box (0.6 wide, the body height),
 * seats as rideable entities, door leaves as interactive-family entities and
 * an optional player. Figures move by the velocity the script gives them
 * through the simulator's one integrator (`tickBody`: gravity, the per-axis
 * sweep, the 9/16 step, ground friction) - the physics every other scenario
 * runs.
 *
 * It answers offline what the device answers slowly: does each figure of a
 * set find room to walk, stay on its model and floor, keep out of walls. The
 * device GameTest (`figures_<id>` in gametest-pack.ts) is the ground truth.
 * (Folded from web/src/engine/figure-life-sim.ts, 2026-09-30, which ran the
 * same script over a stand-in world with its own collision and a constant
 * 0.4-block/tick drop.)
 */

import type { SourceCell } from '../../../engine/bedrock-collider-scale.js';
import { FIGURE_HOME_PROPERTY, FIGURE_SEATING_PROPERTY, figureLifeScript, type FigureHome, type FigureLifeConfig } from '../../../engine/bedrock-figure-life.js';
import { COLLIDER_KIT } from '../../../engine/collider-form.js';
import { Simulation } from '../../core/simulation.js';
import type { SimEntity } from '../../entity/entity.js';
import { entityDefinition, entityFilePath, fixtureAddon, type FixtureFile } from '../../pack/fixture.js';
import type { TerrainGenerator } from '../../world/voxel-world.js';
import { colliderKitFiles } from './fixture.js';

export interface SimFigure {
  typeId: string;
  /** Spawn feet, world blocks. */
  at: { x: number; y: number; z: number };
  mode?: FigureHome['mode'];
  /** Its home, when it does not stand there (a figure pushed out of its area). */
  home?: { x: number; y: number; z: number };
  /** No home record at all: a Minifig Creator figure (the runtime makes one where it stands). */
  noHome?: boolean;
  /** A creator figure the wand holds as a draft (`craftmatic:draft` true) until this tick. */
  draftUntil?: number;
  /** The placement's seating mark (`FIGURE_SEATING_PROPERTY`) is on this figure until this tick (the placement still spawning). */
  seatingUntil?: number;
}

export interface SimSeat {
  typeId: string; at: { x: number; y: number; z: number };
  /** The tick the seat entity appears (a placement still spawning its seats); default: from the start. */
  spawnAt?: number;
}

export interface SimWorld {
  /** Collider cells, world blocks (lo/hi sixteenths, `v` a clearance form). */
  cells: SourceCell[];
  /** Placement box [x0, z0, x1, z1] (exclusive max) and the pin plane. */
  area: [number, number, number, number];
  /** Solid ground under `ground` everywhere (the flat world). */
  ground: number;
  figures: SimFigure[];
  seats?: SimSeat[];
  /** Door/window leaves (positions only). */
  leaves?: Array<{ x: number; y: number; z: number }>;
  /** A player standing still somewhere, or none. */
  player?: { x: number; y: number; z: number };
  /** The tick the player walks away (is gone from the world); default: stays the whole run. */
  playerLeavesAt?: number;
  f?: number;
  /** Every `console.warn` line the runtime writes (its content-log diagnostics: FIGURE_RETAKE_*), in order. */
  onWarn?: (line: string) => void;
}

export interface SimSample { x: number; y: number; z: number; riding: boolean }

const COLLIDER = { block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi' };
const FIGURE_FAMILY = 'craftmatic_figure';
const INTERACTIVE_FAMILY = 'craftmatic_interactive';
const LEAF_TYPE = 'craftmatic:leaf';
/** The draft mark the Minifig Creator wand sets on a figure it is dressing (an actor property). */
const DRAFT_PROPERTY = 'craftmatic:draft';
/** How far past the placement box the world stays loaded (a figure pushed out walks back through it). */
const LOAD_MARGIN = 48;

/** Run the shipped runtime for `ticks` over a world; returns every figure's per-tick track (after each tick). */
export function simulateFigureLife(world: SimWorld, config: Omit<FigureLifeConfig, 'colliders' | 'interactiveFamily'>, ticks: number, seed = 1): SimSample[][] {
  const bodyOf = (typeId: string): number => config.bodyHeights[typeId] ?? config.bodyHeight;
  const figureTypes = [...new Set([...config.figureTypes, ...world.figures.map(f => f.typeId)])];
  const seatTypes = [...new Set([...config.seatTypes, ...(world.seats ?? []).map(s => s.typeId)])];
  const files: Record<string, FixtureFile> = {
    ...colliderKitFiles(),
    'scripts/figures.js': figureLifeScript({ ...config, interactiveFamily: INTERACTIVE_FAMILY, colliders: COLLIDER }),
  };
  for (const t of figureTypes) {
    files[entityFilePath(t)] = entityDefinition(t, {
      properties: { [DRAFT_PROPERTY]: { type: 'bool', default: false } },
      components: {
        'minecraft:type_family': { family: [FIGURE_FAMILY, 'mob'] },
        'minecraft:collision_box': { width: 0.6, height: bodyOf(t) },
        'minecraft:physics': { has_gravity: true, has_collision: true },
      },
    });
  }
  for (const t of seatTypes) {
    files[entityFilePath(t)] = entityDefinition(t, {
      components: { 'minecraft:type_family': { family: ['craftmatic_seat'] }, 'minecraft:collision_box': { width: 0.5, height: 0.5 }, 'minecraft:rideable': { seat_count: 1, seats: [{ position: [0, 0, 0] }] } },
    });
  }
  files[entityFilePath(LEAF_TYPE)] = entityDefinition(LEAF_TYPE, { components: { 'minecraft:type_family': { family: [INTERACTIVE_FAMILY] } } });

  const ground: TerrainGenerator = Object.assign((_x: number, y: number) => ({ typeId: y < world.ground ? 'minecraft:grass_block' : 'minecraft:air' }), { verticalOnly: true });
  const sim = new Simulation({ terrain: ground, seed });
  const { engine, host } = sim;
  const [x0, z0, x1, z1] = world.area;
  engine.tickingAreas.set('figure-life', { name: 'figure-life', dimension: 'minecraft:overworld', x0: x0 - LOAD_MARGIN, z0: z0 - LOAD_MARGIN, x1: x1 + LOAD_MARGIN, z1: z1 + LOAD_MARGIN });
  const addon = fixtureAddon({ name: 'figure_life', files, scriptEntry: 'scripts/figures.js' });
  sim.loadAddon(addon);
  engine.updateLoaded();
  const faults = (): string[] => engine.timeline.entries.filter(e => e.kind === 'content-log' || e.kind === 'script-error' || e.kind === 'unmodelled').map(e => `${e.kind}: ${e.text}`);
  if (faults().length) throw new Error(`figures.js world refused or faulted at load:\n  ${faults().join('\n  ')}`);

  // The collider cells, as the placement lays them (an empty cell is no block).
  const dim = engine.dimension('overworld');
  for (const c of world.cells) {
    if (!(c.hi > c.lo)) continue;
    dim.setPermutation(c.x, c.y, c.z, host.resolvePermutation(COLLIDER_KIT.VARIANTS[c.v ?? 0]!.id, { [COLLIDER.loState]: c.lo, [COLLIDER.hiState]: c.hi }));
  }

  const f = world.f ?? 1;
  const figs: SimEntity[] = world.figures.map(fig => {
    const e = engine.spawnEntity(fig.typeId, 'overworld', fig.at);
    const hp = fig.home ?? fig.at;
    const home: FigureHome = { home: [hp.x, hp.y, hp.z], area: world.area, ground: world.ground, f, mode: fig.mode ?? 'roam' };
    if (!fig.noHome) e.dynamic.set(FIGURE_HOME_PROPERTY, JSON.stringify(home));
    // The placement stamps its seating mark with the scripts' own clock.
    if (fig.seatingUntil !== undefined) e.dynamic.set(FIGURE_SEATING_PROPERTY, host.scriptNow());
    if (fig.draftUntil !== undefined) e.properties.set(DRAFT_PROPERTY, 0 < fig.draftUntil);
    return e;
  });
  const seats = world.seats ?? [];
  const spawnSeat = (s: SimSeat): SimEntity => engine.spawnEntity(s.typeId, 'overworld', s.at);
  const pendingSeats = seats.filter(s => s.spawnAt !== undefined && s.spawnAt > 0);
  const liveSeats = seats.filter(s => !pendingSeats.includes(s)).map(spawnSeat);
  for (const leaf of world.leaves ?? []) engine.spawnEntity(LEAF_TYPE, 'overworld', leaf);
  // Seated-in-set figures start on their seat (world state: seated before the watch begins).
  for (const [k, fig] of world.figures.entries()) {
    if ((fig.mode ?? 'roam') !== 'seated' || fig.noHome) continue;
    const e = figs[k]!;
    const seat = liveSeats.find(s => !s.riderList().length && (s.location.x - e.location.x) ** 2 + (s.location.z - e.location.z) ** 2 < 1.5 ** 2);
    if (seat) { const r = seat.addRider(e, engine.tick + 1); if (!r.ok) throw new Error(`cannot seat ${e.typeId}: ${r.why}`); }
  }
  const player = world.player ? sim.addPlayer('player', world.player) : undefined;

  const tracks: SimSample[][] = figs.map(() => []);
  let warned = engine.timeline.entries.length;
  for (let t = 0; t < ticks; t++) {
    for (let i = pendingSeats.length - 1; i >= 0; i--) if (pendingSeats[i]!.spawnAt! <= t) spawnSeat(pendingSeats.splice(i, 1)[0]!);
    // The placement's seating pass is done with a figure: its mark goes (the placement clears it with `undefined`).
    for (const [k, fig] of world.figures.entries()) {
      if (fig.seatingUntil === t) figs[k]!.dynamic.delete(FIGURE_SEATING_PROPERTY);
      if (fig.draftUntil !== undefined) figs[k]!.properties.set(DRAFT_PROPERTY, t < fig.draftUntil);
    }
    if (player?.valid && world.playerLeavesAt !== undefined && t >= world.playerLeavesAt) engine.removeEntity(player);
    engine.stepSync();
    const entries = engine.timeline.entries;
    for (; warned < entries.length; warned++) {
      const e = entries[warned]!;
      if (e.kind === 'script-error' || e.kind === 'unmodelled') throw new Error(`figures.js faulted at tick ${e.tick}: ${e.kind}: ${e.text}`);
      if (e.kind === 'console' && e.text.startsWith('[warn] ')) world.onWarn?.(e.text.slice('[warn] '.length));
    }
    for (const [k, e] of figs.entries()) tracks[k]!.push({ x: e.location.x, y: e.location.y, z: e.location.z, riding: !!e.ridingOn });
  }
  return tracks;
}
