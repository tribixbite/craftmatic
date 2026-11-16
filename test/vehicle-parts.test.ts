/**
 * The tap pick of a vehicle's moving parts (vehicle-parts.ts `pickVehiclePart`, audit A-02): which door a tap on a
 * parked vehicle meant, from the eye and the view alone (a touch tap's finger is never reported).
 */
import { describe, expect, it } from 'vitest';
import { VEHICLE_PART, pickVehiclePart, pickVehicleTap, vehiclePartAnimation, vehicleSlideWorldPath } from '../web/src/engine/vehicle-parts.js';
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

  it('rides a roof slide the child looks up at from the ground, a part on the view ray first, and only the slide while moving', () => {
    // A slide on the roof 4.2-7.9 blocks up (41395's), entity frame at 100 %.
    const slides = [{ box: [-3.4, 4.2, -6.7, 1.1, 7.9, -4.1] }];
    const eye = { x: 10 - 1.2, y: 65.62, z: 20 - 8 };
    const up = { x: -0.2, y: 3.2, z: 2.3 };
    // Out of a part's 2.5-block reach (it is 2.6 up), inside the slide's: ridden.
    expect(pickVehicleTap(pickVehiclePart, DOORS, slides, POSE, 1, eye, up, shut, false, VEHICLE_PART)).toEqual({ slide: 0 });
    // The same view while the vehicle moves still names the slide (the runtime refuses it); looking at a door names the door.
    expect(pickVehicleTap(pickVehiclePart, DOORS, slides, POSE, 1, eye, up, shut, true, VEHICLE_PART)).toEqual({ slide: 0 });
    expect(pickVehicleTap(pickVehiclePart, DOORS, slides, POSE, 1, { x: 8, y: 65.6, z: 20 }, { x: 1, y: -0.3, z: 0 }, shut, false, VEHICLE_PART)).toEqual({ part: 0 });
    // Moving, a door is never answered (the tap boards as before).
    expect(pickVehicleTap(pickVehiclePart, DOORS, slides, POSE, 1, { x: 8, y: 65.6, z: 20 }, { x: 1, y: -0.3, z: 0 }, shut, true, VEHICLE_PART)).toBeNull();
  });

  it('a tap aimed at the hull boards: a part answers only a tap whose view ray is ON it, never one merely near it (regression fresh-car-tap-50-30zd)', () => {
    // The 50 % McLaren of the regression, parked at yaw 90: its steering wheel (a turnable) sits inside the cabin, and the
    // child 2 blocks south of the root looks at the car's middle. The view ray passes the wheel's box; the 60-degree
    // cone then took the tap meant to board for the wheel, and nobody boarded.
    const wheel = [{ closed: [0.372, 0.694, 0.416, 0.833, 1.155, 0.561], open: [0.373, 0.694, 0.416, 0.833, 1.155, 0.561] }];
    const pose = { x: 9.5, y: -60, z: 0.25, yaw: 90 };
    const eye = { x: 9.5, y: -58.38, z: -1.75 }, toHull = { x: 0, y: -0.47786709020297374, z: 0.8784321511084069 };
    expect(pickVehicleTap(pickVehiclePart, wheel, [], pose, 0.5, eye, toHull, [false], false, VEHICLE_PART)).toBeNull();
    // The same wheel looked AT (the ray through its box's centre) still turns.
    const c = [0, 1, 2].map(a => (wheel[0]!.closed[a]! + wheel[0]!.closed[a + 3]!) / 2 * 0.5);
    // Entity frame -> world at yaw 90 (+x turns toward +z): world x = -ez, world z = ex.
    const at = { x: pose.x - c[2]!, y: pose.y + c[1]!, z: pose.z + c[0]! };
    const look = { x: at.x - eye.x, y: at.y - eye.y, z: at.z - eye.z };
    expect(pickVehicleTap(pickVehiclePart, wheel, [], pose, 0.5, eye, look, [false], false, VEHICLE_PART)).toEqual({ part: 0 });
  });

  it('turns and scales the running line of a slide to where the vehicle stands', () => {
    const w = vehicleSlideWorldPath([[0, 2, 1], [1, 1, 3]], { x: 10, y: 64, z: 20, yaw: 90 }, 2);
    // Bedrock yaw 90: entity +z is world -x, entity +x world +z.
    expect(w[0]!.x).toBeCloseTo(8, 9); expect(w[0]!.y).toBeCloseTo(68, 9); expect(w[0]!.z).toBeCloseTo(20, 9);
    expect(w[1]!.x).toBeCloseTo(4, 9); expect(w[1]!.z).toBeCloseTo(22, 9);
  });

  it('eases every part toward its own property in the client animation', () => {
    const a = vehiclePartAnimation([{ angle: 90 }, { angle: 12, slide: true }], 0.3);
    expect(a.bones['vpart0_spin']).toEqual({ rotation: [0, '-v.vp0', 0] });
    expect(a.bones['vpart1_spin']).toEqual({ position: [0, 'v.vp1 * 0.3', 0] });
    expect(a.initialize).toEqual(["v.vp0 = q.property('craftmatic:vpart_0');", "v.vp1 = q.property('craftmatic:vpart_1');"]);
    expect(a.preAnimation[0]).toContain('q.delta_time * 225');
  });
});
