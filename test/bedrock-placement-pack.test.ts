import { describe, expect, it } from 'vitest';
import {
  buildPlacementPackAssets, placementAlias, rotatePlacementPoint,
  rotateTilePlacement, rotatedSize,
} from '../web/src/engine/bedrock-placement-pack.js';

const tile = { identifier: 'craftmatic:wing', dx: 10, dy: 2, dz: 20, width: 8, height: 5, length: 6, nonAir: 10 };

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
