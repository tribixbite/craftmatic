/**
 * The `creator_wand_<id>` GameTest (gametest-pack.ts) run against the REAL
 * Minifig Creator wand runtime (bedrock-minifig-wand.ts) in one fake Bedrock
 * world, the way the device runs both in one pack: the wand publishes its
 * operations on `globalThis`, the test drives them with a simulated player.
 * A fake walker stands in for scripts/figures.js: a released figure with no
 * home record walks, one with a `seated` home stays.
 */
import { describe, expect, it } from 'vitest';
import { gametestRuntime, judgeWalk, outcomeMatches, arenaSize, GT_MARGIN, type GametestPlan } from '../web/src/engine/gametest-pack.js';
import { MINIFIG_WAND_API_GLOBAL, minifigWandScript } from '../web/src/engine/bedrock-minifig-wand.js';

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

function world(opts: { walkerMoves: boolean }) {
  let nextId = 1;
  const entities = new Map<string, any>();
  class Entity {
    id = `e${nextId++}`; typeId: string; location: any; dimension: any; nameTag = '';
    properties = new Map<string, unknown>(); dynamic = new Map<string, unknown>(); events: string[] = []; rotation = { x: 0, y: 0 };
    isValid = true;
    constructor(typeId: string, dimension: any, at: any) { this.typeId = typeId; this.dimension = dimension; this.location = { ...at }; entities.set(this.id, this); }
    getProperty(k: string) { return this.properties.get(k); }
    setProperty(k: string, v: unknown) { this.properties.set(k, v); }
    getDynamicProperty(k: string) { return this.dynamic.get(k); }
    setDynamicProperty(k: string, v: unknown) { if (v === undefined) this.dynamic.delete(k); else this.dynamic.set(k, v); }
    triggerEvent(e: string) { this.events.push(e); }
    teleport(at: any) { this.location = { ...at }; }
    getRotation() { return { ...this.rotation }; }
    setRotation(r: any) { this.rotation = { ...r }; }
    getComponent() { return undefined; }
    remove() { this.isValid = false; entities.delete(this.id); }
  }
  const dim: any = {
    id: 'overworld',
    spawnEntity: (type: string, at: any) => new Entity(type, dim, at),
    getEntities: (q: any = {}) => [...entities.values()].filter((e) => !q.type || e.typeId === q.type),
    getBlock: () => ({ isAir: true, isLiquid: false, typeId: 'minecraft:air' }),
    runCommand: () => ({ successCount: 1 }),
  };
  const dynamic = new Map<string, unknown>();
  const sim: any = {
    id: 'sim-1', name: 'cmgt_wand1', typeId: 'minecraft:player', location: { x: 10, y: 1, z: 10 }, dimension: dim,
    getRotation: () => ({ x: 0, y: 0 }),
    getBlockFromViewDirection: () => ({ block: { location: { x: 14, y: 0, z: 14 } }, face: 'Up' }),
    getEntitiesFromViewDirection: () => [],
    sendMessage() {},
    getDynamicProperty: (k: string) => dynamic.get(k),
    setDynamicProperty: (k: string, v: unknown) => { if (v === undefined) dynamic.delete(k); else dynamic.set(k, v); },
  };
  /** The fake figures.js: a released creator figure without a home walks; a `seated` home holds still. */
  const tick = () => {
    for (const e of entities.values()) {
      if (e.typeId !== figureType || e.getProperty('craftmatic:draft') !== false) continue;
      const home = e.getDynamicProperty('craftmatic:fig');
      if (opts.walkerMoves && (!home || JSON.parse(home).mode !== 'seated')) e.location = { ...e.location, x: e.location.x + 0.1 };
    }
  };
  const mcWorld: any = {
    afterEvents: {
      itemUse: { subscribe() {} }, playerLeave: { subscribe() {} }, playerSpawn: { subscribe() {} },
      playerInteractWithEntity: { subscribe() {} }, entityHitEntity: { subscribe() {} },
    },
    beforeEvents: { playerInteractWithEntity: { subscribe() {} } },
    getEntity: (id: string) => entities.get(id),
    getDimension: () => dim,
    getAllPlayers: () => [sim],
    getPlayers: () => [sim],
  };
  const system: any = {
    currentTick: 0, run: (fn: Function) => fn(), runTimeout: (fn: Function) => fn(), runInterval: () => 0,
    afterEvents: { scriptEventReceive: { subscribe() {} } }, sendScriptEvent() {},
  };
  return { entities, dim, sim, tick, mcWorld, system };
}

function run(opts: { walkerMoves: boolean }) {
  const w = world(opts);
  const source = minifigWandScript(wandConfig as any).replace(/^import .*;\n/gm, '');
  new Function('world', 'system', 'ActionFormData', 'ModalFormData', 'MessageFormData', 'FormCancelationReason', source)(
    w.mcWorld, w.system, class {}, class {}, class {}, { UserBusy: 'UserBusy' },
  );
  expect((globalThis as any)[MINIFIG_WAND_API_GLOBAL]).toBeDefined();
  const plan: GametestPlan = {
    modelId: 'creator', label: 'Creator', dims: { width: 3, height: 1, length: 3 }, actorTypes: [], angleProperty: 'craftmatic:angle', doorways: [],
    creatorFigure: figureType,
    creatorWand: { api: MINIFIG_WAND_API_GLOBAL, savedKey: 'craftmatic:creator:saved', slotSizes: Object.fromEntries(Object.entries(wandConfig.library.minifig).map(([s, l]) => [s, (l as unknown[]).length])) },
  };
  const registered = new Map<string, (t: any) => Promise<void>>();
  const builder: any = new Proxy({}, { get: () => () => builder });
  const gt = { registerAsync: (_c: string, name: string, fn: (t: any) => Promise<void>) => { registered.set(name, fn); return builder; } };
  const outcome: { succeeded?: boolean; failure?: string } = {};
  const test = {
    worldBlockLocation: (r: any) => r, worldLocation: (r: any) => r,
    getBlock: (r: any) => ({ typeId: r.y === 0 ? 'minecraft:smooth_stone' : 'minecraft:air' }),
    getTestDirection: () => 'South', getDimension: () => w.dim,
    idle: async (ticks: number) => { for (let i = 0; i < ticks; i++) w.tick(); },
    spawnSimulatedPlayer: () => w.sim,
    succeed: () => { outcome.succeeded = true; }, fail: (m: string) => { outcome.failure = m; },
  };
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (s: string) => { if (!s.startsWith('CMGT_PAD')) logs.push(s); };
  try { gametestRuntime({ mc: { GameMode: { Survival: 'Survival' }, world: w.mcWorld, system: w.system }, gt }, plan, arenaSize(plan.dims), GT_MARGIN, judgeWalk, outcomeMatches); } finally { console.warn = warn; }
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
    expect([...h.w.entities.values()].filter((e) => e.typeId === figureType)).toHaveLength(0);
  });

  it('fails naming the step when a released figure never walks', async () => {
    const h = run({ walkerMoves: false });
    await h.go();
    expect(h.outcome.failure).toMatch(/placeWalk/);
    expect(h.outcome.failure).not.toMatch(/placeStay|draftHolds|pickUp/);
  });
});
