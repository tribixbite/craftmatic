/**
 * Driven vehicles: the road-wheel grouping of the compiler's vehicle rig and
 * the client drive animation (engine/bedrock-vehicle.ts).
 */
import { describe, expect, it } from 'vitest';
import { vehicleWheelAssemblies, type VehicleWheelBone } from '../web/src/engine/ldraw-entity-compiler.js';
import { vehicleClientAnimation, vehicleMotionOf } from '../web/src/engine/bedrock-vehicle.js';

type Box = { index: number; min: [number, number, number]; max: [number, number, number] };
const box = (index: number, min: [number, number, number], max: [number, number, number]): Box => ({ index, min, max });

describe('road wheels', () => {
  // 10337's wheel placements as the compiler sees them (levelled LDraw frame, travel along X):
  // twin rear wheels (56904 rim in a 70490 tyre, 5650 rim set IN along the axle in a 15413 tyre) and two fronts.
  const countach: Box[] = [
    box(0, [-128, -100, 82], [-52, -24, 120]), box(1, [-128, -100, -200], [-52, -24, -162]),
    box(2, [-152, -123, -198], [-28, 0, -162]), box(3, [-152, -123, 82], [-28, 0, 118]),
    box(4, [-128, -100, 118], [-52, -24, 168]), box(5, [-128, -100, -248], [-52, -24, -198]),
    box(6, [372, -100, 115], [448, -24, 165]), box(7, [372, -100, -245], [448, -24, -195]),
    box(8, [-152, -124, 118], [-28, 0, 168]), box(9, [-152, -124, -248], [-28, 0, -198]),
    box(10, [348, -124, 115], [472, 0, 165]), box(11, [348, -124, -245], [472, 0, -195]),
  ];
  it('puts each rim in its tyre, even set in along the axle, and keeps twin wheels apart', () => {
    const { wheels, rejected } = vehicleWheelAssemblies(countach, 'x');
    expect(rejected).toBe(0);
    expect(wheels.map(w => w.indices.sort((a, b) => a - b))).toEqual([[0, 3], [1, 2], [4, 8], [5, 9], [6, 10], [7, 11]]);
    expect(wheels.every(w => w.axle === 2 && w.radiusLdu === 62)).toBe(true);
  });
  it('leaves a wheel lying flat, or one turned along the travel axis, on the body and counts it', () => {
    const flat = box(0, [0, -8, 0], [40, 0, 40]);
    const along = box(1, [100, -40, 0], [140, 0, 10]);
    const { wheels, rejected } = vehicleWheelAssemblies([flat, along], 'z');
    expect(wheels).toEqual([]);
    expect(rejected).toBe(2);
  });
});

describe('drive animation', () => {
  const wheels: VehicleWheelBone[] = [
    { name: 'wheel_0', radiusBlocks: 0.32, parts: 2, pivot: [0, 5, 20], end: -1 },
    { name: 'wheel_1', radiusBlocks: 0.32, parts: 2, pivot: [0, 5, -20], end: 1 },
  ];
  it('spins every wheel by its own radius and steers only the front ones', () => {
    const a = vehicleClientAnimation('car_1', 'car', wheels);
    const bones = (a.file as any).animations[a.id].bones;
    expect(bones.wheel_0.rotation).toEqual(['v.cm_wheel / 0.32', 0, 0]);
    expect(bones.wheel_1.rotation).toEqual(['v.cm_wheel / 0.32', 'v.cm_steer', 0]);
    expect(bones.body.rotation).toEqual(['v.cm_pitch', 0, 'v.cm_roll']);
    expect(a.client.animate).toEqual(['drive']);
  });
  it('declares every variable it reads in initialize (an unset one errors every frame)', () => {
    for (const motion of ['car', 'boat', 'plane', 'rotor'] as const) {
      const a = vehicleClientAnimation('v', motion, wheels);
      const text = JSON.stringify(a.file) + a.client.preAnimation.join(' ');
      const used = new Set(text.match(/v\.cm_[a-z_]+/g));
      const declared = new Set(a.client.initialize.map(l => l.split('=')[0]!.trim()));
      expect([...used].filter(v => !declared.has(v))).toEqual([]);
    }
  });
  it('bobs only a boat, banks a plane into the turn and leans a car out of it', () => {
    const boat = vehicleClientAnimation('b', 'boat', []);
    expect((boat.file as any).animations[boat.id].bones.body.position).toBeDefined();
    const plane = vehicleClientAnimation('p', 'plane', []).client.preAnimation.join(' ');
    expect(plane).toMatch(/v\.cm_yaw_rate \* -0\.55/);
    expect(plane).toMatch(/math\.atan2\(q\.vertical_speed/);
    expect(vehicleClientAnimation('c', 'car', []).client.preAnimation.join(' ')).toMatch(/v\.cm_yaw_rate \* 0\.045/);
  });
  it('tells a rotorcraft from a fixed wing by its title', () => {
    expect(vehicleMotionOf('plane', 'Rescue Helicopter (42092-1)')).toBe('rotor');
    expect(vehicleMotionOf('plane', 'Passenger Airplane (60367-1)')).toBe('plane');
    expect(vehicleMotionOf('boat', 'Pirate Ship')).toBe('boat');
  });
});
