/**
 * FID-02 / A-03 (audit 2026-11-15): a vehicle compiled out of a model's bricks takes the share of the building
 * shell's cuboid budget those bricks would have spent as static geometry, never less than the vehicle preset.
 * Until then every vehicle got `LEGO_ENTITY_QUALITY.balanced` (24,576), half a shell's 49,152, so a whole-model
 * car (42172, 3,899 placements) shipped 2,216 placements coarsened (silhouette fidelity 0.863 against 0.928).
 */
import { describe, expect, it } from 'vitest';
import { vehicleEntityQuality } from '../web/src/engine/playable-addon.js';
import { LEGO_ENTITY_QUALITY } from '../web/src/engine/ldraw-part-prototype.js';
import { LEGO_SHELL_QUALITY } from '../web/src/engine/bedrock-building-shell.js';

describe('vehicle cuboid budget (FID-02)', () => {
  it('gives a whole-model vehicle the building shell budget', () => {
    // 42172 as the favourites sweep builds it: 3,899 placements in the car, 19 left in the shell.
    const q = vehicleEntityQuality('balanced', 3899, 3899 + 19);
    expect(q.maxModelCubes).toBe(Math.round(LEGO_SHELL_QUALITY.balanced.maxModelCubes * 3899 / 3918));
    expect(q.maxStudCubes).toBe(Math.round(LEGO_SHELL_QUALITY.balanced.maxStudCubes * 3899 / 3918));
    // The grain every part starts at stays the vehicle preset's.
    expect(q.microcellLdu).toBe(LEGO_ENTITY_QUALITY.balanced.microcellLdu);
    expect(vehicleEntityQuality('high', 1000, 1000).maxModelCubes).toBe(LEGO_SHELL_QUALITY.high.maxModelCubes);
    // `ultra` keeps its own finer start grain.
    expect(vehicleEntityQuality('ultra', 1000, 1000).microcellLdu).toBe(LEGO_ENTITY_QUALITY.ultra.microcellLdu);
  });

  it('never gives a vehicle less than the vehicle preset', () => {
    // A car that is a tenth of a scene keeps the preset: the scene's shell still spends its own budget.
    expect(vehicleEntityQuality('balanced', 300, 3000)).toEqual({ ...LEGO_ENTITY_QUALITY.balanced });
    expect(vehicleEntityQuality(undefined, 0, 0)).toEqual({ ...LEGO_ENTITY_QUALITY.balanced });
  });
});
