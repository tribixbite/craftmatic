/**
 * Integration test for the voxelizer pipeline with colored geometry.
 *
 * Builds a small Three.js scene with distinct colored meshes (red walls,
 * brown roof, blue door, green ground), runs through filterMeshesByHeight +
 * threeToGrid + trimSparseBottomLayers, and checks:
 * - Height filter removes flat ground
 * - Grid has expected approximate dimensions
 * - Palette contains diverse blocks (not monochrome)
 * - Block colors roughly match input mesh colors
 * - .schem round-trip preserves dimensions
 *
 * Usage: bun scripts/test-voxelize-glb.ts
 */

import * as THREE from 'three';
import { threeToGrid, createDataTextureSampler } from '../src/convert/voxelizer.js';
import { filterMeshesByHeight, trimSparseBottomLayers } from '../src/convert/mesh-filter.js';
import { writeSchematic } from '../src/schem/write.js';
import { parseSchematic } from '../src/schem/parse.js';
import { existsSync, unlinkSync } from 'node:fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// ─── Build a test scene: small house with colored materials ─────────────────

function buildTestHouse(): THREE.Group {
  const group = new THREE.Group();

  // Red walls — 6m wide x 4m tall x 6m deep box
  const wallGeo = new THREE.BoxGeometry(6, 4, 6);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xcc3333 }); // Red
  const walls = new THREE.Mesh(wallGeo, wallMat);
  walls.position.set(0, 2, 0);
  group.add(walls);

  // Brown roof — cone
  const roofGeo = new THREE.ConeGeometry(5, 3, 4);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8b4513 }); // SaddleBrown
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.set(0, 5.5, 0);
  roof.rotation.y = Math.PI / 4;
  group.add(roof);

  // Blue door — small box on front face
  const doorGeo = new THREE.BoxGeometry(1.2, 2.5, 0.3);
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x2244aa }); // Blue
  const door = new THREE.Mesh(doorGeo, doorMat);
  door.position.set(0, 1.25, 3.15);
  group.add(door);

  // Green ground plane (thin box, should get filtered by height filter)
  const groundGeo = new THREE.BoxGeometry(20, 0.1, 20);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x22aa22 }); // Green
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.set(0, -0.05, 0);
  group.add(ground);

  group.updateMatrixWorld(true);
  return group;
}

// ─── Main test ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Test: Colored Scene → Voxelizer → .schem pipeline ===\n');

  // 1. Build the test scene
  console.log('1. Building test house scene...');
  const house = buildTestHouse();
  let meshCount = 0;
  house.traverse(c => { if (c instanceof THREE.Mesh) meshCount++; });
  assert(meshCount === 4, `Scene has ${meshCount} meshes (walls, roof, door, ground)`);

  // 2. Height filter (should remove ground plane)
  console.log('\n2. Height filtering...');
  const candidates: Array<{ child: THREE.Mesh; worldBox: THREE.Box3 }> = [];
  house.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.updateWorldMatrix(true, false);
      const worldBox = new THREE.Box3().setFromObject(child);
      candidates.push({ child, worldBox });
    }
  });

  const { kept, groundY, heightFiltered } = filterMeshesByHeight(candidates, 2);
  console.log(`  Ground Y: ${groundY.toFixed(1)}, kept: ${kept.length}, filtered: ${heightFiltered}`);
  assert(heightFiltered >= 1, `Height filter removed ${heightFiltered} mesh(es) (ground plane)`);
  assert(kept.length >= 2, `Kept ${kept.length} meshes (walls + roof + door)`);

  // Build filtered group with baked transforms (same as voxelize-glb.ts does)
  const filtered = new THREE.Group();
  for (const { child } of kept) {
    const cloned = child.clone();
    cloned.applyMatrix4(child.matrixWorld);
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    cloned.updateMatrix();
    filtered.add(cloned);
  }

  // 3. Voxelize
  console.log('\n3. Voxelizing at 1 block/m (surface mode)...');
  const sampler = createDataTextureSampler();
  const grid = threeToGrid(filtered, 1, {
    textureSampler: sampler,
    mode: 'surface',
  });

  const trimmed = trimSparseBottomLayers(grid);
  const nonAir = trimmed.countNonAir();
  console.log(`  Grid: ${trimmed.width}x${trimmed.height}x${trimmed.length}`);
  console.log(`  Blocks: ${nonAir}`);
  console.log(`  Palette: ${[...trimmed.palette].join(', ')}`);

  // Dimension checks: house is ~10m wide (6m walls + 5m roof cone radius) x ~7m tall x ~10m deep
  assert(trimmed.width >= 4 && trimmed.width <= 14, `Width ${trimmed.width} in [4,14]`);
  assert(trimmed.height >= 4 && trimmed.height <= 12, `Height ${trimmed.height} in [4,12]`);
  assert(nonAir > 30, `Non-air: ${nonAir} > 30`);

  // Color diversity — the most important check.
  // With red walls (0xCC3333), brown roof (0x8B4513), blue door (0x2244AA)
  // we expect at least 3 distinct block types if colors are being sampled correctly.
  const paletteNames = [...trimmed.palette].map(([name]) => name).filter(n => n !== 'minecraft:air');
  console.log(`  Block types (${paletteNames.length}): ${paletteNames.join(', ')}`);
  assert(paletteNames.length >= 3, `Color diversity: ${paletteNames.length} block types (need ≥3 for red/brown/blue)`);

  // Check for specific color families — red walls should produce red/terracotta/brick blocks
  const hasRedish = paletteNames.some(n =>
    /red|terracotta|brick|nether|crimson/i.test(n));
  const hasBrownish = paletteNames.some(n =>
    /brown|dark_oak|spruce|jungle|mud|soul|mangrove|nether_brick/i.test(n));
  assert(hasRedish, `Found red-family block for walls: ${paletteNames.filter(n => /red|terracotta|brick|nether|crimson/i.test(n)).join(', ') || 'none'}`);
  assert(hasBrownish, `Found brown-family block for roof: ${paletteNames.filter(n => /brown|dark_oak|spruce|jungle|mud|soul|mangrove/i.test(n)).join(', ') || 'none'}`);

  // 4. Write .schem and verify round-trip
  console.log('\n4. .schem round-trip...');
  const schemPath = '/data/data/com.termux/files/home/test-house-pipeline.schem';
  writeSchematic(trimmed, schemPath);
  assert(existsSync(schemPath), '.schem file exists');

  const schemFile = Bun.file(schemPath);
  assert(schemFile.size > 100, `.schem size: ${schemFile.size} bytes`);

  // Read it back and verify dimensions match
  const parsed = await parseSchematic(schemPath);
  assert(parsed.width === trimmed.width, `Round-trip width: ${parsed.width} === ${trimmed.width}`);
  assert(parsed.height === trimmed.height, `Round-trip height: ${parsed.height} === ${trimmed.height}`);
  assert(parsed.length === trimmed.length, `Round-trip length: ${parsed.length} === ${trimmed.length}`);

  // Cleanup
  unlinkSync(schemPath);

  // Summary
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
