import { describe, it, expect } from 'vitest';
import { buildGlb, parseGlbJson, type MeshInput } from './glb-writer.js';

// Unit cube 0-1 in each axis, 12 triangles (two per face).
function unitCube(): MeshInput {
  const position = new Float32Array([
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0, // back
    0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1, // front
  ]);
  const index = new Uint32Array([
    0, 1, 2,  0, 2, 3,    // back
    4, 5, 6,  4, 6, 7,    // front
    0, 1, 5,  0, 5, 4,    // bottom
    2, 3, 7,  2, 7, 6,    // top
    0, 3, 7,  0, 7, 4,    // left
    1, 2, 6,  1, 6, 5,    // right
  ]);
  return { position, index };
}

describe('buildGlb', () => {
  it('produces a valid GLB with a single untextured mesh', () => {
    const glb = buildGlb([unitCube()]);
    const view = new DataView(glb);
    // Magic = 'glTF'
    expect(view.getUint32(0, true)).toBe(0x46546C67);
    // Version = 2
    expect(view.getUint32(4, true)).toBe(2);
    // Total length matches buffer
    expect(view.getUint32(8, true)).toBe(glb.byteLength);

    const root = parseGlbJson(glb);
    expect(root.meshes.length).toBe(1);
    expect(root.nodes.length).toBe(1);
    expect(root.materials.length).toBe(1);
    expect(root.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([0.5, 0.5, 0.5, 1]);
    expect(root.textures).toBeUndefined();
    expect(root.images).toBeUndefined();
  });

  it('emits scene-node names when meshes carry groupName', () => {
    const a: MeshInput = { ...unitCube(), groupName: 'group_structural' };
    const b: MeshInput = { ...unitCube(), groupName: 'group_plinth' };
    const root = parseGlbJson(buildGlb([a, b]));
    expect(root.nodes.map(n => n.name)).toEqual(['group_structural', 'group_plinth']);
  });

  it('attaches baseColorFactor override', () => {
    const red: MeshInput = { ...unitCube(), baseColorFactor: [1, 0, 0, 1] };
    const root = parseGlbJson(buildGlb([red]));
    expect(root.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 1]);
  });

  it('emits material.extras.minecraftBlock when provided', () => {
    const cube = unitCube();
    const root = parseGlbJson(buildGlb([cube], { minecraftBlocks: ['minecraft:stone_bricks'] }));
    expect(root.materials[0].extras).toEqual({ minecraftBlock: 'minecraft:stone_bricks' });
  });

  it('4-byte aligns JSON + BIN chunks', () => {
    const glb = buildGlb([unitCube()]);
    const view = new DataView(glb);
    const jsonLen = view.getUint32(12, true);
    expect(jsonLen % 4).toBe(0);
    const binOff = 20 + jsonLen;
    const binLen = view.getUint32(binOff, true);
    expect(binLen % 4).toBe(0);
  });

  it('handles SharedArrayBuffer-backed typed arrays by copying', () => {
    // Simulate a typed array whose buffer isn't a plain ArrayBuffer —
    // we construct one via a subarray that has non-zero byteOffset, which
    // exercises the same copy-on-write code path.
    const big = new Float32Array(30);
    big.set([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
             0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], 6);
    const offsetView = big.subarray(6, 30);
    // Despite the offset, buildGlb must produce a valid GLB.
    const mesh: MeshInput = { position: offsetView, index: unitCube().index! };
    const glb = buildGlb([mesh]);
    expect(parseGlbJson(glb).meshes.length).toBe(1);
  });

  it('accepts multiple meshes and numbers nodes+meshes+materials in lockstep', () => {
    const glb = buildGlb([unitCube(), unitCube(), unitCube()]);
    const root = parseGlbJson(glb);
    expect(root.meshes.length).toBe(3);
    expect(root.nodes.length).toBe(3);
    expect(root.materials.length).toBe(3);
    expect(root.scenes[0].nodes).toEqual([0, 1, 2]);
  });
});
