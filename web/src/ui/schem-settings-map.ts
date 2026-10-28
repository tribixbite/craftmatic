/**
 * Stored export settings -> what an export runs with: the two pure steps the
 * settings popover and the export share.
 *
 * - `sanitizeSchemSettings`: a value read back from localStorage (stored by an
 *   older build, or edited by hand) becomes a complete, valid settings object.
 * - `addonPipelineFields`: the settings fields every export branch (bricks or
 *   an uploaded grid) hands the pipeline, mapped once.
 */

import { DEFAULT_SCHEM_SETTINGS, RESOLUTION_OPTIONS, type ResolutionChoice, type SchemExportSettings } from '@engine/schem-settings.js';
import { BLOCK_PROFILES } from '@engine/block-profiles.js';
import { ADDON_SCALE_OPTIONS } from '@engine/addon-scale.js';
import { SMOOTH_TRACK_GRAIN_LDU } from '@engine/coaster-track.js';
import type { SchemWorkerInput } from '@engine/schem-pipeline.js';

const oneOf = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;

/**
 * A complete settings object from whatever was stored. A flag that defaults ON
 * is off only when stored `false` (so a value stored before the flag existed
 * opts in); one that defaults OFF is on only when stored `true`. Every enum or
 * number outside its options falls back to its default, with one exception:
 * `lightCoverage` falls back to `'sealed'`, the lighting every export had before
 * the option existed (ed8bcdd0), although a fresh install starts `'covered'`.
 */
export function sanitizeSchemSettings(stored: Partial<SchemExportSettings>): SchemExportSettings {
  return {
    resolution: oneOf<ResolutionChoice>(stored.resolution, RESOLUTION_OPTIONS.map(o => o.value), 'auto'),
    profile: oneOf(stored.profile, BLOCK_PROFILES.map(p => p.id), DEFAULT_SCHEM_SETTINGS.profile),
    lightFill: stored.lightFill === true,
    vehicleFacing: oneOf(stored.vehicleFacing, ['+x', '-x', '+z', '-z'] as const, 'auto'),
    addonDetail: oneOf(stored.addonDetail, ['high', 'ultra'] as const, 'balanced'),
    addonMainVehicleOnly: stored.addonMainVehicleOnly === true,
    addonSmoothTrack: stored.addonSmoothTrack !== false,
    addonBuildingBricks: stored.addonBuildingBricks !== false,
    addonScale: oneOf(stored.addonScale, ADDON_SCALE_OPTIONS.map(o => o.value), 'auto'),
    lightCoverage: stored.lightCoverage === 'covered' ? 'covered' : 'sealed',
    lightStyle: oneOf(stored.lightStyle, ['lantern', 'sea_lantern'] as const, 'profile'),
    lightSpacing: oneOf(stored.lightSpacing, [3, 6, 10] as const, 6),
    shapes: stored.shapes !== false,
    detailMaterials: stored.detailMaterials === true,
  };
}

/** The pipeline fields an export takes from the settings, whatever its source. */
export type AddonPipelineFields = Pick<SchemWorkerInput,
  'profile' | 'lightFill' | 'lightCoverage' | 'lightStyle' | 'lightSpacing' | 'vehicleFacing' | 'detailMaterials'
  | 'entityQuality' | 'mainVehicleOnly' | 'trackGrainLdu' | 'buildingFidelity'>;

/** Settings -> pipeline input, shared by the bricks and the grid export (FID-02: smooth track unless switched off). */
export function addonPipelineFields(settings: SchemExportSettings): AddonPipelineFields {
  return {
    profile: settings.profile, lightFill: settings.lightFill,
    lightCoverage: settings.lightCoverage, lightStyle: settings.lightStyle, lightSpacing: settings.lightSpacing,
    vehicleFacing: settings.vehicleFacing, detailMaterials: settings.detailMaterials,
    entityQuality: settings.addonDetail,
    mainVehicleOnly: settings.addonMainVehicleOnly === true,
    ...(settings.addonSmoothTrack ? { trackGrainLdu: SMOOTH_TRACK_GRAIN_LDU } : {}),
    buildingFidelity: settings.addonBuildingBricks === false ? 'blocks' : 'bricks',
  };
}
