/**
 * The GameTest pack generator (web/src/engine/gametest-pack.ts): the placement
 * hook injection, the variant manifest, the arena structure, the walk verdicts,
 * and the serialised test runtime run against a fake GameTest harness the way
 * the device runs it (register → place via scriptevent → walk every doorway
 * closed and open → one verdict line per doorway → succeed/fail).
 */
import { describe, expect, it } from 'vitest';
import {
  arenaSize, buildArenaStructure, gametestRuntime, gametestVariantFiles, withGametestImport, gametestScript, GT_MARGIN, GT_PLACE_EVENT,
  judgeWalk, outcomeMatches, patchPlacementForGametest, variantManifest, judgeFigureTrack, arenaExceeds, type GametestPlan, type Vec3,
} from '../web/src/engine/gametest-pack.js';

const PLACEMENT_FIXTURE = [
  'function placementRuntime(config) {',
  '  const states = new Map, histories = new Map;',
  '  const x = 1, state = (p) => states.get(p.id);',
  '  async function place(p) { histories.set(p.id, { entities: [] }); }',
  '  world.afterEvents.itemUse.subscribe((ev) => {',
  '  });',
  '}',
].join('\n');

const PLAN: GametestPlan = {
  modelId: 'demo_1', label: 'Demo', dims: { width: 10, height: 6, length: 8 },
  actorTypes: ['craftmatic:demo_1_shell', 'craftmatic:demo_1_door_1', 'craftmatic:demo_1_door_2'],
  angleProperty: 'craftmatic:angle',
  doorways: [
    { label: 'Door 1', typeId: 'craftmatic:demo_1_door_1', actor: { x: 3, y: 0, z: 4 }, start: { x: 3.5, y: 0, z: 5.5 }, end: { x: 3.5, y: 0, z: 3.5 }, expectClosed: 'blocked', expectOpen: 'passed', offlineVerdict: 'OK' },
    { label: 'Door 2', typeId: 'craftmatic:demo_1_door_2', actor: { x: 7, y: 0, z: 4 }, start: { x: 7.5, y: 0, z: 5.5 }, end: { x: 7.5, y: 0, z: 3.5 }, expectClosed: 'sealed', expectOpen: 'sealed', offlineVerdict: 'SEALED' },
  ],
};

describe('placement hook', () => {
  it('is inserted inside the runtime, before the itemUse handler', () => {
    const out = patchPlacementForGametest(PLACEMENT_FIXTURE);
    expect(out.indexOf(GT_PLACE_EVENT)).toBeGreaterThan(out.indexOf('async function place('));
    expect(out.indexOf(GT_PLACE_EVENT)).toBeLessThan(out.indexOf('world.afterEvents.itemUse'));
  });
  it('refuses a runtime whose shape changed', () => {
    expect(() => patchPlacementForGametest(PLACEMENT_FIXTURE.replace('itemUse', 'itemUseOn'))).toThrow(/anchor not found/);
    expect(() => patchPlacementForGametest(PLACEMENT_FIXTURE.replace('histories.set', 'history.set'))).toThrow(/would not bind/);
  });
});

describe('manifests', () => {
  const manifest = {
    format_version: 2,
    header: { name: 'Demo — Playable', uuid: 'a5e2e1d9-00a9-437d-abbd-04d3bde52f9b', version: [1, 2, 3] },
    modules: [{ type: 'script', uuid: 'f5cbabd8-d93a-4e3d-b2fb-2d3299ed460c', version: [1, 2, 3], entry: 'scripts/main.js' }],
    dependencies: [{ uuid: 'a805a745-f664-429a-8862-8e7dfaeae1d3', version: [1, 2, 3] }, { module_name: '@minecraft/server', version: '2.9.0' }],
  };
  it('the variant gets new uuids and keeps its dependencies', () => {
    const v = variantManifest(manifest);
    expect(v.header.uuid).not.toBe(manifest.header.uuid);
    expect(v.modules[0]!.uuid).not.toBe(manifest.modules[0]!.uuid);
    expect(v.dependencies).toEqual([...manifest.dependencies, { module_name: '@minecraft/server-gametest', version: '1.0.0-beta' }]);
    expect(variantManifest(manifest).header.uuid).toBe(v.header.uuid);
  });
  it('the variant imports the tests from its own entry, once', () => {
    const main = 'import "./placement.js";\nconsole.warn(1);\n';
    expect(withGametestImport(main)).toBe('import "./placement.js";\nconsole.warn(1);\nimport "./gametest.js";\n');
    expect(withGametestImport(withGametestImport(main))).toBe(withGametestImport(main));
    expect(gametestVariantFiles(PLAN).map(f => f.name)).toEqual(['scripts/gametest.js', 'structures/craftmatic_gt/arena_demo_1.mcstructure']);
  });
});

describe('arena structure', () => {
  it('is little-endian NBT sized to the model plus the margin', () => {
    const bytes = buildArenaStructure(PLAN.dims);
    const size = arenaSize(PLAN.dims);
    expect(size).toEqual({ x: 10 + 2 * GT_MARGIN, y: 9, z: 8 + 2 * GT_MARGIN });
    expect(bytes[0]).toBe(10); // TAG_Compound root
    expect(new TextDecoder().decode(bytes)).toContain('minecraft:smooth_stone');
  });
  it('refuses a model wider than one structure', () => {
    expect(() => buildArenaStructure({ width: 70, height: 5, length: 5 })).toThrow(/exceeds one structure/);
  });
});

describe('figure verdicts', () => {
  const area = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 8 } };
  it('measures path, excursion, leaving the footprint, falling and moving', () => {
    const v = judgeFigureTrack([{ x: 1, y: 0.2, z: 1 }, { x: 3, y: 0.2, z: 1 }, { x: 3, y: 0.2, z: 3 }], area, 0, false, 1);
    expect(v).toMatchObject({ samples: 3, pathLength: 4, maxExcursion: 2.83, outsideSamples: 0, belowGround: false, droppedStorey: false, moved: true });
    const out = judgeFigureTrack([{ x: 9, y: 3, z: 1 }, { x: 11.5, y: 0, z: 1 }, { x: 12, y: -1, z: 1 }], area, 0, true, 1);
    expect(out).toMatchObject({ outsideSamples: 2, belowGround: true, droppedStorey: true, endInsideWall: true });
    expect(judgeFigureTrack([{ x: 1, y: 0, z: 1, riding: true }, { x: 1, y: 0, z: 1.5, riding: true }], area, 0, false, 1)).toMatchObject({ moved: false, ridingSamples: 2 });
  });
  it('knows a model too wide for one structure, and the capped arena builds', () => {
    expect(arenaExceeds({ width: 77, height: 17, length: 15 })).toBe(true);
    expect(arenaExceeds(PLAN.dims)).toBe(false);
    expect(() => buildArenaStructure({ width: 77, height: 17, length: 15 }, { overflow: true })).not.toThrow();
  });
  it('registers the figures test only for a plan that has figures', () => {
    const js = gametestScript({ ...PLAN, figures: [{ label: 'F1', typeId: 'craftmatic:demo_1_fig1', actor: { x: 2, y: 0, z: 2 }, seated: false }] });
    expect(js).toContain('figures_');
    expect(js).toContain('function judgeFigureTrack');
  });
});

describe('walk verdicts', () => {
  const s = { x: 0, y: 0, z: 0 }, e = { x: 0, y: 0, z: 2 };
  it('judges progress along the start→end line', () => {
    expect(judgeWalk(s, e, { x: 0.3, y: 0, z: 1.9 }).outcome).toBe('passed');
    expect(judgeWalk(s, e, { x: 0, y: 0, z: 0.4 }).outcome).toBe('blocked');
    expect(judgeWalk(s, e, { x: 0, y: 0, z: 1.2 }).outcome).toBe('partial');
    expect(judgeWalk(s, e, { x: 0, y: -3.2, z: 1.9 }).outcome).toBe('fell');
    expect(outcomeMatches('sealed', 'fell')).toBe(true);
    expect(outcomeMatches('passed', 'fell')).toBe(false);
  });
  it('sealed and blocked both mean "not walkable"', () => {
    expect(outcomeMatches('sealed', 'blocked')).toBe(true);
    expect(outcomeMatches('sealed', 'passed')).toBe(false);
    expect(outcomeMatches('passed', 'partial')).toBe(false);
  });
});

/** A fake of the parts of @minecraft/server + server-gametest the runtime touches. */
function fakeHarness(opts: { doorOpens: boolean; closedLeaks: boolean }) {
  const origin: Vec3 = { x: 100, y: -60, z: 200 };
  const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const scriptSubs: Array<(ev: any) => void> = [];
  const logs: string[] = [];
  const registered = new Map<string, (t: any) => Promise<void>>();
  const anchor = add(origin, { x: GT_MARGIN, y: 1, z: GT_MARGIN });
  const leaves = PLAN.doorways.map(d => ({ typeId: d.typeId, location: add(anchor, d.actor), angle: 0, getProperty(this: any) { return this.angle; } }));
  const dim = {
    getEntities: (q: any) => leaves.filter(l => !q.type || l.typeId === q.type).concat(q.type ? [] : [{ typeId: 'craftmatic:demo_1_shell', location: anchor } as any]),
    runCommand: () => ({ successCount: 1 }),
  };
  let current: Vec3 = { x: 0, y: 0, z: 0 };
  let leafOpen = false;
  const sim: any = {
    location: { x: 0, y: 0, z: 0 },
    teleport(at: Vec3) { this.location = { ...at }; current = { ...at }; },
    moveToLocation(rel: Vec3) {
      const to = add(origin, rel); // SimulatedPlayer moves take test-relative coordinates
      const door = PLAN.doorways.find(d => Math.abs(add(anchor, d.start).x - current.x) < 1e-6)!;
      const walkable = door.offlineVerdict === 'OK' && (leafOpen || opts.closedLeaks);
      this.location = walkable ? { ...to } : { x: current.x, y: current.y, z: current.z + (to.z - current.z) * 0.2 };
    },
    stopMoving() {}, lookAtEntity() {},
    interactWithEntity(leaf: any) { if (opts.doorOpens) { leaf.angle = -90; leafOpen = true; } return true; },
    attackEntity() { return false; },
  };
  const outcome: { succeeded?: boolean; failure?: string } = {};
  const test = {
    worldBlockLocation: (r: Vec3) => add(origin, r), worldLocation: (r: Vec3) => add(origin, r),
    relativeLocation: (w: Vec3) => ({ x: w.x - origin.x, y: w.y - origin.y, z: w.z - origin.z }),
    getBlock: (r: Vec3) => ({ typeId: r.y === 0 ? 'minecraft:smooth_stone' : 'minecraft:air' }), getTestDirection: () => 'South',
    getDimension: () => dim,
    idle: async () => { /* ticks pass instantly */ },
    spawnSimulatedPlayer: () => sim,
    succeed: () => { outcome.succeeded = true; }, fail: (m: string) => { outcome.failure = m; },
  };
  const builder: any = new Proxy({}, { get: () => () => builder });
  const mc = {
    GameMode: { Survival: 'Survival' },
    world: { afterEvents: { playerSpawn: { subscribe() {} }, playerInteractWithEntity: { subscribe() {} }, entityHitEntity: { subscribe() {} } }, getDimension: () => dim, getPlayers: () => [] },
    system: {
      afterEvents: { scriptEventReceive: { subscribe: (fn: (ev: any) => void) => scriptSubs.push(fn) } },
      runTimeout: (fn: () => void) => fn(),
      // The placement pack answers a place request at once, the way the injected hook does after place().
      sendScriptEvent: (id: string, message: string) => {
        if (id !== GT_PLACE_EVENT) return;
        const { player } = JSON.parse(message);
        leafOpen = false;
        for (const fn of scriptSubs) fn({ id: 'craftmatic_gt:placed', message: JSON.stringify({ player, entities: 3 }) });
      },
    },
  };
  const gt = { registerAsync: (_c: string, name: string, fn: (t: any) => Promise<void>) => { registered.set(name, fn); return builder; } };
  const warn = console.warn;
  console.warn = (s: string) => { if (!s.startsWith('CMGT_PAD')) logs.push(s); };
  try { gametestRuntime({ mc, gt }, PLAN, arenaSize(PLAN.dims), GT_MARGIN, judgeWalk, outcomeMatches); } finally { console.warn = warn; }
  const run = async (name: string) => {
    console.warn = (s: string) => { if (!s.startsWith('CMGT_PAD')) logs.push(s); };
    try { await registered.get(name)!(test); } finally { console.warn = warn; }
  };
  return { registered, logs, run, outcome };
}

describe('the serialised runtime', () => {
  it('serialises without references outside itself', () => {
    const js = gametestScript(PLAN);
    expect(js).toContain('import * as gt from "@minecraft/server-gametest"');
    expect(js).not.toMatch(/__name|import_/);
  });
  it('registers the smoke and the doors test', () => {
    const h = fakeHarness({ doorOpens: true, closedLeaks: false });
    expect([...h.registered.keys()]).toEqual(['smoke', 'doors_demo_1']);
  });
  it('registers the pinball test only for a plan that has a machine', () => {
    const js = gametestScript({ ...PLAN, pinball: { consoleType: 'c', buttonType: 'b', flipperTypes: ['l', 'r'], flipProperty: 'craftmatic:flip', seatedTag: 'craftmatic_pinball', parkSlot: 4 } });
    expect(js).toContain('pinball_');
    expect(js).toContain('"parkSlot":4');
  });
  it('passes when every doorway behaves as the offline walk predicted', async () => {
    const h = fakeHarness({ doorOpens: true, closedLeaks: false });
    await h.run('doors_demo_1');
    expect(h.outcome).toEqual({ succeeded: true });
    const rows = h.logs.filter(l => l.startsWith('CMGT DOOR ')).map(l => JSON.parse(l.slice('CMGT DOOR '.length)));
    expect(rows.map(r => [r.label, r.closed.outcome, r.open.outcome, r.pass])).toEqual([['Door 1', 'blocked', 'passed', true], ['Door 2', 'blocked', 'blocked', true]]);
    expect(rows[0].angleAfterInteract).toBe(-90);
  });
  it('fails, naming the doorway, when a tap does not open it', async () => {
    const h = fakeHarness({ doorOpens: false, closedLeaks: false });
    await h.run('doors_demo_1');
    expect(h.outcome.failure).toMatch(/1\/2 doorways differ.*Door 1/);
  });
  it('fails when a closed doorway lets the player through', async () => {
    const h = fakeHarness({ doorOpens: true, closedLeaks: true });
    await h.run('doors_demo_1');
    expect(h.outcome.failure).toMatch(/Door 1/);
  });
});
