/**
 * The interactivity stage (web/src/engine/interactivity-stage.ts): one pass
 * that turns a building's movable parts into entities and reports every
 * candidate with its verdict - found, static (with the rule that kept it),
 * rides, excluded (another entity owns it) or unhandled (no rule yet).
 */
import { describe, expect, it } from 'vitest';
import { interactivityStage, interactivitySummary, movableClassOf } from '../web/src/engine/interactivity-stage.js';
import type { LdrawPartMesh, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mesh = (part: string, description: string, min: Vec3, max: Vec3): LdrawPartMesh => ({
  partId: part, resolvedAs: part, description, triangles: [{ a: min, b: max, c: [min[0], max[1], min[2]] }] as unknown as LdrawPartMesh['triangles'],
  studs: [], bounds: { min, max }, unresolvedRefs: [],
} as unknown as LdrawPartMesh);
const brick = (part: string, x: number, y: number, z: number, rot = I): ParsedBrick => ({ part, color: 6, x, y, z, rot });

describe('movableClassOf', () => {
  it('names what a player would expect to use, and leaves fixtures alone', () => {
    const cases: Array<[string, string | null]> = [
      ['Door  1 x  4 x  6 with 4 Panes and Stud Handle', 'door'],
      ['Garage  4 x  8 x  3 Door', 'door'],
      ['Container Cupboard  2 x  3 x  2 Drawer', 'drawer'],
      ['Container Treasure Chest Lid with Flat Top', 'lid'],
      ['Container Treasure Chest without Slots', null],
      ['Container Cupboard  2 x  3 x  2 with Hollow Studs', null],
      ['Fabuland Bed', 'bed'],
      ['Minifig Seat  2 x  2', 'seat'],
      ['Minifigure, Utensil Stroller / Baby Carriage Seat', null],
      ['Minifigure, Headgear Accessory Propeller 2 Blade Twisted', null],
      ['Technic Steering Wheel Hub with Brake Disc and  3 Pegholes', null],
      ['Window  1 x  4 x  3 without Shutter Tabs', null],
      ['Window  1 x  2 x  3 Pane Latticed with Reinforced Joints', 'window'],
      ['Hinge Control Stick Base', null],
      ['Door  1 x  4 x  6 Frame', null],
      ['Plate  1 x  2 with Door Rail', null],
      ['Brick  2 x  4', null],
    ];
    for (const [d, c] of cases) expect(movableClassOf(d), d).toBe(c);
  });
});

describe('interactivityStage', () => {
  const meshes = new Map<string, LdrawPartMesh | null>([
    ['60623.dat', mesh('60623', 'Door  1 x  4 x  6 with 4 Panes and Stud Handle', [-4, 3, -3], [67, 137, 3])],
    ['38320.dat', mesh('38320', 'Window  1 x  2 x  2 Pane Lattice Diamond', [-16.5, 2.5, -7], [16.5, 40.5, -3])],
    ['722.dat', mesh('722', 'Garage  4 x  8 x  3 Door', [-80, 0, -4], [80, 72, 4])],
    ['4079.dat', mesh('4079', 'Minifig Seat  2 x  2', [-20, -40, -20], [20, 8, 25])],
  ]);
  it('reports every candidate once: found, static with its rule, owned by another entity, unhandled', () => {
    const door = brick('60623.dat', 0, 0, 0), pane = brick('38320.dat', 200, -100, 0), garage = brick('722.dat', 400, 0, 0);
    const carDoor = brick('60623.dat', 800, 0, 0);
    const seat = brick('4079.dat', 600, -8, 100);
    const r = interactivityStage({
      bricks: [door, pane, garage, carDoor, seat], meshes,
      owned: new Map([[carDoor, 'part of Car (a car entity)']]),
      seats: [{ part: '4079', brick: seat, surfaceLdu: [600, -16, 100], facingLdu: [0, -1] }], seatPoints: [[11, 1, 2]],
      toGrid: p => [p[0] / 40, -p[1] / 40, -p[2] / 40],
    });
    expect(r.items.map(i => i.part)).toEqual(['60623']);
    const row = (part: string, verdict: string) => r.report.rows.find(x => x.part === part && x.verdict === verdict);
    expect(row('60623', 'found')?.count).toBe(1);
    expect(row('60623', 'excluded')?.reason).toMatch(/Car/);
    expect(row('38320', 'static')?.reason).toMatch(/centred/);
    expect(row('722', 'unhandled')?.cls).toBe('door');
    expect(row('4079', 'found')?.cls).toBe('seat');
    expect(r.report.totals).toEqual({ found: 2, static: 1, rides: 0, excluded: 1, unhandled: 1 });
    expect(r.report.found).toEqual({ door: 1, seat: 1 });
    expect(interactivitySummary('Demo', r.report)).toMatch(/found 1 door, 1 seat; 1 static \(38320 x1\); 1 unhandled \(door 722 x1\); 1 owned/);
  });
});
