/**
 * Part-source ledger (BIZ-07): for every `.dat` the export resolver reads, WHERE it came from and under
 * which licence, so a pack can prove it ships only redistributable meshes.
 *
 * Pure types and helpers; `ldraw-geometry.ts` owns the recording (it owns the probes) and `credits.ts`
 * renders the attribution. The classes:
 *
 * - `ldraw-official`   - the LDraw.org official library (`parts/`, `p/`, `parts/s/`, or `ldraw_ref/official`).
 * - `ldraw-unofficial` - the LDraw.org parts tracker (`ldraw_ref/unofficial`); redistributable only with a CC BY `!LICENSE`.
 * - `studio`           - anything under Studio's `UnOfficial/` tree, or a `parts/` file that is not an official
 *                        part name (Studio's own edit): NOT redistributable.
 * - `mirror`           - fetched from the prod mirror over the network; its provenance is not known here.
 * - `custom`           - text handed in by the caller (an `.io` CustomPart, an MPD inline, a viewer-seeded text).
 * - `substituted`      - a sibling mould served in place of the requested name (`datSubstitutions`).
 */

import { OFFICIAL_PART_NAMES } from './ldraw-official-parts.generated.js';

/** Where a resolved `.dat` came from. */
export type PartSourceKind = 'ldraw-official' | 'ldraw-unofficial' | 'studio' | 'mirror' | 'custom' | 'substituted';

/** Library mode: `dev` is the unchanged default; `official` reads only redistributable LDraw.org files. */
export type PartLibraryMode = 'dev' | 'official';

/** One resolved `.dat`. */
export interface PartSourceEntry {
  /** The requested part name, normalised (lower case, no `.dat`). */
  part: string;
  kind: PartSourceKind;
  /** The library-relative file actually read (`parts/3001.dat`, `unofficial/parts/x.dat`), or `''` for caller-seeded text. */
  file: string;
  /** The `0 !LICENSE` line's text, or null when the file has none. */
  licence: string | null;
  /** The `0 Author:` line's text, or null. */
  author: string | null;
  /** `substituted` only: the name whose text served the request. */
  servedAs?: string;
  /** `substituted` only: the class of the file that served it. */
  origin?: Exclude<PartSourceKind, 'substituted'>;
}

/** Why a name could not be used in `official` mode. */
export type OfficialViolationReason = 'not-in-official-tree' | 'logo-primitive' | 'bl-copy';

/** One name official mode refused. */
export interface OfficialViolation {
  part: string;
  reason: OfficialViolationReason;
}

/** A licence line the LDraw.org libraries use for redistributable files (CC BY 4.0, or CCAL 2.0 = CC BY 2.0). */
export const CC_BY_LICENCE = /CC\s*BY|CCAL/i;

/** Thrown when an `official`-mode export used a name outside the official library. */
export class OfficialLibraryError extends Error {
  readonly violations: OfficialViolation[];
  constructor(violations: OfficialViolation[]) {
    super(`official library mode: ${violations.length} part name(s) are not redistributable LDraw.org files: ${violations.map(v => `${v.part} (${v.reason})`).join(', ')}`);
    this.name = 'OfficialLibraryError';
    this.violations = violations;
  }
}

/** The library mode named by `CRAFTMATIC_LDRAW_LIBRARY` (`official`), else `dev`. */
export function libraryModeFromEnv(): PartLibraryMode {
  const raw = typeof process !== 'undefined' ? process.env?.['CRAFTMATIC_LDRAW_LIBRARY'] : undefined;
  return raw?.trim().toLowerCase() === 'official' ? 'official' : 'dev';
}

/** `!LICENSE` and `Author:` lines of a `.dat` header (first match of each; both null when absent). */
export function parsePartHeader(text: string): { licence: string | null; author: string | null } {
  let licence: string | null = null;
  let author: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || !line.startsWith('0')) continue;
    const body = line.slice(1).trim();
    if (licence === null && body.startsWith('!LICENSE')) licence = body.slice('!LICENSE'.length).trim() || null;
    else if (author === null && /^Author:/i.test(body)) author = body.replace(/^Author:/i, '').trim() || null;
    if (licence !== null && author !== null) break;
  }
  return { licence, author };
}

let officialSet: ReadonlySet<string> | null = null;

/** True when `stem` names a part in the official library's `parts/` folder (the generated list). */
export function isOfficialPartName(stem: string): boolean {
  officialSet ??= new Set(OFFICIAL_PART_NAMES);
  return officialSet.has(stem.toLowerCase());
}

/** The trees a probe can read: the configured root, or the local mirror copy's two trees. */
export type LibraryTree = 'root' | 'ref-official' | 'ref-unofficial';

/**
 * Class of the file at library-relative `rel` read from `tree`. A root `parts/<name>.dat` is official only when
 * `<name>` is on the official list (a Studio edit of a part keeps its path but is not redistributable);
 * primitives and sub-parts under `p/` and `parts/s/` are trusted by path.
 */
export function classifyLibraryPath(rel: string, tree: LibraryTree): Exclude<PartSourceKind, 'mirror' | 'custom' | 'substituted'> {
  if (tree === 'ref-unofficial') return 'ldraw-unofficial';
  if (tree === 'ref-official') return 'ldraw-official';
  if (/^UnOfficial\//i.test(rel)) return 'studio';
  const top = /^parts\/([^/]+)\.dat$/.exec(rel);
  if (top) return isOfficialPartName(top[1]!) ? 'ldraw-official' : 'studio';
  return 'ldraw-official';
}

/** True for the LEGO-logo stud primitives (`logo*.dat`, `stud-logo*.dat`, `stud*logo*`): a trademark in the mesh. */
export function isLogoPrimitive(key: string): boolean {
  const bare = key.replace(/\\/g, '/').toLowerCase().replace(/\.dat$/, '').split('/').pop() ?? '';
  return bare.startsWith('logo') || /^stud\d*-?logo/.test(bare) || bare.includes('stud-logo');
}

/** The effective class of an entry: a substitution counts as what actually served it, but is never gate-clean. */
function effectiveKind(e: PartSourceEntry): PartSourceKind {
  return e.kind === 'substituted' ? (e.origin ?? 'substituted') : e.kind;
}

/**
 * The licence gate: a ledger is `ok` only when every entry is an official or unofficial LDraw.org file that was
 * NOT substituted and whose licence (when stated) is CC BY. An unofficial file must state one. Everything else
 * (`studio`, `mirror`, `custom`, `substituted`) is `offending`.
 */
export function licenceGate(ledger: readonly PartSourceEntry[]): { ok: boolean; offending: PartSourceEntry[] } {
  const offending = ledger.filter(e => {
    if (e.kind !== 'ldraw-official' && e.kind !== 'ldraw-unofficial') return true;
    if (e.licence === null) return e.kind === 'ldraw-unofficial';
    return !CC_BY_LICENCE.test(e.licence);
  });
  return { ok: offending.length === 0, offending };
}

/** Exposed for `credits.ts`: whether an entry's author is credited (an LDraw.org file, even when it stood in). */
export function isCreditedEntry(e: PartSourceEntry): boolean {
  const kind = effectiveKind(e);
  return kind === 'ldraw-official' || kind === 'ldraw-unofficial';
}
