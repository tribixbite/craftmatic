import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { filterMeshesByHeight, trimSparseBottomLayers, type MeshCandidate } from './mesh-utils.js';
import { BlockGrid } from '../../schem/types.js';

function mk(minY: number, maxY: number): MeshCandidate {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, maxY - minY, 1));
  const worldBox = new THREE.Box3(
    new THREE.Vector3(0, minY, 0),
    new THREE.Vector3(1, maxY, 1),
  );
  return { child: mesh, worldBox };
}

describe('filterMeshesByHeight', () => {
  it('empty → zeros', () => {
    const r = filterMeshesByHeight([], 3);
    expect(r.kept).toEqual([]);
    expect(r.groundY).toBe(0);
    expect(r.heightFiltered).toBe(0);
  });

  it('flat meshes filtered, tall meshes kept', () => {
    // Three sidewalks at y=0→0.5 (flat), one building y=0→30 (tall)
    const candidates = [mk(0, 0.5), mk(0, 0.5), mk(0, 0.5), mk(0, 30)];
    const r = filterMeshesByHeight(candidates, 3);
    expect(r.kept.length).toBe(1);
    expect(r.heightFiltered).toBe(3);
  });

  it('ground level is the median of mesh min-Y', () => {
    const candidates = [mk(-5, 5), mk(-5, 5), mk(0, 10), mk(5, 15), mk(5, 15)];
    const r = filterMeshesByHeight(candidates, 1);
    expect(r.groundY).toBe(0); // median of [-5,-5,0,5,5]
  });
});

describe('trimSparseBottomLayers', () => {
  it('returns same grid when nothing to trim', () => {
    const g = new BlockGrid(4, 4, 4);
    // Fill everything
    for (let y = 0; y < 4; y++)
      for (let z = 0; z < 4; z++)
        for (let x = 0; x < 4; x++)
          g.set(x, y, z, 'minecraft:stone');
    const out = trimSparseBottomLayers(g);
    expect(out.height).toBe(4);
  });

  it('removes sparse bottom layers below fillThreshold', () => {
    const g = new BlockGrid(10, 5, 10);
    // Fill top 3 layers (y=2,3,4) densely; leave y=0,1 empty/sparse
    for (let y = 2; y < 5; y++)
      for (let z = 0; z < 10; z++)
        for (let x = 0; x < 10; x++)
          g.set(x, y, z, 'minecraft:stone');
    // Sparse 1 block at y=0
    g.set(0, 0, 0, 'minecraft:dirt');
    const out = trimSparseBottomLayers(g);
    expect(out.height).toBe(3);
  });

  it('returns original when no layer meets threshold', () => {
    const g = new BlockGrid(10, 5, 10);
    // Only 1 block per layer = 1% fill
    for (let y = 0; y < 5; y++) g.set(0, y, 0, 'minecraft:stone');
    const out = trimSparseBottomLayers(g, 0.05);
    expect(out.height).toBe(5);
  });
});
