/** Types of the one model-import service (`import.ts`). */
import type { ParsedBrick } from '../ldraw-parser.js';
import type { BrickColorSpace } from '../block-profiles.js';
import type { LxfDiagnostics } from '../lxf-parser.js';
import type { SourceQuality } from '../source-quality.js';

/** Container formats the service accepts (`.zip` is unwrapped to one of these). */
export type ImportFormat = 'ldr' | 'mpd' | 'io' | 'lxf' | 'lxfml';

/** One MPD / `.io` sub-model: the creator's own grouping of the placements. */
export interface ImportedSubmodel {
  /** Section name as the file spells it (normalised: lower-case, forward slashes). */
  name: string;
  /**
   * Indices into `ImportedModel.bricks` of every placement made inside this
   * sub-model, nested sub-models included (`ParsedBrick.sourcePath` contains
   * the name). Ascending.
   */
  brickIndices: number[];
}

/** What a creator brought, after import and before any pipeline option. */
export interface ImportedModel {
  format: ImportFormat;
  /** Name as chosen (the `.zip` itself for a zipped model). */
  file: string;
  /** For a `.zip`: the entry that was imported. */
  entry?: string;
  /** `sourceHash12` of the bytes as chosen, before any rewriting. */
  hash12: string;
  /** LDraw placements, in the order the parser expanded them. */
  bricks: ParsedBrick[];
  /** Colour table the placements' ids belong to (an `.io` model2.ldr is Studio/BL space). */
  colorSpace: BrickColorSpace;
  /** `.ldr`/`.mpd`/`.io` model text (after LSynth synthesis), for sub-model resolution in the viewer. */
  ldrawText?: string;
  /** `.io` `CustomParts/` definitions, keyed by archive path relative to `CustomParts/`. */
  customParts?: ReadonlyMap<string, string>;
  submodels: ImportedSubmodel[];
  /**
   * What the user should be told about this source, in display order. Returned,
   * never written to a module global. `.ldr`/`.mpd`/`.io` carry at most one
   * (the provenance caveat); `.lxf` carries the alignment coverage line and the
   * accuracy caveat.
   */
  warnings: string[];
  /** Provenance class of a text source; 'broken' means an unaligned LXFML conversion. */
  quality?: SourceQuality;
  /** LSynth flex parts synthesised into tube geometry (0 when none). */
  lsynthCount: number;
  /** `.lxf`/`.lxfml` alignment coverage. */
  lxf?: LxfDiagnostics;
  /** `.io` details a diagnostic wants. */
  io?: { sourceEntry: string; colorSpaceReason: string; classBReframed: number };
}
