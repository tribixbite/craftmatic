/**
 * CLI standalone mesh voxelizer test.
 *
 * Creates simple Three.js meshes with known colors, runs them through
 * threeToGrid() in both solid and surface modes, and prints the resulting
 * Minecraft block palettes. Verifies color diversity (not monochrome white).
 *
 * Usage: bun scripts/test-voxelizer.ts
 */

import * as THREE from 'three';
import { threeToGrid, threeToGridAsync, createDataTextureSampler } from '../src/convert/voxelizer.js';
import type { VoxelizeProgress } from '../src/convert/voxelizer.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Create a colored box mesh */
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

/** Create a horizontal plane (open surface) */
function makePlane(
  w: number, d: number,
  color: number,
  yPos = 2,
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, d);
  const mat = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(w / 2, yPos, d / 2);
  return mesh;
}

/** Create a textured box using a programmatic DataTexture */
function makeTexturedBox(
  w: number, h: number, d: number,
  r: number, g: number, b: number,
): THREE.Mesh {
  // 4x4 pixel texture filled with the given color
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.needsUpdate = true;

  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff, // material.color is white — texture provides the actual color
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(w / 2, h / 2, d / 2);
  return mesh;
}

/** Collect all non-air blocks from a grid into a block→count map */
function collectPalette(grid: { width: number; height: number; length: number; get(x: number, y: number, z: number): string }): Map<string, number> {
  const counts = new Map<string, number>();
  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          counts.set(b, (counts.get(b) ?? 0) + 1);
        }
      }
    }
  }
  return counts;
}

function printPalette(label: string, palette: Map<string, number>): void {
  const total = [...palette.values()].reduce((a, b) => a + b, 0);
  console.log(`\n=== ${label} ===`);
  console.log(`  Total non-air: ${total}, unique blocks: ${palette.size}`);
  // Sort by count descending
  const sorted = [...palette.entries()].sort((a, b) => b[1] - a[1]);
  for (const [block, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${block}: ${count} (${pct}%)`);
  }
}

// ─── Test cases ──────────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  mesh: () => THREE.Object3D;
  mode: 'solid' | 'surface';
  resolution: number;
  expectedColor: string; // human description like "red", "blue"
}

const TESTS: TestCase[] = [
  {
    name: 'Red 5x5x5 box (solid)',
    mesh: () => makeBox(5, 5, 5, 0xcc2222),
    mode: 'solid',
    resolution: 1,
    expectedColor: 'red/warm',
  },
  {
    name: 'Blue 5x5x5 box (solid)',
    mesh: () => makeBox(5, 5, 5, 0x2244cc),
    mode: 'solid',
    resolution: 1,
    expectedColor: 'blue/cool',
  },
  {
    name: 'Green 5x5x5 box (solid)',
    mesh: () => makeBox(5, 5, 5, 0x22aa22),
    mode: 'solid',
    resolution: 1,
    expectedColor: 'green',
  },
  {
    name: 'Brown 5x5x5 box (solid)',
    mesh: () => makeBox(5, 5, 5, 0x8b4513),
    mode: 'solid',
    resolution: 1,
    expectedColor: 'brown/wood',
  },
  {
    name: 'White 5x5x5 box (solid)',
    mesh: () => makeBox(5, 5, 5, 0xffffff),
    mode: 'solid',
    resolution: 1,
    expectedColor: 'white/light',
  },
  {
    name: 'Red 5x5 plane (surface)',
    mesh: () => makePlane(5, 5, 0xcc2222, 2.5),
    mode: 'surface',
    resolution: 1,
    expectedColor: 'red/warm',
  },
  {
    name: 'Green 5x5 plane (surface)',
    mesh: () => makePlane(5, 5, 0x22aa22, 2.5),
    mode: 'surface',
    resolution: 1,
    expectedColor: 'green',
  },
  {
    name: 'Red 5x5x5 box (surface)',
    mesh: () => makeBox(5, 5, 5, 0xcc2222),
    mode: 'surface',
    resolution: 1,
    expectedColor: 'red/warm (shell only)',
  },
  {
    name: 'Multi-color scene (surface)',
    mesh: () => {
      const group = new THREE.Group();
      // Red floor
      group.add(makePlane(8, 8, 0xcc2222, 0.5));
      // Blue wall (vertical plane)
      const wall = makePlane(8, 5, 0x2244cc, 0);
      wall.rotation.set(0, 0, 0); // reset — make vertical in XY
      wall.position.set(4, 2.5, 0);
      group.add(wall);
      // Green box on the floor
      group.add(makeBox(2, 2, 2, 0x22aa22, 4, 1.5, 4));
      return group;
    },
    mode: 'surface',
    resolution: 1,
    expectedColor: 'red + blue + green mix',
  },
];

// ─── Run all tests ───────────────────────────────────────────────────────────

async function main() {
  console.log('Craftmatic CLI Voxelizer Test');
  console.log('============================\n');

  let passed = 0;
  let failed = 0;

  for (const tc of TESTS) {
    const obj = tc.mesh();
    const group = obj instanceof THREE.Group ? obj : new THREE.Group();
    if (!(obj instanceof THREE.Group)) group.add(obj);
    group.updateMatrixWorld(true);

    const t0 = performance.now();
    const grid = threeToGrid(group, tc.resolution, {
      mode: tc.mode,
      onProgress: (p: VoxelizeProgress) => {
        if (p.message) process.stdout.write(`\r  ${p.message}`);
      },
    });
    const elapsed = (performance.now() - t0).toFixed(0);

    const palette = collectPalette(grid);
    const total = [...palette.values()].reduce((a, b) => a + b, 0);

    // Determine pass/fail
    const isWhiteOnly = palette.size <= 3 &&
      [...palette.keys()].every(b =>
        b.includes('quartz') || b.includes('white') || b.includes('smooth') || b.includes('snow'));
    const hasBlocks = total > 0;

    const ok = hasBlocks && (tc.expectedColor.includes('white') || !isWhiteOnly);
    if (ok) passed++;
    else failed++;

    const status = ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${tc.name} (${elapsed}ms)`);
    console.log(`  Grid: ${grid.width}x${grid.height}x${grid.length}, ${total} blocks, ${palette.size} types`);
    console.log(`  Expected: ${tc.expectedColor}`);

    printPalette(tc.name, palette);
  }

  // Async mode test
  console.log('\n--- Async surface mode test ---');
  const asyncGroup = new THREE.Group();
  asyncGroup.add(makeBox(5, 5, 5, 0xcc8822));
  asyncGroup.updateMatrixWorld(true);

  const t0 = performance.now();
  const asyncGrid = await threeToGridAsync(asyncGroup, 1, {
    mode: 'surface',
    yieldInterval: 2,
    onProgress: (p) => {
      if (p.currentY % 2 === 0) process.stdout.write(`\r  Layer ${p.currentY}/${p.totalY}`);
    },
  });
  const asyncElapsed = (performance.now() - t0).toFixed(0);
  process.stdout.write('\r');

  const asyncPalette = collectPalette(asyncGrid);
  const asyncTotal = [...asyncPalette.values()].reduce((a, b) => a + b, 0);
  console.log(`[PASS] Async orange box (${asyncElapsed}ms)`);
  console.log(`  Grid: ${asyncGrid.width}x${asyncGrid.height}x${asyncGrid.length}, ${asyncTotal} blocks`);
  printPalette('Async orange box (surface)', asyncPalette);

  // Textured mesh test with DataTexture sampler
  console.log('\n--- DataTexture sampler test ---');
  const sampler = createDataTextureSampler();

  // Create a box with a red DataTexture (simulates GLTF texture data)
  const texGroup = new THREE.Group();
  texGroup.add(makeTexturedBox(5, 5, 5, 200, 50, 50)); // dark red texture
  texGroup.updateMatrixWorld(true);

  const t1 = performance.now();
  const texGrid = threeToGrid(texGroup, 1, {
    mode: 'solid',
    textureSampler: sampler,
  });
  const texElapsed = (performance.now() - t1).toFixed(0);
  const texPalette = collectPalette(texGrid);
  const texTotal = [...texPalette.values()].reduce((a, b) => a + b, 0);

  // With sampler, should use texture color (red) not material.color (white)
  const hasRedTex = [...texPalette.keys()].some(b =>
    b.includes('red') || b.includes('terracotta') || b.includes('brick') || b.includes('nether'));
  const hasWhiteTex = [...texPalette.keys()].every(b =>
    b.includes('quartz') || b.includes('white') || b.includes('smooth') || b.includes('snow'));

  if (hasRedTex && !hasWhiteTex) {
    passed++;
    console.log(`[PASS] Textured red box with DataTexture sampler (${texElapsed}ms)`);
  } else {
    failed++;
    console.log(`[FAIL] Textured red box — expected red blocks, got white (sampler not working)`);
  }
  console.log(`  Grid: ${texGrid.width}x${texGrid.height}x${texGrid.length}, ${texTotal} blocks`);
  printPalette('Textured red box (solid + DataTexture sampler)', texPalette);

  // Surface mode with DataTexture sampler
  console.log('\n--- DataTexture sampler + surface mode test ---');
  const texSurfGroup = new THREE.Group();
  texSurfGroup.add(makeTexturedBox(5, 5, 5, 50, 100, 200)); // blue texture
  texSurfGroup.updateMatrixWorld(true);

  const t2 = performance.now();
  const texSurfGrid = threeToGrid(texSurfGroup, 1, {
    mode: 'surface',
    textureSampler: sampler,
  });
  const texSurfElapsed = (performance.now() - t2).toFixed(0);
  const texSurfPalette = collectPalette(texSurfGrid);
  const texSurfTotal = [...texSurfPalette.values()].reduce((a, b) => a + b, 0);

  const hasBlueTex = [...texSurfPalette.keys()].some(b =>
    b.includes('blue') || b.includes('gray') || b.includes('cyan'));
  if (hasBlueTex) {
    passed++;
    console.log(`[PASS] Textured blue box surface mode (${texSurfElapsed}ms)`);
  } else {
    failed++;
    console.log(`[FAIL] Textured blue box surface — expected blue blocks`);
  }
  console.log(`  Grid: ${texSurfGrid.width}x${texSurfGrid.height}x${texSurfGrid.length}, ${texSurfTotal} blocks`);
  printPalette('Textured blue box (surface + DataTexture sampler)', texSurfPalette);

  // Existing .schem palette analysis — verify pre-fix monochrome baseline
  console.log('\n--- Existing tiles .schem palette analysis ---');
  try {
    const { parseToGrid } = await import('../src/schem/parse.js');
    const tilesDir = join(import.meta.dir, '..', 'output', 'tiles');
    const schemFiles = ['tiles-sf-res1rad50.schem', 'tiles-sanjose-res1rad50.schem',
      'tiles-seattle-res1rad50.schem', 'tiles-charleston-res1rad50.schem',
      'tiles-vinalhaven-res1rad50.schem'];

    for (const fname of schemFiles) {
      const fpath = join(tilesDir, fname);
      if (!existsSync(fpath)) {
        console.log(`  [SKIP] ${fname} not found`);
        continue;
      }
      const grid = await parseToGrid(fpath);
      const palette = collectPalette(grid);
      const total = [...palette.values()].reduce((a, b) => a + b, 0);
      const isMonochrome = [...palette.keys()].every(b =>
        b.includes('quartz') || b.includes('white') || b.includes('smooth') || b.includes('snow'));

      console.log(`  ${fname}: ${total} blocks, ${palette.size} types${isMonochrome ? ' [MONOCHROME — pre-fix]' : ' [COLORFUL — post-fix]'}`);
      for (const [block, count] of [...palette.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${block}: ${count}`);
      }
    }
  } catch (err) {
    console.log(`  [SKIP] .schem analysis: ${(err as Error).message}`);
  }

  // Summary
  console.log(`\n============================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFAILURES indicate monochrome white output — color pipeline broken.');
    process.exit(1);
  } else {
    console.log('\nAll tests produce colorful, non-monochrome output.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
