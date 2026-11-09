/**
 * BYOM test corpus manifest: schema + validation (pure, no I/O) — BIZ-48 / WP B29.
 *
 * The committed manifest (`test/fixtures/byom-corpus.manifest.json`) holds METADATA only: where an item came from, its
 * licence as stated, and what it is for. The bytes live under the gitignored `data/byom-corpus/` and are never
 * shipped, published or shown in a showcase (plan B section 5). Everything here is deterministic so the tests can pin
 * it; the polite fetcher (`scripts/byom-corpus-fetch.ts`) is the only code that touches the network or the disk.
 */

/** Root of the local-only corpus, relative to the repo root. `.gitignore:27` (`data/`) keeps it out of git. */
export const CORPUS_ROOT = 'data/byom-corpus';

/** `model` = a model file (.ldr/.mpd/.io/.lxf/.glb); `photos` = a set of photographs of one real build. */
export type CorpusKind = 'model' | 'photos';

/**
 * What an item tests (plan B section 5):
 * `orig` a clean original design; `ip` a MOC of a licensed IP (negative example, never exported in a demo);
 * `mod` a modification of an official set; `pair` a model file AND real photos of the same build (photo ground
 * truth); `scan` a photogrammetry scan; `off` an official LEGO build seen in photos (a photo-to-3D input only);
 * `mixed` per-file judgement (landmarks, cars of several brands).
 */
export type CorpusRole = 'orig' | 'ip' | 'mod' | 'pair' | 'scan' | 'off' | 'mixed';

/** How the fetcher gets an automatable item. Items needing a login or a hand download use `CorpusEntry.manual`. */
export type FetchStrategy =
  /** One file at `url` (default: the entry's own URL); a github.com blob URL is read from raw.githubusercontent.com. */
  | { type: 'direct'; url?: string }
  /** Files of a GitHub repo chosen from its git tree (API + raw; no github.com HTML). */
  | { type: 'github-tree'; repo: string; ref?: string; include: string; exclude?: string; max: number }
  /** A page that links the file: the first href matching `pattern` (a regex source) is downloaded. */
  | { type: 'page-link'; pattern: string }
  /** A Wikimedia Commons category: per-file licence + credit read from the `imageinfo` API, up to `max` photos. */
  | { type: 'commons-category'; category: string; max: number };

export interface CorpusEntry {
  /** Stable id: `F01..` for model files, `P01..` for photo sets (plan B section 5). */
  id: string;
  kind: CorpusKind;
  title: string;
  author: string;
  /** The item's public page (https). */
  url: string;
  /** Licence AS STATED by the source; per-file licences for Commons are read at fetch time. */
  licence: string;
  role: CorpusRole;
  /** Automatable fetch. Exactly one of `fetch` / `manual` is present. */
  fetch?: FetchStrategy;
  /** The exact steps for a human to download it by hand (login wall, terms, or robots.txt forbids automation). */
  manual?: string;
  /** Overrides the licence-derived default (e.g. a self-contradicting licence is import-only whatever it says). */
  importOnly?: boolean;
  /** Format hint, size, roles beyond the tag, caveats. */
  notes: string;
}

export interface ManifestValidation {
  entries: CorpusEntry[];
  errors: string[];
}

const ID_RE = /^[FP]\d{2}$/;
const ROLES: readonly CorpusRole[] = ['orig', 'ip', 'mod', 'pair', 'scan', 'off', 'mixed'];
const STRATEGIES = ['direct', 'github-tree', 'page-link', 'commons-category'];

/**
 * A licence the source actually states: CC0, any Creative Commons, public domain, MIT, or the LDraw library licence.
 * "not stated", "unverified", "not checked", "unclear" and a bare "Other" are NOT a licence.
 */
const STATED_LICENCE_RE = /\b(CC0|CC[ -]BY|public domain|PD|MIT|LDraw|freely used?|can freely be used)\b/i;
const UNSTATED_RE = /\b(not stated|unverified|not checked|unclear|unknown)\b/i;

/** True when the licence text names a real licence and does not say it is unstated. */
export function hasStatedLicence(licence: string): boolean {
  return STATED_LICENCE_RE.test(licence) && !UNSTATED_RE.test(licence);
}

/**
 * Import-only items serve import and robustness tests, never a ground-truth render in a public document (plan B
 * section 5). An explicit `importOnly` wins; otherwise it follows from the licence.
 */
export function isImportOnly(entry: Pick<CorpusEntry, 'licence' | 'importOnly'>): boolean {
  return entry.importOnly ?? !hasStatedLicence(entry.licence);
}

/** Where an item's bytes go, relative to the repo root: `data/byom-corpus/{files,photos}/<id>`. */
export function corpusDirFor(entry: Pick<CorpusEntry, 'id' | 'kind'>): string {
  return `${CORPUS_ROOT}/${entry.kind === 'model' ? 'files' : 'photos'}/${entry.id}`;
}

/** True when `relPath` (repo-relative, `/` separators) stays inside `data/byom-corpus/` after `.`/`..` resolution. */
export function isInsideCorpus(relPath: string): boolean {
  if (/^([a-zA-Z]:|[\\/])/.test(relPath) || relPath.includes('\\')) return false;
  const stack: string[] = [];
  for (const part of relPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.pop() === undefined) return false;
    } else stack.push(part);
  }
  return stack.join('/').startsWith(`${CORPUS_ROOT}/`);
}

/**
 * Turns a remote file name into a safe single path segment (no separators, no `..`, no control characters).
 * Never returns an empty string.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'file';
}

/** Validates the parsed manifest JSON. Never throws; every problem becomes a message naming the entry. */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  const entries: CorpusEntry[] = [];
  const list = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return { entries, errors: ['manifest has no "entries" array'] };

  const seen = new Set<string>();
  for (const item of list as Record<string, unknown>[]) {
    const id = typeof item.id === 'string' ? item.id : '?';
    const bad = (why: string): void => void errors.push(`${id}: ${why}`);
    if (!ID_RE.test(id)) bad('id must look like F01 or P01');
    if (seen.has(id)) bad('duplicate id');
    seen.add(id);
    if (item.kind !== 'model' && item.kind !== 'photos') bad('kind must be "model" or "photos"');
    else if ((item.kind === 'model') !== id.startsWith('F')) bad('F ids are models and P ids are photo sets');
    for (const key of ['title', 'author', 'licence', 'notes']) {
      if (typeof item[key] !== 'string' || (item[key] as string).trim() === '') bad(`${key} is required`);
    }
    if (typeof item.url !== 'string' || !/^https:\/\/[^\s]+$/.test(item.url)) bad('url must be an https URL');
    if (!ROLES.includes(item.role as CorpusRole)) bad(`role must be one of ${ROLES.join(', ')}`);

    const strategy = item.fetch as { type?: unknown } | undefined;
    const hasManual = typeof item.manual === 'string' && item.manual.trim() !== '';
    if (hasManual === (strategy !== undefined)) bad('exactly one of "fetch" and "manual" (steps text) is required');
    if (strategy !== undefined && !STRATEGIES.includes(strategy.type as string)) bad('unknown fetch strategy');

    const entry = item as unknown as CorpusEntry;
    if (ID_RE.test(id) && (entry.kind === 'model' || entry.kind === 'photos')) {
      // Every write path derives from the id, so the id alone can never escape the corpus root.
      if (!isInsideCorpus(`${corpusDirFor(entry)}/x`)) bad('derived path escapes data/byom-corpus');
    }
    entries.push(entry);
  }
  return { entries, errors };
}
