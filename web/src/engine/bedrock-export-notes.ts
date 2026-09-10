import type { BlockGrid } from '@craft/schem/types.js';

/** Block streams cannot carry Java entity/block-entity payloads. Never hide that loss. */
export function bedrockExportNotes(grid: BlockGrid): string[] {
  const used = new Set(Array.from(new Set(grid.rawData), id => grid.blockStateFromIndex(id).split('[')[0]));
  const notes: string[] = [];
  if (used.has('minecraft:armor_stand')) notes.push('Generator armor-stand markers use fence placeholders; this block export does not contain armor-stand entities.');
  if ([...used].some(id => /:(potted_|.*_bed$|.*_banner$|.*_sign$)/.test(id))) notes.push('Flower-pot contents, bed/banner colors, and sign text require block-entity data and are not preserved in this export.');
  if (grid.blockEntities.length) notes.push('Container contents and other block-entity data are not included in the Bedrock block export.');
  return notes;
}
