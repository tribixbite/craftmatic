/**
 * The `creator_wand_<id>` GameTest (gametest-pack.ts) run against the REAL
 * Minifig Creator wand runtime (bedrock-minifig-wand.ts) on the headless
 * simulator (web/src/sim), the way the device runs both in one pack: the wand
 * publishes its operations on `globalThis`, the test drives them with a
 * simulated player. A stand-in walker (an engine system) takes the place of
 * scripts/figures.js: a released figure with no home record walks, one with a
 * `seated` home stays.
 */
import { describe, expect, it } from 'vitest';
import { gametestRuntime, judgeWalk, outcomeMatches, arenaSize, GT_MARGIN, type GametestPlan } from '../web/src/engine/gametest-pack.js';
import { MINIFIG_WAND_API_GLOBAL, creatorFigureBehavior, minifigWandScript } from '../web/src/engine/bedrock-minifig-wand.js';
import { ORDER } from '../web/src/sim/core/engine.js';
import type { TerrainGenerator } from '../web/src/sim/world/voxel-world.js';
import { simHost } from './_sim-host.js';

const slotNames = ['head', 'hair', 'torso', 'arms', 'hands', 'hips', 'legs', 'held_right', 'held_left', 'back'];
const figureType = 'craftmatic:creator_minifig';
const wandConfig = {
  id: 'creator', label: 'Creator', itemId: 'craftmatic:creator_wand', shortAlias: 'mf_creator', figureType,
  library: {
    minifig: Object.fromEntries(slotNames.map((slot) => [slot, slot === 'hair'
      ? [['', 'None', ''], ['3901', 'Hair', 'Hair'], ['3625', 'Long hair', 'Hair']]
      : [['973', 'Part', 'Core']]])),
    minidoll: {},
  },
  colours: [[4, 'Red', 'textures/entity/craftmatic_swatch_4'], [14, 'Yellow', 'textures/entity/craftmatic_swatch_14']],
  firstTranslucentColour: 2,
  defaults: { minifig: { ...Object.fromEntries(slotNames.flatMap((slot) => [[`craftmatic:${slot}`, 0], [`craftmatic:c_${slot}`, 0]])), 'craftmatic:pose': 0 }, minidoll: {} },
  presets: [], worldCap: 20, savedCap: 10, pageSize: 8,
  poses: [['Standing', false], ['Waving', false], ['Sitting', true]],
};

/** The GameTest arena: a smooth-stone floor at y = 0 on stone, air above (what `floorY` reads). */
const ARENA: TerrainGenerator = Object.assign((_x: number, y: number) => ({ typeId: y < 0 ? 'minecraft:stone' : y === 0 ? 'minecraft:smooth_stone' : 'minecraft:air' }), { verticalOnly: true });

/**
 * The wand's SERIALISED runtime on the headless simulator (test/_sim-host.ts),
 * its creator figure declared as the pack declares it. A stand-in for
 * scripts/figures.js runs as an engine system (the test's subject is the
 * GameTest's judgement, not the walker): a released figure with no home
 * record walks 0.1 block a tick, one with a `seated` home stays.
 */
function world(opts: { walkerMoves: boolean }) {
  const h = simHost({ script: minifigWandScript(wandConfig as any), entities: { [figureType]: creatorFigureBehavior(wandConfig as any, '1.26.30') }, terrain: ARENA });
  h.engine.addSystem({
    name: 'figures-stand-in', order: ORDER.entities + 1, tick: engine => {
      for (const e of engine.loadedEntities()) {
        if (e.typeId !== figureType || e.properties.get('craftmatic:draft') !== false) continue;
        const home = e.dynamic.get('craftmatic:fig');
        if (opts.walkerMoves && (typeof home !== 'string' || JSON.parse(home).mode !== 'seated')) e.location = { ...e.location, x: e.location.x + 0.1 };
      }
    },
  });
  return { h, figures: () => [...h.engine.entities.values()].filter(e => e.valid && e.typeId === figureType) };
}

function run(opts: { walkerMoves: boolean }) {
  const w = world(opts);
  const { h } = w;
  expect((globalThis as any)[MINIFIG_WAND_API_GLOBAL]).toBeDefined();
  const plan: GametestPlan = {
    modelId: 'creator', label: 'Creator', dims: { width: 3, height: 1, length: 3 }, actorTypes: [], angleProperty: 'craftmatic:angle', doorways: [],
    creatorFigure: figureType,
    creatorWand: { api: MINIFIG_WAND_API_GLOBAL, savedKey: 'craftmatic:creator:saved', slotSizes: Object.fromEntries(Object.entries(wandConfig.library.minifig).map(([s, l]) => [s, (l as unknown[]).length])) },
  };
  const registered = new Map<string, (t: any) => Promise<void>>();
  const builder: any = new Proxy({}, { get: () => () => builder });
  // `@minecraft/server-gametest` is not part of the simulator: its registration, the test's frame
  // (identity: the arena at the origin) and the simulated player are this fixture, over the sim's world.
  const gt = { registerAsync: (_c: string, name: string, fn: (t: any) => Promise<void>) => { registered.set(name, fn); return builder; } };
  const outcome: { succeeded?: boolean; failure?: string } = {};
  const test = {
    worldBlockLocation: (r: any) => r, worldLocation: (r: any) => r,
    getBlock: (r: any) => h.dimension().getBlock(r),
    getTestDirection: () => 'South', getDimension: () => h.dimension(),
    idle: async (ticks: number) => { await h.runAsync(ticks); },
    spawnSimulatedPlayer: (at: any, name: string) => {
      const player = h.api(h.addPlayer(name, at));
      // The block the simulated player looks at: the arena floor at (14, 0, 14).
      player.getBlockFromViewDirection = () => ({ block: h.dimension().getBlock({ x: 14, y: 0, z: 14 }), face: 'Up' });
      return player;
    },
    succeed: () => { outcome.succeeded = true; }, fail: (m: string) => { outcome.failure = m; },
  };
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (s: string) => { if (!s.startsWith('CMGT_PAD')) logs.push(s); };
  try { gametestRuntime({ mc: { GameMode: { Survival: 'Survival' }, world: h.world, system: h.system }, gt }, plan, arenaSize(plan.dims), GT_MARGIN, judgeWalk, outcomeMatches); } finally { console.warn = warn; }
  return {
    registered, outcome, logs, w,
    async go() {
      console.warn = (s: string) => { if (!s.startsWith('CMGT_PAD')) logs.push(s); };
      try { await registered.get('creator_wand_creator')!(test); } finally { console.warn = warn; }
    },
  };
}

describe('creator_wand GameTest against the real wand runtime', () => {
  it('passes every step: draft, edits, code, save/load, undo, stay, walk, pick up, remove and undo', async () => {
    const h = run({ walkerMoves: true });
    expect([...h.registered.keys()]).toContain('creator_wand_creator');
    await h.go();
    const row = JSON.parse(h.logs.find((l) => l.startsWith('CMGT CREATOR_WAND '))!.slice('CMGT CREATOR_WAND '.length));
    expect(row.slot).toBe('hair');
    expect(Object.values(row.results).every((v) => v === 'ok'), JSON.stringify(row.results)).toBe(true);
    expect(h.outcome).toEqual({ succeeded: true });
    // It cleans up after itself.
    expect(h.w.figures()).toHaveLength(0);
  });

  it('fails naming the step when a released figure never walks', async () => {
    const h = run({ walkerMoves: false });
    await h.go();
    expect(h.outcome.failure).toMatch(/placeWalk/);
    expect(h.outcome.failure).not.toMatch(/placeStay|draftHolds|pickUp/);
  });
});
