import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.js';
import {
  CAR_ON_ROUTE_MAX_LDU, LIFT_MIN_RISE_LDU, PLATFORM_DOCK_MAX_LDU,
  detectCoasterAssemblies, isChainPart, isSelfWheeledPart, isSprocketPart, isWheelPart, measureDatumAboveRailTop,
  type CoasterChainLift, type CoasterPlatformLift,
} from '../web/src/engine/coaster-assemblies.js';

// ─── Synthetic meshes: enough triangles for bounds, descriptions and top faces ──

const tri = (a: Vec3, b: Vec3, c: Vec3) => ({ a, b, c, color: 16 });
function boxMesh(partId: string, description: string, min: Vec3, max: Vec3): LdrawPartMesh {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const v = (x: number, y: number, z: number): Vec3 => [x, y, z];
  const triangles = [
    tri(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1)), tri(v(x0, y0, z0), v(x1, y0, z1), v(x0, y0, z1)), // top (min y)
    tri(v(x0, y1, z0), v(x1, y1, z1), v(x1, y1, z0)), tri(v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)), // bottom
    tri(v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)), tri(v(x0, y0, z0), v(x1, y1, z0), v(x1, y0, z0)),
    tri(v(x0, y0, z1), v(x1, y1, z1), v(x0, y1, z1)), tri(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1)),
    tri(v(x0, y0, z0), v(x0, y1, z1), v(x0, y1, z0)), tri(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)),
    tri(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)), tri(v(x1, y0, z0), v(x1, y1, z1), v(x1, y0, z1)),
  ];
  return { partId, resolvedAs: partId, triangles, studs: [], bounds: { min, max }, unresolvedRefs: [], description };
}
/** A 24869-like wheel pair on an X axle: flange r 13.4 at axial 21.5-24, tread r 12 at 24-33, axle stubs r 4 to 37. */
function wheelMesh(partId: string, description: string): LdrawPartMesh {
  const triangles: LdrawPartMesh['triangles'] = [];
  const ring = (x0: number, x1: number, r: number): void => {
    for (let k = 0; k < 12; k++) {
      const a0 = k / 12 * Math.PI * 2, a1 = (k + 1) / 12 * Math.PI * 2;
      const p = (x: number, a: number): Vec3 => [x, r * Math.cos(a), r * Math.sin(a)];
      triangles.push(tri(p(x0, a0), p(x1, a0), p(x1, a1)), tri(p(x0, a0), p(x1, a1), p(x0, a1)));
    }
  };
  for (const side of [-1, 1]) {
    ring(21.5 * side, 24 * side, 13.4);
    ring(24 * side, 33 * side, 12);
    ring(0, 37 * side, 4);
  }
  return { partId, resolvedAs: partId, triangles, studs: [], bounds: { min: [-37, -13.4, -13.4], max: [37, 13.4, 13.4] }, unresolvedRefs: [], description };
}

const MESHES = new Map<string, LdrawPartMesh | null>([
  ['80562.dat', boxMesh('80562', 'Train Track Roller Coaster  4 x  4', [-40, -18, -34], [40, 8, 34])],
  ['26561.dat', boxMesh('26561', 'Train Track Roller Coaster Ramp', [-10, -162, -34], [150, 144, 34])],
  ['25061.dat', boxMesh('25061', 'Train Track Roller Coaster Curve', [0, -18, 0], [240, 8, 240])],
  ['26021.dat', boxMesh('26021', 'Train Base  4 x  5 Roller Coaster', [-70, 0, -40], [71, 44, 40])],
  ['26021c01.dat', boxMesh('26021c01', 'Train Base  4 x  5 Roller Coaster with Dark Bluish Gray Wheels', [-70, 0, -40], [71, 44, 40])],
  ['24869.dat', wheelMesh('24869', 'Wheels Roller Coaster')],
  ['4185.dat', boxMesh('4185', 'Technic Wedge Belt Wheel', [-30, -30, -5], [30, 30, 5])],
  ['3711.dat', boxMesh('3711', 'Technic Chain Link', [-10, -5, -5], [10, 5, 21])],
  ['3023.dat', boxMesh('3023', 'Plate  1 x  2', [-20, 0, -10], [20, 8, 10])],
  ['3010.dat', boxMesh('3010', 'Brick  1 x  4', [-40, 0, -10], [40, 24, 10])],
  ['3001.dat', boxMesh('3001', 'Brick  2 x  4', [-40, 0, -20], [40, 24, 20])],
  ['973.dat', boxMesh('973', 'Minifig Torso', [-19, 0, -10], [19, 32, 10])],
  ['3626c.dat', boxMesh('3626c', 'Minifig Head with Closed Hollow Stud', [-13, 0, -13], [13, 24, 13])],
  ['3815.dat', boxMesh('3815', 'Minifig Hips', [-18, -11, -10], [18, 21, 10])],
  ['3816.dat', boxMesh('3816', 'Minifig Leg Right', [-19.5, -9, -11], [-1.5, 28, 9])],
]);

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** The real 10303/10261 wheel placement on a 26021: axle along Z, ±25 along the chassis, 17.4 below its origin. */
const WHEEL_ROT = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const brick = (part: string, x: number, y: number, z: number, rot: number[] = IDENTITY, color = 16): ParsedBrick => ({ color, x, y, z, rot, part });
/** A 26021 chassis at `x` on a level route whose datum is y -32 (origin 14.3 above it), with its two wheels, a plate and a seated rider. */
function carAt(x: number, z = 0, withRider = true): ParsedBrick[] {
  const y = -32 - 14.3;
  const parts = [
    brick('26021.dat', x, y, z, IDENTITY, 322),
    brick('24869.dat', x - 25, y + 17.4, z, WHEEL_ROT, 72),
    brick('24869.dat', x + 25, y + 17.4, z, WHEEL_ROT, 72),
    brick('3023.dat', x - 40, y - 8, z, IDENTITY, 15),
  ];
  if (withRider) parts.push(
    brick('973.dat', x - 18, y - 45, z, IDENTITY, 15),
    brick('3626c.dat', x - 18, y - 69, z, IDENTITY, 14),
    brick('3815.dat', x - 18, y - 13, z, IDENTITY, 0),
    brick('3816.dat', x - 18, y - 1, z, IDENTITY, 0),
  );
  return parts;
}
const STRAIGHT_ROUTE = [brick('80562.dat', 0, 0, 0), brick('80562.dat', 80, 0, 0)];
const run = (bricks: ParsedBrick[]) => detectCoasterAssemblies(bricks, MESHES, extractCoasterTrackRoutes(bricks, { isGeometryAvailable: () => true }));

describe('coaster assemblies: part classes by library description', () => {
  it('names wheels, self-wheeled composites, sprockets and chain links without an id list', () => {
    expect(isWheelPart('Wheels Roller Coaster')).toBe(true);
    expect(isWheelPart('Wheel Rim 14 x 18 with Holes on Both Sides (Needs Work)')).toBe(true);
    expect(isWheelPart('Tyre  6/ 50 x  8 Offset Tread')).toBe(true);
    expect(isWheelPart('Plate  2 x  2 with 2 Wheel Pins')).toBe(false);
    expect(isSelfWheeledPart('Train Base  4 x  5 Roller Coaster with Dark Bluish Gray Wheels')).toBe(true);
    expect(isSelfWheeledPart('Train Base  4 x  5 Roller Coaster')).toBe(false);
    expect(isSelfWheeledPart('Plate  2 x  2 with 2 Wheel Pins')).toBe(false);
    expect(isSprocketPart('Technic Wedge Belt Wheel')).toBe(true);
    expect(isSprocketPart('Technic Gear 16 Tooth')).toBe(true);
    expect(isSprocketPart('Wheels Roller Coaster')).toBe(false);
    expect(isChainPart('Technic Chain Link')).toBe(true);
    expect(isChainPart('Technic Chain Tread 17')).toBe(true);
  });

  it('measures the datum over the rail top from a placed straight mould', () => {
    expect(measureDatumAboveRailTop(STRAIGHT_ROUTE, MESHES)).toBe(14);
    expect(measureDatumAboveRailTop([brick('3001.dat', 0, 0, 0)], MESHES)).toBeNull();
  });
});

describe('coaster assemblies: ride cars', () => {
  it('finds a chassis from its two mounted wheels, its members, its rider seat and its place on the route', () => {
    const result = run([...STRAIGHT_ROUTE, ...carAt(40)]);
    expect(result.cars).toHaveLength(1);
    const [car] = result.cars;
    expect(car!.chassis.part).toBe('26021.dat');
    expect(car!.wheels).toHaveLength(2);
    // Chassis, two wheels and the plate; none of the four figure parts.
    expect(car!.bricks).toHaveLength(4);
    expect(car!.frame.travelWorld).toEqual([1, 0, 0]);
    expect(car!.frame.upWorld).toEqual([0, -1, 0]);
    expect(car!.lengthLdu).toBeCloseTo(141, 3);
    expect(car!.widthLdu).toBeCloseTo(80, 3);
    expect(car!.wheelGeometry).toEqual({ axleBelowOriginLdu: 17.4, flangeRadiusLdu: 13.4, treadBandLdu: [24, 33] });
    expect(car!.seats).toHaveLength(1);
    expect(car!.seats[0]!.source).toBe('rider');
    expect(car!.seats[0]!.localLdu).toEqual([-18, -1, 0]);
    expect(car!.seats[0]!.riderBricks).toHaveLength(4);
    expect(car!.route).toMatchObject({ routeIndex: 0, offsetLdu: 14.3, originAboveDatumLdu: 14.3, heading: 1 });
    expect(car!.route!.arcLdu).toBeCloseTo(80, 3);
    expect(result.originAboveDatumLdu).toBe(14.3);
    expect(result.datumAboveRailTopLdu).toBe(14);
    expect(result.trains).toEqual([expect.objectContaining({ routeIndex: 0, carIds: [car!.id], pitchesLdu: [], extentLdu: 0 })]);
    expect(result.strays).toEqual([]);
  });

  it('accepts a composite chassis by its own description, copies a ridden sibling seat, and measures the train pitch', () => {
    const composite = (x: number, withRider: boolean): ParsedBrick[] => carAt(x, 0, withRider).filter(b => b.part !== '24869.dat').map(b => b.part === '26021.dat' ? { ...b, part: '26021c01.dat' } : b);
    const result = run([...STRAIGHT_ROUTE, ...composite(-20, true), ...composite(106, false)]);
    expect(result.cars).toHaveLength(2);
    for (const car of result.cars) { expect(car.wheels).toEqual([]); expect(car.wheelGeometry).toBeUndefined(); }
    expect(result.cars[0]!.seats[0]!.source).toBe('rider');
    expect(result.cars[1]!.seats[0]).toMatchObject({ source: 'sibling', localLdu: [-18, -1, 0], riderBricks: [] });
    expect(result.trains).toHaveLength(1);
    expect(result.trains[0]!.carIds).toHaveLength(2);
    expect(result.trains[0]!.pitchesLdu).toEqual([126]);
    expect(result.trains[0]!.meanPitchLdu).toBe(126);
  });

  it('reports a wheeled chassis away from every route as a stray, never as a ride car', () => {
    const away = carAt(40, 500, false);
    const result = run([...STRAIGHT_ROUTE, ...away]);
    expect(result.cars).toHaveLength(1);
    expect(result.cars[0]!.route).toBeUndefined();
    expect(result.strays).toHaveLength(1);
    expect(result.strays[0]!.nearestFragmentId).toBe('80562:0');
    expect(result.strays[0]!.nearestFragmentDistanceLdu).toBeGreaterThan(CAR_ON_ROUTE_MAX_LDU);
    expect(result.trains).toEqual([]);
    expect(result.warnings.some(w => w.includes('none within'))).toBe(true);
  });

  it('finds nothing and says so when no brick carries wheels', () => {
    const result = run([...STRAIGHT_ROUTE, brick('3001.dat', 40, -60, 0)]);
    expect(result.cars).toEqual([]);
    expect(result.warnings.some(w => w.startsWith('No rolling chassis found'))).toBe(true);
    expect(result.warnings.some(w => w.startsWith('No lift detected'))).toBe(true);
  });
});

describe('coaster assemblies: chain lift', () => {
  // Two 26561 ramps descend 288 LDU with increasing arc (LDraw Y down).
  const HILL = [brick('26561.dat', 0, 0, 0), brick('26561.dat', 160, 144, 0)];
  it('finds a chain lift from sprockets under a climbing section, on both sides of the datum plane', () => {
    const result = run([...HILL,
      brick('4185.dat', 0, 80, 15), brick('4185.dat', 0, 80, -15),      // foot, 112 LDU under the datum (-32)
      brick('4185.dat', 300, 370, 15), brick('4185.dat', 300, 370, -15), // crest
    ]);
    expect(result.lifts).toHaveLength(1);
    const lift = result.lifts[0] as CoasterChainLift;
    expect(lift.kind).toBe('chain');
    expect(lift.sprockets).toHaveLength(4);
    expect(lift.links).toEqual([]);
    // The sprockets project inside the two ramps' 288 LDU descent: their span rises less than the whole hill.
    expect(lift.riseLdu).toBeGreaterThanOrEqual(LIFT_MIN_RISE_LDU);
    expect(lift.riseLdu).toBeLessThan(288);
    expect(lift.riseLdu).toBeCloseTo(232.9, 0);
    // An open route is ordered from its lowest endpoint, so the climb runs with increasing arc.
    expect(lift.climbDirection).toBe(1);
    expect(lift.arcStartLdu).toBeLessThan(lift.arcEndLdu);
  });

  it('ignores drive parts beside the rails or above them, and a lone sprocket', () => {
    const beside = run([...HILL, brick('4185.dat', 0, 80, 70), brick('4185.dat', 300, 370, 70)]);
    expect(beside.lifts).toEqual([]);
    const above = run([...HILL, brick('4185.dat', 0, -100, 0), brick('4185.dat', 300, -400, 0)]);
    expect(above.lifts).toEqual([]);
    const lone = run([...HILL, brick('4185.dat', 0, 80, 0)]);
    expect(lone.lifts).toEqual([]);
    expect(lone.warnings.some(w => w.includes('a lift needs two parts'))).toBe(true);
  });

  it('counts chain links as drive evidence', () => {
    const links = Array.from({ length: 12 }, (_, k) => brick('3711.dat', k * 25, 60 + k * 22.5, 0));
    const result = run([...HILL, ...links]);
    expect(result.lifts).toHaveLength(1);
    expect((result.lifts[0] as CoasterChainLift).links).toHaveLength(12);
  });
});

describe('coaster assemblies: platform lift', () => {
  /** Eight 1x4 bricks sharing one 2-degree tilt about Z: two wall rails at lateral ±28 whose tops meet the track's rail top. */
  function platform(tiltDeg: number, originX: number): ParsedBrick[] {
    const s = Math.sin(tiltDeg * Math.PI / 180), c = Math.cos(tiltDeg * Math.PI / 180);
    const T = [c, s, 0, -s, c, 0, 0, 0, 1];
    const origin: Vec3 = [originX, 6, 0];
    const out: ParsedBrick[] = [];
    for (const dx of [-120, -40, 40, 120]) for (const z of [-28, 28]) {
      const local: Vec3 = [dx, 0, z];
      out.push(brick('3010.dat', origin[0] + T[0]! * local[0] + T[1]! * local[1] + T[2]! * local[2], origin[1] + T[3]! * local[0] + T[4]! * local[1] + T[5]! * local[2], origin[2] + T[6]! * local[0] + T[7]! * local[1] + T[8]! * local[2], T, 191));
    }
    return out;
  }

  it('finds an articulated deck docked at an open terminal and measures its translation to the other one', () => {
    const result = run([...STRAIGHT_ROUTE, ...carAt(40), ...platform(2, 290)]);
    const platforms = result.lifts.filter((l): l is CoasterPlatformLift => l.kind === 'platform');
    expect(platforms).toHaveLength(1);
    const [lift] = platforms;
    expect(lift!.bricks).toHaveLength(8);
    expect(lift!.tiltDeg).toBeCloseTo(2, 1);
    expect(lift!.deck.rule).toBe('wheel-tread-band');
    expect(lift!.deck.memberCount).toBe(8);
    expect(lift!.carOriginAboveRailLdu).toBeCloseTo(28.3, 3);
    expect(lift!.parked.end).toBe('end');
    expect(lift!.parked.deckEnd).toBe('a');
    expect(lift!.parked.misfitDistanceLdu).toBeLessThanOrEqual(PLATFORM_DOCK_MAX_LDU);
    expect(lift!.travel.axisWorld).toEqual([-1, 0, 0]);
    // Deck A's car-origin line starts 1 LDU inside x 130 (the tilted up vector leans it), 169 from the start terminal at x -40.
    expect(Math.abs(lift!.travel.distanceLdu - 170)).toBeLessThan(2);
    expect(lift!.travel.deliveredAt.end).toBe('start');
    expect(lift!.travel.deliveredAt.misfitDistanceLdu).toBeLessThanOrEqual(PLATFORM_DOCK_MAX_LDU);
    expect(lift!.travel.betweenTerminalsLdu).toBeCloseTo(160, 3);
  });

  it('does not dock a rigid group that stands away from every terminal, and never on a closed route', () => {
    const away = run([...STRAIGHT_ROUTE, ...carAt(40), ...platform(2, 2000)]);
    expect(away.lifts).toEqual([]);
    const loop = [
      [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, -1, 0, 1, 0, 1, 0, 0], [-1, 0, 0, 0, 1, 0, 0, 0, -1], [0, 0, 1, 0, 1, 0, -1, 0, 0],
    ].map(rot => brick('25061.dat', 0, 0, 0, rot));
    const closed = run([...loop, ...platform(2, 290)]);
    expect(closed.lifts).toEqual([]);
    expect(closed.warnings.some(w => w.startsWith('No lift detected'))).toBe(true);
  });
});

// ─── Real corpus files (skipped where absent, e.g. CI) ───────────────────────

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const PUBLISHED_10303 = 'C:/git/clego/lego_sets/IOModel2V2/10303.ldr';
const PUBLISHED_10261 = 'C:/git/clego/lego_sets/IOModel2V2/10261.ldr';
const HAVE_CORPUS = existsSync(LDRAW_ROOT) && existsSync(PUBLISHED_10303) && existsSync(PUBLISHED_10261);

async function detectFile(file: string) {
  setLDrawRoot(LDRAW_ROOT);
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const provider = createPartGeometryProvider({ document: doc });
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const tracks = extractCoasterTrackRoutes(doc.bricks, { isGeometryAvailable: (_id, b) => (meshes.get(b.part)?.triangles.length ?? 0) > 0 });
  return { bricks: doc.bricks, tracks, result: detectCoasterAssemblies(doc.bricks, meshes, tracks) };
}

describe.skipIf(!HAVE_CORPUS)('10303 Loop Coaster (published IOModel2V2 source)', () => {
  it('finds the three 26021 cars 120 LDU apart on the drop, the counterweight as strays, and the brick platform lift', async () => {
    const { bricks, result } = await detectFile(PUBLISHED_10303);
    const ride = result.cars.filter(car => car.route);
    expect(ride).toHaveLength(3);
    for (const car of ride) {
      expect(car.chassis.part).toBe('26021.dat');
      expect(car.wheels).toHaveLength(2);
      expect(car.seats).toHaveLength(1);
      expect(car.seats[0]!.source).toBe('rider');
      expect(car.seats[0]!.localLdu[0]).toBeCloseTo(-18, 1);
      expect(car.seats[0]!.localLdu[1]).toBeCloseTo(-1, 1);
      expect(car.seats[0]!.localLdu[2]).toBeCloseTo(0, 1);
      expect(car.route!.offsetLdu).toBeCloseTo(14, 1);
      expect(car.route!.heading).toBe(-1);
      expect(car.wheelGeometry).toEqual({ axleBelowOriginLdu: 17.502, flangeRadiusLdu: 13.4, treadBandLdu: [24, 33] });
      expect(car.lengthLdu).toBe(141);
      expect(car.widthLdu).toBe(80);
    }
    expect(result.trains).toHaveLength(1);
    expect(result.trains[0]!.carIds).toHaveLength(3);
    expect(result.trains[0]!.meanPitchLdu).toBe(120);
    for (const pitch of result.trains[0]!.pitchesLdu) expect(pitch).toBeCloseTo(120, 2);
    expect(result.originAboveDatumLdu).toBeCloseTo(14, 1);
    expect(result.datumAboveRailTopLdu).toBe(14);
    // The counterweight: two 26021 chassis riding the withheld 25059 guide.
    const guide = result.strays.filter(s => s.car.chassis.part === '26021.dat');
    expect(guide).toHaveLength(2);
    for (const stray of guide) {
      expect(stray.nearestFragmentId).toMatch(/^25059:/);
      expect(stray.nearestFragmentDistanceLdu).toBeCloseTo(14, 1);
    }
    // The lift: the tilted brick platform, and no chain drive under the course.
    expect(result.lifts.filter(l => l.kind === 'chain')).toEqual([]);
    const platforms = result.lifts.filter((l): l is CoasterPlatformLift => l.kind === 'platform');
    expect(platforms).toHaveLength(1);
    const [lift] = platforms;
    expect(lift!.bricks).toHaveLength(55);
    expect(lift!.tiltDeg).toBeCloseTo(4.11, 2);
    expect(lift!.deck.rule).toBe('wheel-tread-band');
    // The wheels ride the 30413 panels' wall tops (and the 23950 end pieces), not the 11212 deck 24 LDU lower.
    expect(lift!.deck.memberCount).toBe(10);
    expect(lift!.deck.railTopLocalY).toBeCloseTo(-31.78, 1);
    expect(lift!.carOriginAboveRailLdu).toBeCloseTo(28, 1);
    expect(lift!.parked).toMatchObject({ routeLabel: 'Track 1', end: 'start', deckEnd: 'b' });
    expect(lift!.parked.misfitLdu[0]).toBeCloseTo(15.2, 0);
    expect(lift!.parked.misfitLdu[1]).toBeCloseTo(30.2, 0);
    expect(Math.abs(lift!.parked.misfitLdu[2])).toBeLessThan(1);
    expect(lift!.travel.axisWorld).toEqual([0, -1, 0]);
    expect(lift!.travel.distanceLdu).toBeCloseTo(1854.6, 0);
    expect(lift!.travel.betweenTerminalsLdu).toBeCloseTo(1857.8, 0);
    expect(lift!.travel.deliveredAt).toMatchObject({ routeLabel: 'Track 1', end: 'end', deckEnd: 'a' });
    expect(lift!.travel.deliveredAt.terminalLdu[0]).toBeCloseTo(-781.8, 1);
    expect(lift!.travel.deliveredAt.misfitDistanceLdu).toBeCloseTo(7.6, 0);
    // No wheel is a platform member: the 55981/4185 rollers at the tower base belong to the hoist.
    expect(lift!.bricks.some(i => /^(55981|4185)\.dat$/.test(bricks[i]!.part))).toBe(false);
  });
});

describe.skipIf(!HAVE_CORPUS)('10261 Roller Coaster (IOModel2V2 source)', () => {
  it('finds two three-car trains of composite 26021c01 at 126 LDU, the hill\'s chain lift, and no platform', async () => {
    const { bricks, result, tracks } = await detectFile(PUBLISHED_10261);
    expect(tracks.routes.map(r => r.closed)).toEqual([true, false]);
    const ride = result.cars.filter(car => car.route);
    expect(ride).toHaveLength(6);
    for (const car of ride) {
      expect(car.chassis.part).toBe('26021c01.dat');
      expect(car.wheels).toEqual([]);
      expect(car.seats).toHaveLength(1);
      expect(car.seats[0]!.localLdu[0]).toBeCloseTo(-18, 1);
      expect(car.seats[0]!.localLdu[1]).toBeCloseTo(-1, 1);
      expect(car.seats[0]!.localLdu[2]).toBeCloseTo(0, 1);
      expect(car.route!.offsetLdu).toBeCloseTo(14.32, 1);
    }
    expect(result.trains).toHaveLength(2);
    const [circuit, siding] = result.trains;
    expect(circuit).toMatchObject({ routeIndex: 0, routeClosed: true });
    expect(circuit!.meanPitchLdu).toBeCloseTo(126, 2);
    expect(circuit!.carIds).toHaveLength(3);
    expect(siding).toMatchObject({ routeIndex: 1, routeClosed: false });
    expect(siding!.meanPitchLdu).toBeCloseTo(126, 2);
    expect(siding!.carIds).toHaveLength(3);
    expect(siding!.routeLengthLdu).toBeCloseTo(480, 0);
    // Riders sit in the circuit train only; the siding train inherits the seat from the same mould.
    expect(ride.filter(car => car.route!.routeIndex === 0).every(car => car.seats[0]!.source === 'rider')).toBe(true);
    expect(ride.filter(car => car.route!.routeIndex === 1).every(car => car.seats[0]!.source === 'sibling')).toBe(true);
    expect(result.lifts.filter(l => l.kind === 'platform')).toEqual([]);
    const chains = result.lifts.filter((l): l is CoasterChainLift => l.kind === 'chain');
    expect(chains).toHaveLength(1);
    const [lift] = chains;
    expect(lift!.routeIndex).toBe(0);
    // Four 4185 wedge-belt wheels (foot and crest pairs), the crest axle's 94925 gear, and a mid-hill 87407 pair.
    expect(lift!.sprockets).toHaveLength(7);
    expect(lift!.sprockets.filter(i => bricks[i]!.part === '4185.dat')).toHaveLength(4);
    expect(lift!.links).toEqual([]);
    expect(lift!.riseLdu).toBeCloseTo(966.9, 0);
    expect(lift!.arcStartLdu).toBeCloseTo(127.3, 0);
    expect(lift!.arcEndLdu).toBeCloseTo(1690.9, 0);
    // The cars travel with increasing arc and the lift climbs the same way.
    expect(lift!.climbDirection).toBe(1);
    expect(ride.filter(car => car.route!.routeIndex === 0).every(car => car.route!.heading === 1)).toBe(true);
    // The station gear under the platform straight is reported and rejected on its own.
    expect(result.warnings.some(w => w.includes('11955@'))).toBe(true);
  });
});
