/**
 * The brick-built hinge detector (web/src/engine/brick-hinges.ts): the joint
 * table, joints between placements, the rigid graph and what a cut joint line
 * sets moving. The scene is synthetic (fake part boxes with the real joint
 * moulds' connectors from the generated LDCad table), so each rule is pinned
 * on its own.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import { discoverBrickHinges, findHingeJoints, jointSnapsOf } from '../web/src/engine/brick-hinges.js';
import { interactiveNoun } from '../web/src/engine/bedrock-interactives.js';

/** A fake mesh: a box of bounds with one triangle (so it counts as geometry) and a description. */
function mesh(description: string, min: Vec3, max: Vec3): LdrawPartMesh {
  return { partId: 'x', resolvedAs: 'x', triangles: [{ color: 16, a: min, b: max, c: [min[0], max[1], min[2]] }], studs: [], bounds: { min, max }, unresolvedRefs: [], description } as unknown as LdrawPartMesh;
}
const at = (part: string, x: number, y: number, z: number, rot?: number[]): ParsedBrick => ({ part, color: 1, x, y, z, ...(rot ? { rot } : {}) }) as ParsedBrick;

describe('joint table (hinge-joint-snaps.ts)', () => {
  it('holds the swivel hinge brick pivot, a clip and a finger hinge, and falls back to the base mould', () => {
    const top = jointSnapsOf('3830.dat');
    expect(top.some(s => s.kind === 'y' && s.gender === 'M' && Math.abs(s.a[1]) === 1)).toBe(true);
    expect(jointSnapsOf('3831.dat').some(s => s.kind === 'y' && s.gender === 'F')).toBe(true);
    expect(jointSnapsOf('4085c.dat').some(s => s.kind === 'c')).toBe(true);
    expect(jointSnapsOf('3937.dat').some(s => s.kind === 'f' && s.group === 'hgBrC')).toBe(true);
    // A BrickLink copy and a lettered or printed variant read the base mould's row.
    expect(jointSnapsOf('bl_3830.dat')).toEqual(top);
    expect(jointSnapsOf('3001.dat')).toEqual([]);
  });
});

describe('joints', () => {
  it('pairs the two halves of a swivel hinge brick about their shared vertical line, and a turning one', () => {
    const joints = findHingeJoints([at('3831.dat', 0, 0, 0), at('3830.dat', 0, 0, 0)]);
    expect(joints).toHaveLength(1);
    expect(joints[0]!.type).toBe('cylinder');
    expect(joints[0]!.turns).toBe(true);
    expect(Math.abs(joints[0]!.axis[1])).toBeCloseTo(1, 5);
  });
  it('does not pair two halves that stand apart', () => {
    expect(findHingeJoints([at('3831.dat', 0, 0, 0), at('3830.dat', 60, 0, 0)])).toHaveLength(0);
  });
});

describe('discoverBrickHinges', () => {
  /**
   * A wall with a brick-built door: a floor under the wall and the hinge BASE
   * only, a wall column, a lintel on it, the hinge base 3831 on the floor and
   * the hinge top 3830 beside it on its pin; the leaf (a brick and a smooth
   * tile) stands on the top half and reaches out +X from the pin line.
   */
  function doorScene(): { bricks: ParsedBrick[]; meshes: Map<string, LdrawPartMesh>; leaf: ParsedBrick[] } {
    const meshes = new Map<string, LdrawPartMesh>([
      ['floor.dat', mesh('Plate 6 x 6', [-120, 0, -60], [0, 8, 60])],
      ['wall.dat', mesh('Brick 1 x 1 x 5', [-20, -104, -10], [0, 0, 10])],
      ['lintel.dat', mesh('Brick 2 x 8', [-80, -24, -10], [80, 0, 10])],
      ['3831.dat', mesh('Hinge Brick  1 x  4 Base', [-40, 0, -10], [0, 24, 10])],
      ['3830.dat', mesh('Hinge Brick  1 x  4 Top', [0, 0, -10], [40, 24, 10])],
      ['leafbrick.dat', mesh('Brick 1 x 2 x 3', [0, -72, -10], [40, 0, 10])],
      ['leaftile.dat', mesh('Tile 1 x 2', [0, -8, -10], [40, 0, 10])],
    ]);
    // LDraw Y is down: the floor's top is at y 24, everything stands on it.
    const floor = at('floor.dat', 0, 24, 0);
    const wall = at('wall.dat', -40, 24, 0);
    const lintel = at('lintel.dat', 0, -80, 0);
    const base = at('3831.dat', 0, 0, 0), top = at('3830.dat', 0, 0, 0);
    const leafBrick = at('leafbrick.dat', 0, 0, 0), leafTile = at('leaftile.dat', 0, -72, 0);
    // The rest of the building on the floor: the model the door is a small part of.
    const building = [-80, -100].flatMap(x => [-40, 0, 40].map(z => at('wall.dat', x, 24, z)));
    // The doorway's threshold: a smooth tile under the swinging half (a stud there would hold it shut).
    meshes.set('threshold.dat', mesh('Tile 2 x 2', [0, 0, -10], [40, 8, 10]));
    const threshold = at('threshold.dat', 0, 24, 0);
    return { bricks: [floor, threshold, wall, lintel, base, top, leafBrick, leafTile, ...building], meshes, leaf: [top, leafBrick, leafTile] };
  }

  it('moves the assembly on the hinge top: a door about the pin line, the hinge half first, with a lintel over it', () => {
    const { bricks, meshes, leaf } = doorScene();
    const found = discoverBrickHinges({ bricks, meshOf: b => meshes.get(b.part) ?? null, taken: new Set() });
    expect(found.items).toHaveLength(1);
    const it = found.items[0]!;
    expect(it.kind).toBe('door');
    expect(new Set(it.bricks)).toEqual(new Set(leaf));
    expect(it.bricks[0]!.part).toBe('3830.dat');
    expect(Math.abs(it.axisLdu[1])).toBeCloseTo(1, 5);
    expect(it.pivotLdu[0]).toBeCloseTo(0, 3);
    expect(it.pivotLdu[2]).toBeCloseTo(0, 3);
    expect(Math.abs(it.angleDeg)).toBe(90);
    expect(it.openingLdu?.width).toBeCloseTo(40, 3);
    expect(it.builtFrom).toMatch(/^Brick-built door \(3 parts on 1 cylinder joint, 3831\/3830/);
    expect(interactiveNoun(it)).toBe('Door');
    expect(found.lines.map(l => l.verdict)).toEqual(['moves']);
  });

  it('holds a leaf that is also stacked on the floor: no joint line comes away', () => {
    const { bricks, meshes } = doorScene();
    // The floor now runs under the hinge top too: the top half is pressed onto its studs.
    meshes.set('floor.dat', mesh('Plate 6 x 12', [-120, 0, -60], [120, 8, 60]));
    const found = discoverBrickHinges({ bricks, meshOf: b => meshes.get(b.part) ?? null, taken: new Set() });
    expect(found.items).toHaveLength(0);
    expect(found.lines[0]!.verdict).toBe('holds');
  });

  it('leaves an assembly another rule owns alone', () => {
    const { bricks, meshes, leaf } = doorScene();
    const found = discoverBrickHinges({ bricks, meshOf: b => meshes.get(b.part) ?? null, taken: new Set([leaf[1]!]) });
    expect(found.items).toHaveLength(0);
    expect(found.lines[0]!.verdict).toBe('rejected');
  });

  it('calls a leaf with nothing over it a gate', () => {
    const { bricks, meshes } = doorScene();
    const found = discoverBrickHinges({ bricks: bricks.filter(b => b.part !== 'lintel.dat'), meshOf: b => meshes.get(b.part) ?? null, taken: new Set() });
    expect(found.items.map(i => i.kind)).toEqual(['gate']);
  });

  it('rejects an ornament on a joint: a leaf that is not plates, tiles or bricks', () => {
    const { bricks, meshes } = doorScene();
    meshes.set('leafbrick.dat', mesh('Minifig Flag 6 x 4', [0, -72, -10], [40, 0, 10]));
    meshes.set('leaftile.dat', mesh('Plant Leaves 4 x 3', [0, -8, -10], [40, 0, 10]));
    // No lintel: the leaves would stand on nothing but the hinge.
    const found = discoverBrickHinges({ bricks: bricks.filter(b => b.part !== 'lintel.dat'), meshOf: b => meshes.get(b.part) ?? null, taken: new Set() });
    expect(found.items).toHaveLength(0);
    expect(found.lines[0]!.reason).toMatch(/ornament/);
  });
});
