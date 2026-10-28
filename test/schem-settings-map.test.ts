/**
 * Stored export settings -> what an export runs with. Pins the LEGO tab's
 * sanitising rules (each field's fallback for a value stored by an older build
 * or edited by hand) and the one settings -> pipeline field mapping both export
 * branches share.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeSchemSettings, addonPipelineFields } from '../web/src/ui/schem-settings-map.js';
import { DEFAULT_SCHEM_SETTINGS } from '../web/src/engine/schem-settings.js';
import { SMOOTH_TRACK_GRAIN_LDU } from '../web/src/engine/coaster-track.js';

describe('sanitizeSchemSettings', () => {
  it('keeps every valid stored value', () => {
    const stored = {
      resolution: 'minifig', profile: 'default', lightFill: true, vehicleFacing: '-z', addonDetail: 'ultra',
      addonMainVehicleOnly: true, addonSmoothTrack: false, addonBuildingBricks: false, addonScale: '2',
      lightCoverage: 'covered', lightStyle: 'sea_lantern', lightSpacing: 10, shapes: false, detailMaterials: true,
    } as const;
    expect(sanitizeSchemSettings(stored)).toEqual(stored);
  });

  it('gives an empty stored object the defaults, except lightCoverage (stored before it existed = the old sealed-only lighting)', () => {
    expect(sanitizeSchemSettings({})).toEqual({ ...DEFAULT_SCHEM_SETTINGS, lightCoverage: 'sealed' });
  });

  it('reads booleans by their default: an ON-by-default flag is off only when stored false, an OFF one on only when stored true', () => {
    const s = sanitizeSchemSettings({ addonSmoothTrack: 'yes', addonBuildingBricks: 0, shapes: null, lightFill: 1, addonMainVehicleOnly: 'true', detailMaterials: {} } as never);
    expect(s).toMatchObject({ addonSmoothTrack: true, addonBuildingBricks: true, shapes: true, lightFill: false, addonMainVehicleOnly: false, detailMaterials: false });
  });

  it('replaces an unknown enum or number with its fallback', () => {
    const s = sanitizeSchemSettings({
      resolution: 'huge', profile: 'nope', vehicleFacing: 'up', addonDetail: 'max', addonScale: '9',
      lightCoverage: 'all', lightStyle: 'torch', lightSpacing: 4,
    } as never);
    expect(s).toEqual({ ...sanitizeSchemSettings({}), resolution: 'auto', profile: DEFAULT_SCHEM_SETTINGS.profile });
  });
});

describe('addonPipelineFields', () => {
  it('maps the settings both export branches pass to the pipeline', () => {
    expect(addonPipelineFields(DEFAULT_SCHEM_SETTINGS)).toEqual({
      profile: 'default', lightFill: false, lightCoverage: 'covered', lightStyle: 'profile', lightSpacing: 6,
      vehicleFacing: 'auto', detailMaterials: false, entityQuality: 'balanced', mainVehicleOnly: false,
      trackGrainLdu: SMOOTH_TRACK_GRAIN_LDU, buildingFidelity: 'bricks',
    });
  });

  it('leaves the track to the budget and builds blocks when those are off', () => {
    const f = addonPipelineFields({ ...DEFAULT_SCHEM_SETTINGS, addonSmoothTrack: false, addonBuildingBricks: false, addonMainVehicleOnly: true });
    expect(f).not.toHaveProperty('trackGrainLdu');
    expect(f).toMatchObject({ buildingFidelity: 'blocks', mainVehicleOnly: true });
  });
});
