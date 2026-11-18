/**
 * Doors stacked in one doorway, and moving parts hung under the ground (interactivity-stage.ts, census 2026-11-16).
 *
 * The PDF-reconstructed "building set" buckets (5582, 5482, 3600) place two to four door leaves one above the other
 * in the same doorway columns, each touching or overlapping the next by a sliver: the upper leaf's threshold is the
 * lower leaf's head room, so one door's passage removes the other's floor (5582 Door 2 fell 3.19 blocks at its door
 * plane at 150 %). One leaf of such a stack works (the export keeps the one leading furthest, `chooseStackedDoors`); `stackedDoorways` is the keep-the-lowest fallback tested here.
 *
 * 2504's right gate leaf is posed upside down by the reconstruction and hangs 0.48 block under the ground: an entity
 * is lit by the block at its root, so a root inside the ground block draws the door dark (the shells' lift, see
 * `originAboveModel`), and the simulator found the root 1.93 under the ground at 400 %. A moving part's root moves
 * up its own hinge to the ground plane; the drawn part is the same.
 */
import { describe, expect, it } from 'vitest';
import { groundedAnchors, stackedDoorways } from '../web/src/engine/interactivity-stage.js';
import type { SceneInteractive } from '../web/src/engine/bedrock-interactives.js';
import type { Vec3 } from '../web/src/engine/ldraw-part-geometry.js';

/** LDraw -> grid blocks: 20 LDU across, 24 LDU up (LDraw y is down), z mirrored, as `sceneGridPoint` at scale 1. */
const toGrid = (p: Vec3): Vec3 => [p[0] / 20, -p[1] / 24, -p[2] / 20];

/** A door leaf whose closed mid-plane starts at grid (x, y, z), `w` blocks wide along +x, `h` tall, facing -z. */
function door(x: number, y: number, z: number, w = 1.33, h = 2.51, kind: SceneInteractive['kind'] = 'door'): SceneInteractive {
  const corner: Vec3 = [x * 20, -y * 24, -z * 20];
  const box = { min: [x * 20, -(y + h) * 24, -z * 20 - 1] as Vec3, max: [(x + w) * 20, -y * 24, -z * 20 + 1] as Vec3 };
  return {
    kind, part: '60623', description: 'Door 1 x 4 x 6', bricks: [], pivotLdu: corner, axisLdu: [0, -1, 0], angleDeg: 90,
    leaf: { corner, along: [w * 20, 0, 0], up: [0, -h * 24, 0], normal: [0, 0, 1], thicknessLdu: 2 },
    anchorLdu: [(x + w / 2) * 20, -y * 24, -z * 20], boundsLdu: box, offGridDeg: 0,
  };
}

describe('stackedDoorways: only the lowest leaf of a stack in one doorway is a door', () => {
  it('5582: Door 2 stands on Door 1 with a 0.11-block overlap in the same columns -> Door 2 is demoted', () => {
    const items = [door(8.7, -0.27, 10), door(8.7, 2.13, 10)];
    expect([...stackedDoorways(items, toGrid)]).toEqual([1]);
  });
  it('5482: four leaves stacked 1.95 apart, 0.375 off each other in depth and width -> all but the lowest', () => {
    const items = [door(2.83, 1.18, 6.125, 1.16, 2.0), door(3.2, 3.13, 6.5, 1.16, 2.0), door(3.2, 5.08, 6.5, 1.16, 2.0), door(3.2, 7.03, 6.5, 1.16, 2.0)];
    expect([...stackedDoorways(items, toGrid)].sort()).toEqual([1, 2, 3]);
  });
  it('keeps a double door (side by side), two storeys with a floor between them (910047: 0.38 apart) and a window', () => {
    expect(stackedDoorways([door(0, 0, 0), door(1.33, 0, 0)], toGrid).size).toBe(0);
    expect(stackedDoorways([door(0, 0, 0, 1.33, 3.75), door(0, 4.13, 0, 1.33, 3.75)], toGrid).size).toBe(0);
    expect(stackedDoorways([door(0, 0, 0), door(0, 2.4, 0, 1.33, 2.51, 'window')], toGrid).size).toBe(0);
    // Two doors one above the other in DIFFERENT walls (2 blocks apart in depth) are two doorways.
    expect(stackedDoorways([door(0, 0, 0), door(0, 2.4, 2)], toGrid).size).toBe(0);
  });
});

describe('groundedAnchors: a moving part\'s root is never under the ground plane', () => {
  it('2504: a gate leaf hanging 0.48 under the ground has its root moved up to the ground, on its own hinge line', () => {
    const it0 = door(9.84, -0.48, 8.6);
    const [lifted] = groundedAnchors([it0], toGrid);
    expect(toGrid(lifted!.anchorLdu)[1]).toBeCloseTo(0, 6);
    expect(lifted!.anchorLdu[0]).toBe(it0.anchorLdu[0]);
    expect(lifted!.anchorLdu[2]).toBe(it0.anchorLdu[2]);
    // Nothing else of the part moves.
    expect(lifted!.leaf).toEqual(it0.leaf);
    expect(lifted!.pivotLdu).toEqual(it0.pivotLdu);
  });
  it('leaves a part standing on or above the ground as it is', () => {
    const it0 = door(0, 0, 0), it1 = door(0, 1.2, 3);
    const out = groundedAnchors([it0, it1], toGrid);
    expect(out[0]).toBe(it0);
    expect(out[1]).toBe(it1);
  });
});
