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

// ─── Surface mode tests ──────────────────────────────────────────────────────

/** Create a flat plane (open surface mesh — not watertight) */
function makePlane(
  w: number, d: number,
  color: number,
  yPos = 2,
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, d);
  const mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  // PlaneGeometry is in XY plane by default — rotate to XZ (horizontal)
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(w / 2, yPos, d / 2);
  return mesh;
}

describe('voxelizer surface mode', () => {
  it('surface mode fills voxels near an open plane', () => {
    // A flat plane is open geometry — solid mode's odd-even test won't fill any voxels,
    // but surface mode should fill the layer where the surface lies
    const plane = makePlane(5, 5, 0xff4400, 2.5);
    const group = new THREE.Group();
    group.add(plane);
    group.updateMatrixWorld(true);

    const grid = threeToGrid(group, 1, { mode: 'surface' });
    // Surface mode should produce non-air blocks near the plane
    expect(grid.countNonAir()).toBeGreaterThan(0);
  });

  it('solid mode on open plane: odd-even may produce artifacts', () => {
    // A DoubleSide plane intersected by a Y-axis ray produces 1 crossing (odd),
    // so solid mode fills below the plane — this is a known artifact on open geometry.
    // Surface mode produces cleaner results: only the actual surface layer.
    const plane = makePlane(5, 5, 0xff4400, 2.5);
    const group = new THREE.Group();
    group.add(plane);
    group.updateMatrixWorld(true);

    const solidGrid = threeToGrid(group, 1, { mode: 'solid' });
    const surfaceGrid = threeToGrid(group, 1, { mode: 'surface' });

    // Surface mode should have fewer filled voxels (only near-surface layer)
    // while solid mode fills everything below the plane
    expect(surfaceGrid.countNonAir()).toBeGreaterThan(0);
    expect(surfaceGrid.countNonAir()).toBeLessThanOrEqual(solidGrid.countNonAir());
  });

  it('surface mode on a box produces blocks on all surfaces', () => {
    const mesh = makeBox(5, 5, 5, 0x00cc00);
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);

    const grid = threeToGrid(group, 1, { mode: 'surface' });
    expect(grid.countNonAir()).toBeGreaterThan(0);

    // Surface mode on a box: voxels on the shell but not necessarily the interior
    // Should have blocks at the edges (y=0 and y=4 layers)
    let bottomCount = 0;
    let topCount = 0;
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.get(x, 0, z) !== 'minecraft:air') bottomCount++;
        if (grid.get(x, grid.height - 1, z) !== 'minecraft:air') topCount++;
      }
    }
    expect(bottomCount).toBeGreaterThan(0);
    expect(topCount).toBeGreaterThan(0);
  });

  it('surface mode respects material color', () => {
    // Green plane should produce green-toned blocks
    const plane = makePlane(5, 5, 0x22aa22, 2.5);
    const group = new THREE.Group();
    group.add(plane);
    group.updateMatrixWorld(true);

    const grid = threeToGrid(group, 1, { mode: 'surface' });
    const blocks = new Set<string>();
    for (let y = 0; y < grid.height; y++) {
      for (let z = 0; z < grid.length; z++) {
        for (let x = 0; x < grid.width; x++) {
          const b = grid.get(x, y, z);
          if (b !== 'minecraft:air') blocks.add(b);
        }
      }
    }
    // Should have green-ish blocks, not white/gray
    expect(blocks.size).toBeGreaterThan(0);
    const greenBlocks = [
      'minecraft:green_concrete', 'minecraft:lime_concrete',
      'minecraft:green_terracotta', 'minecraft:lime_terracotta',
      'minecraft:moss_block', 'minecraft:green_wool',
    ];
    const hasGreen = [...blocks].some(b => greenBlocks.includes(b));
    expect(hasGreen).toBe(true);
  });

  it('surface mode with multiple disjoint meshes', () => {
    // Two separate planes at different heights — both should be captured
    const plane1 = makePlane(4, 4, 0xff0000, 1.5);
    const plane2 = makePlane(4, 4, 0x0000ff, 4.5);
    const group = new THREE.Group();
    group.add(plane1);
    group.add(plane2);
    group.updateMatrixWorld(true);

    const grid = threeToGrid(group, 1, { mode: 'surface' });
    // Both planes should contribute blocks
    expect(grid.countNonAir()).toBeGreaterThan(3);

    // Blocks should exist at two separate Y levels
    const yLevels = new Set<number>();
    for (let y = 0; y < grid.height; y++) {
      for (let z = 0; z < grid.length; z++) {
        for (let x = 0; x < grid.width; x++) {
          if (grid.get(x, y, z) !== 'minecraft:air') {
            yLevels.add(y);
          }
        }
      }
    }
    expect(yLevels.size).toBeGreaterThanOrEqual(2);
  });

  it('defaults to solid mode when mode not specified', () => {
    // 3x3x3 box should work with default (solid) mode
    const mesh = makeBox(3, 3, 3, 0x808080);
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);

    const gridDefault = threeToGrid(group, 1);
    const gridSolid = threeToGrid(group, 1, { mode: 'solid' });

    // Default and explicit solid should produce the same result
    expect(gridDefault.countNonAir()).toBe(gridSolid.countNonAir());
  });
});
