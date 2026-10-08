/**
 * The simulator's WORLD (package D, 2026-10-08): water as volumes and the
 * motion in it, bodies that meet (the soft push, collidable solids), vanilla
 * door and stair shapes, and the API fidelity a script meets on the device
 * (per-pack dynamic properties, numeric enums, read-only before-events).
 */
import { describe, expect, it } from 'vitest';
import { AIR_WORLD, simHost, solidBelow } from './_sim-host.js';
import { Simulation } from '../web/src/sim/core/simulation.js';
import { fixtureAddon } from '../web/src/sim/pack/fixture.js';
import { BlockTypes, doorPanel, stairBoxes } from '../web/src/sim/world/block-types.js';
import { liquidSurface, submersion } from '../web/src/sim/world/liquids.js';
import { PLAYER_DIMS, WATER_GRAVITY, playerBox, tickBody, tickPlayer, type PlayerState } from '../web/src/sim/physics/body.js';
import { pushBodies } from '../web/src/sim/physics/body-systems.js';
import { overlappingSolidPairs } from '../web/src/sim/scenario/world-invariants.js';
import { SERVER_TYPES } from '../web/src/sim/script-host/api-catalog.js';
import { enumObject } from '../web/src/sim/script-host/enums.js';
import { DynamicStore } from '../web/src/sim/entity/dynamic-store.js';
import { runScenario, tapReachOf } from '../web/src/sim/scenario/runner.js';
import { walkRoute } from '../web/src/sim/scenario/approach.js';
import type { Scenario } from '../web/src/sim/scenario/types.js';

const still = (x: number, y: number, z: number): PlayerState => ({ x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, sneaking: false, tick: 0 });

/** A pool: stone floor at y 0 (top 1), water source blocks y 1..3 over x, z in [-5, 5]. */
function poolHost() {
  const h = simHost({ terrain: solidBelow(1) });
  h.fill({ x: -5, y: 1, z: -5 }, { x: 5, y: 3, z: 5 }, 'minecraft:water');
  return h;
}

describe('water as volumes (quirks liquid-surface-height, liquid-motion)', () => {
  it('a source fills 8/9 of its cell; one under more water is full', () => {
    const h = poolHost(), w = h.engine.dimension('overworld');
    expect(liquidSurface(w, 0, 3, 0)).toBeCloseTo(3 + 8 / 9, 6);
    expect(liquidSurface(w, 0, 2, 0)).toBe(3);
    expect(liquidSurface(w, 0, 4, 0)).toBeUndefined();
    // A flowing level-4 block fills (8 - 4) / 9.
    h.setBlock(8, 1, 8, 'minecraft:water', { liquid_depth: 4 });
    expect(liquidSurface(w, 8, 1, 8)).toBeCloseTo(1 + 4 / 9, 6);
    // A 1.8-tall body on the pool floor is wholly under; one with its feet at 3 is under to 3.889: (3.889 - 3) / 1.8.
    expect(submersion(w, playerBox({ x: 0.5, y: 1, z: 0.5 }))).toBe(1);
    expect(submersion(w, playerBox({ x: 0.5, y: 3, z: 0.5 }))).toBeCloseTo((8 / 9) / 1.8, 6);
  });

  it('a body in water sinks at the terminal 0.025 blocks/tick and Jump swims it up', () => {
    const h = poolHost(), w = h.engine.dimension('overworld');
    let s = still(0.5, 2.5, 0.5);
    for (let i = 0; i < 40; i++) s = tickPlayer(w, s, { move: { x: 0, z: 0 }, jump: false, sneak: false }).state;
    // Terminal: v = 0.8 v - 0.005 -> -0.025 (Java's water branch; 0.5 blocks/s).
    expect(s.vy).toBeCloseTo(-WATER_GRAVITY / (1 - 0.8), 3);
    let up = still(0.5, 1.2, 0.5);
    for (let i = 0; i < 40; i++) up = tickPlayer(w, up, { move: { x: 0, z: 0 }, jump: true, sneak: false }).state;
    expect(up.y).toBeGreaterThan(2.2);
  });

  it('a swimmer pressed against a bank at the surface climbs out', () => {
    // Water 2 deep in x < 0; a bank of stone at x >= 0 whose top is level with the water's.
    const h = simHost({ terrain: solidBelow(1) });
    h.fill({ x: -6, y: 1, z: -2 }, { x: -1, y: 2, z: 2 }, 'minecraft:water');
    h.fill({ x: 0, y: 1, z: -2 }, { x: 4, y: 2, z: 2 }, 'minecraft:stone');
    const w = h.engine.dimension('overworld');
    let s = { ...still(-0.6, 2.3, 0.5) };
    let t = 0;
    for (; t < 80 && !(s.onGround && s.x > 0.3); t++) s = tickPlayer(w, s, { move: { x: 1, z: 0 }, jump: true, sneak: false }).state;
    // Out within a second, standing on the bank's top (3), never through its face.
    expect(t).toBeLessThan(40);
    expect(s.y).toBeCloseTo(3, 6);
  });

  it('a mob with behavior.float stays up; a buoyant body rests half under', () => {
    const h = poolHost(), w = h.engine.dimension('overworld');
    let f = still(0.5, 1.2, 0.5), sinker = still(1.5, 3.0, 0.5), b = still(2.5, 3.5, 0.5);
    const dims = { width: 0.6, height: 1 };
    for (let i = 0; i < 200; i++) {
      f = tickBody(w, f, dims, true, { floats: true }).state;
      sinker = tickBody(w, sinker, dims, true, {}).state;
      b = tickBody(w, b, dims, true, { buoyancy: 1 }).state;
    }
    expect(f.y).toBeGreaterThan(2.6); // near the surface (3.889 - the 0.4 jump depth, give or take its bob)
    expect(sinker.y).toBeCloseTo(1, 3); // on the floor
    expect(submersion(w, playerBox(b, dims))).toBeGreaterThan(0.35);
    expect(submersion(w, playerBox(b, dims))).toBeLessThan(0.65);
  });

  it('a dry world (no `submersion`) keeps the old integrator bit for bit', () => {
    const solids = { solidsNear: () => [{ x0: -10, y0: -1, z0: -10, x1: 10, y1: 0, z1: 10 }] };
    let s = still(0, 3, 0);
    for (let i = 0; i < 30; i++) s = tickPlayer(solids, s, { move: { x: 0, z: 0 }, jump: false, sneak: false }, PLAYER_DIMS).state;
    expect(s.y).toBe(0);
  });
});

describe('the integrator\'s solids query', () => {
  it('a jump sees the block its head rises into: a slab in the next row up stops it (10261\'s lintel)', () => {
    const h = simHost({ terrain: solidBelow(0), colliders: true });
    // A collider slab whose bottom is 1/16 into the block row over the standing head (head 1.8, slab 2.0625..2.375).
    h.setBlock(0, 2, 0, 'craftmatic:collider', { 'craftmatic:lo': 1, 'craftmatic:hi': 6 });
    const w = h.engine.dimension('overworld');
    let s: PlayerState = { ...still(0.5, 0, 0.5), onGround: true };
    let top = 0;
    for (let i = 0; i < 12; i++) { s = tickPlayer(w, s, { move: { x: 0, z: 0 }, jump: i === 0, sneak: false }).state; top = Math.max(top, s.y + 1.8); }
    expect(top).toBeLessThanOrEqual(2 + 1 / 16 + 1e-6);
    expect(w.overlapping(playerBox(s), 1e-3)).toBeUndefined();
  });
});

describe('bodies that meet (quirks entity-push-soft, entity-collidable-solid)', () => {
  const figure = { components: { 'minecraft:collision_box': { width: 0.6, height: 1.6 }, 'minecraft:physics': { has_gravity: true, has_collision: true }, 'minecraft:pushable_by_entity': {} } };
  const car = { components: { 'minecraft:collision_box': { width: 2, height: 1.5 }, 'minecraft:physics': { has_gravity: true, has_collision: true }, 'minecraft:pushable_by_block': {} } };

  it('two overlapping figures push apart; a vehicle neither pushes nor is pushed', () => {
    const h = simHost({ terrain: solidBelow(0), entities: { 't:fig': figure, 't:car': car } });
    const a = h.spawn('t:fig', { x: 0, y: 0, z: 0 }), b = h.spawn('t:fig', { x: 0.3, y: 0, z: 0 });
    const c = h.spawn('t:car', { x: 0.2, y: 0, z: 0 });
    expect(pushBodies([a, b, c])).toBe(1);
    expect(a.velocity.x).toBeLessThan(0);
    expect(b.velocity.x).toBeGreaterThan(0);
    expect(c.velocity.x).toBe(0);
    h.run(30);
    expect(Math.abs(b.location.x - a.location.x)).toBeGreaterThanOrEqual(0.6 - 1e-3);
  });

  it('a collidable entity is a solid box: a walking player stops at it, and the invariant sees no overlap', () => {
    const block = { components: { ...car.components, 'minecraft:is_collidable': {} } };
    const h = simHost({ terrain: solidBelow(0), entities: { 't:wall': block } });
    const wall = h.spawn('t:wall', { x: 3, y: 0, z: 0.5 });
    const p = h.addPlayer('P', { x: 0.5, y: 0, z: 0.5 }, { yaw: -90 });
    h.controls(p, { forward: 1 });
    h.run(60);
    expect(p.location.x).toBeLessThanOrEqual(wall.location.x - 1 - 0.3 + 1e-3);
    expect(overlappingSolidPairs(h.engine.entities.values())).toEqual([]);
    // Placed inside it, the pair is reported.
    p.location = { x: 3, y: 0, z: 0.5 };
    expect(overlappingSolidPairs(h.engine.entities.values()).map(x => x.solid.typeId)).toEqual(['t:wall']);
  });
});

describe('walking to the tap (runner `reachFor`, approach `walk`; IX-04 report)', () => {
  const knob = { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 't:knob' }, components: { 'minecraft:collision_box': { width: 0.5, height: 0.5 } } } };
  /** A world: ground at y 0, a one-block step at x 4..20 (auto-jump climbs it); `ring` walls the knob in, three high. */
  const scenario = (ring: boolean): Scenario => ({
    name: ring ? 'walled' : 'open', start: { x: 0.5, y: 0, z: 0.5 },
    steps: [
      { kind: 'expect', label: 'lay', check: ctx => {
        const w = ctx.sim.engine.dimension('overworld'), stone = ctx.sim.host.resolvePermutation('minecraft:stone');
        for (let x = 4; x <= 20; x++) for (let z = -6; z <= 6; z++) w.setPermutation(x, 0, z, stone);
        if (ring) for (let x = 10; x <= 14; x++) for (let z = -2; z <= 2; z++) if (x === 10 || x === 14 || z === -2 || z === 2) for (let y = 1; y <= 3; y++) w.setPermutation(x, y, z, stone);
        ctx.sim.engine.spawnEntity('t:knob', 'overworld', { x: 12.5, y: 1, z: 0.5 });
        return undefined;
      } },
      { kind: 'wait', ticks: 2 },
      { kind: 'tap', target: { type: 't:knob' } },
    ],
  });
  const run = (ring: boolean) => runScenario(scenario(ring), [fixtureAddon({ name: 'k', files: { 'entities/knob.json': knob } })], { terrain: solidBelow(0), approach: 'walk' });

  it('walks up a one-block step with auto-jump to a spot a tap picks the target from', async () => {
    const r = await run(false);
    expect(r.violations).toEqual([]);
    expect(tapReachOf(r.state)).toMatchObject([{ target: 't:knob', onFoot: true }]);
    expect(tapReachOf(r.state)[0]!.ticks).toBeGreaterThan(20);
  });

  it('a target walled in three high is reported unreachable on foot, and still tapped from its spot', async () => {
    const r = await run(true);
    expect(r.violations).toEqual([]);
    const t = tapReachOf(r.state);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ onFoot: false });
    expect(r.notes.some(n => /tap-target-unreachable-on-foot/.test(n))).toBe(true);
  });

  it('plans round a wall rather than through a gap two thin bands leave between two columns', () => {
    const h = simHost({ terrain: solidBelow(0), colliders: true });
    // Column x 1 carries a band on its high-x quarter, column x 2 one on its low-x quarter: standable both, a wall between.
    for (let z = -1; z <= 1; z++) for (let y = 0; y <= 2; y++) {
      h.setBlock(1, y, z, 'craftmatic:collider_w6', { 'craftmatic:lo': 0, 'craftmatic:hi': 16 });
      h.setBlock(2, y, z, 'craftmatic:collider_w1', { 'craftmatic:lo': 0, 'craftmatic:hi': 16 });
    }
    const route = walkRoute(h.engine, 'overworld', { x: 0.5, y: 0, z: 0.5 }, { x: 3.5, y: 0, z: 0.5 });
    expect(route).toBeDefined();
    // Round the end of the wall (z beyond +-1), never straight across x 1 -> 2 at z 0.
    expect(route!.some(n => Math.abs(n.z) > 1)).toBe(true);
  });
});

describe('vanilla shapes (quirk vanilla-door-shape)', () => {
  it('a closed door stands opposite its facing; open, on its hinge side', () => {
    // "a door facing east occupies the west part of its block when closed" (minecraft.wiki, Bedrock states).
    expect(doorPanel({ 'minecraft:cardinal_direction': 'east' })).toMatchObject({ x0: 0, x1: 3 / 16 });
    expect(doorPanel({ 'minecraft:cardinal_direction': 'north' })).toMatchObject({ z0: 13 / 16, z1: 1 });
    // Legacy `direction` in the exporter's order (south 0): a south-facing door closes on the north part.
    expect(doorPanel({ direction: 0 })).toMatchObject({ z0: 0, z1: 3 / 16 });
    expect(doorPanel({ direction: 0, open_bit: true })).toMatchObject({ x0: 13 / 16 }); // left hinge: swings west side
    expect(doorPanel({ direction: 0, open_bit: true, door_hinge_bit: true })).toMatchObject({ x0: 0, x1: 3 / 16 });
    const t = new BlockTypes();
    expect(t.shape('minecraft:wooden_door', { direction: 1, open_bit: false }).collision).toHaveLength(1);
  });

  it('a stair is a half block and a step toward its facing, mirrored upside down', () => {
    expect(stairBoxes({ weirdo_direction: 0 })).toEqual([{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 0.5, z1: 1 }, { x0: 0.5, y0: 0.5, z0: 0, x1: 1, y1: 1, z1: 1 }]);
    expect(stairBoxes({ weirdo_direction: 3, upside_down_bit: true })[1]).toEqual({ x0: 0, y0: 0, z0: 0, x1: 1, y1: 0.5, z1: 0.5 });
  });
});

describe('API fidelity (quirks dynamic-properties-per-pack, restricted-execution-before-events)', () => {
  it('a numeric enum carries the device\'s numbers, a string enum its ids', () => {
    const cat = enumObject(SERVER_TYPES['InputPermissionCategory']!);
    expect(cat['Camera']).toBe(1);
    expect(enumObject(SERVER_TYPES['EntityComponentTypes']!)['Rideable']).toBe('minecraft:rideable');
    expect(Object.isFrozen(cat)).toBe(true);
  });

  it('dynamic properties are scoped by the writing pack; tags are shared', () => {
    const writer = `import { world, system } from "@minecraft/server";
system.runInterval(() => { for (const e of world.getDimension("overworld").getEntities({ type: "t:box" })) { e.setDynamicProperty("k", "mine"); e.addTag("shared"); } }, 1);`;
    const reader = `import { world, system } from "@minecraft/server";
system.runInterval(() => { for (const e of world.getDimension("overworld").getEntities({ type: "t:box" })) { world.setDynamicProperty("seen", String(e.getDynamicProperty("k")) + "/" + e.hasTag("shared")); } }, 1);`;
    const sim = new Simulation({ terrain: AIR_WORLD });
    sim.engine.tickingAreas.set('t', { name: 't', dimension: 'minecraft:overworld', x0: -32, z0: -32, x1: 32, z1: 32 });
    sim.loadAddon(fixtureAddon([
      { name: 'a', files: { 'scripts/main.js': writer, 'entities/box.json': { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 't:box' }, components: {} } } } },
      { name: 'b', files: { 'scripts/main.js': reader } },
    ]));
    const box = sim.engine.spawnEntity('t:box', 'overworld', { x: 0, y: 0, z: 0 });
    sim.runSync(4);
    // The engine's view holds the writer's value; the OTHER pack read undefined - and saw the tag.
    expect(box.dynamic.get('k')).toBe('mine');
    const store = (sim.host as unknown as { worldDynamic: DynamicStore }).worldDynamic;
    expect(store.get('seen')).toBe('undefined/true');
    expect(store.getFor('b_BP', 'seen')).toBe('undefined/true');
    expect(store.getFor('a_BP', 'seen')).toBeUndefined();
  });

  it('an engine-seeded value is every pack\'s until a pack writes the key', () => {
    const d = new DynamicStore();
    d.set('k', 1);
    expect(d.getFor('p', 'k')).toBe(1);
    d.setFor('p', 'k', 2);
    expect(d.getFor('p', 'k')).toBe(2);
    expect(d.getFor('q', 'k')).toBeUndefined();
    expect(d.get('k')).toBe(2);
    d.setFor('p', 'k', undefined);
    expect(d.has('k')).toBe(false);
  });

  it('a before-event callback runs read-only: a teleport there throws, system.run defers it', () => {
    const script = `import { world, system } from "@minecraft/server";
world.beforeEvents.playerInteractWithEntity.subscribe(ev => {
  try { ev.player.teleport({ x: 5, y: 0, z: 5 }); world.setDynamicProperty("direct", "moved"); }
  catch (e) { world.setDynamicProperty("direct", String(e.name) + ": " + String(e.message)); }
  system.run(() => ev.player.teleport({ x: 7, y: 0, z: 7 }));
});`;
    const h = simHost({ script, entities: { 't:seat': { components: { 'minecraft:collision_box': { width: 1, height: 1 } } } } });
    const seat = h.spawn('t:seat', { x: 1, y: 0, z: 0 });
    const p = h.addPlayer('P', { x: 0, y: 0, z: 0 });
    h.host.before('playerInteractWithEntity', { player: h.api(p), target: h.api(seat) });
    expect(String(h.world.getDynamicProperty('direct'))).toMatch(/^ReferenceError: Native function \[Player::teleport\] does not have required privileges/);
    expect(p.location.x).toBe(0);
    h.run(1);
    expect(p.location).toMatchObject({ x: 7, z: 7 });
  });
});
