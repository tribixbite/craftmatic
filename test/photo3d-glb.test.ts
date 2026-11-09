/** GLB vertex-colour reader and closedness check (BIZ-39 / WP B15). The GLB is assembled by hand. */
import { describe, it, expect } from 'vitest';
import { readGlb, meshStats } from '../tools/photo3d/glb';

import { buildGlb, TETRA_V, TETRA_F, LINEAR } from './photo3d-glb-fixture';

describe('photo3d glb reader', () => {
  it('reads positions, faces and converts linear COLOR_0 to sRGB 0..255', () => {
    const g = readGlb(buildGlb(TETRA_V, TETRA_F, LINEAR));
    expect(g.vertices.length).toBe(12);
    expect(g.faces.length).toBe(12);
    // linear 0.5 -> sRGB 0.7354 -> 188; 1 -> 255; 0 -> 0.
    expect(Array.from(g.colours.slice(0, 3))).toEqual([188, 0, 0]);
    expect(Array.from(g.colours.slice(9, 12))).toEqual([255, 255, 255]);
    expect(g.hasVertexColour).toBe(true);
    expect(g.hasTexture).toBe(false);
  });

  it('applies the node transform', () => {
    const g = readGlb(buildGlb(TETRA_V, TETRA_F, LINEAR, { translation: [10, 0, 0] }));
    expect(g.vertices[0]).toBeCloseTo(10);
    expect(g.vertices[3]).toBeCloseTo(11);
  });

  it('falls back to mid grey with no colour attribute and flags a texture', () => {
    const g = readGlb(buildGlb(TETRA_V, TETRA_F, null, { texture: true }));
    expect(g.hasVertexColour).toBe(false);
    expect(g.hasTexture).toBe(true);
    expect(Array.from(g.colours.slice(0, 3))).toEqual([128, 128, 128]);
  });

  it('meshStats: a tetrahedron is closed, a single triangle is not', () => {
    expect(meshStats(readGlb(buildGlb(TETRA_V, TETRA_F, LINEAR)))).toMatchObject({
      closed: true,
      openEdges: 0,
      faces: 4,
      components: 1,
    });
    const tri = meshStats(readGlb(buildGlb([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], null)));
    expect(tri.closed).toBe(false);
    expect(tri.openEdges).toBe(3);
  });

  it('rejects bytes that are not a GLB', () => {
    expect(() => readGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(/GLB/);
  });
});
