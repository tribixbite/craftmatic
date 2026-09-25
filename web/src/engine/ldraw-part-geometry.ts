/**
 * Part-local, COLOURED LDraw geometry for the Bedrock entity path.
 *
 * The voxelizer's resolver (`ldraw-geometry.ts`) flattens a part to bare
 * triangles: no colour, no provenance. The entity compiler needs both —
 * printed and multi-colour parts must keep their explicit colours, and stud
 * primitives must be recognised so a plain brick compiles to ONE cuboid and
 * studs can be added back only where the model leaves them visible.
 *
 * Resolution order for a part id:
 *   1. an embedded section of the document being exported (Studio `.io`
 *      exports and OMR MPDs inline `.dat` definitions; those beat the library);
 *   2. the `.dat` text cache shared with the voxelizer (`getDatText`, which is
 *      seeded from the viewer in the Worker and falls back to `/ldraw-parts`);
 *   3. the unprinted base of a printed id (`3010p01` → `3010`), recorded as a
 *      print fallback;
 *   4. `null` — an explicit unresolved result, never a silent box.
 *
 * Colour 16 is kept SYMBOLIC in the returned mesh (it means "the instance's
 * colour"); the compiler substitutes each placement's colour. Sub-file
 * references with an explicit colour resolve their children's 16 to it, which
 * is the same rule the placement parser applies.
 */

import type { LDrawDocument } from './ldraw-parser.js';
import { embeddedPartTexts, parseLDrawColor } from './ldraw-parser.js';
import { datSubstitutionFor, getDatText } from './ldraw-geometry.js';
import { partStem } from './part-id.js';

export type Vec3 = [number, number, number];

export interface LdrawTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  /** LDraw colour id; 16 = inherit from the placement. Direct colours are kept. */
  color: number;
}

/** A top stud, recorded from its primitive reference instead of its triangles. */
export interface LdrawStud {
  /** Centre of the stud's base disc, part-local LDU. */
  center: Vec3;
  /** Unit direction the stud rises in (LDraw up is −Y, so usually [0,−1,0]). */
  up: Vec3;
  radius: number;
  height: number;
}

export interface LdrawPartMesh {
  /** Normalised id as requested (`3001`, `s/3001s01`, `3010p01`). */
  partId: string;
  /** Normalised id whose text was used; differs from `partId` on a print fallback. */
  resolvedAs: string;
  triangles: LdrawTriangle[];
  studs: LdrawStud[];
  /** Over `triangles` only (studs excluded). Zero-size when there are none. */
  bounds: { min: Vec3; max: Vec3 };
  /** Sub-file references that resolved nowhere — a real hole in the part. */
  unresolvedRefs: string[];
  /** Set when the exact (printed) id was missing and its base was used instead. */
  printFallback?: string;
  /**
   * The `.dat`'s own first line without its leading `0 ` (`Minifig Torso`,
   * `Windscreen 8 x 4 x 2 Curved`, `Door 1 x 4 x 6 with Stud Handle`) - the
   * library's description, used for semantic detection (figures, seats,
   * canopies, doors) the way part-elements.ts already does for panes.
   */
  description: string;
  /**
   * For a retired mould (`~Moved to 3068b`): the description of the part it
   * moved to, following up to three redirects. `description` keeps the stub
   * (the figure classifiers read the target ID from it, `mouldFamilyId`); a
   * detector that classifies by wording reads this (`classifiedDescription`).
   * 910032's white dining chairs sit on `3068` tiles, whose description is
   * the stub and matched no tile rule.
   */
  movedDescription?: string;
}

/** The wording to classify a part by: its moved-to target's description for a retired mould, else its own. */
export const classifiedDescription = (mesh: Pick<LdrawPartMesh, 'description' | 'movedDescription'>): string => mesh.movedDescription ?? mesh.description;

/**
 * The meshes with every retired mould's description replaced by its target's
 * (`classifiedDescription`), for detectors that classify by wording (moving
 * parts, seats, stools, furniture). Figure classification keeps the stub: it
 * reads the target ID from it (`mouldFamilyId`).
 */
export function withClassifiedDescriptions(meshes: ReadonlyMap<string, LdrawPartMesh | null>): ReadonlyMap<string, LdrawPartMesh | null> {
  if (![...meshes.values()].some(m => m?.movedDescription)) return meshes;
  return new Map([...meshes].map(([k, m]) => [k, m?.movedDescription ? { ...m, description: classifiedDescription(m) } : m]));
}

export interface PartGeometryProvider {
  getPartMesh(part: string): Promise<LdrawPartMesh | null>;
  /** What could not be resolved and what degraded, for diagnostics. */
  report(): {
    unresolved: string[];
    printFallbacks: Array<{ part: string; base: string }>;
    /** Names the library served through the alias ladder (`6538c` → `6538`): a near-mould stand-in, not the exact part. */
    substitutions: Array<{ part: string; alias: string }>;
  };
}

export interface PartGeometryProviderOptions {
  /** Document whose embedded `.dat` sections take precedence over the library. */
  document?: LDrawDocument;
  /** Extra `[id, text]` pairs treated like embedded sections (e.g. `.io` CustomParts). */
  embedded?: Iterable<readonly [string, string]>;
  /** Library text lookup; defaults to the voxelizer's seeded cache + `/ldraw-parts`. */
  fetchPartText?: (normalizedId: string) => Promise<string | null>;
  /** Which alias (if any) served a library name; defaults to the shared cache's ladder record. */
  substitutionFor?: (normalizedId: string) => string | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Same normalisation as `ldraw-geometry.ts`: forward slashes, lower case, no `.dat`. */
export function normPartId(id: string): string {
  return id.trim().replace(/\\/g, '/').toLowerCase().replace(/\.dat$/i, '');
}

const stemOf = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/**
 * Top-stud primitives, whose shape is known (a cylinder of radius 6 rising 4
 * LDU): `stud` solid, `stud2`/`stud2a` open, `stud10` for round 2×2 tops,
 * `stud15`/`stud17a`/`stud18a` round-part variants, `studp01` the logo stud.
 * Underside tubes (`stud3`, `stud4*`, `stud6*`) and anti-studs (`stug*`) are
 * cavities a solid part does not show; they are skipped entirely.
 */
const TOP_STUD = /^stud(2a?|10|15|17a|18a|p01)?$/;
const SKIP_PRIMITIVE = /^(stud[0-9a-z]*|stug[0-9a-z-]*)$/;
const STUD_RADIUS = 6;
const STUD_HEIGHT = 4;

/** Print suffix → base id (`3010p01`→`3010`, `4215ap01`→`4215a`); null when not printed. */
export function printBaseId(id: string): string | null {
  const m = /^(.*[0-9a-z])p[a-z0-9]{2,}$/.exec(stemOf(id));
  if (!m) return null;
  const base = m[1]!;
  // The base must still end in a digit or a single mould letter; `npeghol2`
  // would otherwise be shredded to `n`.
  if (!/[0-9][a-z]?$/.test(base)) return null;
  const dir = id.slice(0, id.lastIndexOf('/') + 1);
  return dir + base;
}

function applyMat(v: Vec3, R: readonly number[], T: Vec3): Vec3 {
  return [
    R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + T[0],
    R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + T[1],
    R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + T[2],
  ];
}

function rotate(v: Vec3, R: readonly number[]): Vec3 {
  return applyMat(v, R, [0, 0, 0]);
}

function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const n = length(v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** A resolved part before colour substitution; cached per normalised id. */
interface RawMesh {
  triangles: LdrawTriangle[];
  studs: LdrawStud[];
  unresolvedRefs: string[];
  /** First line of the `.dat` (the LDraw description), `0 ` prefix stripped. */
  description: string;
}

const MAX_DEPTH = 12;

/**
 * The LDraw description: the file's first line with the `0 ` stripped (a
 * `~`/`=` alias mark is kept - it means moved/alias).
 *
 * Studio's `UnOfficial/parts` library writes 5,605 of its 22,692 files as
 * one-section MPDs whose FIRST line is `0 FILE <name>.dat` and whose
 * description is the SECOND (`37777.dat`: `0 FILE 37777.dat` / `0 Torso
 * Large, Long Coat …`). Read literally, the description of every one of them
 * was `FILE 37777.dat`, which no figure classifier matches: Hagrid's big-fig
 * torso, arms and hair, the goblins' `93230p04` ear-hair and every mini-doll
 * hair in 42703 were nameless, so they fell out of their figures into the
 * building shell (Pixel 8 Pro, 2026-09-24). The header names the file, not
 * the part: skip it, as `scripts/gen-minidoll-slots.ts` already did.
 */
export function descriptionOf(text: string): string {
  let rest = text;
  for (let hops = 0; hops < 2; hops++) {
    const nl = rest.indexOf('\n');
    const first = (nl < 0 ? rest : rest.slice(0, nl)).replace(/\r$/, '').trim();
    const stripped = first.replace(/^0\s*/, '').trim();
    if (!/^FILE\s/i.test(stripped)) return stripped;
    if (nl < 0) return '';
    rest = rest.slice(nl + 1);
  }
  return '';
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * A description that only repeats the mould id carries no classifiable
 * wording. A Studio/OMR `.mpd` embeds its parts as `<set> - <mould>.dat`
 * sections whose description line is exactly that stub (`0 26021`).
 */
const isStubDescription = (description: string, canonical: string): boolean => {
  const d = description.replace(/^[~=_]+\s*/, '').trim().toLowerCase();
  return d === '' || d === canonical || d === `${canonical}.dat`;
};

export function createPartGeometryProvider(options: PartGeometryProviderOptions = {}): PartGeometryProvider {
  const fetchPartText = options.fetchPartText ?? getDatText;
  const substitutionFor = options.substitutionFor ?? (options.fetchPartText ? () => undefined : datSubstitutionFor);
  const embedded = new Map<string, string>();
  const addEmbedded = (id: string, text: string): void => {
    const key = normPartId(id);
    if (!embedded.has(key)) embedded.set(key, text);
    const stem = stemOf(key);
    if (!embedded.has(stem)) embedded.set(stem, text);
  };
  if (options.document) for (const [name, text] of embeddedPartTexts(options.document)) addEmbedded(name, text);
  if (options.embedded) for (const [name, text] of options.embedded) addEmbedded(name, text);

  const rawCache = new Map<string, RawMesh>();
  const inFlight = new Map<string, Promise<RawMesh | null>>();
  const meshCache = new Map<string, Promise<LdrawPartMesh | null>>();
  const unresolved = new Set<string>();
  const printFallbacks = new Map<string, string>();
  const substitutions = new Map<string, string>();

  /**
   * The description a detector should classify this part by.
   *
   * An embedded `<set> - <mould>.dat` section usually carries a STUB
   * description that just repeats the mould number, losing the wording every
   * description-based detector keys on: 10261's `.mpd` gives `26021`/`24869`
   * where the library gives `Train Base 4 x 5 Roller Coaster`/`Wheels Roller
   * Coaster`, so its ride cars and minifigs were invisible to detection while
   * the same set's `.ldr` resolved both. Fall back to the canonical mould's
   * LIBRARY description in exactly that case; a section with real wording,
   * and a part the library does not have, keep their own.
   */
  async function describedAs(key: string, text: string): Promise<string> {
    const own = descriptionOf(text);
    const canonical = partStem(key);
    if (!isStubDescription(own, canonical)) return own;
    // Deliberately not `textFor`: the embedded section IS the stub being replaced.
    const library = await fetchPartText(canonical);
    return library === null ? own : (descriptionOf(library) || own);
  }

  async function textFor(key: string): Promise<string | null> {
    const own = embedded.get(key) ?? embedded.get(stemOf(key));
    if (own !== undefined) return own;
    const text = await fetchPartText(key);
    if (text !== null) {
      const alias = substitutionFor(key);
      if (alias && alias !== key) substitutions.set(key, alias);
    }
    return text;
  }

  /**
   * Resolve a `.dat` to part-local triangles. Same in-flight-first ordering and
   * cycle guard as the voxelizer's resolver (see ldraw-geometry.ts): a
   * concurrent caller waits for the COMPLETE mesh; only a genuine reference
   * cycle reads the partial one.
   */
  function resolveRaw(id: string, depth: number, ancestors: ReadonlySet<string> | null): Promise<RawMesh | null> {
    const key = normPartId(id);
    if (depth > MAX_DEPTH) return Promise.resolve({ triangles: [], studs: [], unresolvedRefs: [], description: '' });
    const pending = inFlight.get(key);
    if (pending) {
      if (ancestors?.has(key)) return Promise.resolve(rawCache.get(key) ?? null);
      return pending;
    }
    const cached = rawCache.get(key);
    if (cached) return Promise.resolve(cached);

    const childAncestors = new Set(ancestors ?? []);
    childAncestors.add(key);

    const promise = (async (): Promise<RawMesh | null> => {
      const text = await textFor(key);
      if (text === null) return null;
      const mesh: RawMesh = { triangles: [], studs: [], unresolvedRefs: [], description: await describedAs(key, text) };
      rawCache.set(key, mesh); // early, so a cycle sees a (partial) mesh instead of recursing forever
      const subPromises: Promise<void>[] = [];

      for (const rawLine of text.split('\n')) {
        let line = rawLine.trim();
        // `0 !: <line>` is TEXMAP's fallback geometry — the part's real surface
        // for anything that does not paint the texture. Use it.
        if (line.startsWith('0 !:')) line = line.slice(4).trim();
        if (!line || line.startsWith('0')) continue;
        const tok = line.split(/\s+/);

        if (tok[0] === '3' && tok.length >= 11) {
          mesh.triangles.push({
            color: parseLDrawColor(tok[1]!),
            a: [+tok[2]!, +tok[3]!, +tok[4]!],
            b: [+tok[5]!, +tok[6]!, +tok[7]!],
            c: [+tok[8]!, +tok[9]!, +tok[10]!],
          });
        } else if (tok[0] === '4' && tok.length >= 14) {
          const color = parseLDrawColor(tok[1]!);
          const v0: Vec3 = [+tok[2]!, +tok[3]!, +tok[4]!];
          const v1: Vec3 = [+tok[5]!, +tok[6]!, +tok[7]!];
          const v2: Vec3 = [+tok[8]!, +tok[9]!, +tok[10]!];
          const v3: Vec3 = [+tok[11]!, +tok[12]!, +tok[13]!];
          mesh.triangles.push({ color, a: v0, b: v1, c: v2 }, { color, a: v0, b: v2, c: v3 });
        } else if (tok[0] === '1' && tok.length >= 15) {
          const color = parseLDrawColor(tok[1]!);
          const T: Vec3 = [+tok[2]!, +tok[3]!, +tok[4]!];
          const R = [+tok[5]!, +tok[6]!, +tok[7]!, +tok[8]!, +tok[9]!, +tok[10]!, +tok[11]!, +tok[12]!, +tok[13]!];
          const subId = normPartId(tok.slice(14).join(' '));
          const subStem = stemOf(subId);

          if (TOP_STUD.test(subStem)) {
            const upVec = rotate([0, -1, 0], R);
            mesh.studs.push({
              center: T,
              up: normalize(upVec),
              radius: STUD_RADIUS * length(rotate([1, 0, 0], R)),
              height: STUD_HEIGHT * length(upVec),
            });
            continue;
          }
          if (SKIP_PRIMITIVE.test(subStem)) continue;

          subPromises.push(
            resolveRaw(subId, depth + 1, childAncestors).then(sub => {
              if (!sub) { mesh.unresolvedRefs.push(subId); return; }
              for (const t of sub.triangles) {
                mesh.triangles.push({
                  color: t.color === 16 ? color : t.color,
                  a: applyMat(t.a, R, T), b: applyMat(t.b, R, T), c: applyMat(t.c, R, T),
                });
              }
              for (const s of sub.studs) {
                const upVec = rotate(s.up, R);
                mesh.studs.push({
                  center: applyMat(s.center, R, T),
                  up: normalize(upVec),
                  radius: s.radius * length(rotate([1, 0, 0], R)),
                  height: s.height * length(upVec),
                });
              }
              for (const u of sub.unresolvedRefs) mesh.unresolvedRefs.push(u);
            }),
          );
        }
      }

      await Promise.all(subPromises);
      return mesh;
    })();

    inFlight.set(key, promise);
    return promise.finally(() => inFlight.delete(key));
  }

  function boundsOf(triangles: LdrawTriangle[]): { min: Vec3; max: Vec3 } {
    if (triangles.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const t of triangles) for (const v of [t.a, t.b, t.c]) for (let i = 0; i < 3; i++) {
      if (v[i]! < min[i]!) min[i] = v[i]!;
      if (v[i]! > max[i]!) max[i] = v[i]!;
    }
    return { min, max };
  }

  async function build(part: string): Promise<LdrawPartMesh | null> {
    const key = normPartId(part);
    let raw = await resolveRaw(key, 0, null);
    let resolvedAs = key;
    let printFallback: string | undefined;
    if (!raw) {
      const base = printBaseId(key);
      if (base) {
        raw = await resolveRaw(base, 0, null);
        if (raw) { resolvedAs = base; printFallback = base; printFallbacks.set(key, base); }
      }
    }
    if (!raw) { unresolved.add(key); return null; }
    return {
      partId: key,
      resolvedAs,
      triangles: raw.triangles,
      studs: raw.studs,
      bounds: boundsOf(raw.triangles),
      unresolvedRefs: [...new Set(raw.unresolvedRefs)],
      description: raw.description,
      ...(printFallback ? { printFallback } : {}),
      ...(await movedDescriptionOf(raw.description)),
    };
  }

  /** The description a `~Moved to <id>` stub redirects to (up to three hops), or nothing. */
  async function movedDescriptionOf(description: string): Promise<{ movedDescription?: string }> {
    let d = description;
    for (let hop = 0; hop < 3; hop++) {
      const m = /^[~=_]*\s*Moved to\s+(\S+)/i.exec(d);
      if (!m) break;
      const text = await textFor(normPartId(m[1]!));
      if (text === null) return {};
      d = descriptionOf(text);
    }
    return d !== description ? { movedDescription: d } : {};
  }

  return {
    getPartMesh(part: string): Promise<LdrawPartMesh | null> {
      const key = normPartId(part);
      let p = meshCache.get(key);
      if (!p) { p = build(key); meshCache.set(key, p); }
      return p;
    },
    report() {
      return {
        unresolved: [...unresolved].sort(),
        printFallbacks: [...printFallbacks].map(([part, base]) => ({ part, base })).sort((a, b) => a.part.localeCompare(b.part)),
        substitutions: [...substitutions].map(([part, alias]) => ({ part, alias })).sort((a, b) => a.part.localeCompare(b.part)),
      };
    },
  };
}
