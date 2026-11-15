import { describe, expect, it } from 'vitest';
import {
  SIZE_STEPS, buildPlacementPackAssets, encodeColliderRuns, placementAlias, rotatePlacementPoint,
  rotateTilePlacement, rotatedSize, VISIBLE_BOUNDS_HEADROOM_BLOCKS, visibleBoundsFor,
} from '../web/src/engine/bedrock-placement-pack.js';
import { BOARD_OWNER_PROPERTY, BOARD_POINTS_PROPERTY } from '../web/src/engine/bedrock-vehicle.js';
import { host } from './_placement-host.js';
import { BlockGrid } from '@craft/schem/types.js';

const tile = { identifier: 'craftmatic:wing', dx: 10, dy: 2, dz: 20, width: 8, height: 5, length: 6, nonAir: 10 };

describe('visibleBoundsFor', () => {
  /** Does the declared box contain the model AABB at 100 %? */
  const contains = (b: ReturnType<typeof visibleBoundsFor>, extent: { min: readonly number[]; max: readonly number[] }): boolean => {
    const [, oy] = b.visible_bounds_offset, r = b.visible_bounds_width / 2, h = b.visible_bounds_height / 2;
    return [0, 2].every(i => extent.min[i]! >= -r - 1e-9 && extent.max[i]! <= r + 1e-9)
      && extent.min[1]! >= oy! - h - 1e-9 && extent.max[1]! <= oy! + h + 1e-9;
  };

  // Round 2026-10-28c (Pixel): `minecraft:scale` scales the box with the model, so
  // a box sized for the wand's 400 % step kept every shell chunk 70-105 blocks wide
  // and the phone drew a placed model even with it behind the camera (19.6 fps,
  // 47.4 with 100 % boxes). The 100 % box is the whole contract.
  it('holds the model at 100 % and no more than the headroom past it', () => {
    // A 6 x 2 x 10 block car standing on y = 0, centred on the entity position.
    const car = { min: [-3, 0, -5] as const, max: [3, 2, 5] as const };
    const b = visibleBoundsFor(car);
    expect(contains(b, car)).toBe(true);
    expect(b.visible_bounds_width).toBeCloseTo(2 * (5 + VISIBLE_BOUNDS_HEADROOM_BLOCKS), 2);
    expect(b.visible_bounds_height).toBeCloseTo(2 + 2 * VISIBLE_BOUNDS_HEADROOM_BLOCKS, 2);
  });

  it('centres the height on a model authored BELOW its origin', () => {
    // A building shell is authored `originLiftBlocks` down so the entity sits in open sky.
    const shell = { min: [-17, -29, -17] as const, max: [17, -0.2, 17] as const };
    const b = visibleBoundsFor(shell);
    expect(contains(b, shell)).toBe(true);
    expect(b.visible_bounds_offset[1]).toBeCloseTo(-14.6, 1);
    expect(b.visible_bounds_height).toBeLessThan(29 + 2 * VISIBLE_BOUNDS_HEADROOM_BLOCKS + 0.1);
  });

  it('adds the requested slack and the headroom, and never returns a degenerate box', () => {
    const point = { min: [0, 0, 0] as const, max: [0, 0, 0] as const };
    expect(visibleBoundsFor(point, 2).visible_bounds_width).toBe(2 * (2 + VISIBLE_BOUNDS_HEADROOM_BLOCKS));
    const zero = visibleBoundsFor(point);
    expect(zero.visible_bounds_width).toBeGreaterThan(0);
    expect(zero.visible_bounds_height).toBeGreaterThan(0);
  });
});

describe('Bedrock Brick Wand placement pack', () => {
  it('normalizes rotated tile boxes so all pieces and preview share one origin', () => {
    expect(rotateTilePlacement(tile, 100, 80, 90)).toMatchObject({ dx: 54, dy: 2, dz: 10, width: 6, length: 8 });
    expect(rotateTilePlacement(tile, 100, 80, 180)).toMatchObject({ dx: 82, dy: 2, dz: 54, width: 8, length: 6 });
    expect(rotateTilePlacement(tile, 100, 80, 270)).toMatchObject({ dx: 20, dy: 2, dz: 82, width: 6, length: 8 });
    expect(rotatedSize(100, 30, 80, 90)).toEqual({ width: 80, height: 30, length: 100 });
  });

  it('rotates dynamic components with the same normalized transform', () => {
    expect(rotatePlacementPoint({ x: 12, y: 4, z: 7 }, 100, 80, 90)).toEqual({ x: 73, y: 4, z: 12 });
    expect(rotatePlacementPoint({ x: 12, y: 4, z: 7 }, 100, 80, 180)).toEqual({ x: 88, y: 4, z: 73 });
  });

  it('uses memorable known-set aliases and stable collision-safe arbitrary aliases', () => {
    expect(placementAlias('Batcave Shadowbox 76252')).toBe('b76252');
    expect(placementAlias('Prop Plane 8855')).toBe('b8855');
    expect(placementAlias('My Castle')).toMatch(/^b_[0-9a-f]{6}$/);
    expect(placementAlias('My Castle')).toBe(placementAlias('My Castle'));
  });

  it('emits a searchable custom Brick Wand and an explicit preview/place runtime', () => {
    const assets = buildPlacementPackAssets({ stem: 'Batcave 76252', label: 'Batcave Shadowbox', width: 100, height: 30, length: 80, tiles: [tile], actors: [{ typeId: 'craftmatic:batmobile', label: 'Batmobile', x: 12, y: 4, z: 7 }], previewPoints: Array.from({ length: 200 }, (_, x) => ({ x, y: 1, z: 2 })) });
    const names = assets.files.map(f => f.name);
    expect(assets.shortAlias).toBe('b76252');
    expect(names).toContain('functions/b76252.mcfunction');
    expect(names).toContain('scripts/placement.js');
    const item = JSON.parse(new TextDecoder().decode(assets.files.find(f => f.name.startsWith('items/'))!.data));
    expect(item['minecraft:item'].components['minecraft:icon']).toBe('brick');
    expect(item['minecraft:item'].components['minecraft:display_name'].value).toContain('BrickWand');
    expect(assets.script).toContain("world.afterEvents.itemUse.subscribe");
    expect(assets.script).toContain('structure load "${t.identifier}"');
    expect(assets.script).toContain('entity.setRotation');
    expect(assets.script).toContain('Undo last placement');
    expect(assets.script).toContain('Lighting / night vision');
    expect(assets.script).not.toContain('import { showTimeMachineControls }');
    expect(assets.script).toContain('p.addEffect');
    expect(assets.script).toContain('minecraft:night_vision');
    expect(assets.script).toContain('showParticles: false');
    expect(assets.script).toContain("defaultValue: String(a.x)");
    expect(assets.script).toContain('tickingarea add ${fx} ${y} ${fz} ${tx} ${y} ${tz} ${areaId} true');
    expect(assets.script).toContain('dimension.getBlock(q)');
    expect(assets.script).toContain('PINNED PREVIEW');
    expect(assets.script).toContain("minecraft:redstone_ore_dust_particle");
    expect(assets.script).not.toContain('getViewDirection');
    expect(assets.script).not.toContain('basic_flame_particle');
    expect(assets.script).not.toContain('miniature');
    expect(assets.script).toContain('previewPoints":[{"x":0');
    expect(assets.script).not.toContain('"x":120,"y":1,"z":2');
    expect(() => new Function(assets.script.replace(/^import .*;$/gm, ''))).not.toThrow();
  });

  it('keeps an explicit brick-chair marker model-local so it follows size, turn and undo rather than guessing furniture', () => {
    const assets = buildPlacementPackAssets({ stem: 'Chair test', label: 'Chair test', width: 12, height: 8, length: 10, tiles: [tile], manualSeatTypeId: 'craftmatic:chair_test_seat' });
    expect(assets.script).toContain('manualSeatTypeId":"craftmatic:chair_test_seat"');
    expect(assets.script).toContain('Add seat here');
    expect(assets.script).toContain('const modelPoint =');
    expect(assets.script).toContain('const q = worldPoint(st, seat)');
    expect(assets.script).toContain('st.manualSeats || []');
    expect(assets.script).toContain('world.getEntity(id)?.remove()');
  });

  it('offers the measured door size and re-hangs its two vanilla halves after scaled colliders', () => {
    const assets = buildPlacementPackAssets({ stem: 'Door test', label: 'Door test', width: 12, height: 8, length: 10, tiles: [tile], runtimeDoorCandidates: [{ x: 4, y: 1, z: 5, requiredSize: 300, lower: { id: 'minecraft:wooden_door', states: { direction: 0, upper_block_bit: false } }, upper: { id: 'minecraft:wooden_door', states: { direction: 0, upper_block_bit: true } } }] });
    expect(assets.script).toContain('Use next door size');
    expect(assets.script).toContain('st.size < door.requiredSize');
    expect(assets.script).toContain('scripted ? config.runtimeDoorCandidates || [] : []');
    expect(assets.script).toContain('no solid support exists below the resized opening');
    expect(assets.script).toContain('BlockPermutation.resolve(door.lower.id');
    expect(assets.script).toContain('runtimeDoorCandidates');
  });

  it('serializes an exclusive maximum size for source leaf actors', () => {
    const assets = buildPlacementPackAssets({ stem: 'Leaf test', label: 'Leaf test', width: 2, height: 3, length: 2, tiles: [], actors: [{ typeId: 'craftmatic:leaf', label: 'Door leaf', x: 1, y: 2, z: 1, maxSizeExclusive: 300 }] });
    expect(assets.script).toContain('"maxSizeExclusive":300');
    expect(assets.script).toContain('st.size >= actor.maxSizeExclusive');
  });
});

/**
 * A-05 (PROC-19): Undo removed a boarding point only when it could SEE it - a loaded point whose owner was retired.
 * 10303 at 400 % kept two in a chunk nobody loaded (`sim --sizes=400`: "2 boarding points left after Undo"). The
 * vehicle runtime tags each point with its vehicle's placement tag and lists the point ids on the vehicle
 * (`BOARD_POINTS_PROPERTY`); Undo retires those ids with the vehicle, so a point that loads later is swept then.
 */
describe('Brick Wand Undo and a scripted vehicle\'s boarding points', () => {
  const FAR = { x: 5000, y: 20, z: 5000 };
  const boardType = (pct: number) => `craftmatic:b_car_board_${pct}`;
  const bare = (identifier: string) => JSON.stringify({ format_version: '1.26.30', 'minecraft:entity': { description: { identifier, is_spawnable: true, is_summonable: true }, components: {} } });
  const spec = {
    stem: 'car', label: 'Car (car-1)', width: 10, height: 4, length: 10,
    tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 10, height: 4, length: 10, nonAir: 1 }],
    actors: [{ typeId: 'craftmatic:car', label: 'Car', x: 5, y: 1, z: 5 }],
    previewPoints: [{ x: 0.5, y: 0.5, z: 0.5 }], settleTicks: 0, finalHoldTicks: 0,
    boardTypes: SIZE_STEPS.map(boardType), boardOwnerProperty: BOARD_OWNER_PROPERTY, boardPointsProperty: BOARD_POINTS_PROPERTY,
  };

  it('undo removes every board point type of every size step, loaded or not, and a far one when its chunk loads', async () => {
    const h = host(spec, { playerAt: { x: 10, y: 20, z: 30 }, loadEverywhere: false, definitions: Object.fromEntries(SIZE_STEPS.map(p => [boardType(p), bare(boardType(p))])) });
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    h.player.location = { x: 8.5, y: 20, z: 30.5 }; // out of the footprint (A-06: the wand asks before building round a player)
    await h.open({ action: 'Place' }, { selection: 0 });
    const car = h.spawned.find(s => s.typeId === 'craftmatic:car')!;
    const vehicle = car.entity, tag = (vehicle.getTags() as string[]).find(t => t.startsWith('cmu_'))!;
    expect(tag).toBeDefined();
    // As the vehicle runtime stands them (`tendBoard`): one point per size step, each owned, tagged and listed.
    const ids: string[] = [];
    for (const pct of SIZE_STEPS) {
      const p = h.dimension.spawnEntity(boardType(pct), { x: vehicle.location.x + 1, y: vehicle.location.y, z: vehicle.location.z });
      p.setDynamicProperty(BOARD_OWNER_PROPERTY, vehicle.id);
      p.addTag(tag);
      ids.push(p.id);
    }
    vehicle.setDynamicProperty(BOARD_POINTS_PROPERTY, JSON.stringify(ids));
    const points = () => h.spawned.filter(s => s.typeId.startsWith('craftmatic:b_car_board_'));
    expect(points()).toHaveLength(SIZE_STEPS.length);
    // Half of them out in a chunk nobody loads (a 400 % hull's far end, past the simulation distance).
    for (const [i, s] of points().entries()) if (i % 2) (s as any).sim.location = { ...FAR };
    h.engine.updateLoaded();
    expect(h.world.getEntity(ids[1]!)).toBeUndefined();

    await h.open({ action: 'Undo last placement' });
    expect(h.player.sendMessage.mock.calls.map((c: unknown[]) => String(c[0])).some((m: string) => m.includes('Undo complete'))).toBe(true);
    expect((car as any).sim.valid).toBe(false);
    for (const [i, s] of points().entries()) if (!(i % 2)) expect((s as any).sim.valid, `loaded ${s.typeId}`).toBe(false);
    // The far points' chunk loads (the player walks there): every one is swept then.
    h.player.location = FAR;
    h.engine.runSync(2);
    for (const s of points()) expect((s as any).sim.valid, s.typeId).toBe(false);
  });
});

/**
 * A-06 (PROC-19): a pin the AIM centred kept its CORNER through Size and Rotate, so a model shrank and turned away
 * from the aimed spot - at 50 % turned 90, 10261 covered the child who aimed it (`player-not-in-solid`, 9 sets).
 * A centred pin keeps its centre; a corner pin (Pin corner at my feet, Edit coordinates) keeps its corner.
 */
describe('Brick Wand Size and Rotate', () => {
  const spec = {
    stem: 'centre', label: 'Centre (centre-1)', width: 20, height: 4, length: 10, tiles: [],
    // A marker at the footprint's centre: where it stands after placing is where the footprint's centre is.
    actors: [{ typeId: 'craftmatic:mark', label: 'Mark', x: 10, y: 0, z: 5 }],
    previewPoints: [{ x: 0.5, y: 0.5, z: 0.5 }], settleTicks: 0, finalHoldTicks: 0,
  };
  /** Press the menu button starting with `label` until the menu body reads `until`. */
  const pressUntil = async (h: ReturnType<typeof host>, label: string, done: () => boolean) => {
    for (let i = 0; i < 12 && !done(); i++) await h.open({ action: label }, { canceled: true });
  };
  /** The last wand menu's summary (its body). */
  const summaryOf = (h: ReturnType<typeof host>) => h.forms.filter(f => / · Brick Wand$/.test(f.title)).at(-1)?.body ?? '';

  it('Size and Rotate keep the footprint centred on the aimed point', async () => {
    const h = host(spec);
    const aim = h.intervals.get(4)!;
    h.setHit({ block: { location: { x: 40, y: 63, z: 80 } }, face: 'Up' });
    await h.use(); // a fresh wand follows the aim
    aim();
    await h.open({ action: 'Stop following my aim' });
    await pressUntil(h, 'Size', () => /· 50 percent/.test(summaryOf(h)));
    await pressUntil(h, 'Rotate', () => /· 90°/.test(summaryOf(h)));
    expect(summaryOf(h)).toMatch(/· 90°/);
    await h.open({ action: 'Place' }, { selection: 0 });
    const mark = h.spawned.find(s => s.typeId === 'craftmatic:mark')!;
    if (!mark) throw new Error(JSON.stringify({ forms: h.forms.slice(-3).map(f => [f.title, f.body.slice(0, 200)]), said: h.player.sendMessage.mock.calls.slice(-4) }));
    // The aimed spot is the top face of (40, 63, 80): its centre (40.5, 80.5); the footprint rounds to whole blocks.
    expect(Math.abs(mark.entity.location.x - 40.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(mark.entity.location.z - 80.5)).toBeLessThanOrEqual(1);
  });

  it('a corner pin keeps its corner through Size and Rotate', async () => {
    const h = host(spec, { playerAt: { x: 100, y: 64, z: 200 } });
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await pressUntil(h, 'Rotate', () => /· 90°/.test(summaryOf(h)));
    await pressUntil(h, 'Size', () => /· 200 percent/.test(summaryOf(h)));
    expect(summaryOf(h)).toMatch(/· 90°/);
    expect(summaryOf(h)).toContain('Origin: 100, 64, 200');
  });
});

describe('Brick Wand never builds walls round a player unasked (A-06)', () => {
  const solid = () => {
    const g = new BlockGrid(4, 3, 2);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) g.set(x, y, z, 'craftmatic:collider[lo=0,hi=16]');
    return encodeColliderRuns(g, 'craftmatic:collider').runs;
  };
  const spec = (extra: Record<string, unknown> = {}) => ({
    stem: 'held', label: 'Held (held-1)', width: 4, height: 3, length: 2,
    tiles: [{ identifier: 'craftmatic:held_t0', dx: 0, dy: 0, dz: 0, width: 4, height: 3, length: 2, nonAir: 1 }],
    colliders: { width: 4, height: 3, length: 2, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: solid(), keptCells: 0 },
    previewPoints: [{ x: 0.5, y: 0.5, z: 0.5 }], settleTicks: 0, finalHoldTicks: 0, ...extra,
  });
  const PROMPT = 'Someone is standing where it goes';

  it('a placement whose colliders would hold a player\'s body prompts, and Find a clear spot places it clear of them', async () => {
    const h = host(spec(), { playerAt: { x: 100.5, y: 64, z: 200.5 } });
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 }, { selection: 0 });
    expect(h.forms.map(f => f.title)).toContain(PROMPT);
    expect(h.forms.find(f => f.title === PROMPT)!.buttons).toEqual(['Find a clear spot nearby', 'Move', 'Place anyway', 'Cancel']);
    const confirm = h.forms.filter(f => /^Place .*\?$/.test(f.title)).at(-1)!;
    const o = /Origin: (-?\d+), (-?\d+), (-?\d+)/.exec(confirm.body)!.slice(1).map(Number);
    // The footprint (4 x 2) no longer reaches the player's column at x 100, z 200.
    expect(100 >= o[0]! && 100 < o[0]! + 4 && 200 >= o[2]! && 200 < o[2]! + 2).toBe(false);
  });

  it('a player beside the footprint is not asked; a store pack offers no Place anyway', async () => {
    const h = host(spec(), { playerAt: { x: 98.5, y: 64, z: 200.5 } });
    await h.open({ action: 'Edit coordinates' }, { formValues: ['100', '64', '200'] }, { canceled: true });
    await h.open({ action: 'Place' }, { canceled: true });
    expect(h.forms.map(f => f.title)).not.toContain(PROMPT);
    const store = host(spec({ marketplacePlacement: true }), { playerAt: { x: 100.5, y: 64, z: 200.5 } });
    await store.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await store.open({ action: 'Place' }, { canceled: true });
    expect(store.forms.find(f => f.title === PROMPT)!.buttons).toEqual(['Find a clear spot nearby', 'Move', 'Cancel']);
  });
});
