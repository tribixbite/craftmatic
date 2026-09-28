import { describe, expect, it } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';
import { findSeatPlaces, seatPartKind, takeSeatCensus, type SeatCensusContext } from '../web/src/engine/seat-census.js';
import { seatedFigure, SEAT_BELOW_TORSO_LDU } from '../web/src/engine/minifig-rig.js';

/** A mesh that carries only a description and a box: what the classifiers read. */
const mesh = (id: string, description: string, min: [number, number, number] = [-10, 0, -10], max: [number, number, number] = [10, 24, 10]): LdrawPartMesh =>
  ({ partId: id, resolvedAs: id, triangles: [], studs: [], bounds: { min, max }, unresolvedRefs: [], description }) as unknown as LdrawPartMesh;

const MESHES = new Map<string, LdrawPartMesh | null>([
  ['973.dat', mesh('973', 'Minifig Torso', [-19, -12, -10], [19, 32, 10])],
  ['3626c.dat', mesh('3626c', 'Minifig Head with Closed Hollow Stud', [-13, 0, -13], [13, 24, 13])],
  ['3815.dat', mesh('3815', 'Minifig Hips', [-18, -11, -10], [18, 21, 10])],
  ['3816.dat', mesh('3816', 'Minifig Leg Right', [-19.5, -9, -11], [-1.5, 28, 9])],
  ['3817.dat', mesh('3817', 'Minifig Leg Left', [1.5, -9, -11], [19.5, 28, 9])],
  ['4079.dat', mesh('4079', 'Minifig Seat  2 x  2')],
  ['3829c01.dat', mesh('3829c01', 'Car Steering Stand and Wheel (Complete)')],
  ['3001.dat', mesh('3001', 'Brick  2 x  4')],
]);

/** Rotation about X by 90 degrees: a leg that sat down points forward. */
const SIT: number[] = [1, 0, 0, 0, 0, -1, 0, 1, 0];

/** A minifig standing (legs straight) or sitting (legs turned 90 degrees) with its torso at `at`. */
function figure(at: [number, number, number], sitting: boolean): ParsedBrick[] {
  const [x, y, z] = at;
  const legRot = sitting ? SIT : undefined;
  return [
    { part: '973.dat', color: 4, x, y, z },
    { part: '3626c.dat', color: 14, x, y: y - 24, z },
    { part: '3815.dat', color: 1, x, y: y + 32, z },
    { part: '3816.dat', color: 1, x, y: y + 44, z, ...(legRot ? { rot: legRot } : {}) },
    { part: '3817.dat', color: 1, x, y: y + 44, z, ...(legRot ? { rot: legRot } : {}) },
  ];
}

describe('seat parts', () => {
  it('names seat moulds, furniture, saddles, helms and minifig steering wheels, and nothing else', () => {
    expect(seatPartKind('4079.dat', 'Minifig Seat  2 x  2')).toBe('seat-mould');
    expect(seatPartKind('4222a.dat', 'Fabuland Chair')).toBe('furniture');
    expect(seatPartKind('24312.dat', 'Minifig Wheelchair')).toBe('furniture');
    expect(seatPartKind('67075.dat', 'Friends Swing Seat')).toBe('furniture');
    expect(seatPartKind('4491b.dat', 'Animal Horse Saddle with Two Clips')).toBe('saddle');
    expect(seatPartKind('4790b.dat', '')).toBe('helm');
    expect(seatPartKind('52395.dat', 'Boat Ship Wheel with Pin')).toBe('helm');
    expect(seatPartKind('3829c01.dat', 'Car Steering Stand and Wheel (Complete)')).toBe('steering');
    expect(seatPartKind('3828.dat', '~Car Steering Wheel')).toBe('steering');
    expect(seatPartKind('30640c01.dat', 'Car Steering Wheel Holder  2 x  2 (Complete)')).toBe('steering');
    expect(seatPartKind('41850.dat', 'Minifig Brick  2 x  2 with Steering Wheel')).toBe('steering');
    // Not a minifig's: a Technic model's wheel, a bare holder, a 5 x 5 decorative wheel, a Technic steering link.
    expect(seatPartKind('2819.dat', 'Technic Steering Wheel Small')).toBeNull();
    expect(seatPartKind('30640.dat', 'Car Steering Wheel Holder  2 x  2')).toBeNull();
    expect(seatPartKind('67811.dat', 'Car Steering Wheel  5 x  5 with Two Spokes and  2 x  2 Stud Centre with Axlehole')).toBeNull();
    expect(seatPartKind('2739a.dat', 'Technic Steering Link  6L Type 1')).toBeNull();
    expect(seatPartKind('3001.dat', 'Brick  2 x  4')).toBeNull();
  });
});

describe('seated figures', () => {
  it('reads a figure whose legs are turned forward at the hip as sitting, and a standing one as not', () => {
    const sitting = seatedFigure(figure([0, -72, 0], true), MESHES);
    expect(sitting?.system).toBe('minifig');
    expect(sitting?.bendDeg).toBe(90);
    expect(seatedFigure(figure([0, -72, 0], false), MESHES)).toBeNull();
    // One leg bent (a figure posed in flight, 76269's) is not sitting.
    const oneLeg = figure([0, -72, 0], true).map(b => b.part === '3817.dat' ? { ...b, rot: undefined } : b);
    expect(seatedFigure(oneLeg, MESHES)).toBeNull();
    // A bust (a torso and a head, no legs: a ship's figurehead) does not sit.
    expect(seatedFigure(figure([0, -72, 0], true).slice(0, 2), MESHES)).toBeNull();
  });

  it('finds the seat a sitting figure proves at its hips, and ignores a standing one', () => {
    const places = findSeatPlaces([...figure([0, -72, 0], true), ...figure([200, -72, 0], false)], MESHES);
    expect(places.map(p => p.kind)).toEqual(['seated-figure']);
    expect(places[0]!.pointLdu[1]).toBeCloseTo(-72 + SEAT_BELOW_TORSO_LDU.minifig);
  });
});

describe('seat census', () => {
  it('judges each place against the pack and clusters the parts that name one seat', () => {
    // A car: a driver on a seat mould behind a wheel, a free passenger seat behind; a chair in the room; a steering wheel on a shelf.
    const driver = figure([0, -72, 0], true);
    const driverSeat: ParsedBrick = { part: '4079.dat', color: 0, x: 0, y: -32, z: 0 };
    const wheel: ParsedBrick = { part: '3829c01.dat', color: 0, x: 0, y: -40, z: -30 };
    const back: ParsedBrick = { part: '4079.dat', color: 0, x: 0, y: -32, z: 60 };
    const chair: ParsedBrick = { part: '4079.dat', color: 0, x: 400, y: -32, z: 0 };
    const shelf: ParsedBrick = { part: '3829c01.dat', color: 0, x: 800, y: -200, z: 0 };
    const carBricks = [...driver, driverSeat, wheel, back];
    const all = [...carBricks, chair, shelf];
    const context: SeatCensusContext = {
      vehicles: [{ label: 'Car', entity: 'set_car', kind: 'car', bricks: carBricks, driver: driver, driverSource: 'seated-figure', passengers: [[back]], seatCount: 2, controls: 'scripted car', riderVisibleSizes: [1], driverPointLdu: [0, -40, 0] }],
      sceneSeats: [
        { brick: chair, part: '4079', surfaceLdu: [400, -40, 0] },
        { part: 'bench', surfaceLdu: [600, -24, 0] },
      ],
      owners: [],
    };
    const census = takeSeatCensus(findSeatPlaces(all, MESHES), context);
    // Parts: the driver figure, its seat mould, its wheel, the back seat, the chair, the shelf wheel; plus the brick-built bench.
    expect(census.rows).toHaveLength(7);
    // A part counts at its PLACE's use: the driver's seat mould and wheel are the driver's seat too.
    expect(census.counts.raw).toMatchObject({ driver: 3, passenger: 1, seat: 2, none: 1 });
    // Places: the driver's (figure + mould + wheel), the passenger's, the chair, the bench, the shelf.
    expect(census.places).toHaveLength(5);
    expect(census.counts.distinct).toMatchObject({ driver: 1, passenger: 1, seat: 2, none: 1 });
    const shelfPlace = census.places.find(p => p.parts.includes('3829c01') && p.use === 'none')!;
    expect(shelfPlace.detail).toMatch(/no vehicle was found/);
  });

  it('counts a scene seat a source figure rides as the player\'s when the figure yields it', () => {
    const sitter = figure([0, -72, 0], true);
    const chair: ParsedBrick = { part: '4079.dat', color: 0, x: 0, y: -32, z: 0 };
    const occupant = { label: 'a figure the source seated there', bricks: new Set(sitter) };
    const places = findSeatPlaces([...sitter, chair], MESHES);
    const held = takeSeatCensus(places, { vehicles: [], owners: [], sceneSeats: [{ brick: chair, part: '4079', surfaceLdu: [0, -40, 0], occupant }] });
    expect(held.counts.distinct).toMatchObject({ occupied: 1 });
    const yields = takeSeatCensus(places, { vehicles: [], owners: [], sceneSeats: [{ brick: chair, part: '4079', surfaceLdu: [0, -40, 0], occupant: { ...occupant, yields: true } }] });
    expect(yields.counts.distinct).toMatchObject({ seat: 1, occupied: 0 });
    expect(yields.places[0]!.detail).toMatch(/gives it up to a player/);
  });

  it('counts a wheel on its own stand as one place', () => {
    const stand: ParsedBrick = { part: '3829c01.dat', color: 0, x: 0, y: -40, z: 0 };
    const wheel: ParsedBrick = { part: '3829c01.dat', color: 0, x: 0, y: -58, z: -10, rot: [1, 0, 0, 0, 0.6, 0.8, 0, -0.8, 0.6] };
    const census = takeSeatCensus(findSeatPlaces([stand, wheel], MESHES), { vehicles: [], sceneSeats: [], owners: [] });
    expect(census.rows).toHaveLength(2);
    expect(census.places).toHaveLength(1);
  });

  it('keeps a steering wheel mounted to turn on its own out of the places, and lists it', () => {
    const wheel: ParsedBrick = { part: '3829c01.dat', color: 0, x: 0, y: -200, z: 0 };
    const census = takeSeatCensus(findSeatPlaces([wheel], MESHES), { vehicles: [], sceneSeats: [], owners: [{ label: 'turnable', use: 'none', bricks: new Set([wheel]), reason: 'moves with a turnable', decoration: true }] });
    expect(census.places).toHaveLength(0);
    expect(census.excluded).toEqual([expect.objectContaining({ kind: 'steering', part: '3829c01' })]);
    // The same wheel as a stool's top is that stool (910032).
    const stool = takeSeatCensus(findSeatPlaces([wheel], MESHES), { vehicles: [], sceneSeats: [{ brick: wheel, part: 'stool', surfaceLdu: [0, -200, 0] }], owners: [{ label: 'turnable', use: 'none', bricks: new Set([wheel]), reason: 'moves with a turnable', decoration: true }] });
    expect(stool.excluded).toHaveLength(0);
    expect(stool.counts.distinct.seat).toBe(1);
  });
});
