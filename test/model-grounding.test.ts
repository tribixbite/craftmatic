/**
 * PROC-20 / TODO(grounded-favourites), 2026-11-25: the simulator's `model-grounded` (gate-k) read 5582, 6243, 76417
 * and 76435 hanging over the ground. Each was ONE class: the export grounds the shell on its lowest part, and a few
 * source parts ran under the model's broad base (5582 a 60623 door placed twice in one doorway, the second through
 * the base brick; 6243 masts/hoses/pillars hung from their origins; 76417 a pitchfork at its raw LDD origin; 76435 a
 * parked bigfig cluster and two 30987s). They were found by hand with `_lowest_parts.ts`. The rule now lives in ONE
 * place (`engine/model-grounding.ts`): the sim judges the drawn model with it, and the export names the parts that
 * hold the model up in its warnings, so the next such source is named at build time.
 */
import { describe, expect, it } from 'vitest';
import { groundedVerdict, partsUnderBroadBase, hangingPartsWarning, type GroundBox } from '../web/src/engine/model-grounding.js';
import { groundedVerdict as simGroundedVerdict } from '../web/src/sim/adapters/craftmatic/child-play.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): GroundBox => ({ x0, y0, z0, x1, y1, z1 });

describe('model grounding: one rule for the sim and the export (PROC-20, grounded-favourites)', () => {
  it('the sim judges with the engine rule', () => {
    const boxes = [box(0, 6, 0, 30, 6.4, 15), box(2, 6.4, 2, 28, 14, 13), box(10, 0.3, 5, 10.25, 6, 5.25)];
    expect(simGroundedVerdict(boxes.map(b => ({ box: b, glass: false })), 0, 1)).toEqual(groundedVerdict(boxes, 0, 1));
  });

  it('names the thin parts under a hanging model\'s broad base, and only those (5582: one door under the base brick)', () => {
    const items = [
      { box: box(0, 1.5, 0, 8, 1.95, 4), item: 'base 4204' },
      { box: box(0.5, 1.95, 0.5, 7.5, 6, 3.5), item: 'walls' },
      { box: box(2.4, 0, 3.4, 3.7, 2.5, 3.5), item: 'door 60623' },
    ];
    const r = partsUnderBroadBase(items, 1);
    expect(r.verdict.hanging).toBe(true);
    expect(r.verdict.hangBlocks).toBeCloseTo(1.5, 1);
    expect(r.under.map(u => u.item)).toEqual(['door 60623']);
    expect(r.under[0]!.depthBlocks).toBeCloseTo(1.5, 1);
  });

  it('names nothing for a model on its base, a car on its wheels or a tree house on its trunk', () => {
    const house = partsUnderBroadBase([{ box: box(0, 0, 0, 16, 0.4, 16), item: 'plate' }, { box: box(1, 0.4, 1, 15, 8, 15), item: 'house' }], 1);
    expect(house.verdict.hanging).toBe(false);
    expect(house.under).toEqual([]);
    const tree = partsUnderBroadBase([{ box: box(3, 0, 3, 5, 6, 5), item: 'trunk' }, { box: box(0, 6, 0, 8, 7, 8), item: 'floor' }, { box: box(1, 7, 1, 7, 10, 7), item: 'house' }], 1);
    expect(tree.verdict.hanging).toBe(false);
    expect(tree.under).toEqual([]);
  });

  it('the export warning names the source parts that hold the model up, in LDraw units (76417: the pitchfork)', () => {
    // A 16 x 8-stud base plate on the ground plane (LDraw y 0 is its underside) with a wall on it, and one
    // pitchfork-like part 41 LDU under the underside - the 76417 shape. Grid: 20 LDU per cell across, 24 up, scale 1.
    const mesh = (min: [number, number, number], max: [number, number, number], description: string): LdrawPartMesh =>
      ({ partId: description, resolvedAs: description, triangles: [{} as never], studs: [], bounds: { min, max }, unresolvedRefs: [], description } as unknown as LdrawPartMesh);
    const meshes = new Map<string, LdrawPartMesh | null>([
      ['plate.dat', mesh([-160, -8, -80], [160, 0, 80], 'Plate 16 x 8')],
      ['wall.dat', mesh([-150, -200, -70], [150, 0, 70], 'Wall')],
      ['95345.dat', mesh([-4, -80, -4], [4, 45, 4], 'Minifigure, Utensil Pitchfork')],
    ]);
    const at = (part: string, x: number, y: number, z: number): ParsedBrick => ({ part, color: 16, x, y, z, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] } as ParsedBrick);
    const bricks = [at('plate.dat', 0, 0, 0), at('wall.dat', 0, -8, 0), at('95345.dat', 100, -4, 40)];
    const frame: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: 20, cellY: 24, };
    const line = hangingPartsWarning(bricks, meshes, frame);
    expect(line).toBeDefined();
    expect(line).toContain('95345');
    expect(line).toContain('41 LDU');
    expect(line).not.toContain('plate.dat');
    // Without the pitchfork the model stands on its plate: no warning.
    expect(hangingPartsWarning(bricks.slice(0, 2), meshes, frame)).toBeUndefined();
  });
});
