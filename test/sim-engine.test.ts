/**
 * The headless simulator (web/src/sim, docs/sim-engine.md): its engine pieces
 * against the device facts they encode, a whole add-on built in memory and
 * run through the script host, and - where this machine has them - the
 * 2026-09-29 regression packs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createZip } from '../web/src/engine/zip-utils.js';
import { compileCondition } from '../web/src/sim/world/molang.js';
import { isIntegerLiteral, parseJsonWithLiterals } from '../web/src/sim/pack/json.js';
import { EntityDefinitions } from '../web/src/sim/entity/definitions.js';
import { SimEntity } from '../web/src/sim/entity/entity.js';
import { BlockTypes } from '../web/src/sim/world/block-types.js';
import { rewriteModule } from '../web/src/sim/script-host/module-loader.js';
import { Simulation } from '../web/src/sim/core/simulation.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { tap } from '../web/src/sim/input/touch.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';
import { allQuirks, quirk, quirkValue } from '../web/src/sim/quirks/registry.js';
import { PLAYER_HEIGHT as SIM_PLAYER_HEIGHT, PLAYER_WIDTH as SIM_PLAYER_WIDTH, STEP_HEIGHT as SIM_STEP_HEIGHT, tickPlayer, NO_INPUT } from '../web/src/sim/physics/body.js';
import { PLAYER_WIDTH_BLOCKS } from '../web/src/engine/addon-scale.js';
import { PLAYER_HEIGHT_BLOCKS } from '../web/src/engine/lego-scale.js';
import { STEP16 } from '../web/src/engine/bedrock-collider-scale.js';
import { FLAT_GROUND_Y } from '../web/src/sim/world/voxel-world.js';
import { REGRESSIONS } from '../web/src/sim/adapters/craftmatic/regressions.js';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';

const enc = new TextEncoder();
const entityJson = (identifier: string, components: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format_version: '1.26.30', 'minecraft:entity': { description: { identifier, ...(extra['description'] as object ?? {}) }, components, ...(extra['groups'] ? { component_groups: extra['groups'] } : {}), ...(extra['events'] ? { events: extra['events'] } : {}) } });

/** A tiny add-on: a manifest, two scripts that both write the action bar, a seat entity, a wall block with no selection box. */
async function miniAddon(scripts: Record<string, string>, entities: Record<string, string> = {}, blocks: Record<string, unknown> = {}): Promise<Uint8Array> {
  const manifest = { format_version: 2, header: { name: 'mini', uuid: '00000000-0000-0000-0000-000000000001', version: [1, 0, 0] }, modules: [{ type: 'data', uuid: '00000000-0000-0000-0000-000000000002', version: [1, 0, 0] }, { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: '00000000-0000-0000-0000-000000000003', version: [1, 0, 0] }], dependencies: [{ module_name: '@minecraft/server', version: '2.9.0' }] };
  const files = [{ name: 'mini_BP/manifest.json', data: enc.encode(JSON.stringify(manifest)) }];
  for (const [p, t] of Object.entries(scripts)) files.push({ name: `mini_BP/scripts/${p}`, data: enc.encode(t) });
  for (const [p, t] of Object.entries(entities)) files.push({ name: `mini_BP/entities/${p}`, data: enc.encode(t) });
  for (const [p, t] of Object.entries(blocks)) files.push({ name: `mini_BP/blocks/${p}`, data: enc.encode(JSON.stringify(t)) });
  return createZip(files);
}

describe('the physics is the walk preview\'s, and the Minecraft facts agree with the exporter\'s', () => {
  it('the player box and the step are the exporter\'s numbers', () => {
    expect(SIM_PLAYER_WIDTH).toBe(PLAYER_WIDTH_BLOCKS);
    expect(SIM_PLAYER_HEIGHT).toBe(PLAYER_HEIGHT_BLOCKS);
    expect(SIM_STEP_HEIGHT).toBe(STEP16 / 16);
  });
  it('a player in the air falls to a floor and stands on it', () => {
    const floor = { solidsNear: () => [{ x0: -5, y0: -1, z0: -5, x1: 5, y1: 0, z1: 5 }] };
    let s = { x: 0, y: 3, z: 0, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 };
    for (let i = 0; i < 40; i++) s = tickPlayer(floor, s, NO_INPUT).state;
    expect(s.y).toBeCloseTo(0, 6);
    expect(s.onGround).toBe(true);
  });
  it('slow falling falls about four times slower over the same drop', () => {
    const none = { solidsNear: () => [] };
    const fall = (slowFalling: boolean): number => { let s = { x: 0, y: 100, z: 0, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 }; for (let i = 0; i < 40; i++) s = tickPlayer(none, s, { ...NO_INPUT, slowFalling }).state; return 100 - s.y; };
    expect(fall(false) / fall(true)).toBeGreaterThan(4);
  });
});

describe('world', () => {
  it('Molang permutation conditions', () => {
    const c = compileCondition("q.block_state('craftmatic:lo') == 3 && q.block_state('craftmatic:hi') == 16");
    expect(c({ 'craftmatic:lo': 3, 'craftmatic:hi': 16 })).toBe(true);
    expect(c({ 'craftmatic:lo': 2, 'craftmatic:hi': 16 })).toBe(false);
    expect(() => compileCondition('math.sin(1)')).toThrow();
  });
  it('a collision box may be an array (a floor + wall form); selection_box false passes rays', () => {
    const types = new BlockTypes();
    types.addDefinition('f.json', { 'minecraft:block': { description: { identifier: 'test:f', states: { 'test:lo': { values: { min: 0, max: 15 } } } }, components: { 'minecraft:collision_box': [{ origin: [-8, 0, -8], size: [16, 4, 16] }, { origin: [0, 4, -8], size: [8, 12, 16] }], 'minecraft:selection_box': false } } });
    const shape = types.shape('test:f', {});
    expect(shape.collision).toHaveLength(2);
    expect(shape.collision[1]).toEqual({ x0: 0.5, y0: 0.25, z0: 0, x1: 1, y1: 1, z1: 1 });
    expect(shape.selection).toHaveLength(0);
  });
});

describe('entities load as the game loads them', () => {
  it('refuses a digit identifier and a dropped component, and drops a float property written as an integer', () => {
    const d = new EntityDefinitions();
    expect(d.load('a.json', entityJson('x:10303_cart', {}))).toBeUndefined();
    expect(d.load('b.json', entityJson('x:ball', { 'minecraft:pushable': {} }))).toBeUndefined();
    const refused = d.load('c.json', JSON.stringify({ 'minecraft:entity': { description: { identifier: 'x:door', properties: { 'x:angle': { type: 'float', range: [0.0, 90.0], default: 0 } } }, components: {} } }));
    expect(refused?.propertiesRefused).toBe(true);
    const ok = d.load('d.json', '{"minecraft:entity":{"description":{"identifier":"x:door2","properties":{"x:angle":{"type":"float","range":[0.0,90.0],"default":0.0}}},"components":{}}}');
    expect(ok?.propertiesRefused).toBe(false);
    expect(d.contentLog.join('\n')).toMatch(/may not begin with a digit[\s\S]*pushable[\s\S]*does not match the specified type 'float'/);
    expect(isIntegerLiteral(parseJsonWithLiterals('{"a":0}').numberLiterals.get('/a'))).toBe(true);
    expect(isIntegerLiteral(parseJsonWithLiterals('{"a":0.0}').numberLiterals.get('/a'))).toBe(false);
  });
  it('removing a component group removes its components even where the base declares them', () => {
    const d = new EntityDefinitions();
    const def = d.load('e.json', entityJson('x:car', { 'minecraft:rideable': { seat_count: 1 } }, { groups: { g: { 'minecraft:rideable': { seat_count: 2 } } }, events: { add: { add: { component_groups: ['g'] } }, drop: { remove: { component_groups: ['g'] } } } }))!;
    const e = new SimEntity('x:car', 'minecraft:overworld', { x: 0, y: 0, z: 0 }, 0, def);
    e.triggerEvent('add');
    expect(e.rideable()?.seatCount).toBe(2);
    e.triggerEvent('drop');
    expect(e.rideable()).toBeUndefined();
    expect(quirk('group-removal-strips-base').simulated).toBe('modelled');
  });
  it('addRider refuses in the spawn tick, then seats; the seat\'s +Z is the nose and the eye is 1.12 over it', () => {
    const d = new EntityDefinitions();
    const def = d.load('s.json', entityJson('x:seat', { 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: [0, 0.5, 1] } } }))!;
    const seat = new SimEntity('x:seat', 'minecraft:overworld', { x: 0, y: 0, z: 0 }, 10, def);
    seat.rotation.y = 90;
    const p = new SimEntity('minecraft:player', 'minecraft:overworld', { x: 3, y: 0, z: 0 }, 0, undefined, true);
    expect(seat.addRider(p, 10)).toEqual({ ok: false, why: 'spawn-tick' });
    expect(seat.addRider(p, 11)).toEqual({ ok: true });
    // Yaw 90 faces -X: the nose offset (z 1) lands at x -1; the eye 1.12 over the seat is the feet 1.12 - 1.62 lower.
    expect(p.location.x).toBeCloseTo(-1, 9);
    expect(p.location.y).toBeCloseTo(0.5 + quirkValue('rider-eye-above-seat', 'eyeAboveSeatBlocks') - 1.62, 9);
  });
});

describe('the script host', () => {
  it('rewrites imports and exports for the shared context', () => {
    const r = rewriteModule("import { world, system as s } from '@minecraft/server';\nimport './other.js';\nexport function f() {}\nconst x = 1;\nexport { x as y };");
    expect(r.body).toContain('const { world, system: s } = __import("@minecraft/server");');
    expect(r.body).toContain('__import("./other.js");');
    expect(r.body).toContain('__exports["f"] = f;');
    expect(r.body).toContain('__exports["y"] = x;');
  });

  it('loads every script together, names the script behind each line, records unmodelled API, and catches an action bar taken over', async () => {
    const bytes = await miniAddon({
      'main.js': "import './a.js';\nimport './b.js';\n",
      'a.js': "import { world, system } from '@minecraft/server';\nsystem.runTimeout(() => { for (const p of world.getAllPlayers()) p.onScreenDisplay.setActionBar('Hint from A'); }, 5);\n",
      'b.js': "import { world, system } from '@minecraft/server';\nsystem.runTimeout(() => { for (const p of world.getAllPlayers()) { p.onScreenDisplay.setActionBar('HUD from B'); try { p.applyDamage(1); } catch {} if (p.someMemberBedrockLacks !== undefined) throw new Error('should be undefined'); } }, 7);\n",
    });
    const addon = await readAddon(bytes, 'mini');
    const r = await runScenario({ name: 'stolen', steps: [{ kind: 'wait', ticks: 20 }] }, [addon], { keepTimeline: true });
    const bars = r.timeline!.filter(e => e.kind === 'actionbar');
    expect(bars.map(b => b.source)).toEqual(['scripts/a.js', 'scripts/b.js']);
    expect(r.violations.map(v => v.invariant)).toContain('actionbar-not-stolen');
    expect(r.unmodelled.map(u => u.member)).toEqual(['Player.applyDamage']);
    expect(r.status).toBe('fail');
    expect(r.violations.some(v => v.invariant === 'no-script-error')).toBe(false);
  });

  it('a tap passes a block with no selection box and hits the seat behind it; a stone wall hides it', async () => {
    const seat = entityJson('x:seat', { 'minecraft:collision_box': { width: 1, height: 0.6 }, 'minecraft:physics': { has_gravity: false, has_collision: false } });
    const glassless = { 'minecraft:block': { description: { identifier: 'x:collider' }, components: { 'minecraft:collision_box': true, 'minecraft:selection_box': false } } };
    const sim = new Simulation();
    sim.loadAddon(await readAddon(await miniAddon({ 'main.js': '' }, { 'seat.json': seat }, { 'c.json': glassless }), 'mini'));
    const p = sim.addPlayer('Child', { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 });
    const target = sim.engine.spawnEntity('x:seat', 'overworld', { x: 3.5, y: FLAT_GROUND_Y + 1, z: 0.5 });
    const w = sim.engine.dimension('overworld');
    await sim.run(2);
    w.setPermutation(2, FLAT_GROUND_Y + 1, 0, sim.host.resolvePermutation('x:collider'));
    expect(tap(sim.engine, p, target).entity).toBe(target);
    w.setPermutation(2, FLAT_GROUND_Y + 1, 0, sim.host.resolvePermutation('minecraft:stone'));
    const r = tap(sim.engine, p, target);
    expect(r.entity).toBeUndefined();
    expect(r.blockedBy).toMatch(/minecraft:stone/);
  });

  it('getBlock outside the loaded area is undefined, never air', async () => {
    const bytes = await miniAddon({ 'main.js': "import { world, system } from '@minecraft/server';\nsystem.run(() => { const d = world.getDimension('overworld'); console.warn('near ' + (d.getBlock({ x: 0, y: -61, z: 0 })?.typeId) + ' far ' + (d.getBlock({ x: 5000, y: -61, z: 0 }) === undefined)); });\n" });
    const r = await runScenario({ name: 'unloaded', steps: [{ kind: 'wait', ticks: 3 }] }, [await readAddon(bytes, 'mini')], { keepTimeline: true });
    expect(r.timeline!.find(e => e.kind === 'console')?.text).toBe('[warn] near minecraft:grass_block far true');
  });
});

describe('the quirk registry', () => {
  it('names its evidence for every fact, and says what it cannot simulate', () => {
    for (const q of allQuirks()) { expect(q.evidence.length).toBeGreaterThan(10); if (q.simulated === 'partial') expect(q.gap).toBeTruthy(); }
    expect(allQuirks().some(q => q.simulated === 'device-only')).toBe(true);
    expect(() => quirk('no-such-fact' as never)).toThrow();
  });
});

// The device-bug regression set, where this machine has the packs the device ran (the output folders are local).
const regressionPacks = REGRESSIONS.every(c => existsSync(c.oldPack));
describe.skipIf(!regressionPacks)('the 2026-09-29 regression set reproduces on the packs the device ran', () => {
  for (const c of REGRESSIONS) {
    it(`${c.id}${c.limits ? ' (known not reproduced)' : ''}`, async () => {
      const b = readFileSync(c.oldPack);
      const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, c.oldPack);
      const pack = readCraftmaticPack(addon)!;
      const r = await runScenario(c.scenario(pack), [addon], { handlers: craftmaticHandlers(pack, addon) });
      const j = c.judge(r, pack);
      // A case whose device situation the simulator cannot build says so in `limits`; it must not claim a reproduction.
      expect(j.reproduced).toBe(!c.limits);
      if (c.expectNew === 'reproduce-as-model') expect(j.attribution).toBe('model');
    });
  }
});
