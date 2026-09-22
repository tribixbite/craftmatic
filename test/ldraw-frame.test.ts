/**
 * The LDraw → scene / grid frame is a ROTATION, never a reflection.
 *
 * Found 2026-09-22: the viewer converted LDraw (Y down) to three.js (Y up) by
 * negating Y alone — determinant −1 — so every model rendered as its mirror
 * image and every baked export (GLB/OBJ/STL/3MF) was chirally wrong with
 * inward-facing normals. The block grid, the Java display entities and the
 * building shell's compensation (`SHELL_FRAME = −I`) carried the same mirror.
 * These tests pin the determinants and the winding so it cannot come back.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LDRAW_TO_SCENE_SIGN, ldrawInstanceMatrix, ldrawPointToScene, pushLdrawPointToScene } from '../web/src/viewer/ldraw/frame.js';
import { meshesToStlBinary, type ExportMeshLike } from '../web/src/viewer/exporter.js';
import { sceneGridPoint, yawForFacing } from '../web/src/engine/bedrock-scene-actors.js';
import { sceneGridVector } from '../web/src/engine/bedrock-coaster.js';
import { SHELL_FRAME } from '../web/src/engine/bedrock-building-shell.js';
import { ldrawToRenderRotation } from '../web/src/engine/ldraw-entity-compiler.js';
import { FRAME_SIGN } from '../web/src/engine/lxf-parser.js';
import { matrixToQuaternion } from '../web/src/engine/display-entities.js';
import { stairCodeForPlacement, decodeStairCode } from '../web/src/engine/block-shapes.js';

type V3 = readonly [number, number, number];

const det3 = (m: readonly number[]): number =>
  m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);

/** Row-major rotation about Y by `deg`, LDraw convention. */
const rotY = (deg: number): number[] => {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
/** Row-major rotation about X by `deg`. */
const rotX = (deg: number): number[] => {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const mul = (a: readonly number[], b: readonly number[]): number[] => {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j]! += a[i * 3 + k]! * b[k * 3 + j]!;
  return out;
};
const cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const apply4 = (m: THREE.Matrix4, v: V3): [number, number, number] => {
  const p = new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(m);
  return [p.x, p.y, p.z];
};

/**
 * A printed "F" — the simplest chiral glyph — as triangles on the TOP face of
 * an LDraw tile (top = y −8, the face a printed tile shows). Wound so that,
 * seen from the printed side (looking along +Y in LDraw, i.e. from above the
 * tile), every triangle is counter-clockwise. A mirror reverses that; a
 * rotation never does. 932 of 932 glyph triangles of 10261's `3069bp82`
 * reversed under the old Y-only flip; this is the same check on a synthetic
 * glyph so the test needs no part library.
 */
function printedGlyphTriangles(): Array<[V3, V3, V3]> {
  const y = -8;
  // Quads of the F in the tile's XZ plane (x right, z toward the viewer's feet
  // when the tile is read the right way up: the letter's top is at −z).
  const quads: Array<[number, number, number, number]> = [
    [-6, -8, -4, 8],   // stem
    [-4, -8, 6, -6],   // top bar
    [-4, -1, 3, 1],    // middle bar
  ];
  const tris: Array<[V3, V3, V3]> = [];
  for (const [x0, z0, x1, z1] of quads) {
    // Seen from above (from −Y looking toward +Y in LDraw, the printed side),
    // with x to the right, +z runs UP the page (right-handed: right × up =
    // −view), so (x0,z0)→(x1,z0)→(x1,z1) goes right then up: counter-clockwise.
    tris.push([[x0, y, z0], [x1, y, z0], [x1, y, z1]]);
    tris.push([[x0, y, z0], [x1, y, z1], [x0, y, z1]]);
  }
  return tris;
}

/** Winding of a triangle as seen by a viewer looking along `view` (+1 = counter-clockwise). */
function windingSeenFrom(t: [V3, V3, V3], view: V3): number {
  const n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
  // A viewer looking ALONG `view` sees the triangle counter-clockwise when its
  // normal points back at them, i.e. against the view direction.
  return Math.sign(-dot(n, view));
}

describe('LDraw → scene frame (frame.ts)', () => {
  it('is the half turn about X, det +1, the same matrix as FRAME_SIGN and ldrawToRenderRotation(+z)', () => {
    const [sx, sy, sz] = LDRAW_TO_SCENE_SIGN;
    expect(sx * sy * sz).toBe(1);
    expect([sx, sy, sz]).toEqual([1, -1, -1]);
    expect([...FRAME_SIGN]).toEqual([sx, sy, sz]);
    expect(ldrawToRenderRotation('+z')).toEqual([sx, 0, 0, 0, sy, 0, 0, 0, sz]);
    // LDraw −Z (the model's front) lands on scene +Z; LDraw down (+Y) on scene −Y.
    expect(ldrawPointToScene([0, 0, -1]).map(v => v + 0)).toEqual([0, 0, 1]);
    expect(ldrawPointToScene([0, 1, 0]).map(v => v + 0)).toEqual([0, -1, 0]);
    const out: number[] = [];
    pushLdrawPointToScene(out, [1, 2, 3], 2);
    expect(out).toEqual([2, -4, -6]);
  });

  it('ldrawInstanceMatrix has det = +scale³ · det(R) for proper and mirrored placements', () => {
    const scale = 1 / 20;
    const cases: Array<[string, number[]]> = [
      ['identity', [1, 0, 0, 0, 1, 0, 0, 0, 1]],
      ['yaw 90', rotY(90)],
      ['yaw 37 · pitch 22', mul(rotY(37), rotX(22))],
      ['mirrored sub-part (det −1)', [-1, 0, 0, 0, 1, 0, 0, 0, 1]],
      ['Studio 0.999988-scaled', [0.999988, 0, 0, 0, 0.999988, 0, 0, 0, 0.999988]],
    ];
    for (const [name, R] of cases) {
      const m = ldrawInstanceMatrix(R, [12, -34, 56], scale);
      expect(m.determinant(), name).toBeCloseTo(scale ** 3 * det3(R), 12);
    }
    // And the translation goes through the same frame as the rotation.
    const m = ldrawInstanceMatrix([1, 0, 0, 0, 1, 0, 0, 0, 1], [12, -34, 56], scale);
    expect(apply4(m, [0, 0, 0])).toEqual([12 * scale, 34 * scale, -56 * scale]);
  });

  it('keeps the winding of a printed glyph seen from the printed side (the check that found the mirror)', () => {
    const glyph = printedGlyphTriangles();
    expect(glyph).toHaveLength(6);
    // Sanity on the fixture: every triangle is counter-clockwise from the
    // printed side in LDraw (looking along +Y, down onto the tile's top).
    for (const t of glyph) expect(windingSeenFrom(t, [0, 1, 0])).toBe(1);

    const scale = 1 / 20;
    for (const R of [[1, 0, 0, 0, 1, 0, 0, 0, 1], rotY(90), rotY(180), mul(rotY(45), rotX(30))]) {
      const m = ldrawInstanceMatrix(R, [3, -5, 7], scale);
      // The printed side's view direction goes through the same transform (a
      // direction: no translation), so "seen from the printed side" is the
      // same physical viewpoint in the scene.
      const viewLdu: V3 = [R[1]!, R[4]!, R[7]!];  // R · (0, 1, 0)
      const viewScene: V3 = [viewLdu[0] * LDRAW_TO_SCENE_SIGN[0], viewLdu[1] * LDRAW_TO_SCENE_SIGN[1], viewLdu[2] * LDRAW_TO_SCENE_SIGN[2]];
      let reversed = 0;
      for (const t of glyph) {
        const s: [V3, V3, V3] = [apply4(m, t[0]), apply4(m, t[1]), apply4(m, t[2])];
        if (windingSeenFrom(s, viewScene) !== 1) reversed++;
      }
      expect(reversed).toBe(0);
    }
    // The old frame (Y alone) reversed every one of them.
    const mirror = new THREE.Matrix4().makeScale(1, -1, 1);
    let reversed = 0;
    for (const t of glyph) {
      const s: [V3, V3, V3] = [apply4(mirror, t[0]), apply4(mirror, t[1]), apply4(mirror, t[2])];
      if (windingSeenFrom(s, [0, -1, 0]) !== 1) reversed++;
    }
    expect(reversed).toBe(glyph.length);
  });
});

describe('baked STL keeps outward normals', () => {
  /** Parse a binary STL into facets with the normal recomputed from the vertex winding. */
  function facets(buf: ArrayBuffer): Array<{ written: V3; fromWinding: V3; centroid: V3 }> {
    const view = new DataView(buf);
    const n = view.getUint32(80, true);
    const out: Array<{ written: V3; fromWinding: V3; centroid: V3 }> = [];
    for (let t = 0; t < n; t++) {
      const base = 84 + t * 50;
      const f = (k: number): number => view.getFloat32(base + k * 4, true);
      const written: V3 = [f(0), f(1), f(2)];
      const a: V3 = [f(3), f(4), f(5)], b: V3 = [f(6), f(7), f(8)], c: V3 = [f(9), f(10), f(11)];
      const w = cross(sub(b, a), sub(c, a));
      const len = Math.hypot(...w) || 1;
      out.push({ written, fromWinding: [w[0] / len, w[1] / len, w[2] / len], centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
    }
    return out;
  }

  it('a box baked through the instance matrix has every facet normal pointing away from its centre', async () => {
    // BoxGeometry is wound counter-clockwise from outside. The instance
    // matrices are the viewer's own (rotation, position, LDU scale); under a
    // reflection every facet would point INTO the box.
    const geometry = new THREE.BoxGeometry(20, 24, 40);
    const placements: Array<[number[], V3]> = [[[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, -12, 0]], [rotY(90), [60, -12, -40]], [mul(rotY(30), rotX(10)), [-80, -36, 20]]];
    const mesh: ExportMeshLike = {
      geometry, material: new THREE.MeshStandardMaterial(),
      userData: { originalMatrices: placements.map(([R, T]) => ldrawInstanceMatrix(R, T, 1 / 20)) },
    };
    const buf = await meshesToStlBinary([mesh], 8);
    const all = facets(buf);
    expect(all).toHaveLength(12 * placements.length);
    // Group facets per instance by their order (STLExporter writes meshes in
    // sequence) and test each against its own box centre.
    for (let i = 0; i < placements.length; i++) {
      const group = all.slice(i * 12, (i + 1) * 12);
      const centre: V3 = group.reduce<[number, number, number]>((s, f) => [s[0] + f.centroid[0] / 12, s[1] + f.centroid[1] / 12, s[2] + f.centroid[2] / 12], [0, 0, 0]);
      for (const f of group) {
        expect(dot(f.fromWinding, sub(f.centroid, centre))).toBeGreaterThan(0);
        // The written normal agrees with the winding, so a slicer that trusts
        // either sees the same outside.
        expect(dot(f.written, f.fromWinding)).toBeGreaterThan(0.999);
      }
    }
  });
});

describe('the block grid and the Bedrock actors use the same rotation', () => {
  const frame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: 20, cellY: 8 };
  it('sceneGridPoint / sceneGridVector are the half turn about X per cell (det +1)', () => {
    const cols = [sceneGridVector(frame, [20, 0, 0]), sceneGridVector(frame, [0, 8, 0]), sceneGridVector(frame, [0, 0, 20])];
    const m = [cols[0]![0], cols[1]![0], cols[2]![0], cols[0]![1], cols[1]![1], cols[2]![1], cols[0]![2], cols[1]![2], cols[2]![2]];
    expect(m.map(v => v + 0)).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
    expect(det3(m)).toBe(1);
    expect(sceneGridPoint(frame, [40, -24, -60])).toEqual([2, 3, 3]);
  });
  it('a figure facing LDraw −Z (the front) faces world +Z, yaw 0', () => {
    expect(yawForFacing([0, -1])).toBe(0);
    expect(yawForFacing([0, 1])).toBe(180);
    expect(yawForFacing([1, 0])).toBe(-90);
    expect(yawForFacing([-1, 0])).toBe(90);
  });
  it('SHELL_FRAME is a proper rotation that lands the shell on the grid at yaw 0', () => {
    expect(det3(SHELL_FRAME)).toBe(1);
    expect([...SHELL_FRAME]).toEqual(ldrawToRenderRotation('-z'));
    // World at yaw 0 sees the render frame as (−x, y, −z) (extraPlacement,
    // Pixel-proven); composed with SHELL_FRAME that must be the grid's frame.
    const world = mul([-1, 0, 0, 0, 1, 0, 0, 0, -1], SHELL_FRAME);
    expect(world.map(v => v + 0)).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
  });
  it('Java display entities conjugate the rotation by the same frame', () => {
    // A roll about X keeps its sign (the half turn is about X itself), and a
    // yaw about LDraw's Y, which points DOWN, is the opposite yaw about
    // Minecraft's up. The old Y-only mirror kept the yaw and flipped the roll.
    const q = matrixToQuaternion(rotX(90));
    expect(q.map(v => v + 0)).toEqual([0.7071, 0, 0, 0.7071]);
    const y = matrixToQuaternion(rotY(90));
    expect(y.map(v => v + 0)).toEqual([0, -0.7071, 0, 0.7071]);
  });
  it('a slope rising toward LDraw +Z becomes a stair facing north (grid +Z is LDraw −Z)', () => {
    expect(decodeStairCode(stairCodeForPlacement({ ux: 0, uz: 1, inverted: false }, [1, 0, 0, 0, 1, 0, 0, 0, 1]))!.facing).toBe('north');
    expect(decodeStairCode(stairCodeForPlacement({ ux: 1, uz: 0, inverted: false }, [1, 0, 0, 0, 1, 0, 0, 0, 1]))!.facing).toBe('east');
  });
});
