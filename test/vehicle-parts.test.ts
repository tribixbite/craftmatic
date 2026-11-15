/**
 * The tap pick of a vehicle's moving parts (vehicle-parts.ts `pickVehiclePart`, audit A-02): which door a tap on a
 * parked vehicle meant, from the eye and the view alone (a touch tap's finger is never reported).
 */
import { describe, expect, it } from 'vitest';
import { VEHICLE_PART, pickVehiclePart, vehiclePartAnimation } from '../web/src/engine/vehicle-parts.js';

/** Two doors on a car's flanks, entity frame at 100 %: left at x -1.1, right at x +1.1, both 1 block long, 1.5 tall. */
const DOORS = [
  { closed: [-1.15, 0.2, -0.5, -1.05, 1.7, 0.5], open: [-2.1, 0.2, 0.4, -1.1, 1.7, 0.5] },
  { closed: [1.05, 0.2, -0.5, 1.15, 1.7, 0.5], open: [1.1, 0.2, 0.4, 2.1, 1.7, 0.5] },
];
const POSE = { x: 10, y: 64, z: 20, yaw: 0 };
const shut = [false, false];

describe('which part a tap on a parked vehicle meant (pickVehiclePart, A-02)', () => {
  it('picks the door the view points at, on either flank', () => {
    expect(pickVehiclePart(DOORS, POSE, 1, { x: 8, y: 65.6, z: 20 }, { x: 1, y: -0.3, z: 0 }, shut, VEHICLE_PART)).toBe(0);
    expect(pickVehiclePart(DOORS, POSE, 1, { x: 12, y: 65.6, z: 20 }, { x: -1, y: -0.3, z: 0 }, shut, VEHICLE_PART)).toBe(1);
  });

  it('boards instead when no part is within reach or the view looks away', () => {
    // Four blocks off the left door: past REACH_BLOCKS.
    expect(pickVehiclePart(DOORS, POSE, 1, { x: 4.5, y: 65.6, z: 20 }, { x: 1, y: 0, z: 0 }, shut, VEHICLE_PART)).toBe(-1);
    // Beside the left door, looking straight away from it.
    expect(pickVehiclePart(DOORS, POSE, 1, { x: 8, y: 65.6, z: 20 }, { x: -1, y: 0, z: 0 }, shut, VEHICLE_PART)).toBe(-1);
  });

  it('turns and scales the boxes with the vehicle (yaw 90, 200 percent)', () => {
    // Bedrock yaw 90: entity +x is world +z, entity -x world -z; at 200 % the left door is 2.2 blocks out.
    const pose = { ...POSE, yaw: 90 };
    expect(pickVehiclePart(DOORS, pose, 2, { x: 10, y: 66, z: 16.5 }, { x: 0, y: -0.2, z: 1 }, shut, VEHICLE_PART)).toBe(0);
    expect(pickVehiclePart(DOORS, pose, 2, { x: 10, y: 66, z: 23.5 }, { x: 0, y: -0.2, z: -1 }, shut, VEHICLE_PART)).toBe(1);
  });

  it('gives overlapping boxes to the one aimed at (two stacked drawers whose corner boxes overlap)', () => {
    const drawers = [
      { closed: [-0.5, 1.0, 1.0, 0.5, 1.6, 1.2], open: [-0.5, 1.0, 1.0, 0.5, 1.6, 1.8] },
      { closed: [-0.5, 1.5, 1.0, 0.5, 2.1, 1.2], open: [-0.5, 1.5, 1.0, 0.5, 2.1, 1.8] },
    ];
    // Looking level at the upper drawer's middle (y 1.8) from 1.5 in front: the ray enters both boxes' faces at z 1.2.
    expect(pickVehiclePart(drawers, POSE, 1, { x: 10, y: 65.8, z: 22.7 }, { x: 0, y: 0, z: -1 }, shut, VEHICLE_PART)).toBe(1);
    expect(pickVehiclePart(drawers, POSE, 1, { x: 10, y: 65.3, z: 22.7 }, { x: 0, y: 0, z: -1 }, shut, VEHICLE_PART)).toBe(0);
  });

  it('tests an open part by its open box', () => {
    // Standing where the left door swung to (x -2.1..-1.1 entity, z 0.4..0.5), looking at it.
    const eye = { x: 10 - 1.6, y: 65.6, z: 20 + 1.6 };
    expect(pickVehiclePart(DOORS, POSE, 1, eye, { x: 0, y: -0.2, z: -1 }, [true, false], VEHICLE_PART)).toBe(0);
  });

  it('eases every part toward its own property in the client animation', () => {
    const a = vehiclePartAnimation([{ angle: 90 }, { angle: 12, slide: true }], 0.3);
    expect(a.bones['vpart0_spin']).toEqual({ rotation: [0, '-v.vp0', 0] });
    expect(a.bones['vpart1_spin']).toEqual({ position: [0, 'v.vp1 * 0.3', 0] });
    expect(a.initialize).toEqual(["v.vp0 = q.property('craftmatic:vpart_0');", "v.vp1 = q.property('craftmatic:vpart_1');"]);
    expect(a.preAnimation[0]).toContain('q.delta_time * 225');
  });
});
