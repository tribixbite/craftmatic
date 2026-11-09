/**
 * The one model-import service.
 *
 * `importModelFile(bytes, name)` turns a creator's file into placements for
 * `.ldr`, `.mpd`, `.io`, `.lxf`, `.lxfml` and `.zip` (the first model inside).
 * It touches no DOM and keeps no module state, so the LEGO tab, a Worker, the
 * batch CLI and vitest all share this one path. It replaces the two copies of
 * the same logic that `lego.ts` kept for uploads and for indexed models; the
 * UI keeps only what is UI (status text, abandon checks, the quality gate).
 */
import { parseLDrawDocument, type ParsedBrick } from '../ldraw-parser.js';
import { extractIoModel } from '../io-extractor.js';
import { synthesizeLSynth } from '../lsynth.js';
import { reconstructionQuality, sourceCaveat, type SourceQuality } from '../source-quality.js';
import { sourceHash12 } from '../pipeline-version.js';
import { describeLxfDiagnostics, parseLxfWithDiagnostics, type LxfParseOptions } from '../lxf-parser.js';
import { extractMatching, listZipEntries } from '../zip-utils.js';
import type { BrickColorSpace } from '../block-profiles.js';
import type { ImportFormat, ImportedModel, ImportedSubmodel } from './types.js';

export type { ImportedModel, ImportedSubmodel, ImportFormat } from './types.js';

/** Appended to every `.lxf` of more than 150 bricks: the measured accuracy of the alignment tables. */
export const LXF_ALIGNMENT_CAVEAT =
  'LDD .lxf: placed through the Studio per-part alignment (≈93% of parts land '
  + 'on authentic Studio ground truth, measured over 91 sets); flex parts and '
  + 'designs Studio does not map can still sit off';

/** Bricks above which an `.lxf` gets the accuracy caveat. */
const LXF_CAVEAT_MIN_BRICKS = 150;

const BROKEN_IO_WARNING =
  'this .io is a repackaged LXFML conversion — placements/colors may be wrong (defects are in the file, not the renderer)';

export interface ImportOptions extends LxfParseOptions {
  /** Hash of the bytes when the caller already has it (skips a second pass). */
  hash12?: string;
  /**
   * How a text source's 'broken' warning refers to it: an explicit upload says
   * "this file", an index pick says "this source". Wording only; both load.
   */
  sourceNoun?: 'file' | 'source';
  /** Synthesize unsynthesized LSynth flex blocks (default true). */
  synthesize?: boolean;
}

const EXTENSION_FORMATS: Readonly<Record<string, ImportFormat>> = {
  ldr: 'ldr', dat: 'ldr', mpd: 'mpd', io: 'io', lxf: 'lxf', lxfml: 'lxfml',
};

const extensionOf = (name: string): string => name.split(/[\\/]/).pop()!.split('.').pop()!.toLowerCase();

/** Format by extension; anything unrecognised is text-shaped LDraw, as the UI has always treated it. */
function formatOf(name: string): ImportFormat | 'zip' {
  const ext = extensionOf(name);
  return ext === 'zip' ? 'zip' : (EXTENSION_FORMATS[ext] ?? 'ldr');
}

/** An exact-size `ArrayBuffer` of the bytes (the zip and XML readers take `ArrayBuffer`). */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer as ArrayBuffer;

/**
 * Sub-models of a parsed document: every non-root section some placement was
 * made inside, in order of first appearance. Embedded part definitions are not
 * sub-models: the parser terminates on them, so no `sourcePath` names them.
 */
export function submodelsOf(bricks: readonly ParsedBrick[]): ImportedSubmodel[] {
  const byName = new Map<string, number[]>();
  bricks.forEach((brick, index) => {
    // sourcePath[0] is the root section; the rest are nested sub-models.
    const path = brick.sourcePath ?? [];
    for (let depth = 1; depth < path.length; depth++) {
      const name = path[depth]!;
      let list = byName.get(name);
      if (!list) byName.set(name, list = []);
      // A name repeated down one path (a model that includes itself) lists the brick once.
      if (list[list.length - 1] !== index) list.push(index);
    }
  });
  return [...byName].map(([name, brickIndices]) => ({ name, brickIndices }));
}

/** The provenance warning for a text source, or none. */
function textWarning(text: string, quality: SourceQuality, noun: 'file' | 'source', isIo: boolean): string[] {
  if (quality === 'broken') {
    return [isIo
      ? BROKEN_IO_WARNING
      : `this ${noun} is an unaligned LXFML conversion — parts render scattered/stacked and colors may be wrong (defects are in the file, not the renderer)`];
  }
  const caveat = sourceCaveat(text, quality);
  return caveat ? [caveat] : [];
}

/**
 * Import one model file.
 * @param bytes the file as chosen
 * @param name  the file name; its extension picks the format
 * @throws when the container holds no readable model (the parsers' own messages)
 */
export async function importModelFile(
  bytes: Uint8Array, name: string, options: ImportOptions = {},
): Promise<ImportedModel> {
  const hash12 = options.hash12 ?? sourceHash12(bytes);
  const format = formatOf(name);
  if (format === 'zip') return importZip(bytes, name, hash12, options);
  const noun = options.sourceNoun ?? 'file';
  const buf = toArrayBuffer(bytes);

  if (format === 'lxf' || format === 'lxfml') {
    const parsed = await parseLxfWithDiagnostics(buf, options);
    const line = describeLxfDiagnostics(parsed.diagnostics);
    const warnings = [
      ...(line ? [line] : []),
      ...(parsed.bricks.length > LXF_CAVEAT_MIN_BRICKS ? [LXF_ALIGNMENT_CAVEAT] : []),
    ];
    return {
      format, file: name, hash12, bricks: parsed.bricks, colorSpace: 'ldraw',
      submodels: [], warnings, lsynthCount: 0, lxf: parsed.diagnostics,
    };
  }

  let rawText: string;
  let colorSpace: BrickColorSpace = 'ldraw';
  let customParts: ReadonlyMap<string, string> | undefined;
  let io: ImportedModel['io'];
  if (format === 'io') {
    const ioModel = await extractIoModel(buf);
    rawText = ioModel.text;
    colorSpace = ioModel.colorSpace;
    customParts = ioModel.customParts.size ? ioModel.customParts : undefined;
    io = { sourceEntry: ioModel.sourceEntry, colorSpaceReason: ioModel.colorSpaceReason, classBReframed: ioModel.classBReframed };
  } else {
    // TextDecoder strips a BOM exactly as Response.text() / File.text() do.
    rawText = new TextDecoder().decode(bytes);
  }
  const synthesized = (options.synthesize ?? true) ? synthesizeLSynth(rawText) : { text: rawText, count: 0 };
  const text = synthesized.text;
  const doc = parseLDrawDocument(text);
  const quality = reconstructionQuality(text);
  return {
    format, file: name, hash12, bricks: doc.bricks, colorSpace, ldrawText: text,
    ...(customParts ? { customParts } : {}),
    submodels: submodelsOf(doc.bricks),
    warnings: textWarning(text, quality, noun, format === 'io'),
    quality, lsynthCount: synthesized.count,
    ...(io ? { io } : {}),
  };
}

/** `.zip`: import the first model entry (archive order) as if it had been chosen on its own. */
async function importZip(bytes: Uint8Array, name: string, hash12: string, options: ImportOptions): Promise<ImportedModel> {
  const buf = toArrayBuffer(bytes);
  const entry = listZipEntries(buf).find((e) => !e.endsWith('/') && EXTENSION_FORMATS[extensionOf(e)] !== undefined);
  if (!entry) throw new Error(`No model file (.ldr/.mpd/.io/.lxf/.lxfml) found in ${name}`);
  const found = await extractMatching(buf, (n) => n === entry);
  const data = found.get(entry);
  if (!data) throw new Error(`Could not read ${entry} from ${name}`);
  const inner = await importModelFile(new Uint8Array(data), entry, { ...options, hash12 });
  return { ...inner, file: name, entry };
}
