/**
 * The tap pick of a vehicle's moving parts (vehicle-parts.ts `pickVehiclePart`, audit A-02): which door a tap on a
 * parked vehicle meant, from the eye and the view alone (a touch tap's finger is never reported).
 */
import { describe, expect, it } from 'vitest';
import { VEHICLE_PART, pickVehiclePart, vehiclePartAnimation } from '../web/src/engine/vehicle-parts.js';
import { boneTransforms } from '../web/src/engine/bedrock-geometry-faces.js';

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

  it('follows the body\'s leftover lean: the part is picked where the leaned body draws it (TODO vehicle-parts-lean)', () => {
    // A cupboard high on a long body's far end, entity frame at 100 %: 6 blocks forward, 2.5 up.
    const cupboard = { closed: [-0.4, 2.3, 5.8, 0.4, 2.7, 6.2], open: [-0.4, 2.3, 5.8, 0.4, 2.7, 6.6] };
    // The drawn body: the `body` bone about its pivot (the entity origin), the drive animation's [-pitch, 0, -bank]
    // (vehicleClientAnimation) through the same transform the simulator draws with (boneTransforms, JSON z mirrored).
    const pitch = 12, bank = 8;
    const bones = [{ name: 'body', pivot: [0, 0, 0] as [number, number, number] }];
    const T = boneTransforms(bones, undefined, new Map([['body', { rotation: [-pitch, 0, -bank] as [number, number, number], position: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }]])).get('body')!;
    const c = cupboard.closed, mid = [(c[0]! + c[3]!) / 2, (c[1]! + c[4]!) / 2, (c[2]! + c[5]!) / 2];
    // Entity -> JSON (z mirrored, sixteenths), through the bone, back.
    const j = [mid[0]! * 16, mid[1]! * 16, -mid[2]! * 16];
    const w = [T[0]! * j[0]! + T[1]! * j[1]! + T[2]! * j[2]! + T[3]!, T[4]! * j[0]! + T[5]! * j[1]! + T[6]! * j[2]! + T[7]!, T[8]! * j[0]! + T[9]! * j[1]! + T[10]! * j[2]! + T[11]!];
    const drawn = { x: POSE.x + w[0]! / 16, y: POSE.y + w[1]! / 16, z: POSE.z - w[2]! / 16 };
    // The child stands 1.5 blocks beside the drawn cupboard and looks straight at it.
    const eye = { x: drawn.x + 1.5, y: drawn.y, z: drawn.z };
    const dir = { x: -1, y: 0, z: 0 };
    // Unleaned, the drawn cupboard has moved off the box the pick tests (over a block at this lean).
    expect(Math.hypot(drawn.x - POSE.x - mid[0]!, drawn.y - POSE.y - mid[1]!, drawn.z - POSE.z - mid[2]!)).toBeGreaterThan(1);
    expect(pickVehiclePart([cupboard], { ...POSE, pitch, bank, pivot: [0, 0, 0] }, 1, eye, dir, [false], { ...VEHICLE_PART, CONE_DEG: 0 })).toBe(0);
    // And the same view on the unleaned body misses it (the box is where the body would be level).
    expect(pickVehiclePart([cupboard], { ...POSE, pitch: 0, bank: 0, pivot: [0, 0, 0] }, 1, eye, dir, [false], { ...VEHICLE_PART, CONE_DEG: 0 })).toBe(-1);
  });

  it('eases every part toward its own property in the client animation', () => {
    const a = vehiclePartAnimation([{ angle: 90 }, { angle: 12, slide: true }], 0.3);
    expect(a.bones['vpart0_spin']).toEqual({ rotation: [0, '-v.vp0', 0] });
    expect(a.bones['vpart1_spin']).toEqual({ position: [0, 'v.vp1 * 0.3', 0] });
    expect(a.initialize).toEqual(["v.vp0 = q.property('craftmatic:vpart_0');", "v.vp1 = q.property('craftmatic:vpart_1');"]);
    expect(a.preAnimation[0]).toContain('q.delta_time * 225');
  });
});
