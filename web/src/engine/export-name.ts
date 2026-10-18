/**
 * Export filename stems — "what the downloaded file is called".
 *
 * The old stem was whatever internal label the loader happened to use, which
 * leaked the SOURCE of the model into the user's Downloads folder
 * (`10276-1-omr.schem`, `21063-1-io.schem`). The source is an implementation
 * detail of where we found the LDraw file; it tells the user nothing about the
 * model and makes two exports of the same set look like different things.
 *
 * The convention is instead **name first, then set number**:
 * `Colosseum-10276.schem`. The name is the recognizable part, so it leads; the
 * set number disambiguates (many sets share a name across years) and is what a
 * user searches for.
 *
 * Pure string logic, no DOM — offline-tested in `test/export-name.test.ts`.
 */

/**
 * Character budget for the leading name fragment.
 *
 * 12 is the top of the user's requested 10-12 range: it fits "Millennium",
 * "Rivendell", "Colosseum" and "Hogwarts" whole, and it is short enough that
 * the set number stays visible in a truncated file listing.
 */
export const NAME_STEM_MAX = 12;

/**
 * Reduce a set name to a compact, space-free, filesystem-safe fragment.
 *
 * Words are kept WHOLE up to the budget — truncating mid-word ("Millenniu")
 * reads as a corrupted filename, whereas dropping a trailing word ("Millennium"
 * from "Millennium Falcon") reads as an abbreviation. Only a single first word
 * that is itself over budget is cut, because there is no boundary to stop at.
 *
 * Each word's first letter is upper-cased so the join stays readable once the
 * spaces are gone (`the lego movie` → `TheLegoMovie`).
 */
export function sanitizeNameStem(name: string | undefined | null, max = NAME_STEM_MAX): string {
  if (!name) return '';
  // Split on anything that is not alphanumeric: spaces, punctuation, dashes,
  // and the trademark/registered marks LEGO set names carry.
  const words = name.split(/[^A-Za-z0-9]+/).filter(w => w.length > 0);
  if (words.length === 0) return '';

  let stem = '';
  for (const word of words) {
    const piece = word.charAt(0).toUpperCase() + word.slice(1);
    if (stem.length + piece.length > max) break;
    stem += piece;
  }
  if (stem.length > 0) return stem;

  // Single over-long first word — cut it, there is no word boundary to use.
  const first = words[0]!;
  return (first.charAt(0).toUpperCase() + first.slice(1)).slice(0, max);
}

/**
 * Normalize a catalog set number for use in a filename.
 *
 * Rebrickable numbers carry a variant suffix (`10276-1`). `-1` is the primary
 * variant of essentially every set, so it is noise in a filename and the user's
 * requested example drops it (`Colosseum-10276`). A NON-`-1` suffix is real
 * information — it identifies a different physical release — so it is kept.
 */
export function normalizeSetNumber(setNum: string | undefined | null): string {
  if (!setNum) return '';
  const trimmed = setNum.trim();
  return trimmed.endsWith('-1') ? trimmed.slice(0, -2) : trimmed;
}

/**
 * Strip characters no filesystem (or `Content-Disposition` header) should see:
 * the Windows-reserved set, path separators and any Unicode control/format
 * character (`\p{C}` — includes NUL and the bidi overrides that can disguise an
 * extension). Letters outside ASCII are left alone; `sanitizeNameStem` has
 * already reduced catalog names to ASCII, and an uploaded filename keeps its
 * own characters.
 */
export function safeFilenameStem(stem: string): string {
  return stem
    .replace(/[\p{C}\\/:*?"<>|]+/gu, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

export interface ExportStemInput {
  /** The set's display name, e.g. "Colosseum". */
  name?: string | undefined;
  /** The catalog set number, e.g. "10276-1". */
  setNum?: string | undefined;
  /** Used when neither name nor set number is known (an uploaded file's name). */
  fallback?: string | undefined;
}

/**
 * Build the export filename stem: `<Name≤12>-<setNumber>`.
 *
 * Degrades in order — name+number, number alone, name alone, the caller's
 * fallback label, then the literal `model` so a download never has an empty
 * name. Never includes an extension; callers append `.schem`, `.mcpack`, …
 */
export function modelExportStem(input: ExportStemInput): string {
  const name = sanitizeNameStem(input.name);
  const num = safeFilenameStem(normalizeSetNumber(input.setNum));
  if (name && num) return `${name}-${num}`;
  if (num) return num;
  if (name) return name;
  const fallback = safeFilenameStem(input.fallback ?? '');
  return fallback || 'model';
}
