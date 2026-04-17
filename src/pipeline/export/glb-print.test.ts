import { describe, it, expect } from 'vitest';
import { exportPrintGlb } from './glb-print.js';
import { parseGlbJson } from './glb-writer.js';
import type { BuildingBRep, MaterialRef } from '../synthesis/brep.js';
import type { LocalPoint2D } from '../context/types.js';

function mat(block: string): MaterialRef {
  return { blockName: block, lab: [60, 0, 0] };
}

function boxBrep(): BuildingBRep {
  const SQ = 10;
  const poly: LocalPoint2D[] = [
    { x: -SQ / 2, z: -SQ / 2 },
    { x:  SQ / 2, z: -SQ / 2 },
    { x:  SQ / 2, z:  SQ / 2 },
    { x: -SQ / 2, z:  SQ / 2 },
  ];
  return {
    origin: { lat: 0, lng: 0 }, rotationDeg: 0,
    floors: [{ level: 0, elevationM: 0, thicknessM: 0.3, polygon: poly }],
    walls: [
      { level: 0, facadeEdge: 0, start: poly[0], end: poly[1],
        heightM: 3, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 1, start: poly[1], end: poly[2],
        heightM: 3, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 2, start: poly[2], end: poly[3],
        heightM: 3, thicknessM: 0.3, material: 'wall' },
      { level: 0, facadeEdge: 3, start: poly[3], end: poly[0],
        heightM: 3, thicknessM: 0.3, material: 'wall' },
    ],
    roof: { type: 'flat', baseZ: 3.3, peakZ: 3.8, pitchDeg: 0, polygon: poly, params: {} },
    details: [],
    materials: {
      wall: mat('minecraft:stone_bricks'),
      trim: mat('minecraft:smooth_stone'),
      roof: mat('minecraft:deepslate_tiles'),
      window: mat('minecraft:glass'),
    },
  };
}

describe('exportPrintGlb', () => {
  it('produces a watertight structural group', async () => {
    const result = await exportPrintGlb(boxBrep());
    expect(result.watertight).toBe(true);
    expect(result.structuralVolume).toBeGreaterThan(0);
    expect(result.glbBytes.byteLength).toBeGreaterThan(0);

    const root = parseGlbJson(result.glbBytes);
    expect(root.nodes.length).toBe(1);
    expect(root.nodes[0].name).toBe('group_structural');
    expect(result.hasPlinth).toBe(false);
  });

  it('adds plinth group when requested', async () => {
    const result = await exportPrintGlb(boxBrep(), { plinth: true });
    expect(result.hasPlinth).toBe(true);
    const root = parseGlbJson(result.glbBytes);
    expect(root.nodes.length).toBe(2);
    expect(root.nodes.map(n => n.name)).toContain('group_plinth');
  });

  it('structural material carries minecraftBlock extras', async () => {
    const result = await exportPrintGlb(boxBrep());
    const root = parseGlbJson(result.glbBytes);
    expect(root.materials[0].extras).toEqual({ minecraftBlock: 'minecraft:stone_bricks' });
  });

  it('plinth mesh is physically below ground (y ≤ 0)', async () => {
    const result = await exportPrintGlb(boxBrep(), { plinth: true });
    const root = parseGlbJson(result.glbBytes);
    // Plinth is the second mesh; its POSITION accessor min.y should be < 0
    // (we stored bounds in the accessor via addAccessor)
    const plinthMeshIdx = 1;
    const plinthPrim = root.meshes[plinthMeshIdx].primitives[0];
    const posAccessor = root.accessors[plinthPrim.attributes['POSITION']];
    expect(posAccessor.min).toBeDefined();
    expect(posAccessor.min![1]).toBeLessThan(0);
  });
});
