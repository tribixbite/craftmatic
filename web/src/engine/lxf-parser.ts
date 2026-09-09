/**
 * Parse a LEGO Digital Designer .lxf file → ParsedBrick[].
 *
 * LXF is a plain ZIP archive containing IMAGE100.LXFML (XML).
 * LXFML structure:
 *   <LXFML>
 *     <Bricks>
 *       <Brick designID="3001">
 *         <Part materials="21,...">
 *           <Bone transformation="r00,r01,...,tx,ty,tz"/>
 *         </Part>
 *       </Brick>
 *     </Bricks>
 *   </LXFML>
 *
 * Two coordinate problems must both be solved to place parts correctly:
 *
 * 1. LDD vs LDraw world axes — LDD is Y-up, cm units; LDraw is Y-down, LDU.
 *    Conversion: flip Y, scale translations ×25 (1 LDD unit = 25 LDU).
 *
 * 2. LDD vs LDraw PART ORIGIN — the same physical part has a different local
 *    origin in LDD than in the LDraw library, so the LXFML <Bone> transform
 *    (which positions the LDD origin) does NOT place the LDraw geometry
 *    correctly, and every part attached only through a displaced one reads as
 *    floating or splayed (issue #108).
 *
 * TWO correction tables, and the ORDER matters (audit 2026-09-08, P0 item 2):
 *
 *  a. `/ldd-measured-align.json` — clego's MEASURED per-design correction,
 *     voted from 207 sets that have both an LXFML dump and an authentic Studio
 *     `.io` (scripts/gen-ldd-measured-align.py; clego DBIX_SOLVER.md §4/§9).
 *     Covers ~92 % of a typical set's placements. Its correction is already in
 *     LDU and already in the FLIPPED LDraw basis, so it composes post-flip.
 *  b. `/ldd-part-map.json` — BrickLink Studio's own `ldraw.xml` correction
 *     columns (axis-angle + translation in LDD units), the FALLBACK, and still
 *     the source of the LDraw FILENAME for a design (e.g. 60583 → 60583b.dat).
 *
 * Measured over six sets with a native `.lxf` AND an authentic Studio `.io`,
 * none of them in clego's training cohort, so this is held out:
 *
 *     ldraw.xml columns, F = diag(1,-1,1)   (what shipped)     7.15 % GEO
 *     ldraw.xml columns, F = diag(1,-1,-1)                     7.06 %
 *     MEASURED table,    F = diag(1,-1,1)                     48.12 %
 *     MEASURED table,    F = diag(1,-1,-1)                    72.70 %
 *     no per-part correction at all         (control)          3.78 %
 *
 * i.e. the shipped path was barely above the do-nothing control — the ldraw.xml
 * columns do not reproduce Studio's own placements. Both halves of the fix
 * matter independently: the payload (+65 pts) and the change of basis (+25 pts).
 *
 * THE CHANGE OF BASIS. `F = diag(1,-1,1)` has det = -1: it is a REFLECTION, so
 * it mirrors the whole model and lands every chiral part (slopes, wedges, curved
 * shells) in a physically wrong slot. LDD (Y-up) and LDraw (Y-down) are BOTH
 * right-handed, so the map between them is a 180° rotation about X:
 *
 *     F = diag(1, -1, -1)        det = +1
 *
 * Final per-part transform:
 *   measured  R_world = (F·R_bone·F)·D,  t_world = 25·(F·t_bone) + (F·R_bone·F)·e
 *   ldraw.xml R_world = F·(R_bone·R_align)·F,  t_world = 25·F·(R_bone·t_align + t_bone)
 */

import { extractFile } from './zip-utils';
import { lddToLDraw } from './ldd-colors';
import type { ParsedBrick } from './ldraw-parser';

/** 1 cm = 25 LDraw units (1 stud = 0.8cm = 20 LDU → 1cm = 25 LDU). */
const CM_TO_LDU = 25;

/**
 * The LDD→LDraw change of basis, as a per-axis sign. `diag(1,-1,-1)` — a 180°
 * rotation about X, det = +1. `diag(1,-1,1)` (what shipped until 2026-09-09) has
 * det = -1: a reflection, which mirrors the model and puts every chiral part in
 * the wrong slot. Both libraries are right-handed. See the module header.
 */
export const FRAME_SIGN: readonly [number, number, number] = [1, -1, -1];

/** designID → [ldrawFile, tx, ty, tz, angle(rad), ax, ay, az]. LDD units. */
export type PartAlign = [string, number, number, number, number, number, number, number];

/**
 * designID → [ldrawFile, r0..r8 (row-major D), tx, ty, tz (e, LDU), support].
 * clego's MEASURED correction, already expressed in the flipped LDraw basis.
 */
export type MeasuredAlign = [
  string,
  number, number, number, number, number, number, number, number, number,
  number, number, number,
  number,
];

/** Where the ldraw.xml fallback table lives (scripts/gen-ldd-part-map.py). */
export const PART_MAP_URL = '/ldd-part-map.json';
/** Where the measured table lives (scripts/gen-ldd-measured-align.py). */
export const MEASURED_ALIGN_URL = '/ldd-measured-align.json';
/** A transient failure gets this many tries in total before we give up on it. */
const TABLE_FETCH_ATTEMPTS = 3;
const TABLE_RETRY_BACKOFF_MS = [250, 750];

/**
 * The loaded alignment resource. `state` separates the two failures the audit
 * found conflated: `unavailable` means the WHOLE table is missing (so every
 * placement silently falls back to its raw LDD origin and the model looks
 * scattered), while an `ok` table with a design id absent from `entries` is one
 * unsupported mould among thousands of correct ones.
 */
export interface AlignmentTable<T> {
  state: 'ok' | 'unavailable';
  /** the URL it was fetched from — half of the "source identity". */
  source: string;
  /** schema-validated entries, keyed by LDD designID. */
  entries: Record<string, T>;
  /** raw entries present in the JSON but rejected by the row validator. */
  rejected: number;
  /** the resource's own identity, from its HTTP validators when it has them. */
  version?: string;
  /** why the whole resource is unavailable. */
  error?: string;
}

export type LxfAlignmentTable = AlignmentTable<PartAlign>;
export type LxfMeasuredTable = AlignmentTable<MeasuredAlign>;

/** The reported shape of one loaded table. */
export interface LxfTableReport {
  state: 'ok' | 'unavailable';
  source: string;
  entries: number;
  rejected: number;
  version?: string;
  error?: string;
}

/** What a `.lxf` parse can tell the caller about how well it went. */
export interface LxfDiagnostics {
  /** the ldraw.xml fallback table (also the source of LDraw filenames). */
  table: LxfTableReport;
  /** clego's measured table — the primary correction. */
  measured: LxfTableReport;
  /** placements positioned through the MEASURED correction. */
  measuredPlacements: number;
  /** placements positioned through the ldraw.xml fallback correction. */
  mappedPlacements: number;
  /** placements with NEITHER: identity alignment + bare `designID.dat`. */
  unmappedPlacements: number;
  /** distinct unmapped design ids, most-used first (capped for readability). */
  unmappedDesignIds: string[];
  /** `<Part>` elements with no `<Bone>` at all. */
  skippedNoBone: number;
  /** `<Part>` elements whose `<Bone transformation>` had < 12 numbers. */
  skippedBadTransform: number;
  /** `<Part>` elements with several `<Bone>`s (flex segments; first one wins). */
  multiBoneParts: number;
}

/**
 * One `<Part>` worth of LXFML, lifted out of the DOM so the placement maths can
 * be exercised without a DOM (the test environment is plain node).
 */
export interface LxfPartRecord {
  designID: string;
  materialId: number;
  transformation: string;
  boneCount: number;
}

/** True when `v` is a structurally valid `PartAlign` row. */
export function validatePartAlign(v: unknown): v is PartAlign {
  if (!Array.isArray(v) || v.length !== 8) return false;
  if (typeof v[0] !== 'string' || v[0].length === 0) return false;
  for (let i = 1; i < 8; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return false;
  }
  return true;
}

/** True when `v` is a structurally valid `MeasuredAlign` row. */
export function validateMeasuredAlign(v: unknown): v is MeasuredAlign {
  if (!Array.isArray(v) || v.length !== 14) return false;
  if (typeof v[0] !== 'string' || v[0].length === 0) return false;
  for (let i = 1; i < 14; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return false;
  }
  // The rotation must be a real rotation — the generator re-orthonormalises, so
  // a row whose determinant is off is corrupt, not merely quantised.
  const d = det3(v.slice(1, 10) as number[]);
  return Math.abs(d - 1) <= 0.02;
}

/** Determinant of a 3×3 row-major matrix. */
function det3(m: number[]): number {
  return m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!)
    - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!)
    + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
}

/**
 * Validate a fetched alignment table. A malformed or non-object body yields an
 * `unavailable` table rather than a silent empty one, and individual bad rows
 * are DROPPED and COUNTED — one corrupt row must not disable alignment for the
 * thousands of good ones.
 */
export function validateTable<T>(
  raw: unknown, source: string, isRow: (v: unknown) => v is T, version?: string,
): AlignmentTable<T> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      state: 'unavailable', source, entries: {}, rejected: 0, version,
      error: `alignment table is not a JSON object (got ${Array.isArray(raw) ? 'array' : typeof raw})`,
    };
  }
  const entries: Record<string, T> = {};
  let rejected = 0;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isRow(v)) entries[id] = v;
    else rejected++;
  }
  if (Object.keys(entries).length === 0) {
    return {
      state: 'unavailable', source, entries, rejected, version,
      error: `alignment table has no usable entries (${rejected} rejected by schema)`,
    };
  }
  return { state: 'ok', source, entries, rejected, version };
}

/** Back-compat alias for the ldraw.xml table's validator. */
export const validatePartMap = (raw: unknown, source: string, version?: string): LxfAlignmentTable =>
  validateTable(raw, source, validatePartAlign, version);

const tableCache = new Map<string, Promise<AlignmentTable<unknown>>>();

/** Drop the cached tables so the next load refetches. Exported for tests. */
export function resetPartMapCache(): void {
  tableCache.clear();
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Fetch + validate one table, retrying a TRANSIENT failure. A 404/410 is
 * definitive (the asset genuinely isn't deployed) and is not retried; a thrown
 * fetch, a 5xx or a 429 is.
 */
async function fetchTable<T>(
  url: string, isRow: (v: unknown) => v is T,
): Promise<AlignmentTable<T>> {
  let error = 'unknown failure';
  for (let attempt = 0; attempt < TABLE_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(TABLE_RETRY_BACKOFF_MS[attempt - 1] ?? 750);
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (err) {
      error = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (!resp.ok) {
      error = `HTTP ${resp.status}`;
      if (resp.status === 404 || resp.status === 410) break; // definitive
      continue;
    }
    // The resource carries no version field of its own, so its identity is the
    // HTTP validator the server does send, plus the accepted entry count.
    const version = resp.headers?.get?.('etag')
      ?? resp.headers?.get?.('last-modified')
      ?? undefined;
    try {
      return validateTable(await resp.json(), url, isRow, version ?? undefined);
    } catch (err) {
      // Malformed JSON is a property of the bytes, not of the connection —
      // retrying cannot help, so stop here and report it.
      return {
        state: 'unavailable', source: url, entries: {}, rejected: 0,
        version: version ?? undefined,
        error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { state: 'unavailable', source: url, entries: {}, rejected: 0, error };
}

/**
 * Lazily fetch + cache one alignment table.
 *
 * A SUCCESSFUL table is cached for the page session; a failure is NOT. The old
 * implementation turned every HTTP/network/JSON error into `{}` and kept that
 * promise, so one transient blip left every later `.lxf` load in the session
 * placing parts at their raw LDD origins with no way to recover short of a
 * reload (audit 2026-09-08, P1 item 3).
 */
function loadTable<T>(url: string, isRow: (v: unknown) => v is T): Promise<AlignmentTable<T>> {
  const hit = tableCache.get(url);
  if (hit) return hit as Promise<AlignmentTable<T>>;
  const p = fetchTable(url, isRow).then(
    t => {
      if (t.state !== 'ok') tableCache.delete(url); // let the next load retry
      return t;
    },
    err => {
      tableCache.delete(url);
      throw err;
    },
  );
  tableCache.set(url, p as Promise<AlignmentTable<unknown>>);
  return p;
}

/** The ldraw.xml fallback table (~232 KB) — also the source of LDraw filenames. */
export function loadPartMap(): Promise<LxfAlignmentTable> {
  return loadTable(PART_MAP_URL, validatePartAlign);
}

/** clego's MEASURED per-design correction (~145 KB) — the primary alignment. */
export function loadMeasuredAlign(): Promise<LxfMeasuredTable> {
  return loadTable(MEASURED_ALIGN_URL, validateMeasuredAlign);
}

/** Axis-angle (radians) → 3×3 row-major rotation matrix. */
export function axisAngleToMatrix(angle: number, ax: number, ay: number, az: number): number[] {
  if (Math.abs(angle) < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const n = Math.hypot(ax, ay, az);
  if (n < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  ax /= n; ay /= n; az /= n;
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * ax * ax + c,      t * ax * ay - s * az, t * ax * az + s * ay,
    t * ax * ay + s * az, t * ay * ay + c,      t * ay * az - s * ax,
    t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c,
  ];
}

/** Multiply two 3×3 row-major matrices. */
function mul3(a: number[], b: number[]): number[] {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

/** Multiply a 3×3 row-major matrix by a 3-vector. */
function mulVec(m: number[], v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Parse an LXFML `<Bone transformation>` string into a row-major rotation +
 * translation. The LXFML value is a COLUMN-major 4×3 (9 rotation values then
 * tx,ty,tz, LDD units); this returns the transposed row-major R plus t.
 * Returns null when there aren't at least 12 values.
 */
export function parseBoneTransform(
  tf: string,
): { rBone: number[]; tBone: [number, number, number] } | null {
  const v = tf.split(',').map(Number);
  if (v.length < 12) return null;
  return {
    rBone: [v[0], v[3], v[6], v[1], v[4], v[7], v[2], v[5], v[8]],
    tBone: [v[9], v[10], v[11]],
  };
}

export interface LxfPlacement { rot: number[]; x: number; y: number; z: number; }

/**
 * Conjugate a 3×3 row-major rotation by F = diag(FRAME_SIGN): entry (i,j) is
 * scaled by s_i·s_j. F·F = I, so this is its own inverse.
 */
function conjugateFrame(m: number[]): number[] {
  const [sx, sy, sz] = FRAME_SIGN;
  const s = [sx, sy, sz];
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) out[i * 3 + j] = s[i]! * s[j]! * m[i * 3 + j]!;
  return out;
}

/**
 * The `ldraw.xml`-column path (issue #108): compose the LDD bone transform with
 * the per-part LDD→LDraw origin alignment IN LDD SPACE, then change basis.
 * Pure — no DOM / fetch / ZIP. The FALLBACK since 2026-09-09; prefer
 * `composeLxfMeasured` when the measured table covers the design.
 *
 *   R_world = R_bone · R_align,  t_world = R_bone · t_align + t_bone   (LDD)
 *   rot = F·R_world·F,  pos = 25·(F·t_world),  F = diag(FRAME_SIGN)
 *
 * `align` undefined → identity alignment (bare `designID.dat` fallback caller-side).
 */
export function composeLxfPlacement(
  rBone: number[],
  tBone: [number, number, number],
  align: PartAlign | undefined,
): LxfPlacement {
  const tAlign: [number, number, number] = align ? [align[1], align[2], align[3]] : [0, 0, 0];
  const rAlign = align
    ? axisAngleToMatrix(align[4], align[5], align[6], align[7])
    : [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const rWorld = mul3(rBone, rAlign);
  const rotated = mulVec(rBone, tAlign);
  const [sx, sy, sz] = FRAME_SIGN;
  return {
    rot: conjugateFrame(rWorld),
    x: sx * (rotated[0] + tBone[0]) * CM_TO_LDU,
    y: sy * (rotated[1] + tBone[1]) * CM_TO_LDU,
    z: sz * (rotated[2] + tBone[2]) * CM_TO_LDU,
  };
}

/**
 * The MEASURED path. clego's correction `(D, e)` is already in LDU and already
 * in the flipped LDraw basis, so the change of basis happens FIRST and the
 * correction is applied on the LDraw side:
 *
 *   R_ldr = F·R_bone·F,  t_ldr = 25·(F·t_bone)
 *   rot = R_ldr·D,       pos = t_ldr + R_ldr·e
 *
 * Same algebra as `composeLxfPlacement`, with the correction expressed on the
 * other side of the change of basis. Held out against authentic Studio truth
 * this scores 72.70 % geometric agreement against the ldraw.xml path's 7.15 %
 * (see the module header).
 */
export function composeLxfMeasured(
  rBone: number[],
  tBone: [number, number, number],
  measured: MeasuredAlign,
): LxfPlacement {
  const rLdr = conjugateFrame(rBone);
  const d = measured.slice(1, 10) as number[];
  const e: [number, number, number] = [measured[10], measured[11], measured[12]];
  const [sx, sy, sz] = FRAME_SIGN;
  const offset = mulVec(rLdr, e);
  return {
    rot: mul3(rLdr, d),
    x: sx * tBone[0] * CM_TO_LDU + offset[0],
    y: sy * tBone[1] * CM_TO_LDU + offset[1],
    z: sz * tBone[2] * CM_TO_LDU + offset[2],
  };
}

/**
 * The DOM-free core: LXFML `<Part>` records × the alignment table → placements
 * plus the coverage/skip counts. Pure, so the production table's real coverage
 * is testable without a browser.
 */
export function buildLxfPlacements(
  records: readonly LxfPartRecord[],
  table: LxfAlignmentTable,
  measured: LxfMeasuredTable,
): { bricks: ParsedBrick[]; diagnostics: LxfDiagnostics } {
  const bricks: ParsedBrick[] = [];
  const unmapped = new Map<string, number>();
  let measuredPlacements = 0;
  let mappedPlacements = 0;
  let unmappedPlacements = 0;
  let skippedNoBone = 0;
  let skippedBadTransform = 0;
  let multiBoneParts = 0;

  for (const rec of records) {
    if (rec.boneCount > 1) multiBoneParts++;
    if (!rec.transformation) { skippedNoBone++; continue; }
    const boneT = parseBoneTransform(rec.transformation);
    if (!boneT) { skippedBadTransform++; continue; }

    // MEASURED correction first (10× the geometric agreement of the ldraw.xml
    // columns — see the module header), then the ldraw.xml columns, then a bare
    // designID.dat at identity for a design neither table names.
    const meas = measured.entries[rec.designID];
    const align = table.entries[rec.designID];
    let part: string;
    let placement: LxfPlacement;
    if (meas) {
      measuredPlacements++;
      part = meas[0];
      placement = composeLxfMeasured(boneT.rBone, boneT.tBone, meas);
    } else {
      if (align) mappedPlacements++;
      else {
        unmappedPlacements++;
        unmapped.set(rec.designID, (unmapped.get(rec.designID) ?? 0) + 1);
      }
      part = align ? align[0] : `${rec.designID}.dat`;
      placement = composeLxfPlacement(boneT.rBone, boneT.tBone, align);
    }
    bricks.push({
      color: lddToLDraw(rec.materialId), rot: placement.rot,
      x: placement.x, y: placement.y, z: placement.z, part,
    });
  }

  const report = (t: AlignmentTable<unknown>): LxfTableReport => ({
    state: t.state,
    source: t.source,
    rejected: t.rejected,
    entries: Object.keys(t.entries).length,
    ...(t.version !== undefined ? { version: t.version } : {}),
    ...(t.error !== undefined ? { error: t.error } : {}),
  });

  return {
    bricks,
    diagnostics: {
      table: report(table),
      measured: report(measured),
      measuredPlacements,
      mappedPlacements,
      unmappedPlacements,
      unmappedDesignIds: [...unmapped.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([id]) => id),
      skippedNoBone,
      skippedBadTransform,
      multiBoneParts,
    },
  };
}

/**
 * One line describing how the alignment tables served this model, or null when
 * there is nothing worth telling the user. Pure, so the wording is testable.
 */
export function describeLxfDiagnostics(d: LxfDiagnostics): string | null {
  const total = d.measuredPlacements + d.mappedPlacements + d.unmappedPlacements;
  if (d.table.state !== 'ok' && d.measured.state !== 'ok') {
    return `LDD alignment tables unavailable (${d.measured.error ?? d.table.error ?? 'unknown'}) — every part is placed at its raw LDD origin, so this model will look scattered. Reload to retry.`;
  }
  const parts: string[] = [];
  if (d.measured.state !== 'ok') {
    // The accurate table is gone but the ldraw.xml fallback is not: the model
    // still renders, ~10x less accurately. Say so rather than imply it is fine.
    parts.push(
      `measured alignment table unavailable (${d.measured.error ?? 'unknown'}) — ` +
      'falling back to Studio\'s ldraw.xml columns, which place far fewer parts ' +
      'correctly. Reload to retry',
    );
  } else if (d.table.state !== 'ok') {
    parts.push(
      `ldraw.xml fallback table unavailable (${d.table.error ?? 'unknown'}) — designs ` +
      'outside the measured table are placed at their raw LDD origin. Reload to retry',
    );
  } else if (total > 0 && d.measuredPlacements < total) {
    const pct = (100 * d.measuredPlacements) / total;
    parts.push(
      `${d.measuredPlacements} of ${total} placements (${pct.toFixed(1)}%) use the ` +
      'measured LDD alignment; the rest fall back to Studio\'s ldraw.xml columns, ' +
      'which are much less accurate',
    );
  }
  if (d.unmappedPlacements > 0 && total > 0) {
    parts.push(
      `${d.unmappedPlacements} placements (${d.unmappedDesignIds.length} design ` +
      `id${d.unmappedDesignIds.length === 1 ? '' : 's'}) have no LDD→LDraw alignment ` +
      'entry at all and use their raw LDD origin',
    );
  }
  if (d.skippedBadTransform > 0) parts.push(`${d.skippedBadTransform} malformed bone transforms skipped`);
  if (d.skippedNoBone > 0) parts.push(`${d.skippedNoBone} parts with no bone skipped`);
  return parts.length ? `LDD .lxf: ${parts.join('; ')}` : null;
}

/** Lift every `<Part>` out of an LXFML document. Thin — the DOM half. */
function readLxfParts(doc: Document): LxfPartRecord[] {
  const out: LxfPartRecord[] = [];
  // A <Brick> can contain MULTIPLE <Part> elements (assemblies — e.g. a hinge
  // is designID 73983 wrapping parts 2430 + 2429), each with its OWN designID,
  // materials, and <Bone> transform. Iterate every Part, not just the first,
  // or assembly halves silently vanish.
  for (const brick of doc.querySelectorAll('Brick')) {
    const brickDesign = brick.getAttribute('designID');
    for (const partEl of brick.querySelectorAll('Part')) {
      const bones = partEl.querySelectorAll('Bone');
      out.push({
        designID: partEl.getAttribute('designID') ?? brickDesign ?? '3001',
        materialId: parseInt((partEl.getAttribute('materials') ?? '').split(',')[0], 10) || 194,
        // Each Part carries its own Bone(s); the first bone is its placement.
        // (Multiple bones = a flex part's segments — out of scope; first wins,
        // matching prior behaviour, and counted in the diagnostics.)
        transformation: bones[0]?.getAttribute('transformation') ?? '',
        boneCount: bones.length,
      });
    }
  }
  return out;
}

/** `.lxf` → placements + the alignment diagnostics behind them. */
export async function parseLxfWithDiagnostics(
  buffer: ArrayBuffer,
): Promise<{ bricks: ParsedBrick[]; diagnostics: LxfDiagnostics }> {
  // .lxf is a ZIP wrapping IMAGE100.LXFML; a bare .lxfml is the same XML
  // unwrapped (DBIX interactive-instruction dumps ship as .lxfml). Sniff the
  // ZIP magic instead of trusting the extension.
  const head = new Uint8Array(buffer.slice(0, 2));
  const isZip = head[0] === 0x50 && head[1] === 0x4B; // 'PK'
  const xmlBytes = isZip
    ? await extractFile(buffer, 'IMAGE100.LXFML')
    : new Uint8Array(buffer);
  const xmlText = new TextDecoder('utf-8').decode(xmlBytes);

  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) throw new Error(`LXFML parse error: ${parserError.textContent?.slice(0, 120)}`);

  // Both tables in parallel — the measured correction is primary, the
  // ldraw.xml columns are the fallback AND the LDraw filename source.
  const [table, measured] = await Promise.all([loadPartMap(), loadMeasuredAlign()]);
  const result = buildLxfPlacements(readLxfParts(doc), table, measured);
  if (result.bricks.length === 0) throw new Error('No brick placements found in LXFML');
  return result;
}

/** `.lxf` → placements. Diagnostics-free wrapper for callers that don't need them. */
export async function parseLxf(buffer: ArrayBuffer): Promise<ParsedBrick[]> {
  return (await parseLxfWithDiagnostics(buffer)).bricks;
}
