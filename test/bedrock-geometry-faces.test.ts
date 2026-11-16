/**
 * The render-fault arithmetic behind the 2026-09-25 device report (hatching
 * and strobing on every model): Bedrock's rotation convention in the geometry
 * JSON's own frame, the JSON -> world Z mirror, coplanar-face detection and
 * the export-time separation that removes it.
 */
import { describe, expect, it } from 'vitest';
import {
  COPLANAR_SEPARATION_UNITS, apply, coplanarFaces, pivotRotation, separateCoplanarFaces, visibleCoplanarHits, worldFaces,
  type GeoEntryLike, type Vec3,
} from '../web/src/engine/bedrock-geometry-faces.js';
import { eulerZYX } from '../web/src/engine/ldraw-entity-compiler.js';
import { buildAddonAppearance } from '../web/src/ui/addon-appearance.js';

const DEG = Math.PI / 180;
const mat = (m: number[], v: Vec3): Vec3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
const Rx = (a: number): number[] => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const Ry = (a: number): number[] => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const Rz = (a: number): number[] => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const mul3 = (a: number[], b: number[]): number[] => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));

describe('pivotRotation: the compiler writes M as (−a, −b, c) under an X mirror', () => {
  it('turns a JSON point exactly as M turns the render point it mirrors', () => {
    // A render-frame turn with all three angles non-zero, through the compiler's own Euler extraction.
    const M = mul3(Rz(33 * DEG), mul3(Ry(-51 * DEG), Rx(17 * DEG)));
    const [a, b, c] = eulerZYX(M);
    const json: Vec3 = [-a, -b, c]; // what jsonBone writes
    const p: Vec3 = [3, -7, 11]; // render frame
    const want = mat(M, p);
    const got = apply(pivotRotation(json, [0, 0, 0]), [-p[0], p[1], p[2]]); // JSON mirrors X
    expect(got[0]).toBeCloseTo(-want[0], 1);
    expect(got[1]).toBeCloseTo(want[1], 1);
    expect(got[2]).toBeCloseTo(want[2], 1);
  });
});

describe('worldFaces: JSON to world', () => {
  it('mirrors Z into the world, so an entity\'s parts land on the side the game draws them', () => {
    const entry: GeoEntryLike = { bones: [{ name: 'body', pivot: [0, 0, 0] }], groups: [{ ldrawColor: 4, alpha: 1, cubes: [{ bone: 'body', origin: [0, 0, 16], size: [16, 16, 16] }] }] };
    const faces = worldFaces([{ typeId: 't', kind: 'shell', entry, at: { x: 10, y: 0, z: 10 }, yawDeg: 0 }]);
    const zs = faces.flatMap(f => f.corners.map(c => c[2] / 16));
    expect(Math.min(...zs)).toBeCloseTo(8, 6);
    expect(Math.max(...zs)).toBeCloseTo(9, 6);
    // Normals point OUT of the cube despite the mirror.
    const up = faces.find(f => f.face === 'up')!;
    expect(up.normal[1]).toBeCloseTo(1, 6);
  });

  it('turns an actor by its BEDROCK yaw: at yaw 90 the model\'s +X runs along world +Z, as the wand turns the colliders (2026-09-30)', () => {
    // A cube one block out along JSON +X (X is not mirrored). The wand's quarter turn (`rotatePlacementPoint`, 90)
    // carries the model's +X to world +Z, and it sets the shell's yaw to 90; the drawn cube must follow.
    const entry: GeoEntryLike = { bones: [{ name: 'body', pivot: [0, 0, 0] }], groups: [{ ldrawColor: 4, alpha: 1, cubes: [{ bone: 'body', origin: [16, 0, -8], size: [16, 16, 16] }] }] };
    const centre = (yawDeg: number): Vec3 => {
      const cs = worldFaces([{ typeId: 't', kind: 'shell', entry, at: { x: 0, y: 0, z: 0 }, yawDeg }]).flatMap(f => f.corners);
      const mid = (i: 0 | 1 | 2): number => (Math.min(...cs.map(c => c[i])) + Math.max(...cs.map(c => c[i]))) / 2 / 16;
      return [mid(0), mid(1), mid(2)];
    };
    const at0 = centre(0), at90 = centre(90);
    expect(at0[0]).toBeCloseTo(1.5, 6);
    expect(at0[2]).toBeCloseTo(0, 6);
    expect(at90[0]).toBeCloseTo(0, 6);
    expect(at90[2]).toBeCloseTo(1.5, 6);
  });
});

/** A 3 x 3 red plate with a white tile sunk flush into its top: the source-overlap shape behind the hatching. */
const sunkTile = (): GeoEntryLike => ({
  bones: [{ name: 'body', pivot: [0, 0, 0] }],
  groups: [
    { ldrawColor: 4, alpha: 1, cubes: [{ bone: 'body', origin: [0, 0, 0], size: [18, 2.4, 18] }] },
    { ldrawColor: 15, alpha: 1, cubes: [{ bone: 'body', origin: [6, 0.6, 6], size: [6, 1.8, 6] }] },
  ],
});

describe('coplanar faces', () => {
  const self = (entry: GeoEntryLike) => worldFaces([{ typeId: 't', kind: 'shell', entry, at: { x: 0, y: 0, z: 0 }, yawDeg: 0 }]);

  it('finds a tile sunk flush into a plate: two colours on one plane', () => {
    const { hits } = coplanarFaces(self(sunkTile()));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.area).toBeCloseTo(36, 6);
    expect(hits[0]!.normal[1]).toBeCloseTo(1, 6);
  });

  it('separates it by pushing the smaller face out, and leaves nothing on the plane', () => {
    const entry = sunkTile();
    const r = separateCoplanarFaces(entry);
    expect(r).toMatchObject({ pairsFound: 1, facesGrown: 1, pairsLeft: 0 });
    const tile = entry.groups[1]!.cubes[0]!;
    expect(tile.origin).toEqual([6, 0.6, 6]);
    expect(tile.size[1]).toBeCloseTo(1.8 + COPLANAR_SEPARATION_UNITS, 2);
    expect(entry.groups[0]!.cubes[0]!.size).toEqual([18, 2.4, 18]);
    expect(coplanarFaces(self(entry)).hits).toHaveLength(0);
  });

  it('leaves alone a pair pressed flat against a third face (nobody can see it)', () => {
    const entry = sunkTile();
    // A blue plate lying ON the red one covers the tile's top completely.
    entry.groups.push({ ldrawColor: 1, alpha: 1, cubes: [{ bone: 'body', origin: [0, 2.4, 0], size: [18, 2.4, 18] }] });
    const r = separateCoplanarFaces(entry);
    expect(r.pairsFound).toBe(0);
    expect(entry.groups[1]!.cubes[0]!.size[1]).toBe(1.8);
    expect(coplanarFaces(self(entry)).hits).toHaveLength(1);
    expect(visibleCoplanarHits(self(entry))).toHaveLength(0);
  });

  it('never moves a face decal: the fringe on its plane goes in front', () => {
    const entry: GeoEntryLike = {
      bones: [{ name: 'head', pivot: [0, 0, 0] }],
      groups: [
        { ldrawColor: 0, alpha: 1, cubes: [{ bone: 'head', origin: [0, 6, 0], size: [8, 2, 1] }] },
        { ldrawColor: null, alpha: 1, texture: { path: 'faces' }, cubes: [{ bone: 'head', origin: [0, 0, 0], size: [8, 8, 0.2], faceUv: { face: 'north', uv: [0, 0], size: [8, 8] } }] },
      ],
    };
    const r = separateCoplanarFaces(entry);
    expect(r.facesGrown).toBe(1);
    expect(entry.groups[1]!.cubes[0]!.origin).toEqual([0, 0, 0]);
    expect(entry.groups[0]!.cubes[0]!.origin[2]).toBeLessThan(0);
  });

  it('finds a pair whose normals straddle a quantisation step (two bones turned 0.028 and 0.029 degrees) (A-17)', () => {
    // 76269's shell shipped 121 such pairs on its turned floor: two Euler spellings of one tilt round their normals
    // into neighbouring 1e-3 buckets, so the per-bucket sweep never compared them and the separation never ran.
    const deg = (s: number): number => Math.asin(s) / DEG;
    const entry = sunkTile();
    entry.bones = [{ name: 'a', pivot: [0, 0, 0], rotation: [0, 0, deg(0.00049)] }, { name: 'b', pivot: [0, 0, 0], rotation: [0, 0, deg(0.00051)] }];
    entry.groups[0]!.cubes[0]!.bone = 'a';
    entry.groups[1]!.cubes[0]!.bone = 'b';
    const faces = self(entry);
    const tops = faces.filter(f => f.face === 'up');
    expect(new Set(tops.map(f => Math.round(f.normal[0] * 1e3))).size).toBe(2);
    expect(coplanarFaces(faces).hits).toHaveLength(1);
    expect(separateCoplanarFaces(entry)).toMatchObject({ pairsFound: 1, pairsLeft: 0 });
  });

  it('runs until a CHAIN of pushes settles: each pushed face meets the next one up (A-17)', () => {
    // Six nested blocks of six colours: the second's top sits on the first's plane, and every later top sits one
    // separation above the one before, so each push lands the winner on the next plane. Three passes (the cap
    // until 2026-11-15) left the last pair on one plane; 530 such pairs survived in 11374's shell.
    const step = COPLANAR_SEPARATION_UNITS;
    const entry: GeoEntryLike = { bones: [{ name: 'body', pivot: [0, 0, 0] }], groups: [] };
    for (let k = 0; k < 6; k++) {
      const inset = k * 1.5, top = k === 0 ? 0 : (k - 1) * step;
      entry.groups.push({ ldrawColor: k + 1, alpha: 1, cubes: [{ bone: 'body', origin: [inset, -4 - k, inset], size: [18 - 2 * inset, top + 4 + k, 18 - 2 * inset] }] });
    }
    const r = separateCoplanarFaces(entry);
    expect(r.pairsFound).toBe(1);
    expect(r.pairsLeft).toBe(0);
    expect(visibleCoplanarHits(self(entry))).toHaveLength(0);
  });

  it('resolves a coplanar pair on a turned bone along that bone\'s own face', () => {
    const entry = sunkTile();
    entry.bones = [{ name: 'body', pivot: [0, 0, 0] }, { name: 'r1', pivot: [9, 0, 9], rotation: [0, 37, 0] }];
    for (const g of entry.groups) for (const c of g.cubes) c.bone = 'r1';
    expect(separateCoplanarFaces(entry)).toMatchObject({ pairsFound: 1, pairsLeft: 0 });
  });
});

describe('addon-appearance: the LOD hull is far-only', () => {
  it('marks a `<=` distance controller far, so a close-up view or audit skips it', () => {
    const geo = (id: string) => JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: id, texture_width: 16, texture_height: 16 }, bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [1, 1, 1], uv: [0, 0] }] }] }] });
    const rc = (geoKey: string, op: string) => ({ arrays: { geometries: { 'Array.g': [`Geometry.${geoKey}`, 'Geometry.empty'] } }, geometry: `Array.g[query.distance_from_camera ${op} 96]`, textures: ['Texture.default'], materials: [{ '*': 'Material.default' }] });
    const sources = new Map<string, string>([
      ['RP/models/entity/a.geo.json', geo('geometry.a_mesh_0')],
      ['RP/models/entity/b.geo.json', geo('geometry.a_mesh_1')],
      ['RP/render_controllers/a.render_controllers.json', JSON.stringify({ format_version: '1.8.0', render_controllers: { 'controller.render.a_0': rc('mesh_0', '>'), 'controller.render.a_1': rc('mesh_1', '<=') } })],
      ['RP/entity/a.entity.json', JSON.stringify({ format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: 'craftmatic:a', textures: { default: 'textures/entity/craftmatic_swatch_4' }, geometry: { mesh_0: 'geometry.a_mesh_0', mesh_1: 'geometry.a_mesh_1', empty: 'geometry.empty' }, render_controllers: ['controller.render.a_0', 'controller.render.a_1'] } } })],
    ]);
    const groups = buildAddonAppearance(sources).byType.get('craftmatic:a')!.groups;
    expect(groups.map(g => !!g.far)).toEqual([false, true]);
  });
});
