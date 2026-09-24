/**
 * The playable add-on's model scale (engine/addon-scale.ts): `auto` reads the
 * model's own evidence, a fixed step is honoured verbatim, and every plan
 * reports one cell that the blocks, colliders and entities share.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCESS_SCALE_STEPS, ADDON_SCALE_OPTIONS, JUMP_HEIGHT_BLOCKS, MIN_AUTO_SCALE, PASSAGE_HEIGHT_BLOCKS, PASSAGE_WIDTH_BLOCKS, PLAYER_WIDTH_BLOCKS,
  STEP_HEIGHT_BLOCKS, VEHICLE_TARGET_BLOCKS, accessStepFor, describeAddonScale, hasMinifigCue, modelExtentLdu, passageRequiredScale, planAddonScale,
} from '../web/src/engine/addon-scale.js';
import { WAND_SIZE_STEPS } from '../web/src/engine/bedrock-scene-actors.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const brick = (part: string, x: number, y = 0, z = 0): ParsedBrick => ({ part, color: 4, x, y, z, rot: I });

/** A row of bricks `lengthLdu` long along X (origins 0..lengthLdu). */
const rowOf = (part: string, lengthLdu: number): ParsedBrick[] => [brick(part, 0), brick(part, lengthLdu)];

describe('planAddonScale', () => {
  it('a minifig in the model pins the scale to 1× whatever the title says', () => {
    const plan = planAddonScale([...rowOf('3001.dat', 2000), brick('973.dat', 100)], 'auto', 'Ferrari F40 Sports Car (10248)');
    expect(plan.scale).toBe(1);
    expect(plan.cue).toBe('minifig');
    expect(plan.lduPerBlock).toBeCloseTo(LDU_PER_BLOCK);
    expect(plan.reason).toMatch(/minifig scale \(1×\)/);
  });

  it('recognises Studio custom torsos and hip/leg moulds as minifig cues', () => {
    expect(hasMinifigCue([brick('bl_973pb5574c01_torso.dat', 0)])).toBe(true);
    expect(hasMinifigCue([brick('3815c01.dat', 0)])).toBe(true);
    expect(hasMinifigCue([brick('3816.dat', 0)])).toBe(true);
    // 97301 is not a torso: the family regex must not match a longer id.
    expect(hasMinifigCue([brick('97301.dat', 0), brick('3001.dat', 0)])).toBe(false);
  });

  it('shrinks a figure-less display car to a real car length, never below the floor', () => {
    // 25 studs of origins + a stud each side = 540 LDU ≈ 10.1 blocks at 1×.
    const car = planAddonScale(rowOf('3001.dat', 500), 'auto', 'Mini Cooper (10242)');
    expect(car.cue).toBe('vehicle');
    expect(car.kind).toBe('car');
    expect(car.scale).toBeLessThan(1);
    expect(car.scale).toBeCloseTo(VEHICLE_TARGET_BLOCKS.car / (540 / LDU_PER_BLOCK), 2);
    expect(car.sizeBlocks.x).toBeCloseTo(VEHICLE_TARGET_BLOCKS.car, 1);
    expect(car.lduPerBlock).toBeCloseTo(LDU_PER_BLOCK / car.scale);
    // A 200-stud display ship would need 1/20: the floor holds it at ¼.
    const huge = planAddonScale(rowOf('3001.dat', 4000), 'auto', 'Titanic Ship (10294)');
    expect(huge.scale).toBe(MIN_AUTO_SCALE);
  });

  it('never enlarges a vehicle that is already within its real length', () => {
    const plan = planAddonScale(rowOf('3001.dat', 100), 'auto', 'Race Car (60322)');
    expect(plan.scale).toBe(1);
    expect(plan.cue).toBe('vehicle');
  });

  it('a microfigure and no minifig doubles a microscale set; a minifig beside it wins', () => {
    const micro = planAddonScale([...rowOf('3005.dat', 600), brick('85863.dat', 100)], 'auto', 'Hogwarts Castle (76419)');
    expect(micro.cue).toBe('microfig');
    expect(micro.scale).toBe(2);
    expect(micro.lduPerBlock).toBeCloseTo(LDU_PER_BLOCK / 2);
    const both = planAddonScale([brick('85863.dat', 100), brick('973.dat', 0)], 'auto', '');
    expect(both.cue).toBe('minifig');
    expect(both.scale).toBe(1);
  });

  it('leaves a figure-less building at 1× and says how to change it', () => {
    const plan = planAddonScale(rowOf('3001.dat', 3000), 'auto', 'Hogwarts Castle (71043)');
    expect(plan.scale).toBe(1);
    expect(plan.cue).toBe('none');
    expect(plan.reason).toMatch(/pick a scale/);
  });

  it('honours every fixed step verbatim, with the cell to match', () => {
    for (const o of ADDON_SCALE_OPTIONS) {
      if (o.value === 'auto') continue;
      const plan = planAddonScale(rowOf('3001.dat', 500), o.value, 'Mini Cooper (10242)');
      expect(plan.cue).toBe('explicit');
      expect(plan.scale).toBe(Number(o.value));
      expect(plan.lduPerBlock).toBeCloseTo(LDU_PER_BLOCK / Number(o.value));
    }
    // 4× is what turns a microscale castle into a walkable one.
    const four = planAddonScale(rowOf('3001.dat', 3000), '4', 'Hogwarts Castle (71043)');
    expect(four.sizeBlocks.x).toBeCloseTo(3040 / (LDU_PER_BLOCK / 4), 1);
  });

  it('measures the origin extent padded by a stud each side', () => {
    expect(modelExtentLdu([])).toEqual({ x: 0, y: 0, z: 0 });
    expect(modelExtentLdu([brick('3001.dat', -10, 5, 7), brick('3001.dat', 30, -3, 100)])).toEqual({ x: 80, y: 48, z: 133 });
  });

  it('describes the plan with its footprint in blocks', () => {
    const line = describeAddonScale(planAddonScale(rowOf('3001.dat', 500), '0.5', 'Mini Cooper (10242)'));
    expect(line).toMatch(/^0\.5× minifig scale, as chosen — ≈ \d+×\d+×\d+ blocks$/);
  });
});

describe('the player passage and the access size ladder', () => {
  it('a passage is one block wide and two high: the whole-block quantisation of a 0.6 × 1.8 player', () => {
    expect(PLAYER_WIDTH_BLOCKS).toBe(0.6);
    expect(PASSAGE_WIDTH_BLOCKS).toBe(1);
    expect(PASSAGE_HEIGHT_BLOCKS).toBe(2);
  });

  it("the ladder is every export scale at or above 1×, which is the wand's 100…400 % steps", () => {
    expect(ACCESS_SCALE_STEPS).toEqual([1, 1.5, 2, 3, 4]);
    expect(ACCESS_SCALE_STEPS).toEqual(WAND_SIZE_STEPS.filter(p => p >= 100).map(p => p / 100));
    expect(ACCESS_SCALE_STEPS.map(String)).toEqual(ADDON_SCALE_OPTIONS.map(o => o.value).filter(v => v !== 'auto' && Number(v) >= 1));
  });

  it('the required scale is whichever of width and height is further from the passage', () => {
    // A 1×4×6 doorway (60 × 144) clears at 0.89×: its width is the limit. A one-stud, one-brick gap needs 4.44×: its height.
    expect(passageRequiredScale(60, 144)).toBeCloseTo(LDU_PER_BLOCK / 60, 9);
    expect(passageRequiredScale(20, 24)).toBeCloseTo(2 * LDU_PER_BLOCK / 24, 9);
    // No lintel: width alone decides.
    expect(passageRequiredScale(40, Infinity)).toBeCloseTo(LDU_PER_BLOCK / 40, 9);
  });

  it('a brick riser (24 LDU) is a step at 100 %, a jump at 200 % and a wall from 300 %', () => {
    expect(STEP_HEIGHT_BLOCKS).toBe(0.6);
    expect(JUMP_HEIGHT_BLOCKS).toBe(1.25);
    const riserBlocks = (scale: number): number => 24 * scale / LDU_PER_BLOCK;
    expect(riserBlocks(1)).toBeLessThanOrEqual(STEP_HEIGHT_BLOCKS);
    expect(riserBlocks(2)).toBeLessThanOrEqual(JUMP_HEIGHT_BLOCKS);
    expect(riserBlocks(2)).toBeGreaterThan(STEP_HEIGHT_BLOCKS);
    expect(riserBlocks(3)).toBeGreaterThan(JUMP_HEIGHT_BLOCKS);
  });

  it('rounds a required scale up to the next supported step and abstains above 4×', () => {
    expect(accessStepFor(0.5)).toBe(1);
    expect(accessStepFor(1)).toBe(1);
    expect(accessStepFor(1.03)).toBe(1.5);
    expect(accessStepFor(2.22)).toBe(3);
    expect(accessStepFor(4)).toBe(4);
    expect(accessStepFor(4.44)).toBeUndefined();
  });
});
