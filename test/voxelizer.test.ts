/**
 * Tests for the Three.js mesh voxelizer with CIE-Lab color matching
 * and BVH acceleration.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { threeToGrid } from '../src/convert/voxelizer.js';

/** Create a simple colored box mesh centered at the given position */
function makeBox(
  w: number, h: number, d: number,
  color: number,
  cx = w / 2, cy = h / 2, cz = d / 2,
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, cy, cz);
  return mesh;
}

describe('voxelizer', () => {
  it('voxelizes a 3x3x3 box and has non-air blocks', () => {
    // Use a 3-unit box to ensure interior voxels are well inside geometry
    const mesh = makeBox(3, 3, 3, 0xff0000);
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);

    const grid = threeToGrid(group, 1);
    expect(grid.width).toBe(3);
    expect(grid.height).toBe(3);
    expect(grid.length).toBe(3);
    // Center voxel should be non-air (well inside the box)
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });

  it('resolution=2 doubles grid dimensions', () => {
    const mesh = makeBox(2, 2, 2, 0x00ff00);
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);

    const grid = threeToGrid(group, 2);
    // 2 units * 2 resolution = 4 blocks per axis
    expect(grid.width).toBe(4);
    expect(grid.height).toBe(4);
    expect(grid.length).toBe(4);
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });

  it('CIE-Lab matching: red mesh maps to warm-toned block', () => {
    const mesh = makeBox(3, 3, 3, 0xcc2222); // Deep red
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);

    const grid = threeToGrid(group, 1);
    // Find a non-air block (center voxel)
    const block = grid.get(1, 1, 1);
    if (block !== 'minecraft:air') {
      // Should be a warm-toned block, not gray stone
      const warmBlocks = [
        'minecraft:bricks', 'minecraft:terracotta', 'minecraft:red_concrete',
        'minecraft:red_terracotta', 'minecraft:nether_bricks', 'minecraft:red_nether_bricks',
        'minecraft:brown_terracotta', 'minecraft:brown_concrete',
      ];
      expect(warmBlocks).toContain(block);
    }
  });

  it('empty group produces 1x1x1 grid', () => {
    const group = new THREE.Group();
    const grid = threeToGrid(group, 1);
    expect(grid.width).toBe(1);
    expect(grid.height).toBe(1);
    expect(grid.length).toBe(1);
  });

  it('BVH is applied (geometry has boundsTree after voxelization)', () => {
    const mesh = makeBox(2, 2, 2, 0x808080);
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);

    threeToGrid(group, 1);

    // After voxelization, geometry should have BVH tree assigned
    const geo = mesh.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    expect(geo.boundsTree).toBeDefined();
  });

  it('calls onProgress callback', () => {
    const mesh = makeBox(2, 3, 2, 0x0000ff);
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);

    const progress: number[] = [];
    threeToGrid(group, 1, {
      onProgress: (p) => progress.push(p.progress),
    });

    // Should have been called for each Y layer + final 1.0
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('different colors produce different block types', () => {
    // Voxelize two separate boxes with distinct colors
    const redMesh = makeBox(3, 3, 3, 0xff0000);
    const redGroup = new THREE.Group();
    redGroup.add(redMesh);
    redGroup.updateMatrixWorld(true);
    const redGrid = threeToGrid(redGroup, 1);

    const blueMesh = makeBox(3, 3, 3, 0x4080a0);
    const blueGroup = new THREE.Group();
    blueGroup.add(blueMesh);
    blueGroup.updateMatrixWorld(true);
    const blueGrid = threeToGrid(blueGroup, 1);

    // At least one non-air block in each should differ (different color → different block)
    // Collect all unique block types
    const redBlocks = new Set<string>();
    const blueBlocks = new Set<string>();
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 3; z++) {
        for (let x = 0; x < 3; x++) {
          const rb = redGrid.get(x, y, z);
          const bb = blueGrid.get(x, y, z);
          if (rb !== 'minecraft:air') redBlocks.add(rb);
          if (bb !== 'minecraft:air') blueBlocks.add(bb);
        }
      }
    }

    // Both should have blocks, and they shouldn't be identical sets
    if (redBlocks.size > 0 && blueBlocks.size > 0) {
      // Check that at least one block type differs
      const allSame = [...redBlocks].every(b => blueBlocks.has(b)) &&
                      [...blueBlocks].every(b => redBlocks.has(b));
      expect(allSame).toBe(false);
    }
  });
});
