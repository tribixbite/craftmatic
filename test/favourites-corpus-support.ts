/**
 * Shared loader for the per-favourite corpus guards (audit 2026-11-15, PROC-19): each favourite's source is the
 * models index's FIRST pick (`indexedTryOrder`, as `_favorites_export_sweep.ts` and the LEGO tab choose it), read
 * the way `_playable_ref.ts` reads it - an `.io` through `extractIoModel` with its CustomParts, an `.ldr`/`.mpd`
 * as text with its embedded sections. LXF sources (71043) need a DOM shim and are reported as skipped.
 */
import { existsSync, readFileSync } from 'node:fs';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.js';
import { embeddedPartTexts, parseLDrawDocument, type LDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { synthesizeLSynth } from '../web/src/engine/lsynth.js';
import { extractIoModel } from '../web/src/engine/io-extractor.js';

export const CLEGO_INDEX = 'C:/git/clego/lego-models-index.json';
export const CLEGO_CORPUS = 'C:/git/clego/lego_sets';
export const STUDIO_LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
/** True on the dev box (corpus, index and the Studio library present); CI skips the corpus guards. */
export const HAVE_FAVOURITES_CORPUS = existsSync(CLEGO_INDEX) && existsSync(CLEGO_CORPUS) && existsSync(STUDIO_LDRAW_ROOT);

interface IndexEntry { name?: string; models?: IndexModel[]; parts?: number; catalogParts?: number }
let indexCache: Record<string, IndexEntry> | null = null;

/** The index's first-pick source of a set: its corpus path and source class, or null when the set is not indexed. */
export function favouriteFirstPick(set: string): { path: string; src: string; file: string } | null {
  indexCache ??= (JSON.parse(readFileSync(CLEGO_INDEX, 'utf8')) as { sets: Record<string, IndexEntry> }).sets;
  const entry = indexCache[set];
  if (!entry?.models?.length) return null;
  const model = entry.models[indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts)[0]!]!;
  return { path: model.path, src: String(model.src), file: `${CLEGO_CORPUS}/${model.path}` };
}

export interface FavouriteSource {
  path: string;
  doc: LDrawDocument;
  /** Embedded `.dat` sections plus an `.io`'s CustomParts, as `_playable_ref.ts` seeds them. */
  embedded: Array<readonly [string, string]>;
}

/** The favourite's first pick parsed as the CLI export parses it; null for an LXF source or a missing file. */
export async function loadFavouriteSource(set: string): Promise<FavouriteSource | null> {
  const pick = favouriteFirstPick(set);
  if (!pick || !existsSync(pick.file) || /\.lxf(ml)?$/i.test(pick.file)) return null;
  const bytes = readFileSync(pick.file);
  let text: string;
  let custom: Array<readonly [string, string]> = [];
  if (/\.io$/i.test(pick.file)) {
    const io = await extractIoModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    text = io.text;
    custom = [...io.customParts];
  } else {
    text = bytes.toString('utf8');
  }
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  return { path: pick.path, doc, embedded: [...embeddedPartTexts(doc), ...custom] };
}

/**
 * Every baseplate the source places (a part described `Baseplate ...`) with how many OTHER placements have their
 * origin over its footprint within 30 LDU above its top (A-09: 76457's three 16 x 32 plates carried 1-15 such parts
 * while they lay beside the village, 137-154 once under it).
 */
export async function baseplatesUncarried(
  source: FavouriteSource,
  provider: { getPartMesh(part: string): Promise<{ description: string; movedDescription?: string; bounds: { min: number[]; max: number[] } } | null> },
): Promise<Array<{ part: string; at: number[]; standing: number }>> {
  const bricks = source.doc.bricks;
  const out: Array<{ part: string; at: number[]; standing: number }> = [];
  for (const b of bricks) {
    const mesh = await provider.getPartMesh(b.part);
    // A `~Moved to` stub (95 -> 2748 -> 3857) is classified by the mould it moved to.
    if (!mesh || !/^[~=_]*\s*Baseplate\b/i.test(mesh.movedDescription ?? mesh.description)) continue;
    const R = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let standing = 0;
    for (const o of bricks) {
      if (o === b) continue;
      const d = [o.x - b.x, o.y - b.y, o.z - b.z];
      const l = [0, 1, 2].map(c => R[c]! * d[0]! + R[3 + c]! * d[1]! + R[6 + c]! * d[2]!);
      if (l[0]! >= mesh.bounds.min[0]! && l[0]! <= mesh.bounds.max[0]! && l[2]! >= mesh.bounds.min[2]! && l[2]! <= mesh.bounds.max[2]!
        && l[1]! <= mesh.bounds.min[1]! + 1 && l[1]! >= mesh.bounds.min[1]! - 30) standing++;
    }
    out.push({ part: b.part, at: [b.x, b.y, b.z], standing });
  }
  return out;
}
