import type { BlockGrid } from '@craft/schem/types.js';

/**
 * Every export made before 2026-09-22 was the model's MIRROR IMAGE: the
 * LDraw → Minecraft frame negated Y alone (a reflection, det −1) instead of
 * turning the model half a turn about X. Exports made since are the model's
 * true handedness, so they cannot be overlaid on anything placed from an
 * older file of the same model - a hinge, a printed sign and a coaster's
 * turns are on the other side. Said in every Bedrock export's notes so a
 * user with an older placement in a world knows to rebuild it, not patch it.
 * `craftmatic-provenance.json` carries `frame: "x180"` (`pipeline-version.ts`)
 * from the same change; a pack without that field is a mirrored one.
 */
export const FRAME_CHANGE_NOTE = 'Frame: this export is the model in its true handedness (LDraw to world is a half turn about X, since 2026-09-22). Exports made before that date - Bedrock packs, .schem/.litematic files, GLB/OBJ/STL/3MF - were the model\'s MIRROR IMAGE, so a new export will not line up with a placement made from an older file of the same model: re-place it from this export rather than overlaying the two.';

/** Block streams cannot carry Java entity/block-entity payloads. Never hide that loss. */
export function bedrockExportNotes(grid: BlockGrid): string[] {
  const used = new Set(Array.from(new Set(grid.rawData), id => grid.blockStateFromIndex(id).split('[')[0]));
  const notes: string[] = [FRAME_CHANGE_NOTE];
  if (used.has('minecraft:armor_stand')) notes.push('Generator armor-stand markers use fence placeholders; this block export does not contain armor-stand entities.');
  if ([...used].some(id => /:(potted_|.*_bed$|.*_banner$|.*_sign$)/.test(id))) notes.push('Flower-pot contents, bed/banner colors, and sign text require block-entity data and are not preserved in this export.');
  if (grid.blockEntities.length) notes.push('Container contents and other block-entity data are not included in the Bedrock block export.');
  return notes;
}
