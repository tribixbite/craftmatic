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
import { lookAt, tap } from '../web/src/sim/input/touch.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';
import { allQuirks, quirk, quirkValue } from '../web/src/sim/quirks/registry.js';
import { PLAYER_HEIGHT as SIM_PLAYER_HEIGHT, PLAYER_WIDTH as SIM_PLAYER_WIDTH, STEP_HEIGHT as SIM_STEP_HEIGHT, tickPlayer, NO_INPUT } from '../web/src/sim/physics/body.js';
import { PLAYER_WIDTH_BLOCKS } from '../web/src/engine/addon-scale.js';
import { PLAYER_HEIGHT_BLOCKS } from '../web/src/engine/lego-scale.js';
import { STEP16 } from '../web/src/engine/bedrock-collider-scale.js';
import { FLAT_GROUND_Y } from '../web/src/sim/world/voxel-world.js';
import { REGRESSIONS, regressionVerdict } from '../web/src/sim/adapters/craftmatic/regressions.js';
import { craftmaticHandlers, figureMode } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { FLOOR_LEVEL_TOLERANCE, floorLevelInRecordedCell, judgeSide, onRunout } from '../web/src/sim/adapters/craftmatic/play.js';
import { relayRounding } from '../web/src/engine/bedrock-collider-scale.js';
import { findApproach } from '../web/src/sim/scenario/approach.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { swapTreeRuntimes } from '../web/src/sim/adapters/craftmatic/runtime-swap.js';
import { extractJsonAfter } from '../web/src/sim/pack/script-config.js';
import { ESCAPE_OPTIONS } from '../web/src/engine/collider-form.js';
import { firstPersonSnapshot } from '../web/src/sim/adapters/craftmatic/snapshot.js';
import type { AddonAppearance } from '../web/src/sim/adapters/craftmatic/appearance.js';

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
    // Declared at origin x 0, size 8: the device stands it on the LOW-x half (x is mirrored,
    // quirk block-collision-x-mirrored, Pixel GameTest 2026-09-30).
    expect(shape.collision[1]).toEqual({ x0: 0, y0: 0.25, z0: 0, x1: 0.5, y1: 1, z1: 1 });
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
  it('a seat on a scaled entity is scaled with it and the eye offset is not (quirk seat-scales-with-entity, Saga 30k: 76286 at 200 %)', () => {
    const d = new EntityDefinitions();
    // 76286's shipped 200 % group (packs-78e06246): the seat written pre-scaled under scale 2.
    const def = d.load('m.json', entityJson('x:milano', { 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: [0, 4.58, 3.6] } } },
      { groups: { 'craftmatic:size_200': { 'minecraft:scale': { value: 2 }, 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: [0, 10.28, 7.2] } } } }, events: { 'craftmatic:size_200': { add: { component_groups: ['craftmatic:size_200'] } } } }))!;
    const ship = new SimEntity('x:milano', 'minecraft:overworld', { x: 0, y: 0, z: 0 }, 10, def);
    const p = new SimEntity('minecraft:player', 'minecraft:overworld', { x: 3, y: 0, z: 0 }, 0, undefined, true);
    expect(ship.addRider(p, 11)).toEqual({ ok: true });
    // 100 %: the eye at (0, 5.7, 3.6), as the Saga read it (`r27-strip.jpg`).
    expect(p.headLocation().y).toBeCloseTo(5.7, 9);
    expect(p.location.z).toBeCloseTo(3.6, 9);
    ship.triggerEvent('craftmatic:size_200');
    ship.placeRiders();
    // 200 %: the device read the eye at (0, 21.68, 14.4) = 2 x the declared seat + 1.12 (`r28-strip.jpg`).
    expect(ship.seatWorld(0)).toEqual({ x: 0, y: 20.56, z: 14.4 });
    expect(p.headLocation().y).toBeCloseTo(21.68, 9);
    expect(p.location.z).toBeCloseTo(14.4, 9);
    expect(quirk('seat-scales-with-entity').simulated).toBe('modelled');
  });
});

describe('first-person entity snapshots use the device draw cull', () => {
  const appearance: AddonAppearance = {
    byType: new Map([['x:box', {
      typeId: 'x:box', cubeCount: 1,
      bones: [{ name: 'body', pivot: [0, 0, 0] }],
      groups: [{ colorHex: 0xff0000, alpha: 1, ldrawColor: 4, cubes: [{ bone: 'body', origin: [-32, -32, -32], size: [64, 64, 64] }] }],
    }]]),
    cubeCount: 1, materialMode: 'classic', notes: [],
  };
  const picture = async (box: { width: number; height: number }, at: { x: number; y: number; z: number }) => {
    const sim = new Simulation();
    sim.loadAddon(await readAddon(await miniAddon({ 'main.js': '' }, { 'box.json': entityJson('x:box', { 'minecraft:collision_box': box, 'minecraft:physics': { has_gravity: false, has_collision: false } }) }), 'snapshot'));
    const player = sim.addPlayer('Camera', { x: 0, y: 0, z: 0 });
    sim.engine.spawnEntity('x:box', 'overworld', at);
    lookAt(player, { x: at.x, y: at.y, z: at.z });
    const withActor = firstPersonSnapshot(sim.engine, appearance, player, { width: 32, height: 32 });
    const empty = firstPersonSnapshot(sim.engine, { ...appearance, byType: new Map() }, player, { width: 32, height: 32 });
    return { drawn: withActor.some((v, i) => v !== empty[i]), eye: player.headLocation() };
  };

  it('draws a small-box actor through 64 blocks from the camera to its root, then culls it', async () => {
    const y = SIM_PLAYER_HEIGHT * 0.9;
    expect((await picture({ width: 0.1, height: 0.1 }, { x: 0, y, z: 63 })).drawn).toBe(true);
    expect((await picture({ width: 0.1, height: 0.1 }, { x: 0, y, z: 65 })).drawn).toBe(false);
  });

  it('uses full 3-D camera-to-root distance, including height', async () => {
    const first = await picture({ width: 0.1, height: 0.1 }, { x: 0, y: 0, z: 1 });
    expect((await picture({ width: 0.1, height: 0.1 }, { x: 0, y: first.eye.y + 65, z: 1 })).drawn).toBe(false);
  });

  it('caps a large collision box at the measured 70-block actor ceiling', async () => {
    const y = SIM_PLAYER_HEIGHT * 0.9;
    expect((await picture({ width: 3.5, height: 2.5 }, { x: 0, y, z: 69 })).drawn).toBe(true);
    expect((await picture({ width: 3.5, height: 2.5 }, { x: 0, y, z: 71 })).drawn).toBe(false);
  });

  it('renders the actual actor scale while keeping its placement and camera-to-root culling fixed', async () => {
    const render = async (scale: number, geometryScale: number) => {
      const sim = new Simulation();
      sim.loadAddon(await readAddon(await miniAddon({ 'main.js': '' }, { 'box.json': entityJson('x:box', {
        'minecraft:collision_box': { width: 3.5, height: 2.5 }, 'minecraft:scale': { value: scale },
        'minecraft:physics': { has_gravity: false, has_collision: false },
      }) }), 'scaled-snapshot'));
      const player = sim.addPlayer('Camera', { x: 0, y: 0, z: 0 });
      const at = { x: 1, y: 3, z: 12 };
      const entity = sim.engine.spawnEntity('x:box', 'overworld', at);
      entity.rotation.y = 90;
      lookAt(player, at);
      const base = appearance.byType.get('x:box')!;
      const imageAppearance: AddonAppearance = { ...appearance, byType: new Map([['x:box', {
        ...base,
        bones: [{ name: 'body', pivot: [8 * geometryScale, 0, 0], rotation: [12, 7, 18] }],
        groups: base.groups.map(group => ({ ...group, cubes: group.cubes.map(cube => ({
          ...cube,
          origin: cube.origin.map(v => v * geometryScale) as [number, number, number],
          size: cube.size.map(v => v * geometryScale) as [number, number, number],
          rotation: [5, -11, 8] as [number, number, number], pivot: [0, 8 * geometryScale, 0] as [number, number, number],
        })) })),
      }]]) };
      return firstPersonSnapshot(sim.engine, imageAppearance, player, { width: 64, height: 64 });
    };
    const scaledActor = await render(2, 1);
    expect(scaledActor).toEqual(await render(1, 2));
    expect(scaledActor).not.toEqual(await render(1, 1));
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

  it('finds a standing spot for a part lying on the floor the child stands on (31141 Turnable 1, 2026-09-30 triage)', async () => {
    // A flat part at foot level: its pick box is 0.2 tall on the ground. The approach used to try floors only a
    // little under eye level with the pick point - all of them under the ground here - and found no spot at all.
    const plate = entityJson('x:plate', { 'minecraft:custom_hit_test': { hitboxes: [{ width: 0.9, height: 0.2, pivot: [0, 0.1, 0] }] }, 'minecraft:physics': { has_gravity: false, has_collision: false } });
    const sim = new Simulation();
    sim.loadAddon(await readAddon(await miniAddon({ 'main.js': '' }, { 'plate.json': plate }), 'mini'));
    const p = sim.addPlayer('Child', { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 });
    const target = sim.engine.spawnEntity('x:plate', 'overworld', { x: 12.5, y: FLAT_GROUND_Y, z: 0.5 });
    await sim.run(2);
    const spot = findApproach(sim.engine, p, target);
    expect(spot).toBeDefined();
    expect(spot!.feet.y).toBeCloseTo(FLAT_GROUND_Y, 6);
    // From there the tap picks it.
    p.location = { ...spot!.feet };
    expect(tap(sim.engine, p, target).entity).toBe(target);
    // A child told to step out of a doorway never picks a spot the doorway holds (`notWhere`): every spot
    // within 2 blocks of the part refused, the next is farther out.
    const out = findApproach(sim.engine, p, target, undefined, [], { notWhere: f => Math.hypot(f.x - 12.5, f.z - 0.5) < 2 });
    expect(out).toBeDefined();
    expect(Math.hypot(out!.feet.x - 12.5, out!.feet.z - 0.5)).toBeGreaterThanOrEqual(2);
    expect(findApproach(sim.engine, p, target, undefined, [], { notWhere: () => true })).toBeUndefined();
  });

  it('a rider that gets off is set on the floor one block to -z, then +z, then a diagonal; walled in, at the seat 0.2 up (quirk dismount-free-spot, Pixel GameTest 2026-09-30)', async () => {
    // The moulded seat's shape: rider 0.3 under the seat entity. Sunk: the seat entity AT the ground top (run 2 `sunk03`).
    const seat = entityJson('x:seat', { 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: [0, -0.3, 0] } }, 'minecraft:physics': { has_gravity: false, has_collision: false } });
    const sim = new Simulation();
    sim.loadAddon(await readAddon(await miniAddon({ 'main.js': '' }, { 'seat.json': seat }), 'mini'));
    const w = sim.engine.dimension('overworld');
    const stone = sim.host.resolvePermutation('minecraft:stone');
    const G = FLAT_GROUND_Y;
    const wall = (x: number, z: number): void => { w.setPermutation(x, G, z, stone); w.setPermutation(x, G + 1, z, stone); };
    // Seat A open (sunk); seat B with -z walled; seat C with +-z walled; seat D walled on all eight sides.
    const seats = [0, 10, 20, 30].map(x => sim.engine.spawnEntity('x:seat', 'overworld', { x: x + 0.5, y: G, z: 0.5 }));
    wall(10, -1); wall(20, -1); wall(20, 1);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) wall(30 + dx!, dz!);
    const players = seats.map((_, i) => sim.addPlayer(`Child${i}`, { x: i * 10 + 0.5, y: G, z: 3.5 }));
    await sim.run(2);
    seats.forEach((s, i) => expect(s.addRider(players[i]!, sim.engine.tick).ok).toBe(true));
    await sim.run(1);
    for (const p of players) sim.controls.set(p.id, { sneak: true });
    await sim.run(1);
    for (const p of players) { sim.controls.set(p.id, { sneak: false }); expect(p.ridingOn).toBeUndefined(); }
    const at = (i: number) => ({ dx: players[i]!.location.x - seats[i]!.location.x, y: players[i]!.location.y, dz: players[i]!.location.z - seats[i]!.location.z });
    expect(at(0)).toEqual({ dx: 0, y: G, dz: -1 });
    expect(at(1)).toEqual({ dx: 0, y: G, dz: 1 });
    expect(at(2)).toEqual({ dx: 1, y: G, dz: -1 });
    expect(at(3).dx).toBe(0);
    expect(at(3).dz).toBe(0);
    expect(quirk('dismount-free-spot').simulated).toBe('partial');
  });

  it('a player teleported into a block falls through it, pushed sideways only where a side is free (quirk teleport-into-floor, Pixel GameTest 2026-09-30)', async () => {
    const sim = new Simulation();
    sim.loadAddon(await readAddon(await miniAddon({ 'main.js': '' }), 'mini'));
    const w = sim.engine.dimension('overworld');
    const stone = sim.host.resolvePermutation('minecraft:stone');
    const G = FLAT_GROUND_Y;
    // A 3 x 3 pad at x -1..1 and a single block at x 10, both one block over the ground.
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) w.setPermutation(x, G, z, stone);
    w.setPermutation(10, G, 0, stone);
    const centred = sim.addPlayer('Centred', { x: 0.5, y: G + 1 - 0.34, z: 0.5 });
    const edge = sim.addPlayer('Edge', { x: 11.0, y: G + 1 - 0.1, z: 0.5 });
    await sim.run(40);
    // Device (run1 QTP 2 and 16): the centred player ends at the pad's bottom, unmoved sideways (-0.66 from the target);
    // the edge player is pushed +x off the block (0.64 on the device) and lands on the ground under it.
    expect(centred.location.y).toBeCloseTo(G, 6);
    expect(centred.location.x).toBeCloseTo(0.5, 6);
    expect(edge.location.y).toBeCloseTo(G, 6);
    expect(edge.location.x - 11.0).toBeGreaterThan(0.3);
    expect(edge.location.x - 11.0).toBeLessThan(0.8);
    expect(quirk('teleport-into-floor').values?.['pushBlocksPerTick']).toBe(0.1);
  });

  it('lets a yielding status line be replaced at once, and still catches an instruction taken over', async () => {
    const bytes = await miniAddon({
      'main.js': "import './a.js';\nimport './b.js';\n",
      'a.js': "import { world, system } from '@minecraft/server';\nsystem.runTimeout(() => { for (const p of world.getAllPlayers()) p.onScreenDisplay.setActionBar('[Wand] 100 percent · done'); }, 5);\n",
      'b.js': "import { world, system } from '@minecraft/server';\nsystem.runTimeout(() => { for (const p of world.getAllPlayers()) p.onScreenDisplay.setActionBar('press Play'); }, 8);\n",
    });
    const run = async (yieldingLines?: RegExp[]) => runScenario({ name: 'y', steps: [{ kind: 'wait', ticks: 20 }], ...(yieldingLines ? { yieldingLines } : {}) }, [await readAddon(bytes, 'mini')]);
    expect((await run()).violations.map(v => v.invariant)).toContain('actionbar-not-stolen');
    expect((await run([/percent · done$/])).violations.map(v => v.invariant)).not.toContain('actionbar-not-stolen');
  });

  it('system.run from an event handler runs at the end of the same tick; from other code, in the next tick (Microsoft\'s contract)', async () => {
    const bytes = await miniAddon({
      'main.js': [
        "import { world, system } from '@minecraft/server';",
        "system.afterEvents.scriptEventReceive.subscribe(ev => { const at = system.currentTick; system.run(() => console.warn(ev.id + ' handler ' + at + ' ran ' + system.currentTick)); });",
        "system.runTimeout(() => { const at = system.currentTick; system.run(() => console.warn('timeout ' + at + ' ran ' + system.currentTick)); }, 3);",
      ].join('\n'),
    });
    const sim = new Simulation();
    await sim.loadAddonBytes(bytes, 'mini');
    sim.addPlayer();
    await sim.run(2);
    sim.engine.emit('scriptEventReceive', { id: 'test:ping', message: '' });
    await sim.run(4);
    const lines = sim.engine.timeline.of('console').map(e => e.text);
    expect(lines).toContain('[warn] test:ping handler 3 ran 3');
    expect(lines).toContain('[warn] timeout 3 ran 4');
  });

  it('fails a rider held in a control scheme whose drag turns only the camera, and passes the default scheme (Saga 30k: the Nimbus in player_relative ignored every drag)', async () => {
    const seat = entityJson('x:mount', { 'minecraft:collision_box': { width: 1, height: 0.6 }, 'minecraft:physics': { has_gravity: false, has_collision: false }, 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: [0, 0.5, 0], lock_rider_rotation: 181 } } });
    const ride = (scheme: string): string => "import { world, system } from '@minecraft/server';\n"
      + "system.runTimeout(() => { const p = world.getAllPlayers()[0]; const m = world.getDimension('overworld').spawnEntity('x:mount', p.location); system.runTimeout(() => { m.getComponent('minecraft:rideable').addRider(p); p.runCommand('controlscheme @s " + scheme + "'); }, 2); }, 2);\n";
    const run = async (scheme: string) => runScenario({ name: 'scheme', steps: [{ kind: 'wait', ticks: 12 }] }, [await readAddon(await miniAddon({ 'main.js': ride(scheme) }, { 'mount.json': seat }), 'mini')]);
    const held = await run('set player_relative');
    expect(held.violations.map(v => v.invariant)).toContain('rider-drag-reaches-look');
    expect((await run('set camera_relative')).violations.map(v => v.invariant)).toContain('rider-drag-reaches-look');
    expect((await run('clear')).violations.map(v => v.invariant)).not.toContain('rider-drag-reaches-look');
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

describe('historical regression replay inputs', () => {
  it('boards the lift car and replays a tap only from floor-level legal spots inside the recorded HUD cell', () => {
    const lift = REGRESSIONS.find(c => c.id === 'gabby-lift-cap')!;
    const liftStep = lift.scenario({ rides: { rides: [{ index: 0, kind: 'lift' }] } } as never).steps.find(s => s.kind === 'rideLift');
    expect(liftStep).toMatchObject({ kind: 'rideLift', on: 'car' });

    // 10326 Door 3 (30h) is replayed at the /tp echo exactly, inside the corridor's floor collider as the device
    // stood: no HUD-cell reconstruction (none of that cell's legal spots is at its height in any pack).
    const door = REGRESSIONS.find(c => c.id === 'door3-tap-10326')!;
    const doorScenario = door.scenario({} as never);
    const doorTap = doorScenario.steps.find(s => s.kind === 'tapPartFrom');
    expect(doorTap).toMatchObject({ feet: { x: 4.6, y: 0.2, z: 2.4 }, at: { x: 6.5, y: 1.2, z: 2.35 } });
    expect((doorTap as { recordedCell?: boolean }).recordedCell).toBeUndefined();
    expect(doorScenario.invariants).not.toContain('player-not-in-solid');

    const recorded = { x: 10.6, y: -59.8, z: -3.6 };
    const spot = (x: number, y: number, z: number) => ({ feet: { x, y, z }, aim: { x: 12, y: -58, z: -3 }, distance: 2 });
    const floor = floorLevelInRecordedCell([
      spot(11.01, -59.8, -3.4), // adjacent x cell: never a reconstruction of this HUD cell
      spot(10.65, -59.12, -3.55), // 0.68 higher in the same cell (10326's handrail band): not the device's pose
      spot(10.9, -59.1, -3.1), // a step up in the same cell: not the device's pose either
      spot(10.7, -59.8125, -3.5), // a plate top: the floor the device stood on
      spot(10.2, -59.75, -3.9),
    ], recorded);
    expect(floor.map(s => s.feet)).toEqual([{ x: 10.7, y: -59.8125, z: -3.5 }, { x: 10.2, y: -59.75, z: -3.9 }]);
    expect(FLOOR_LEVEL_TOLERANCE).toBeLessThan(0.68);
    expect(floorLevelInRecordedCell([spot(11.01, -59.8, -3.4)], recorded)).toEqual([]);
  });

  it('judges a regression: NOT TESTED fails, KNOWN-UNREPRODUCED passes only on a passing current pack', () => {
    const side = (reproduced: boolean, extra: { status?: string; untested?: string; attribution?: string } = {}) => ({ reproduced, evidence: 'e', status: extra.status ?? (reproduced ? 'fail' : 'pass'), ms: 1, ...extra });
    const pass = { expectNew: 'pass' as const };
    expect(regressionVerdict(pass, side(true), side(false))).toMatchObject({ verdict: 'OK', failing: false });
    expect(regressionVerdict(pass, side(true), side(true))).toMatchObject({ verdict: 'FAIL', failing: true });
    // An old pack that does not reproduce proves nothing unless the case knows why.
    expect(regressionVerdict(pass, side(false), side(false))).toMatchObject({ failing: true, notTested: true });
    const known = { ...pass, knownUnreproduced: true, limits: 'the device cadence is not modelled' };
    expect(regressionVerdict(known, side(false), side(false))).toMatchObject({ failing: false, known: true });
    expect(regressionVerdict(known, side(false), side(false)).verdict).toMatch(/^KNOWN-UNREPRODUCED/);
    expect(regressionVerdict(known, side(false), side(true))).toMatchObject({ failing: true, known: false });
    // A current pack whose run could not set up the device's conditions is NOT TESTED, never a pass.
    expect(regressionVerdict(pass, side(true), side(false, { untested: 'no floor-level spot' }))).toMatchObject({ failing: true, notTested: true });
    expect(regressionVerdict(pass, { error: 'missing' }, side(false))).toMatchObject({ failing: true, notTested: true });
  });
});

describe('the runtime swap (--runtime=tree)', () => {
  it('rebuilds a shipped figures.js from its own CONFIG with the current runtime, filling what an older config lacks', () => {
    // A figures.js as an older build shipped it: its CONFIG has the rides' set-down limits and no escape bounds.
    const config = { figureTypes: [], seatTypes: ['craftmatic:a_seat'], interactiveFamily: 'craftmatic_interactive', bodyHeights: {}, bodyHeight: 1.8,
      tuning: {}, seatSafety: { lift: 0.05, reach: 2, drop: 3 } };
    const old = ["import { world, system } from '@minecraft/server';", `const CONFIG = ${JSON.stringify(config)};`, '(function old() {})();', ''].join('\n');
    const files = new Map([['scripts/figures.js', new TextEncoder().encode(old)], ['scripts/other.js', new TextEncoder().encode('// untouched')]]);
    const addon = { source: 'fixture', packs: [{ kind: 'behavior' as const, folder: '', name: 'bp', uuid: '', version: [], scriptModules: {}, files }] };
    expect(swapTreeRuntimes(addon)).toEqual(['scripts/figures.js']);
    const text = new TextDecoder().decode(files.get('scripts/figures.js')!);
    expect(text).toContain('routeClear');
    expect((extractJsonAfter(text, 'const CONFIG') as typeof config & { seatSafety: { escape: unknown } }).seatSafety.escape).toEqual(ESCAPE_OPTIONS);
    expect(new TextDecoder().decode(files.get('scripts/other.js')!)).toBe('// untouched');
  });
});

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
      expect(j.untested).toBeUndefined();
      if (c.expectNew === 'reproduce-as-model') expect(j.attribution).toBe('model');
    });
  }
});

describe('craftmatic adapter judgements (simulator triage 2026-09-30)', () => {
  const ctx = () => {
    const notes: string[] = [], violations: string[] = [];
    return { notes, violations, c: { note: (t: string) => { notes.push(t); }, violate: (v: { message: string }) => { violations.push(v.message); }, state: {} as Record<string, unknown> } };
  };
  it('a doorway side fails on a stopped column only when no column from that side crosses (a child steers)', () => {
    const stop = { crossed: false, pending: { message: 'Door 1 column 3,4 from + side: stopped', evidence: {} } };
    const a = ctx();
    judgeSide(a.c, [stop, { crossed: true }]);
    expect(a.violations).toEqual([]);
    expect(a.notes[0]).toMatch(/another column from this side crosses/);
    const b = ctx();
    judgeSide(b.c, [stop, { crossed: false }]);
    expect(b.violations).toEqual(['Door 1 column 3,4 from + side: stopped; no column from this side crosses']);
  });
  it('the re-lay moves a wall by up to half a block at 150 percent, none at whole sizes', () => {
    expect([1, 1.5, 2, 3, 4].map(relayRounding)).toEqual([0, 0.5, 0, 0, 0]);
    expect(relayRounding(0.5)).toBe(0);
  });
  it('a slide seat past the chute foot, at its height, is on the run-out', () => {
    const r = { foot: { x: 0, y: 5, z: 0 }, end: { x: 0.45, y: 5, z: 0 } };
    expect(onRunout({ x: 0.2, y: 5, z: 0 }, r)).toBe(true);
    expect(onRunout({ x: -0.2, y: 5.3, z: 0 }, r)).toBe(false);
    expect(onRunout({ x: 0.2, y: 5.4, z: 0 }, r)).toBe(false);
  });
  it('reads a figure\'s life mode from the placement\'s record: only a source-seated one retakes', () => {
    const e = { dynamic: new Map<string, unknown>([['craftmatic:fig', JSON.stringify({ mode: 'seated' })]]) } as unknown as SimEntity;
    expect(figureMode(e)).toBe('seated');
    expect(figureMode({ dynamic: new Map() } as unknown as SimEntity)).toBeUndefined();
  });
});
