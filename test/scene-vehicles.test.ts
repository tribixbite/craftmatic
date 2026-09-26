/**
 * Vehicle classification beyond the title words (engine/playable-components.ts:
 * craft words decided by parts, hover titles) and vehicles found standing in a
 * scene (engine/scene-vehicles.ts), on synthetic placements with known answers.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import { classifyVehicleKind, discoverPlayableComponents, isWholeVehicleLabel, vehicleKindFromParts } from '../web/src/engine/playable-components.js';
import { findSceneVehicles, SCENE_VEHICLES } from '../web/src/engine/scene-vehicles.js';

/** A part mesh that is just its box and its library description. */
const mesh = (description: string, min: Vec3, max: Vec3): LdrawPartMesh => ({
  partId: description, resolvedAs: description, triangles: [{ a: min, b: max, c: max } as never], studs: [], bounds: { min, max }, unresolvedRefs: [], description,
});

/** A scene builder: `add(part, description, box relative to the placement, at)`. */
function scene() {
  const bricks: ParsedBrick[] = [];
  const meshes = new Map<string, LdrawPartMesh | null>();
  const add = (part: string, description: string, min: Vec3, max: Vec3, at: Vec3): ParsedBrick => {
    if (!meshes.has(part)) meshes.set(part, mesh(description, min, max));
    const b: ParsedBrick = { part, color: 4, x: at[0], y: at[1], z: at[2] };
    bricks.push(b);
    return b;
  };
  return { bricks, meshes, add };
}

/** A town square: a baseplate, a building, a car on its wheels, a rowing boat with its oars, a barrow, a coaster car. */
function town() {
  const s = scene();
  // The ground: one 32 x 32 baseplate, its top at y = 0 (LDraw y is down).
  s.add('3811.dat', 'Baseplate 32 x 32', [-320, 0, -320], [320, 4, 320], [0, 0, 0]);
  // A building: 60 bricks stacked on the baseplate.
  for (let k = 0; k < 60; k++) s.add('3001.dat', 'Brick  2 x  4', [-40, -24, -20], [40, 0, 20], [-200 + (k % 3) * 80, -24 * Math.floor(k / 3), -200]);
  // A car 140 LDU long on four wheels (their bottoms on the baseplate), a chassis, a body and a steering wheel.
  const car: ParsedBrick[] = [];
  for (const [x, z] of [[110, -36], [230, -36], [110, 36], [230, 36]]) car.push(s.add('wheel.dat', 'Wheel 11mm D. x 6mm', [-8, -8, -4], [8, 8, 4], [x!, -8, z!]));
  car.push(s.add('plate.dat', 'Plate  4 x  8', [-70, -8, -40], [70, 0, 40], [170, -12, 0]));
  for (let k = 0; k < 8; k++) car.push(s.add('3001.dat', 'Brick  2 x  4', [-40, -24, -20], [40, 0, 20], [130 + (k % 2) * 80, -20 - 24 * Math.floor(k / 4), (k % 4 < 2 ? -20 : 20)]));
  car.push(s.add('3829.dat', 'Car Steering Wheel', [-10, -10, -4], [10, 0, 4], [150, -68, 0]));
  // A rowing boat lying on the ground: keel plates on the lowest layer, a hull on them, two oars beside it.
  const boat: ParsedBrick[] = [];
  for (let k = 0; k < 3; k++) boat.push(s.add('keel.dat', 'Plate  2 x  8', [-80, -8, -20], [80, 0, 20], [80, 0 - 0, 160 + k * 40]));
  for (let k = 0; k < 8; k++) boat.push(s.add('curve.dat', 'Slope Brick Curved  4 x  1', [-40, -24, -10], [40, 0, 10], [40 + (k % 2) * 80, -8, k < 4 ? 150 : 250]));
  for (const x of [60, 100]) boat.push(s.add('oar.dat', 'Minifig Tool Oar', [-4, -2, -40], [4, 2, 40], [x, -30, 290]));
  // A barrow: three wheels, 80 LDU long - too small to ride.
  for (const [x, z] of [[-60, 150], [-20, 130], [-20, 170]]) s.add('wheel.dat', 'Wheel 11mm D. x 6mm', [-8, -8, -4], [8, 8, 4], [x!, -8, z!]);
  for (let k = 0; k < 6; k++) s.add('3003.dat', 'Brick  2 x  2', [-20, -24, -20], [20, 0, 20], [-40, -16 - 24 * k, 150]);
  // A coaster car: four wheels under a ride chassis - the rail engine's, never a free car.
  for (const [x, z] of [[200, 200], [280, 200], [200, 250], [280, 250]]) s.add('wheel.dat', 'Wheel 11mm D. x 6mm', [-8, -8, -4], [8, 8, 4], [x!, -8, z!]);
  s.add('26021.dat', 'Train Base  4 x  5 Roller Coaster', [-60, -8, -40], [60, 0, 40], [240, -16, 225]);
  for (let k = 0; k < 8; k++) s.add('3001.dat', 'Brick  2 x  4', [-40, -24, -20], [40, 0, 20], [220 + (k % 2) * 40, -24 - 24 * Math.floor(k / 2), 225]);
  return { ...s, car, boat };
}

describe('vehicles standing in a scene (findSceneVehicles)', () => {
  const t = town();
  const found = findSceneVehicles(t.bricks, t.meshes);
  it('finds the car on its wheels with every one of its placements and nothing of the ground', () => {
    const car = found.components.find(c => c.kind === 'car');
    expect(car).toBeDefined();
    expect(new Set(car!.bricks)).toEqual(new Set(t.car));
    expect(car!.provenance).toMatch(/4 wheels with a steering wheel/);
  });
  it('finds the boat by its oars and takes its keel plates (they lie on the lowest layer) and the oars with it', () => {
    const boat = found.components.find(c => c.kind === 'boat');
    expect(boat).toBeDefined();
    expect(new Set(boat!.bricks)).toEqual(new Set(t.boat));
  });
  it('leaves the building, the barrow and the coaster car, and says why', () => {
    expect(found.components).toHaveLength(2);
    const reasons = found.candidates.filter(c => !c.kind).map(c => c.reason);
    expect(reasons.some(r => /too small to ride/.test(r))).toBe(true);
    expect(reasons.some(r => /rail engine/.test(r))).toBe(true);
  });
  it('keeps every tuned number in one exported table', () => {
    expect(SCENE_VEHICLES.MIN_LENGTH).toBe(120);
    expect(SCENE_VEHICLES.MAX_SHARE).toBeLessThan(0.5);
  });
});

describe('titles that name a craft or a hover craft', () => {
  const describe_ = (d: Record<string, string>) => (part: string): string => d[part] ?? '';
  const winged = [...Array(30)].map((_, i) => ({ part: `w${i}.dat`, color: 1, x: i, y: 0, z: 0 }));
  it('treats "Explorer" and "Bounty" as a vehicle whose kind the parts decide, and not "Bounty Hunter"', () => {
    expect(isWholeVehicleLabel('Galaxy Explorer (10497-1)')).toBe(true);
    expect(isWholeVehicleLabel("Destiny's Bounty (70618-1)")).toBe(true);
    expect(isWholeVehicleLabel('Bounty Hunter Pursuit')).toBe(false); // a bounty HUNTER is a figure, not a craft
    expect(classifyVehicleKind('Galaxy Explorer (10497-1)', 'auto')).toBeNull();
    expect(classifyVehicleKind('Galaxy Explorer (10497-1)', 'auto', 'plane')).toBe('plane');
  });
  it('reads wings as a plane, road wheels as a car, a hull as a boat', () => {
    const wingDescs = Object.fromEntries(winged.map(b => [b.part, 'Wedge Plate  4 x  2 Wing Left']));
    expect(vehicleKindFromParts(winged, describe_(wingDescs)).kind).toBe('plane');
    const wheels = winged.slice(0, 6);
    expect(vehicleKindFromParts(wheels, describe_(Object.fromEntries(wheels.map(b => [b.part, 'Tyre  6/ 50 x  8'])))).kind).toBe('car');
    const hull = winged.slice(0, 3);
    expect(vehicleKindFromParts(hull, describe_(Object.fromEntries(hull.map(b => [b.part, 'Boat Hull Unitary 41 x 12 x 6'])))).kind).toBe('boat');
    expect(vehicleKindFromParts(hull, () => 'Brick  2 x  4').kind).toBeNull();
  });
  it('makes a winged "Explorer" one whole plane, and leaves a partless one static with a warning', () => {
    const wingDescs = Object.fromEntries(winged.map(b => [b.part, 'Wing 3 x 4']));
    const found = discoverPlayableComponents(winged, 'Galaxy Explorer (10497-1)', 'auto', describe_(wingDescs));
    expect(found.components).toHaveLength(1);
    expect(found.components[0]).toMatchObject({ kind: 'plane' });
    expect(found.components[0]!.provenance).toMatch(/kind from its parts: .*wings/);
    const bare = discoverPlayableComponents(winged, 'Galaxy Explorer (10497-1)', 'auto', () => 'Brick  1 x  1');
    expect(bare.components).toHaveLength(0);
    expect(bare.warnings[0]).toMatch(/names a craft/);
  });
  it('keeps a sail barge a hull-shaped vehicle (it floats: vehicleMotionOf) and classifies a bare "Landspeeder"', () => {
    expect(classifyVehicleKind("Jabba's Sail Barge (75397-1)", 'auto')).toBe('boat');
    expect(classifyVehicleKind('X-34 Landspeeder', 'auto')).toBe('boat');
    expect(isWholeVehicleLabel('X-34 Landspeeder')).toBe(true);
  });
});
