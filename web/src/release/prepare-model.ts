/**
 * The model input of a release build (D-08b): `.ldr`, `.mpd`, `.io`, `.lxf`, `.lxfml` and `.zip`, all through the ONE
 * import service (`engine/byom/import.ts`, B01). The service touches no DOM; the LXF alignment tables it needs are
 * read from `web/public/` here instead of fetched, so a release build stays offline.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importModelFile, type ImportedModel } from '../engine/byom/import.js';
import { embeddedPartTexts, parseLDrawDocument } from '../engine/ldraw-parser.js';
import {
  applyMeasuredBound, validateElementRow, validateMeasuredAlign, validatePartAlign, validatePrintRow, validateTable,
  ELEMENT_MAP_URL, MEASURED_ALIGN_URL, PART_MAP_URL, PRINT_MAP_URL, type LxfParseOptions,
} from '../engine/lxf-parser.js';

/** File types a release product may name as its model. */
export const MODEL_EXTENSIONS = /\.(ldr|mpd|io|lxf|lxfml|zip)$/i;

/** What the build needs of a model. */
export interface ReleaseModel extends ImportedModel {
  /**
   * Part definitions the file carries itself (MPD sections, `.io` CustomParts), `[name, text]`, to seed the library.
   * Official-library mode records each as caller-supplied, so the licence gate names them.
   */
  embeddedParts: Array<[string, string]>;
}

/** The alignment tables from `<publicDir>/ldd-*.json`, shaped as `LxfParseOptions.loaders`. */
function shippedLddTables(publicDir: string): NonNullable<LxfParseOptions['loaders']> {
  const json = (name: string): unknown => JSON.parse(readFileSync(join(publicDir, name), 'utf8'));
  return {
    partMap: async () => validateTable(json('ldd-part-map.json'), PART_MAP_URL, validatePartAlign),
    measured: async () => applyMeasuredBound(validateTable(json('ldd-measured-align.json'), MEASURED_ALIGN_URL, validateMeasuredAlign)),
    printMap: async () => validateTable(json('ldd-print-map.json'), PRINT_MAP_URL, validatePrintRow),
    elementMap: async () => validateTable(json('ldd-element-map.json'), ELEMENT_MAP_URL, validateElementRow),
  };
}

/**
 * Read a release product's model file.
 * @param file      absolute path of the model
 * @param publicDir `web/public` of the checkout the build runs in (the LXF alignment tables)
 * @throws on an unsupported extension or a container with no readable model
 */
export async function loadReleaseModel(file: string, publicDir: string): Promise<ReleaseModel> {
  if (!MODEL_EXTENSIONS.test(file)) throw new Error(`a release model must be .ldr, .mpd, .io, .lxf, .lxfml or .zip: ${file}`);
  const bytes = new Uint8Array(readFileSync(file));
  const model = await importModelFile(bytes, file, { loaders: shippedLddTables(publicDir) });
  const embeddedParts: Array<[string, string]> = [];
  if (model.ldrawText !== undefined) embeddedParts.push(...embeddedPartTexts(parseLDrawDocument(model.ldrawText)));
  if (model.customParts) embeddedParts.push(...model.customParts);
  return { ...model, embeddedParts };
}

/** Reasons the model cannot be released (empty = fine). Provenance caveats that still load are not problems. */
export function modelProblems(model: ReleaseModel): string[] {
  const out: string[] = [];
  if (model.bricks.length === 0) out.push('the model has no bricks');
  if (model.quality === 'broken') out.push(`the source is an unaligned conversion, its placements are wrong in the file itself: ${model.warnings.join(' ')}`);
  return out;
}
