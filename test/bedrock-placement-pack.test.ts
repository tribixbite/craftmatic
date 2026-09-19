import { describe, expect, it } from 'vitest';
import {
  SIZE_STEPS, buildPlacementPackAssets, placementAlias, rotatePlacementPoint,
  rotateTilePlacement, rotatedSize, visibleBoundsForSizeSteps,
} from '../web/src/engine/bedrock-placement-pack.js';

const tile = { identifier: 'craftmatic:wing', dx: 10, dy: 2, dz: 20, width: 8, height: 5, length: 6, nonAir: 10 };

describe('visibleBoundsForSizeSteps', () => {
  /** Does the declared box contain the model AABB scaled by `f` about the entity position? */
  const contains = (b: ReturnType<typeof visibleBoundsForSizeSteps>, extent: { min: readonly number[]; max: readonly number[] }, f: number): boolean => {
    const [, oy] = b.visible_bounds_offset, r = b.visible_bounds_width / 2, h = b.visible_bounds_height / 2;
    return [0, 2].every(i => extent.min[i]! * f >= -r - 1e-9 && extent.max[i]! * f <= r + 1e-9)
      && extent.min[1]! * f >= oy! - h - 1e-9 && extent.max[1]! * f <= oy! + h + 1e-9;
  };

  it('covers the model at EVERY size step, not just at 100 %', () => {
    // A 6 x 2 x 10 block car standing on y = 0, centred on the entity position.
    const car = { min: [-3, 0, -5] as const, max: [3, 2, 5] as const };
    const b = visibleBoundsForSizeSteps(car);
    for (const pct of SIZE_STEPS) expect([pct, contains(b, car, pct / 100)]).toEqual([pct, true]);
    // 400 % of the 5-block half-length is the binding constraint on the width.
    expect(b.visible_bounds_width).toBeGreaterThanOrEqual(40);
    expect(b.visible_bounds_height).toBeGreaterThanOrEqual(8);
  });

  it('keeps a model authored BELOW its origin inside the box at every step', () => {
    // A building shell is authored `originLiftBlocks` down so the entity sits in
    // open sky; shrinking it pulls it UP towards the origin, growing it pushes it
    // down, so the box has to span both.
    const shell = { min: [-17, -29, -17] as const, max: [17, -0.2, 17] as const };
    const b = visibleBoundsForSizeSteps(shell);
    for (const pct of SIZE_STEPS) expect([pct, contains(b, shell, pct / 100)]).toEqual([pct, true]);
    expect(b.visible_bounds_offset[1]).toBeLessThan(0);
  });

  it('adds the requested slack before scaling, and never returns a degenerate box', () => {
    const point = { min: [0, 0, 0] as const, max: [0, 0, 0] as const };
    expect(visibleBoundsForSizeSteps(point, 2).visible_bounds_width).toBe(16); // 2 blocks of pad, 4x, both sides
    const zero = visibleBoundsForSizeSteps(point);
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
    expect(assets.script).toContain("structure load ${t.identifier}");
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
});
