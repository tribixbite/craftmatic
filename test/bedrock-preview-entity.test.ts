import { describe, expect, it } from 'vitest';
import { BlockGrid } from '@craft/schem/types.js';
import { buildPreviewGhost, coverBoxes, ghostCube, sceneOccupancy } from '../web/src/engine/bedrock-preview-entity.js';
import { SIZE_STEPS, rotatePlacementPoint, rotateTilePlacement } from '../web/src/engine/bedrock-placement-pack.js';

const solid = (w: number, h: number, l: number, fill: (x: number, y: number, z: number) => boolean): BlockGrid => {
  const g = new BlockGrid(w, h, l);
  for (let y = 0; y < h; y++) for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) if (fill(x, y, z)) g.set(x, y, z, 'minecraft:stone');
  return g;
};

describe('ghost preview entity', () => {
  it('covers a solid block with one box and leaves air alone', () => {
    const g = solid(4, 2, 3, () => true);
    const { occ, w, h, l } = sceneOccupancy(g, [], 1);
    expect(coverBoxes(occ, w, h, l)).toEqual([{ x: 0, y: 0, z: 0, sx: 4, sy: 2, sz: 3 }]);
    expect(coverBoxes(new Uint8Array(24), 4, 2, 3)).toEqual([]);
  });

  it('coarsens until the box cover fits the cube budget and records the factor', () => {
    // A 3-D checkerboard needs one box per cell at factor 1 and one box at factor 2.
    const g = solid(8, 8, 8, (x, y, z) => (x + y + z) % 2 === 0);
    const fine = buildPreviewGhost('m', g, [], { maxCubes: 100000 });
    expect(fine.factor).toBe(1);
    expect(fine.cubeCount).toBe(256);
    const coarse = buildPreviewGhost('m', g, [], { maxCubes: 100 });
    expect(coarse.factor).toBe(2);
    expect(coarse.cubeCount).toBe(1);
  });

  it('marks a vehicle component at its scene position and scale', () => {
    const scenery = new BlockGrid(20, 4, 20);
    const car = solid(2, 1, 4, () => true);
    // Component centre at scene (10, 0, 10), 2 scene blocks per component cell → occupies x 8..12, z 6..14, y 0..2.
    const { occ, w, l } = sceneOccupancy(scenery, [{ grid: car, scale: 2, x: 10, y: 0, z: 10 }], 1);
    const at = (x: number, y: number, z: number) => occ[(y * l + z) * w + x];
    expect(at(8, 0, 6)).toBe(1);
    expect(at(11, 1, 13)).toBe(1);
    expect(at(7, 0, 6)).toBe(0);
    expect(at(8, 2, 6)).toBe(0);
    expect(at(12, 0, 6)).toBe(0);
  });

  it('authors cubes so that yaw 0 covers the unrotated tiles and yaw 90 covers the rotated ones', () => {
    // A 6 wide × 2 tall × 10 long model with one solid box in its +x/+z corner.
    const g = solid(6, 2, 10, (x, _y, z) => x >= 4 && z >= 7);
    const ghost = buildPreviewGhost('m', g, [], { maxCubes: 100 });
    expect(ghost.cubeCount).toBe(1);
    const cube = (ghost.geometry as any)['minecraft:geometry'][0].bones[0].cubes[0];
    // World offset from the footprint centre (3, 0, 5): x 1..3, z 2..5 → JSON x −3..−1, z −5..−2 (mirror both), y 0..2.
    expect(cube.origin).toEqual([-3 * 16, 0, -5 * 16]);
    expect(cube.size).toEqual([2 * 16, 2 * 16, 3 * 16]);
    // The wand spawns the ghost at anchor + rotated centre and sets yaw = rotation. Under Bedrock's
    // yaw the world offset (px, pz) of a model point turns to (−pz, px) at 90°, exactly what the
    // tile rotation does about the centre: check with the same helpers the runtime uses.
    const centre0 = rotatePlacementPoint({ x: 3, y: 0, z: 5 }, 6, 10, 0);
    const centre90 = rotatePlacementPoint({ x: 3, y: 0, z: 5 }, 6, 10, 90);
    expect(centre0).toEqual({ x: 3, y: 0, z: 5 });
    expect(centre90).toEqual({ x: 5, y: 0, z: 3 });
    const tile = rotateTilePlacement({ identifier: 't', dx: 4, dy: 0, dz: 7, width: 2, height: 2, length: 3, nonAir: 12 }, 6, 10, 90);
    // Centre-relative box extents after rotation: x ∈ [−pz_max, −pz_min] = [−5, −2] → dx = 5 + (−5..−2) = 0..3; z = px → 3 + (1..3) = 4..6.
    expect(tile).toMatchObject({ dx: 0, dz: 4, width: 3, length: 2 });
    const rotated = { x0: centre90.x + (-(5)), x1: centre90.x + (-(2)), z0: centre90.z + 1, z1: centre90.z + 3 };
    expect([rotated.x0, rotated.x1, rotated.z0, rotated.z1]).toEqual([tile.dx, tile.dx + tile.width, tile.dz, tile.dz + tile.length]);
  });

  // The ghost carries the wand's size groups, and `minecraft:scale` does not
  // resize a geometry's culling box, so the box must already hold the ghost at
  // 400 % or a scaled-up preview vanishes when the camera tilts away from it.
  it('bounds the ghost for the LARGEST wand size step', () => {
    const ghost = buildPreviewGhost('m', solid(6, 2, 10, () => true), []);
    const f = Math.max(...SIZE_STEPS) / 100;
    for (const mesh of (ghost.geometry as any)['minecraft:geometry']) {
      const d = mesh.description, half = d.visible_bounds_width / 2, oy = d.visible_bounds_offset[1];
      // Footprint 6 × 10 centred on the entity, standing on y = 0.
      expect(half).toBeGreaterThanOrEqual(5 * f);
      expect(oy - d.visible_bounds_height / 2).toBeLessThanOrEqual(0);
      expect(oy + d.visible_bounds_height / 2).toBeGreaterThanOrEqual(2 * f);
    }
  });

  it('ships a translucent material, a tinted texture, and a non-persistent, non-colliding behaviour', () => {
    const ghost = buildPreviewGhost('m', solid(3, 3, 3, () => true), []);
    expect(ghost.typeId).toBe('craftmatic:m_preview');
    // A name starting with a digit is not a legal Bedrock identifier; measured on the Pixel: the type never registered.
    expect(buildPreviewGhost('75892mclaren', solid(1, 1, 1, () => true), []).typeId).toBe('craftmatic:p_75892mclaren_preview');
    expect((ghost.clientEntity as any)['minecraft:client_entity'].description.materials.default).toBe('entity_alphablend');
    expect((ghost.behavior as any)['minecraft:entity'].components['minecraft:physics']).toEqual({ has_gravity: false, has_collision: false });
    expect((ghost.behavior as any)['minecraft:entity'].components['minecraft:despawn']).toBeDefined();
    expect((ghost.behavior as any)['minecraft:entity'].components['minecraft:persistent']).toBeUndefined();
    expect(ghost.texturePng.subarray(0, 8)).toEqual(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
    expect(ghostCube({ x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1 }, 1, { x: 0, z: 0 }).origin).toEqual([-16, 0, -16]);
  });
});
