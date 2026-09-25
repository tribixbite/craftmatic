/**
 * The GameTest pack generator (web/src/engine/gametest-pack.ts): the placement
 * hook injection, the variant manifest, the arena structure, the walk verdicts,
 * and the serialised test runtime run against a fake GameTest harness the way
 * the device runs it (register → place via scriptevent → walk every doorway
 * closed and open → one verdict line per doorway → succeed/fail).
 */
import { describe, expect, it } from 'vitest';
import {
  arenaSize, arenaWindows, windowOf, buildArenaStructure, gametestRuntime, gametestVariantFiles, withGametestImport, gametestScript, GT_MARGIN, GT_PLACE_EVENT,
  judgeWalk, outcomeMatches, patchPlacementForGametest, variantManifest, judgeFigureTrack, arenaExceeds, type GametestPlan, type Vec3,
  summariseVehiclePhase, buildVehicleArena, GT_VEHICLE_LAYOUT,
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
  it('tests a model wider than one structure in windows over one arena (76457 is 77 wide)', () => {
    // The full arena exceeds one structure: it is built capped (overflow) and tested in windows.
    expect(arenaExceeds({ width: 77, height: 5, length: 5 })).toBe(true);
    expect(() => buildArenaStructure({ width: 77, height: 5, length: 5 }, { overflow: true })).not.toThrow();
    const w = arenaWindows({ width: 77, height: 5, length: 5 });
    expect(w).toEqual([{ x0: 0, x1: 58 }, { x0: 50, x1: 77 }]);
    // Every x lands in a window with room round it; the overlap goes to the first.
    expect(windowOf(w, 10)).toBe(0);
    expect(windowOf(w, 53)).toBe(0);
    expect(windowOf(w, 56)).toBe(1);
    expect(windowOf(w, 76)).toBe(1);
    expect(arenaWindows({ width: 40, height: 5, length: 5 })).toEqual([{ x0: 0, x1: 40 }]);
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

/** A fake harness for the parts-and-seats test: a door-like part, a turnable, and a seat. */
function partsHarness(opts: { toggles: boolean; seats: boolean; occupiedBy?: string }) {
  const origin: Vec3 = { x: 100, y: -60, z: 200 };
  const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const anchor = add(origin, { x: GT_MARGIN, y: 1, z: GT_MARGIN });
  const scriptSubs: Array<(ev: any) => void> = [];
  const logs: string[] = [];
  const registered = new Map<string, (t: any) => Promise<void>>();
  const plan: GametestPlan = {
    ...PLAN, doorways: [],
    parts: [
      { label: 'Window 1', typeId: 'craftmatic:demo_1_window_1', kind: 'window', actor: { x: 2, y: 1, z: 2 }, from: { x: 2.5, y: 0, z: 4.5 }, openAngle: -60 },
      { label: 'Turnable 1', typeId: 'craftmatic:demo_1_turnable_1', kind: 'turnable', actor: { x: 6, y: 1, z: 2 }, from: { x: 6.5, y: 0, z: 4.5 }, openAngle: 90 },
    ],
    seats: [{ label: 'Seat (4079)', typeId: 'craftmatic:s_demo_1_seat', at: { x: 4, y: 0.5, z: 6 }, ...(opts.occupiedBy ? { occupied: true } : {}) }],
  };
  const entities = [
    ...plan.parts!.map(p => ({ typeId: p.typeId, location: add(anchor, p.actor), angle: 0, kind: p.kind, step: p.openAngle, getProperty(this: any) { return this.angle; } })),
  ];
  const riders: string[] = opts.occupiedBy ? [opts.occupiedBy] : [];
  const seat = { typeId: plan.seats![0]!.typeId, location: add(anchor, plan.seats![0]!.at), getComponent: () => ({ getRiders: () => riders.map(name => ({ name })), ejectRiders: () => { riders.length = 0; } }) };
  const all: any[] = [...entities, seat];
  const dim = { getEntities: (q: any) => all.filter(e => !q.type || e.typeId === q.type), runCommand: () => ({ successCount: 1 }) };
  const sim: any = {
    name: 'cmgt_1', location: { x: 0, y: 0, z: 0 },
    teleport(at: Vec3) { this.location = { ...at }; }, lookAtEntity() {}, stopMoving() {},
    attackEntity(e: any) { if (!opts.toggles) return true; if (e.kind === 'turnable') e.angle += e.step; else e.angle = e.angle ? 0 : e.step; return true; },
    interactWithEntity(e: any) { if (opts.seats && e === seat) riders.push(sim.name); return true; },
  };
  const outcome: { succeeded?: boolean; failure?: string } = {};
  const test = {
    worldBlockLocation: (r: Vec3) => add(origin, r), worldLocation: (r: Vec3) => add(origin, r),
    relativeLocation: (w: Vec3) => ({ x: w.x - origin.x, y: w.y - origin.y, z: w.z - origin.z }),
    getBlock: (r: Vec3) => ({ typeId: r.y === 0 ? 'minecraft:smooth_stone' : 'minecraft:air' }), getTestDirection: () => 'South',
    getDimension: () => dim, idle: async () => {}, spawnSimulatedPlayer: () => sim,
    succeed: () => { outcome.succeeded = true; }, fail: (m: string) => { outcome.failure = m; },
  };
  const builder: any = new Proxy({}, { get: () => () => builder });
  const mc = {
    GameMode: { Survival: 'Survival' },
    world: { afterEvents: { playerSpawn: { subscribe() {} }, playerInteractWithEntity: { subscribe() {} }, entityHitEntity: { subscribe() {} } }, getDimension: () => dim, getPlayers: () => [] },
    system: {
      afterEvents: { scriptEventReceive: { subscribe: (fn: (ev: any) => void) => scriptSubs.push(fn) } },
      runTimeout: (fn: () => void) => fn(),
      sendScriptEvent: (id: string, message: string) => {
        if (id !== GT_PLACE_EVENT) return;
        const { player } = JSON.parse(message);
        for (const fn of scriptSubs) fn({ id: 'craftmatic_gt:placed', message: JSON.stringify({ player, entities: 3 }) });
      },
    },
  };
  const gt = { registerAsync: (_c: string, name: string, fn: (t: any) => Promise<void>) => { registered.set(name, fn); return builder; } };
  const warn = console.warn;
  console.warn = (s2: string) => { if (!s2.startsWith('CMGT_PAD')) logs.push(s2); };
  try { gametestRuntime({ mc, gt }, plan, arenaSize(plan.dims), GT_MARGIN, judgeWalk, outcomeMatches); } finally { console.warn = warn; }
  const run = async (name: string) => {
    console.warn = (s2: string) => { if (!s2.startsWith('CMGT_PAD')) logs.push(s2); };
    try { await registered.get(name)!(test); } finally { console.warn = warn; }
  };
  return { registered, logs, run, outcome };
}

describe('the parts-and-seats test', () => {
  it('registers once for a plan with parts or seats', () => {
    expect([...partsHarness({ toggles: true, seats: true }).registered.keys()]).toEqual(['smoke', 'parts_demo_1']);
  });
  it('passes when a hit opens and closes a part, turns a turnable two steps, and a seat takes the player', async () => {
    const h = partsHarness({ toggles: true, seats: true });
    await h.run('parts_demo_1');
    expect(h.outcome).toEqual({ succeeded: true });
    const rows = h.logs.filter(l => /^CMGT (PART|SEAT) /.test(l)).map(l => JSON.parse(l.replace(/^CMGT (PART|SEAT) /, '')));
    expect(rows.map(r => [r.label, r.pass])).toEqual([['Window 1', true], ['Turnable 1', true], ['Seat (4079)', true]]);
    expect(rows[0].angles).toEqual([0, -60, 0]);
    expect(rows[1].angles).toEqual([0, 90, 180]);
  });
  it('checks that a seat a figure was sat on still holds its figure, instead of mounting the player (10261)', async () => {
    const h = partsHarness({ toggles: true, seats: false, occupiedBy: 'craftmatic:f_demo_1_fig2' });
    await h.run('parts_demo_1');
    expect(h.outcome).toEqual({ succeeded: true });
    const seat = h.logs.filter(l => l.startsWith('CMGT SEAT ')).map(l => JSON.parse(l.slice('CMGT SEAT '.length)))[0];
    expect(seat).toMatchObject({ occupied: true, riders: ['craftmatic:f_demo_1_fig2'], pass: true });
  });
  it('fails naming the parts that did not move and the seat that did not take the player', async () => {
    const h = partsHarness({ toggles: false, seats: false });
    await h.run('parts_demo_1');
    expect(h.outcome.failure).toMatch(/3\/3 parts or seats failed: Window 1, Turnable 1, Seat \(4079\)/);
  });
});

describe('vehicle phases', () => {
  it('summarises distance, sideways slip, climb, turn and speed in the start heading', () => {
    const s = summariseVehiclePhase([
      { t: 0, along: 0, side: 0, dy: 0, yaw: 170 },
      { t: 2, along: 1, side: 0, dy: 0, yaw: 178 },
      { t: 4, along: 2, side: 0.5, dy: 0.5, yaw: -174 },
    ], 2);
    expect(s).toMatchObject({ along: 2, side: 0.5, dy: 0.5, maxDy: 0.5, minDy: 0, yawChange: 16, maxSpeed: 11.18, endSpeed: 11.18 });
  });
  it('builds a 64 x 64 arena with land, a pool a block lower, a slab and a step', () => {
    const bytes = buildVehicleArena();
    expect(bytes.length).toBeGreaterThan(100);
    expect(GT_VEHICLE_LAYOUT.waterTop).toBe(GT_VEHICLE_LAYOUT.landTop - 1);
  });
});

/** A fake harness for the vehicle test: the vehicle moves along its heading while the simulated player pushes the stick. */
function vehicleHarness(opts: { drives: boolean; kind: 'car' | 'boat' | 'plane' | 'hover'; scripted?: boolean; passesPosts?: boolean; vanishAfter?: number }) {
  const origin: Vec3 = { x: 100, y: -60, z: 200 };
  const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const logs: string[] = [];
  const registered = new Map<string, (t: any) => Promise<void>>();
  const plan: GametestPlan = { ...PLAN, doorways: [], vehiclesOnly: true, vehicles: [{ label: 'Demo car', typeId: 'craftmatic:v_demo_1_car', kind: opts.kind, seats: 2, size: { width: 2, height: 1.5, length: 4 }, ...(opts.scripted ? { scripted: true } : {}) }] };
  const sent: any[] = [];
  let hookTicks = 0;
  const riders: any[] = [];
  let input = { x: 0, y: 0 }, jumping = false;
  const veh: any = {
    typeId: 'craftmatic:v_demo_1_car', location: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0 },
    getRotation() { return this.rot; }, setRotation(r: any) { this.rot = { ...r }; },
    getVelocity: () => ({ x: 0, y: 0, z: 0 }), teleport(at: Vec3, o?: any) { this.location = { ...at }; if (o?.rotation) this.rot = { ...o.rotation }; },
    getComponent: () => ({ getRiders: () => riders, addRider: (p: any) => { riders.push(p); return true; }, ejectRiders: () => { riders.length = 0; } }),
    remove() {}, isOnGround: true, isInWater: opts.kind === 'boat',
  };
  let stepped = 0;
  if (opts.vanishAfter !== undefined) {
    // Out of the simulated area: reading the entity throws, as Bedrock's InvalidEntityError.
    let at = { x: 0, y: 0, z: 0 };
    Object.defineProperty(veh, 'location', { get: () => { if (stepped > opts.vanishAfter!) throw new Error('InvalidEntityError: Entity being invalid'); return at; }, set: (v: Vec3) => { at = v; } });
  }
  const step = (): void => {
    stepped++;
    if (opts.vanishAfter !== undefined && stepped > opts.vanishAfter) return; // gone: nothing moves it
    if (!opts.drives || !riders.length) return;
    // A scripted vehicle turns right on x = -1 while its hook input lasts.
    if (opts.scripted) { if (hookTicks > 0) { hookTicks--; veh.rot.y += -input.x * 3; } else { input = { x: 0, y: 0 }; hookJump = false; } }
    const rad = veh.rot.y * Math.PI / 180;
    // A scripted plane's throttle is Jump alone: it rolls forward on it.
    const push = opts.scripted && opts.kind === 'plane' && hookJump && !input.y ? 1 : input.y;
    let next = { x: veh.location.x - Math.sin(rad) * push * 0.4, y: veh.location.y + (jumping && opts.kind === 'plane' ? 0.3 : 0), z: veh.location.z + Math.cos(rad) * push * 0.4 };
    // A hover craft over the pool floats a block lower, on the water.
    if (opts.kind === 'hover' && next.z - origin.z >= GT_VEHICLE_LAYOUT.poolZ0) next = { ...next, y: origin.y + GT_VEHICLE_LAYOUT.waterTop };
    // The runtime's swept footprint: the vehicle (4 long, heading +x) stops with its nose at a post.
    if (!opts.passesPosts) for (const p of posts) if (Math.abs(next.z - origin.z - p.z - 0.5) < 1.5 && next.x - origin.x + 2 > p.x && veh.location.x - origin.x + 2 <= p.x + 0.01) next = { ...next, x: origin.x + p.x - 2 };
    veh.location = next;
    jumping = false;
  };
  let hookJump = false;
  const posts: Vec3[] = [];
  const mkSim = (name: string): any => ({
    name, location: { x: 0, y: 0, z: 0 }, teleport(at: Vec3) { this.location = { ...at }; }, lookAtEntity() {}, lookAtLocation() {}, setRotation() {},
    interactWithEntity() { riders.push(this); return true; }, moveRelative(_x: number, y: number) { input = { x: 0, y }; },
    stopMoving() { input = { x: 0, y: 0 }; }, rotateBody(a: number) { if (opts.drives) veh.rot.y += a; }, jump() { jumping = true; return true; },
  });
  const outcome: { succeeded?: boolean; failure?: string } = {};
  const dim = { spawnEntity: (_t: string, at: Vec3) => { veh.location = { ...at }; return veh; }, getEntities: () => [veh] };
  const test = {
    worldBlockLocation: (r: Vec3) => add(origin, r), worldLocation: (r: Vec3) => add(origin, r),
    relativeLocation: (w: Vec3) => ({ x: w.x - origin.x, y: w.y - origin.y, z: w.z - origin.z }),
    getBlock: (r: Vec3) => ({ typeId: r.y === 0 ? 'minecraft:smooth_stone' : 'minecraft:air' }), getTestDirection: () => 'South',
    getDimension: () => dim, idle: async (n = 1) => { for (let i = 0; i < n; i++) step(); },
    setBlockType: (type: string, at: Vec3) => { if (type === 'minecraft:oak_log') { if (!posts.some(p => p.x === at.x && p.z === at.z)) posts.push({ ...at }); } else posts.length = 0; },
    spawnSimulatedPlayer: (_at: Vec3, name: string) => mkSim(name),
    succeed: () => { outcome.succeeded = true; }, fail: (m: string) => { outcome.failure = m; },
  };
  const builder: any = new Proxy({}, { get: () => () => builder });
  const mc = {
    GameMode: { Survival: 'Survival' },
    world: { afterEvents: { playerSpawn: { subscribe() {} }, playerInteractWithEntity: { subscribe() {} }, entityHitEntity: { subscribe() {} } }, getDimension: () => dim, getPlayers: () => [] },
    system: { afterEvents: { scriptEventReceive: { subscribe() {} } }, runTimeout: (fn: () => void) => fn(), sendScriptEvent: (id: string, msg: string) => { const m = JSON.parse(msg); sent.push({ id, ...m }); input = { x: m.x, y: m.y }; jumping = m.jump; hookJump = !!m.jump; hookTicks = m.ticks; } },
  };
  const gt = { registerAsync: (_c: string, name: string, fn: (t: any) => Promise<void>) => { registered.set(name, fn); return builder; } };
  const warn = console.warn;
  console.warn = (s2: string) => { if (!s2.startsWith('CMGT_PAD')) logs.push(s2); };
  try { gametestRuntime({ mc, gt }, plan, arenaSize(plan.dims), GT_MARGIN, judgeWalk, outcomeMatches, judgeFigureTrack, { summarise: summariseVehiclePhase, layout: GT_VEHICLE_LAYOUT, inputEvent: 'craftmatic:flight_input' }); } finally { console.warn = warn; }
  const run = async (name: string) => {
    console.warn = (s2: string) => { if (!s2.startsWith('CMGT_PAD')) logs.push(s2); };
    try { await registered.get(name)!(test); } finally { console.warn = warn; }
  };
  return { registered, logs, run, outcome, sent };
}

describe('the vehicle test', () => {
  it('registers only the vehicle test for a vehicles-only plan', () => {
    expect([...vehicleHarness({ drives: true, kind: 'car' }).registered.keys()]).toEqual(['vehicle_demo_1_1']);
  });
  it('drives a car through every phase and reports each one', async () => {
    const h = vehicleHarness({ drives: true, kind: 'car' });
    await h.run('vehicle_demo_1_1');
    const phases = h.logs.filter(l => l.startsWith('CMGT VEHICLE_PHASE ')).map(l => JSON.parse(l.slice('CMGT VEHICLE_PHASE '.length)));
    expect(phases.map(p => p.phase)).toEqual(['settle', 'forward', 'coast', 'reverse', 'stop_after_reverse', 'turn_left', 'turn_stop', 'dash', 'steps']);
    expect(phases.find(p => p.phase === 'forward').along).toBeGreaterThan(20);
    expect(phases.find(p => p.phase === 'reverse').along).toBeLessThan(-10);
    const verdict = JSON.parse(h.logs.find(l => l.startsWith('CMGT VEHICLE '))!.slice('CMGT VEHICLE '.length));
    expect(verdict.checks).toMatchObject({ mounted: true, forwardMoves: true, reverseMoves: true, turns: true });
    expect(verdict.ridersWithPassenger).toHaveLength(2);
  });
  it('drives a scripted boat through its runtime input hook, not the simulated player', async () => {
    const h = vehicleHarness({ drives: true, kind: 'boat', scripted: true });
    await h.run('vehicle_demo_1_1');
    const phases = h.logs.filter(l => l.startsWith('CMGT VEHICLE_PHASE ')).map(l => JSON.parse(l.slice('CMGT VEHICLE_PHASE '.length)));
    expect(phases.map(p => p.phase)).toEqual(['settle', 'ahead', 'coast', 'rudder_right', 'astern', 'boost', 'shore', 'back_off', 'post']);
    expect(h.sent.every((m: any) => m.id === 'craftmatic:flight_input')).toBe(true);
    expect(h.sent.map((m: any) => [m.x, m.y, m.jump, m.ticks])).toEqual([[0, 1, false, 80], [-1, 1, false, 60], [0, -1, false, 40], [0, 1, true, 60], [0, 1, false, 120], [0, -1, false, 40], [0, 0.6, false, 80]]);
    expect(phases.find(p => p.phase === 'rudder_right').yawChange).toBeGreaterThan(30);
  });
  it('stands a post off the centre line, inside the footprint, and checks the vehicle stops at it', async () => {
    for (const kind of ['car', 'boat', 'plane'] as const) {
      const h = vehicleHarness({ drives: true, kind, scripted: true });
      await h.run('vehicle_demo_1_1');
      const verdict = JSON.parse(h.logs.find(l => l.startsWith('CMGT VEHICLE '))!.slice('CMGT VEHICLE '.length));
      // Width 2: the post stands 0.65 off the centre line, 5 blocks past the nose; the harness stops the nose there.
      expect(verdict.post.offset).toBe(0.65);
      expect(verdict.post.clearAlong).toBeGreaterThanOrEqual(4.5);
      expect(verdict.phases.post.along).toBeCloseTo(verdict.post.clearAlong, 5);
      expect(verdict.checks.stopsAtPost).toBe(true);
      const through = vehicleHarness({ drives: true, kind, scripted: true, passesPosts: true });
      await through.run('vehicle_demo_1_1');
      expect(through.outcome.failure).toMatch(/stopsAtPost/);
    }
  });
  it('drives a hover craft over the land lane and then off it onto the pool', async () => {
    const h = vehicleHarness({ drives: true, kind: 'hover', scripted: true });
    await h.run('vehicle_demo_1_1');
    const phases = h.logs.filter(l => l.startsWith('CMGT VEHICLE_PHASE ')).map(l => JSON.parse(l.slice('CMGT VEHICLE_PHASE '.length)));
    expect(phases.map(p => p.phase)).toEqual(['settle', 'ahead', 'coast', 'reverse', 'turn_right', 'boost', 'post', 'over_water']);
    const verdict = JSON.parse(h.logs.find(l => l.startsWith('CMGT VEHICLE '))!.slice('CMGT VEHICLE '.length));
    expect(verdict.checks.floatsOverWater).toBe(true);
    expect(phases.find(p => p.phase === 'over_water').minDy).toBeLessThan(-0.5);
  });
  it('ends cleanly with staysInReach false when the vehicle stops being readable mid-course (the Milano flew out of reach)', async () => {
    const h = vehicleHarness({ drives: true, kind: 'plane', scripted: true, vanishAfter: 200 });
    await h.run('vehicle_demo_1_1');
    const verdict = JSON.parse(h.logs.find(l => l.startsWith('CMGT VEHICLE '))!.slice('CMGT VEHICLE '.length));
    expect(verdict.lost.phase).toBeDefined();
    expect(verdict.checks.staysInReach).toBe(false);
    expect(h.outcome.failure).toMatch(/staysInReach/);
    expect(h.logs.some(l => /"skipped":"vehicle lost in/.test(l))).toBe(true);
  });
  it('flies the plane course in a circle: the roll ends once airborne, then climb, turn, cruise and approach all hold right stick', async () => {
    const h = vehicleHarness({ drives: true, kind: 'plane', scripted: true });
    await h.run('vehicle_demo_1_1');
    const inputs = h.sent.map((m: any) => [m.x, m.y, m.jump, m.ticks]);
    expect(inputs.slice(0, 4)).toEqual([[0, 0, true, 120], [0, -1, true, 30], [-1, 0, false, 60], [-0.5, 0, false, 40]]);
    expect(inputs.filter(i => i[0] === -0.5 && i[1] === 0.35)).toHaveLength(15);
  });
  it('fails naming what did not happen when the vehicle does not move', async () => {
    const h = vehicleHarness({ drives: false, kind: 'plane' });
    await h.run('vehicle_demo_1_1');
    expect(h.outcome.failure).toMatch(/forwardMoves.*reverseMoves.*turns/);
  });
});

/**
 * A driven train on the fake harness: the model is placed (the placement hook
 * answers), a car of the route carries the rail runtime's dynamic properties,
 * and the stick hook (`craftmatic:flight_input`, `y` along the train) drives it
 * with the rail step's shape: traction 3 blocks/s², brake 6 against the
 * motion, reverse only from rest, a stop at an open line's ends.
 */
function trainHarness(opts: { responds: boolean; closed: boolean; start?: number }) {
  const origin: Vec3 = { x: 100, y: -60, z: 200 };
  const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const scriptSubs: Array<(ev: any) => void> = [];
  const logs: string[] = [];
  const registered = new Map<string, (t: any) => Promise<void>>();
  const length = 40;
  const plan: GametestPlan = { ...PLAN, doorways: [], vehiclesOnly: true,
    trains: [{ label: 'Line', route: 0, carTypes: ['craftmatic:c_demo_car'], closed: opts.closed, length, at: { x: 5, y: 1, z: 4 } }] };
  const props = new Map<string, number>([['craftmatic:coaster_route', 0], ['craftmatic:coaster_distance', opts.start ?? 20], ['craftmatic:coaster_speed', 0], ['craftmatic:coaster_direction', 1]]);
  const riders: any[] = [];
  const car: any = { id: 'car0', typeId: 'craftmatic:c_demo_car', location: add(origin, { x: 8, y: 2, z: 7 }), getDynamicProperty: (k: string) => props.get(k),
    getComponent: () => ({ getRiders: () => riders, addRider: (p: any) => { riders.push(p); return true; }, ejectRiders: () => { riders.length = 0; } }) };
  let stick = 0, stickTicks = 0, v = 0;
  const step = (): void => {
    const y = stickTicks > 0 ? (stickTicks--, stick) : 0;
    if (!opts.responds) return;
    const dt = 0.05;
    if (y && (v === 0 || Math.sign(y) === Math.sign(v))) v += y * 3 * dt;
    else if (y) { const next = v - Math.sign(v) * 6 * dt * Math.abs(y); v = Math.sign(next) !== Math.sign(v) ? 0 : next; }
    else if (v) { const next = v - Math.sign(v) * 0.3 * dt; v = Math.sign(next) !== Math.sign(v) ? 0 : next; }
    v = Math.max(-12, Math.min(12, v));
    let d = props.get('craftmatic:coaster_distance')! + v * dt;
    if (opts.closed) d = ((d % length) + length) % length;
    else if (d <= 1 || d >= length - 1) { d = Math.max(1, Math.min(length - 1, d)); v = 0; }
    props.set('craftmatic:coaster_distance', d);
    props.set('craftmatic:coaster_speed', Math.abs(v));
    props.set('craftmatic:coaster_direction', v < 0 ? -1 : 1);
  };
  const sim: any = { name: 'cmgt_t', location: { x: 0, y: 0, z: 0 }, teleport(at: Vec3) { this.location = { ...at }; }, lookAtEntity() {}, interactWithEntity() { riders.push(sim); return true; } };
  const dim = { getEntities: (q: any) => (!q.type || q.type === car.typeId ? [car] : []), runCommand: () => ({ successCount: 1 }) };
  const outcome: { succeeded?: boolean; failure?: string } = {};
  const test = {
    worldBlockLocation: (r: Vec3) => add(origin, r), worldLocation: (r: Vec3) => add(origin, r),
    relativeLocation: (w: Vec3) => ({ x: w.x - origin.x, y: w.y - origin.y, z: w.z - origin.z }),
    getBlock: (r: Vec3) => ({ typeId: r.y === 0 ? 'minecraft:smooth_stone' : 'minecraft:air' }), getTestDirection: () => 'South',
    getDimension: () => dim, idle: async (n = 1) => { for (let i = 0; i < n; i++) step(); }, spawnSimulatedPlayer: () => sim,
    succeed: () => { outcome.succeeded = true; }, fail: (m: string) => { outcome.failure = m; },
  };
  const sent: any[] = [];
  const builder: any = new Proxy({}, { get: () => () => builder });
  const mc = {
    GameMode: { Survival: 'Survival' },
    world: { afterEvents: { playerSpawn: { subscribe() {} }, playerInteractWithEntity: { subscribe() {} }, entityHitEntity: { subscribe() {} } }, getDimension: () => dim, getPlayers: () => [] },
    system: {
      afterEvents: { scriptEventReceive: { subscribe: (fn: (ev: any) => void) => scriptSubs.push(fn) } },
      runTimeout: (fn: () => void) => fn(),
      sendScriptEvent: (id: string, message: string) => {
        const m = JSON.parse(message);
        if (id === GT_PLACE_EVENT) { for (const fn of scriptSubs) fn({ id: 'craftmatic_gt:placed', message: JSON.stringify({ player: m.player, entities: 3 }) }); return; }
        sent.push({ ...m, id, car: m.id });
        if (id === 'craftmatic:flight_input') { stick = m.y; stickTicks = m.ticks; }
      },
    },
  };
  const gt = { registerAsync: (_c: string, name: string, fn: (t: any) => Promise<void>) => { registered.set(name, fn); return builder; } };
  const warn = console.warn;
  console.warn = (s2: string) => { if (!s2.startsWith('CMGT_PAD')) logs.push(s2); };
  try { gametestRuntime({ mc, gt }, plan, arenaSize(plan.dims), GT_MARGIN, judgeWalk, outcomeMatches, judgeFigureTrack, { summarise: summariseVehiclePhase, layout: GT_VEHICLE_LAYOUT, inputEvent: 'craftmatic:flight_input' }); } finally { console.warn = warn; }
  const run = async (name: string) => {
    console.warn = (s2: string) => { if (!s2.startsWith('CMGT_PAD')) logs.push(s2); };
    try { await registered.get(name)!(test); } finally { console.warn = warn; }
  };
  return { registered, logs, run, outcome, sent };
}

describe('the train test', () => {
  it('registers one train test per driven route', () => {
    expect([...trainHarness({ responds: true, closed: false }).registered.keys()]).toEqual(['train_demo_1_1']);
  });
  it('drives an open line through the stick hook: parks, goes, brakes, reverses and stops at the buffer', async () => {
    const h = trainHarness({ responds: true, closed: false });
    await h.run('train_demo_1_1');
    expect(h.sent.every((m: any) => m.id === 'craftmatic:flight_input' && m.id !== undefined)).toBe(true);
    expect(h.sent.map((m: any) => [m.y, m.ticks, m.car])).toEqual([[1, 40, 'car0'], [-1, 60, 'car0'], [-1, 60, 'car0'], [0, 40, 'car0'], [1, 400, 'car0']]);
    const verdict = JSON.parse(h.logs.find(l => l.startsWith('CMGT TRAIN '))!.slice('CMGT TRAIN '.length));
    expect(verdict.checks).toEqual({ mounted: true, parks: true, drives: true, brakesToStop: true, reverses: true, stopsAtBuffer: true });
    expect(h.outcome.succeeded).toBe(true);
  });
  it('drives a circuit across its seam without counting a lap as a jump', async () => {
    const h = trainHarness({ responds: true, closed: true });
    await h.run('train_demo_1_1');
    const verdict = JSON.parse(h.logs.find(l => l.startsWith('CMGT TRAIN '))!.slice('CMGT TRAIN '.length));
    expect(verdict.checks.stopsAtBuffer).toBeUndefined();
    expect(verdict.pass).toBe(true);
  });
  it('drives the other way when the train was placed against the buffer ahead', async () => {
    const h = trainHarness({ responds: true, closed: false, start: 39 });
    await h.run('train_demo_1_1');
    expect(h.sent.map((m: any) => m.y)).toEqual([1, -1, 1, 1, 0, -1]);
    const verdict = JSON.parse(h.logs.find(l => l.startsWith('CMGT TRAIN '))!.slice('CMGT TRAIN '.length));
    expect(verdict.pass).toBe(true);
  });
  it('fails naming what did not happen when the train ignores the stick', async () => {
    const h = trainHarness({ responds: false, closed: false });
    await h.run('train_demo_1_1');
    expect(h.outcome.failure).toMatch(/drives.*reverses/);
  });
});
