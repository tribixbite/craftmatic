import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCoaster, type CoasterDesign, type GeneratedCoaster } from '../web/src/engine/coaster-design';
import { STATIC_SHELL_CULL_MAX_SCALE, STATIC_SHELL_RADIUS_LIMIT_BLOCKS, STATIC_SHELL_CELL_BLOCKS, shellChunkId } from '../web/src/engine/bedrock-building-shell';
import { apply, boneTransforms, cubeCorners, pivotRotation, type Vec3 } from '../web/src/engine/bedrock-geometry-faces';
import {
  buildTrackMesh, compareRailRepresentations, cubeRotationFor, COASTER_TRACK_MESH, type TrackMesh, type TrackCube,
} from '../web/src/engine/coaster-track-mesh';

const len = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];

/** Every cube of every chunk in WORLD units (route frame x16), corners read back through the project's own geometry reader. */
function worldCubes(mesh: TrackMesh): Array<{ chunk: string; colour: number; cube: TrackCube; corners: Vec3[]; centre: Vec3 }> {
  const out: Array<{ chunk: string; colour: number; cube: TrackCube; corners: Vec3[]; centre: Vec3 }> = [];
  for (const chunk of mesh.chunks) {
    const rootU = chunk.root.map(v => v * 16) as Vec3;
    chunk.geometry['minecraft:geometry'].forEach((geo, gi) => {
      const bones = boneTransforms(geo.bones.map(b => ({ name: b.name, pivot: b.pivot })));
      for (const bone of geo.bones) for (const cube of bone.cubes) {
        const local = cubeCorners({ bone: bone.name, origin: cube.origin, size: cube.size, rotation: cube.rotation, pivot: cube.pivot }, bones.get(bone.name)!);
        const corners = local.map(p => [p[0] + rootU[0], p[1] + rootU[1], p[2] + rootU[2]] as Vec3);
        out.push({ chunk: chunk.id, colour: chunk.materials[gi]!.ldrawColor, cube, corners, centre: [cube.pivot[0] + rootU[0], cube.pivot[1] + rootU[1], cube.pivot[2] + rootU[2]] });
      }
    });
  }
  return out;
}

describe('coaster-track-mesh', () => {
  let gen: GeneratedCoaster, mesh: TrackMesh;
  beforeAll(() => {
    const sketch = JSON.parse(readFileSync('test/fixtures/coaster/3x-sketch.json', 'utf8')) as CoasterDesign;
    gen = generateCoaster(sketch);
    mesh = buildTrackMesh(gen);
  });

  it("every rail chunk's root lies within STATIC_SHELL_RADIUS_LIMIT_BLOCKS of each of its cubes", () => {
    expect(mesh.chunks.length).toBeGreaterThan(10);
    expect(mesh.warnings).toEqual([]);
    // Independent of the module's own reach figure: re-read every shipped cube's corners and measure from the root.
    for (const chunk of mesh.chunks) {
      const rootU = chunk.root.map(v => v * 16);
      let worst = 0;
      for (const cube of worldCubes({ ...mesh, chunks: [chunk] })) for (const corner of cube.corners) worst = Math.max(worst, len(sub(corner, rootU)) / 16);
      expect(worst * STATIC_SHELL_CULL_MAX_SCALE).toBeLessThanOrEqual(STATIC_SHELL_RADIUS_LIMIT_BLOCKS + 1e-6);
      expect(Math.abs(worst - chunk.reachBlocks)).toBeLessThan(2e-3);
    }
  });

  it('roots sit at lattice cell centres and ids name the cell, not a list position', () => {
    const ids = new Set<string>();
    for (const c of mesh.chunks) {
      expect(c.id).toBe(shellChunkId('coaster_track', c.cell));
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.root[0]).toBeCloseTo((c.cell[0] + 0.5) * STATIC_SHELL_CELL_BLOCKS, 9);
      expect(c.root[2]).toBeCloseTo((c.cell[2] + 0.5) * STATIC_SHELL_CELL_BLOCKS, 9);
      expect(c.id).not.toMatch(/^\d/);
    }
  });

  it('a cube turned by cubeRotationFor maps its local axes onto the frame through pivotRotation', () => {
    const frames = [
      { side: [1, 0, 0], up: [0, 1, 0], along: [0, 0, 1] },
      { side: [0, 0, 1], up: [0, 1, 0], along: [-1, 0, 0] },
      { side: [0, 1, 0], up: [-1, 0, 0], along: [0, 0, 1] },  // banked 90 degrees: gimbal pole
      { side: [0.6, 0, 0.8], up: [0, 1, 0], along: [-0.8, 0, 0.6] },
    ] as const;
    // A generic frame: tilt of 30 degrees about x then 50 about y (columns of a rotation).
    const cx = Math.cos(0.52), sx = Math.sin(0.52), cy = Math.cos(0.87), sy = Math.sin(0.87);
    const generic = { side: [cy, 0, -sy] as Vec3, up: [sx * sy, cx, sx * cy] as Vec3, along: [cx * sy, -sx, cx * cy] as Vec3 };
    for (const f of [...frames.map(x => ({ side: [...x.side] as Vec3, up: [...x.up] as Vec3, along: [...x.along] as Vec3 })), generic]) {
      const rot = cubeRotationFor(f);
      const m = pivotRotation(rot, [0, 0, 0]);
      for (const [axis, want] of [[[1, 0, 0], f.side], [[0, 1, 0], f.up], [[0, 0, 1], f.along]] as const) {
        const got = apply(m, [...axis] as Vec3);
        expect(len(sub(got, want))).toBeLessThan(1e-6);
      }
    }
  });

  it('the rails run continuously along the route and every joint is buried in both neighbouring cubes', () => {
    const left = mesh.railPieces.filter(p => p.rail === 'L'), right = mesh.railPieces.filter(p => p.rail === 'R');
    expect(left.length).toBeGreaterThan(400);
    expect(left.length).toBe(right.length);
    for (const rail of [left, right]) {
      rail.forEach((piece, i) => {
        const next = rail[(i + 1) % rail.length]!; // closed route: the last piece meets the first
        expect(len(sub(piece.to, next.from))).toBeLessThan(1e-9);
        expect(len(sub(piece.to, piece.from))).toBeLessThanOrEqual(COASTER_TRACK_MESH.maxSegmentB + 1e-9);
      });
    }
    // Every joint lies inside the first rail cube on each side of it (oriented-box containment in the cube's own frame).
    const cubes = worldCubes(mesh).filter(c => c.colour === COASTER_TRACK_MESH.colours.rail);
    const inside = (p: Vec3, c: (typeof cubes)[number]): boolean => {
      const [o, s, piv, rot] = [c.cube.origin, c.cube.size, c.cube.pivot, c.cube.rotation];
      const rootU = sub(c.centre, piv);
      const m = pivotRotation(rot, piv);
      // Corner 0 and the three edge corners give the box axes in chunk-local units.
      const c0 = apply(m, [o[0], o[1], o[2]]), cx = apply(m, [o[0] + s[0], o[1], o[2]]), cy = apply(m, [o[0], o[1] + s[1], o[2]]), cz = apply(m, [o[0], o[1], o[2] + s[2]]);
      const rel = sub(p, [c0[0] + rootU[0], c0[1] + rootU[1], c0[2] + rootU[2]]);
      return [cx, cy, cz].every(e => {
        const axis = sub(e, c0), l2 = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
        const t = (rel[0] * axis[0] + rel[1] * axis[1] + rel[2] * axis[2]) / l2;
        return t >= -1e-3 && t <= 1 + 1e-3;
      });
    };
    // Sample 60 joints across the course: each must be covered by >= 2 distinct rail cubes of its rail (a flat + a rolled bar per piece, two pieces meeting).
    for (let k = 0; k < left.length; k += Math.floor(left.length / 60)) {
      const p = left[k]!.to.map(v => v * 16) as Vec3;
      const covering = cubes.filter(c => inside(p, c)).length;
      expect(covering).toBeGreaterThanOrEqual(4);
    }
  });

  it('the rail pieces stay within the deviation tolerance of the route samples', () => {
    // Each rail piece starts and ends exactly on a rail sample; check the route's samples between against the chord.
    const pts = gen.route.points;
    const rail = mesh.railPieces.filter(p => p.rail === 'L');
    // The centreline of the rail pair is the route: the midpoint of the L and R piece ends sits barRise under it.
    const right = mesh.railPieces.filter(p => p.rail === 'R');
    const barB = COASTER_TRACK_MESH.railU / 16;
    rail.forEach((l, i) => {
      const r = right[i]!;
      const mid = [(l.from[0] + r.from[0]) / 2, (l.from[1] + r.from[1]) / 2, (l.from[2] + r.from[2]) / 2];
      // Distance from the pair's midpoint to the nearest route point is the half-bar drop, plus sample spacing slack.
      let best = Infinity;
      for (let k = 0; k < pts.length; k += 1) best = Math.min(best, len(sub(mid, pts[k]!)));
      expect(best).toBeLessThan(barB / 2 + 0.2 + 1e-6);
      expect(best).toBeGreaterThan(barB / 2 - 0.2);
    });
  });

  it('ties come one per tieSpacingB of arc and carry two studs each', () => {
    const per = mesh.stats.routeLengthB / COASTER_TRACK_MESH.tieSpacingB;
    expect(Math.abs(mesh.stats.ties - per)).toBeLessThanOrEqual(1);
    const colours = COASTER_TRACK_MESH.colours;
    const all = worldCubes(mesh);
    const studs = all.filter(c => c.cube.size[1] === COASTER_TRACK_MESH.studHeightU);
    expect(studs.length).toBe(mesh.stats.ties * 2);
    expect(all.length).toBe(mesh.stats.cubes);
    expect(colours.rail).not.toBe(colours.tie);
  });

  it('every cube declares at least one unit on every axis (Bedrock floors box-UV sizes)', () => {
    for (const c of worldCubes(mesh)) for (const s of c.cube.size) expect(s).toBeGreaterThanOrEqual(1);
  });

  it('chunk cube counts add up and every chunk lists its colours as separate geometries', () => {
    expect(mesh.chunks.reduce((n, c) => n + c.cubeCount, 0)).toBe(mesh.stats.cubes);
    for (const c of mesh.chunks) {
      expect(c.materials.reduce((n, m) => n + m.cubes, 0)).toBe(c.cubeCount);
      const ids = c.geometry['minecraft:geometry'].map(g => g.description.identifier);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(c.materials.map(m => m.geometryId));
    }
  });

  it('is deterministic, and a mirrored build yields the mirrored course', () => {
    expect(JSON.stringify(buildTrackMesh(gen).chunks)).toBe(JSON.stringify(mesh.chunks));
    const mirrored = buildTrackMesh(gen, { mirror: 'x' });
    expect(mirrored.stats.cubes).toBe(mesh.stats.cubes);
    // Mirroring x swaps the side axis, so rail L of one is rail R of the other: compare by the pair's midpoint.
    const mid = (p: Vec3, q: Vec3): Vec3 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const m0 = mid(mesh.railPieces.find(p => p.rail === 'L' && p.index === 0)!.from, mesh.railPieces.find(p => p.rail === 'R' && p.index === 0)!.from);
    const m1 = mid(mirrored.railPieces.find(p => p.rail === 'L' && p.index === 0)!.from, mirrored.railPieces.find(p => p.rail === 'R' && p.index === 0)!.from);
    expect(len(sub([-m0[0], m0[1], m0[2]], m1))).toBeLessThan(1e-6);
  });

  it('the lean profile drops the second bar and the studs, keeps every chunk in reach, and ships fewer cubes', () => {
    const lean = buildTrackMesh(gen, { profile: { roundRails: false, studs: false } });
    expect(lean.stats.cubes).toBe(mesh.stats.railPieces + mesh.stats.ties);
    expect(lean.stats.cubes).toBeLessThan(mesh.stats.cubes / 2);
    expect(lean.warnings).toEqual([]);
  });

  it('rejects an id stem that starts with a digit and ups that do not match the route', () => {
    expect(() => buildTrackMesh(gen, { idPrefix: '10303_track' })).toThrow(/digit/);
    expect(() => buildTrackMesh({ route: gen.route, ups: gen.ups.slice(1) })).toThrow(/ups/);
  });

  it('the 3x sketch produces a bounded, measured entity cost and a comparison against block rails', () => {
    expect(mesh.stats.routeLengthB).toBeGreaterThan(545);
    expect(mesh.stats.maxReachBlocks * STATIC_SHELL_CULL_MAX_SCALE).toBeLessThanOrEqual(STATIC_SHELL_RADIUS_LIMIT_BLOCKS);
    const cmp = compareRailRepresentations(gen, mesh);
    expect(cmp.entity.chunks).toBe(mesh.chunks.length);
    expect(cmp.entity.visibleCubeShare.min).toBeGreaterThan(0);
    expect(cmp.entity.visibleCubeShare.min).toBeLessThan(1); // a rider never has the whole course in reach
    expect(cmp.blocks.length).toBe(5);
    // A finer quantum never needs fewer permutations, and its edge error is never larger.
    for (let i = 1; i < cmp.blocks.length; i++) {
      expect(cmp.blocks[i]!.permutations).toBeGreaterThanOrEqual(cmp.blocks[i - 1]!.permutations);
      expect(cmp.blocks[i]!.maxEdgeErrorB).toBeLessThanOrEqual(cmp.blocks[i - 1]!.maxEdgeErrorB + 1e-9);
    }
    expect(cmp.worldPermutationCap).toBe(65536);
  });
});
