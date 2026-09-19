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
 * TWO correction tables and ONE slot rule, and the ORDER matters:
 *
 *  a. `/ldd-part-map.json` — BrickLink Studio's own `ldraw.xml` correction
 *     columns (axis-angle + translation in LDD units), the PRIMARY correction
 *     and the source of the LDraw FILENAME for a design (60583 → 60583b.dat).
 *     The row describes the transform that carries the LDRAW origin onto the
 *     LDD origin, so placing an LDD part in LDraw applies its INVERSE.
 *  b. `/ldd-measured-align.json` — clego's MEASURED per-design correction,
 *     voted from 207 sets that have both an LXFML dump and an authentic Studio
 *     `.io` (scripts/gen-ldd-measured-align.py; clego DBIX_SOLVER.md §4/§9),
 *     the FALLBACK for designs Studio's table does not name. Its correction is
 *     already in LDU and already in the FLIPPED LDraw basis, so it composes
 *     post-flip; it is quantised (1/20 rotations, 1 LDU), so it is less exact.
 *  c. `MINIDOLL_SLOT_CORRECTION` — the mini-doll (LEGO Friends) skeleton, which
 *     NEITHER table covers: the measured table has no doll row (no ground-truth
 *     set contains a mini-doll) and every doll row `ldraw.xml` has is all-zero,
 *     so a doll used to be emitted at its raw LDD bone with a broken skeleton.
 *     It applies AFTER the two tables and only where they correct NOTHING, so
 *     the filename ladder is unchanged and a part with a real row is untouched.
 *     Keyed by SLOT, not by part id — see the block above the table.
 *
 * Measured with `scripts/lxf_gt_eval.py` over EVERY native `.lxf` in clego
 * whose set has an authentic (non-laundered) Studio `.io` — 91 files, none of
 * them the DBIX dumps the measured table was learned from — scored by clego's
 * `dbix_gt_compare` (GEO = the part's world-space geometry matches within 3 LDU;
 * exact = same pose within 1.5 LDU). 10242 Mini Cooper, 1,076 parts:
 *
 *     ldraw.xml columns applied FORWARD    (shipped until 2026-09-17)   13.3 % GEO
 *     MEASURED table                        (shipped 2026-09-09..17)     89.3 % GEO / 74.4 % exact
 *     ldraw.xml columns applied as INVERSE  (this file)                  93.6 % GEO / 93.2 % exact
 *     no per-part correction at all         (control)                     8.6 % GEO
 *
 * The 2026-09-09 note that "the ldraw.xml columns do not reproduce Studio's
 * own placements" was wrong: they reproduce them almost exactly once they are
 * applied in the right DIRECTION. The measured table stays as the fallback
 * because it names 1,841 designs and the ldraw.xml 4,467; a design in neither
 * is placed at its raw LDD origin. The whole-cohort numbers for each path are
 * in `docs/lego-renderer-guide.md` (LXF section).
 *
 * THE CHANGE OF BASIS. `F = diag(1,-1,1)` has det = -1: it is a REFLECTION, so
 * it mirrors the whole model and lands every chiral part (slopes, wedges, curved
 * shells) in a physically wrong slot. LDD (Y-up) and LDraw (Y-down) are BOTH
 * right-handed, so the map between them is a 180° rotation about X:
 *
 *     F = diag(1, -1, -1)        det = +1
 *
 * Final per-part transform:
 *   ldraw.xml R_world = F·(R_bone·R_alignᵀ)·F,  t_world = 25·F·(t_bone − R_bone·R_alignᵀ·t_align)
 *   measured  R_world = (F·R_bone·F)·D,         t_world = 25·(F·t_bone) + (F·R_bone·F)·e
 */

import { extractFile, extractMatching } from './zip-utils';
import { lddToLDraw } from './ldd-colors';
import type { ParsedBrick } from './ldraw-parser';
import { MINIDOLL_SLOTS } from './minidoll-slots-generated.js';
import type { MiniDollSlot } from './minifig-rig.js';

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

/** Where Studio's ldraw.xml table lives (scripts/gen-ldd-part-map.py). */
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
  /** Studio's ldraw.xml table — the primary correction and the source of LDraw filenames. */
  table: LxfTableReport;
  /** clego's measured table — the fallback for designs Studio's table does not name. */
  measured: LxfTableReport;
  /** placements positioned through the MEASURED fallback correction. */
  measuredPlacements: number;
  /** placements positioned through Studio's (inverse) ldraw.xml correction. */
  mappedPlacements: number;
  /**
   * placements re-positioned by the MINI-DOLL slot correction — an OVERLAY on
   * the three counts above, not a fourth bucket: the LDraw filename still came
   * from whichever table named the design, only the correction was replaced.
   */
  miniDollPlacements: number;
  /**
   * mini-doll placements LEFT to their table row because the row that placed
   * them carries a real (non-identity) correction. With the shipped tables this
   * is 13 placements over clego's 2,302 LXFML dumps, all of design `80911`
   * (`bl_80911.dat`, a doll hair) whose MEASURED row is (1085, 23, -310) LDU —
   * a bad learned vote, not an authored doll row. A large value means a table
   * now authors doll corrections and this rule should be retired.
   */
  miniDollDeferredToTable: number;
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

/** Studio's ldraw.xml table (~232 KB) — the primary alignment and the source of LDraw filenames. */
export function loadPartMap(): Promise<LxfAlignmentTable> {
  return loadTable(PART_MAP_URL, validatePartAlign);
}

/** clego's MEASURED per-design correction (~145 KB) — the fallback alignment. */
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

/** Transpose of a 3×3 row-major matrix (the inverse of a rotation). */
function transpose3(m: number[]): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

/**
 * The `ldraw.xml`-column path (issue #108), the PRIMARY correction since
 * 2026-09-17: compose the LDD bone transform with the INVERSE of Studio's
 * per-part alignment IN LDD SPACE, then change basis. Pure — no DOM / fetch /
 * ZIP.
 *
 * Studio's row `(R_align, t_align)` is the rigid transform that carries the
 * LDraw part's origin onto the LDD part's origin (it is how Studio takes an
 * LDraw part INTO an LDD scene). Placing an LDD part in LDraw is the other
 * direction, so the inverse `(R_alignᵀ, −R_alignᵀ·t_align)` is what composes
 * with the bone:
 *
 *   R_world = R_bone · R_alignᵀ,  t_world = t_bone − R_bone · R_alignᵀ · t_align   (LDD)
 *   rot = F·R_world·F,  pos = 25·(F·t_world),  F = diag(FRAME_SIGN)
 *
 * Applied FORWARD (what shipped until 2026-09-17) the same columns scored
 * 13.3 % GEO on 10242 against 93.6 % applied as the inverse — see the module
 * header. `align` undefined → identity (bare `designID.dat` fallback caller-side).
 */
export function composeLxfPlacement(
  rBone: number[],
  tBone: [number, number, number],
  align: PartAlign | undefined,
): LxfPlacement {
  const tAlign: [number, number, number] = align ? [align[1], align[2], align[3]] : [0, 0, 0];
  const rAlignInv = align
    ? transpose3(axisAngleToMatrix(align[4], align[5], align[6], align[7]))
    : [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const rWorld = mul3(rBone, rAlignInv);
  // t_world = t_bone − R_world · t_align  (R_world = R_bone · R_alignᵀ)
  const rotated = mulVec(rWorld, tAlign);
  const [sx, sy, sz] = FRAME_SIGN;
  return {
    rot: conjugateFrame(rWorld),
    x: sx * (tBone[0] - rotated[0]) * CM_TO_LDU,
    y: sy * (tBone[1] - rotated[1]) * CM_TO_LDU,
    z: sz * (tBone[2] - rotated[2]) * CM_TO_LDU,
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
 * other side of the change of basis. The FALLBACK since 2026-09-17 for designs
 * Studio's `ldraw.xml` does not name: its votes are quantised, so it is less
 * exact than the inverse ldraw.xml columns (see the module header).
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
 * THE MINI-DOLL SLOT CORRECTION — the THIRD case, for the moulds NEITHER table
 * covers (clego `dbix_figure_align.py`, `DBIX_SOLVER.md` §11).
 *
 * A LEGO Friends mini-doll used to render with a broken skeleton: hips at the
 * torso's own origin, head 50 LDU up instead of 33.20, arms at 20 instead of
 * 11.00. It is a MISSING correction, not a wrong one — every mini-doll part
 * resolved with no row at all and was emitted at its raw LDD bone:
 *
 *  * the MEASURED table has zero mini-doll rows and always will: none of the
 *    173 ground-truth sets it is voted from contains a mini-doll torso, so the
 *    learner never saw one;
 *  * Studio's `ldraw.xml` names five doll moulds in the shipped table (`20380`,
 *    `21630`, `21634`, `25727` legs and `88286` hair) and EVERY one of them is
 *    an all-zero row — an identity correction, which is exactly the bug.
 *
 * LDD's origin convention for these moulds is not LDraw's: LDD gives the torso
 * and the hips the SAME bone (its torso origin is the waist plane), which is
 * why `torso → hips` measured 0.00. The difference is a per-mould constant, so
 * it is an origin correction like any other.
 *
 * MEASURED ON BOTH SIDES, nothing fitted (clego §11.2): (A) the LDraw library's
 * own 145 mini-doll composites, flattened with `~Moved to` stubs followed, give
 * each slot's offset from the plain torso with a p10–p90 spread of 0.0; (B) the
 * modal offset from the torso bone over the LDD corpus. `A − B` is the
 * correction up to one rigid constant, and that constant is measured too: the
 * legs is the part LDD places on the model (its bone lands on the model's own
 * 8 LDU plate / 20 LDU stud grid in 82 % / 84 % of 360 figures while no other
 * slot does, and the LDraw legs part's `hi.y` IS the sole plane), so the legs
 * carries the whole 10.01 LDU in x — one mini-doll foot's axis (`s/92251s03`
 * is centred at x = 9.95) — and nothing in y or z.
 *
 * The four joints this reproduces are the authentic ones to 0.02 LDU: torso →
 * head 33.20, torso → arm 11.00, torso → plain hips 29.42, hips → legs 47.48.
 * They share NOTHING with the minifig's 24 / 18 / 32, which is why the minifig
 * rig's numbers must never be reused for a doll.
 *
 * NOT corrected, deliberately: `doll_hips_legs` (LDD emits a hips and a legs,
 * never the composite), `doll_torso_arms` (a different mould, 12.8 LDU below
 * the plain torso, that LDD likewise never emits) and `doll_body` (the
 * one-piece baby/micro-doll body — the library has no composite that places
 * one, so there is nothing to measure). A slot with no row here is left alone.
 */
export const MINIDOLL_SLOT_CORRECTION: Readonly<Partial<Record<MiniDollSlot, readonly [number, number, number]>>> = {
  doll_leg: [10.01, 0.00, 0.00],    // LDD's origin is on one foot's axis
  doll_torso: [0.00, -19.09, 1.72], // LDD's origin is the waist plane
  doll_hips: [0.01, 10.33, 2.83],   // LDD gives the hips the torso's bone
  doll_arm: [0.00, -2.26, 0.94],
  doll_head: [0.00, -2.24, 3.28],
  doll_hair: [0.00, -2.29, 0.28],
};

/** `parts/92198p01.dat` → `92198p01`. */
const stemOfPart = (part: string): string =>
  part.replace(/^.*[\\/]/, '').replace(/\.dat$/i, '').toLowerCase();

/**
 * The mini-doll SLOT of an LDraw part, or null for everything that is not a
 * mini-doll mould (which is every other part in the library).
 *
 * The SLOT comes from `minidoll-slots-generated.ts`, which is this repo's own
 * description classifier (`classifyMiniDollPart`) run over the LDraw library at
 * build time — keying by slot and not by part id is what covers the 13 LDD legs
 * moulds and 5 torso moulds the reference library has no composite for.
 *
 * An unknown PRINT of a known mould falls back to the unprinted mould
 * (`92198p99` → `92198`); an unknown COMPOSITE never does, because a composite
 * is a different mould with a different origin (`92241p03c01` is the torso WITH
 * ARMS, 12.8 LDU lower) and inheriting the plain mould's correction would move
 * it wrongly.
 */
export function miniDollSlotOf(part: string): MiniDollSlot | null {
  const stem = stemOfPart(part);
  // `92198p99` → `92198` (an unknown print of a known mould), but
  // `92241p99c01` → `92241c01` and NOT `92241`: the composite suffix is kept so
  // an unknown composite falls out of the table instead of inheriting the plain
  // mould's slot.
  const unprinted = stem.replace(/^([0-9]+[a-z]?)p[0-9a-z]*?(c[0-9]+)?$/, '$1$2');
  return MINIDOLL_SLOTS[stem] ?? MINIDOLL_SLOTS[unprinted] ?? null;
}

/** The correction for a part's slot, or null when the slot has none (see above). */
export function miniDollCorrectionFor(part: string): readonly [number, number, number] | null {
  const slot = miniDollSlotOf(part);
  return (slot && MINIDOLL_SLOT_CORRECTION[slot]) ?? null;
}

/**
 * The mini-doll path: no rotation correction (`D = I`, the LDD bone's rotation
 * is already right — the defect is purely the origin), the slot's `e` applied
 * on the LDraw side exactly as the measured path applies its own.
 */
export function composeLxfMiniDoll(
  rBone: number[],
  tBone: [number, number, number],
  e: readonly [number, number, number],
): LxfPlacement {
  const rLdr = conjugateFrame(rBone);
  const offset = mulVec(rLdr, [e[0], e[1], e[2]]);
  const [sx, sy, sz] = FRAME_SIGN;
  return {
    rot: rLdr,
    x: sx * tBone[0] * CM_TO_LDU + offset[0],
    y: sy * tBone[1] * CM_TO_LDU + offset[1],
    z: sz * tBone[2] * CM_TO_LDU + offset[2],
  };
}

/** A `ldraw.xml` row that corrects nothing: no translation and no rotation. */
export function isIdentityPartAlign(a: PartAlign | undefined): boolean {
  if (!a) return true;
  const zeroT = Math.abs(a[1]) < 1e-6 && Math.abs(a[2]) < 1e-6 && Math.abs(a[3]) < 1e-6;
  const zeroR = Math.abs(a[4]) < 1e-9 || Math.hypot(a[5], a[6], a[7]) < 1e-9;
  return zeroT && zeroR;
}

/** A measured row that corrects nothing: zero offset and an identity rotation. */
export function isIdentityMeasuredAlign(m: MeasuredAlign | undefined): boolean {
  if (!m) return true;
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // `slice` because a computed index into the tuple type widens to `string | number`.
  const d = m.slice(1, 10) as number[];
  for (let i = 0; i < 9; i++) if (Math.abs(d[i]! - identity[i]!) > 1e-6) return false;
  return Math.abs(m[10]) < 1e-6 && Math.abs(m[11]) < 1e-6 && Math.abs(m[12]) < 1e-6;
}

export interface LxfPlacementOptions {
  /**
   * Apply the mini-doll slot correction (default true). `false` reproduces the
   * pre-fix placements exactly, which is what a before/after measurement needs
   * — the same A/B switch as clego's `DBIX_FIGURE_ALIGN=0`.
   */
  miniDoll?: boolean;
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
  options: LxfPlacementOptions = {},
): { bricks: ParsedBrick[]; diagnostics: LxfDiagnostics } {
  const correctMiniDoll = options.miniDoll !== false;
  const bricks: ParsedBrick[] = [];
  const unmapped = new Map<string, number>();
  let measuredPlacements = 0;
  let mappedPlacements = 0;
  let unmappedPlacements = 0;
  let skippedNoBone = 0;
  let skippedBadTransform = 0;
  let multiBoneParts = 0;
  let miniDollPlacements = 0;
  let miniDollDeferredToTable = 0;

  for (const rec of records) {
    if (rec.boneCount > 1) multiBoneParts++;
    if (!rec.transformation) { skippedNoBone++; continue; }
    const boneT = parseBoneTransform(rec.transformation);
    if (!boneT) { skippedBadTransform++; continue; }

    // Studio's ldraw.xml columns first (applied as the inverse they are — see
    // the module header), then clego's measured correction for a design Studio
    // does not name, then a bare designID.dat at identity for a design neither
    // table names.
    const align = table.entries[rec.designID];
    const meas = measured.entries[rec.designID];
    let part: string;
    let placement: LxfPlacement;
    if (align) {
      mappedPlacements++;
      part = align[0];
      placement = composeLxfPlacement(boneT.rBone, boneT.tBone, align);
    } else if (meas) {
      measuredPlacements++;
      part = meas[0];
      placement = composeLxfMeasured(boneT.rBone, boneT.tBone, meas);
    } else {
      unmappedPlacements++;
      unmapped.set(rec.designID, (unmapped.get(rec.designID) ?? 0) + 1);
      part = `${rec.designID}.dat`;
      placement = composeLxfPlacement(boneT.rBone, boneT.tBone, undefined);
    }

    // THE THIRD CASE: a mini-doll mould, which neither table corrects. The
    // FILENAME still comes from the ladder above (Studio's table is what turns
    // design `21630` into `92250.dat`); only the CORRECTION is replaced, and
    // only when the row that named the file corrects nothing — a part with a
    // real `ldraw.xml` or measured row keeps it, so nothing outside the doll
    // moulds can move and an authored doll row would win if one ever appears.
    if (correctMiniDoll) {
      const e = miniDollCorrectionFor(part);
      if (e) {
        // The test is on the row that ACTUALLY placed this part, not on both:
        // `88286` (a doll hair) has an identity `ldraw.xml` row — which wins and
        // is what the placement above used — plus a measured row of
        // (967, 0, -470) LDU that nothing applies. Requiring both to be identity
        // deferred 13 corpus placements to a row the loader never reads.
        if (align ? isIdentityPartAlign(align) : isIdentityMeasuredAlign(meas)) {
          miniDollPlacements++;
          placement = composeLxfMiniDoll(boneT.rBone, boneT.tBone, e);
        } else {
          miniDollDeferredToTable++;
        }
      }
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
      miniDollPlacements,
      miniDollDeferredToTable,
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
  if (d.table.state !== 'ok') {
    // The exact table is gone but the measured fallback is not: the model
    // still renders, less exactly. Say so rather than imply it is fine.
    parts.push(
      `Studio ldraw.xml alignment table unavailable (${d.table.error ?? 'unknown'}) — ` +
      'falling back to the measured LDD alignment, which places parts less ' +
      'exactly. Reload to retry',
    );
  } else if (d.measured.state !== 'ok') {
    parts.push(
      `measured fallback alignment table unavailable (${d.measured.error ?? 'unknown'}) — designs ` +
      'outside Studio\'s ldraw.xml are placed at their raw LDD origin. Reload to retry',
    );
  } else if (total > 0 && d.measuredPlacements > 0) {
    const pct = (100 * d.mappedPlacements) / total;
    parts.push(
      `${d.mappedPlacements} of ${total} placements (${pct.toFixed(1)}%) use Studio's ` +
      `exact ldraw.xml alignment; ${d.measuredPlacements} fall back to the measured ` +
      'LDD alignment, which is less exact',
    );
  }
  if (d.unmappedPlacements > 0 && total > 0) {
    parts.push(
      `${d.unmappedPlacements} placements (${d.unmappedDesignIds.length} design ` +
      `id${d.unmappedDesignIds.length === 1 ? '' : 's'}) have no LDD→LDraw alignment ` +
      'entry at all and use their raw LDD origin',
    );
  }
  if (d.miniDollDeferredToTable > 0) {
    // The rule is written to lose to an authored row; say so when it does,
    // because that means the doll correction below is now dead code for those
    // moulds and the table is answering for them instead.
    parts.push(
      `${d.miniDollDeferredToTable} mini-doll placements kept their table row ` +
      'instead of the measured slot correction, so their skeleton may still be wrong',
    );
  }
  if (d.skippedBadTransform > 0) parts.push(`${d.skippedBadTransform} malformed bone transforms skipped`);
  if (d.skippedNoBone > 0) parts.push(`${d.skippedNoBone} parts with no bone skipped`);
  return parts.length ? `LDD .lxf: ${parts.join('; ')}` : null;
}

/**
 * The design id a `<Brick>`/`<Part>` names, without LDD's mould-VARIANT suffix.
 *
 * LDD writes `designID="1006030;I"` in the LXFML its own dumps carry (4,111 of
 * 41732's ids have one); the letter after the `;` is the mould variant, and no
 * table is keyed by it. Passing it through verbatim missed BOTH alignment
 * tables and asked the library for `1006030;I.dat`, so every part of such a
 * file rendered at its raw LDD origin with no geometry at all — the model came
 * up empty ("37 pieces of 13 part types not in library", 0×0 studs). clego's
 * converter and `scripts/lxf_gt_eval.py` have always split here; the loader
 * did not. Native `.lxf` files written by LDD itself carry no suffix, which is
 * why the whole native corpus never showed it.
 */
export function normalizeDesignId(raw: string | null | undefined, fallback = '3001'): string {
  const id = (raw ?? '').split(';')[0]!.trim();
  return id === '' ? fallback : id;
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
        designID: normalizeDesignId(partEl.getAttribute('designID')?.trim() || brickDesign),
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
  let xmlBytes: Uint8Array;
  if (isZip) {
    try {
      xmlBytes = new Uint8Array(await extractFile(buffer, 'IMAGE100.LXFML'));
    } catch {
      // Fallback: search for any .lxfml entry in the archive
      const matching = await extractMatching(buffer, name => /\.lxfml$/i.test(name));
      const first = matching.values().next().value;
      if (first) {
        xmlBytes = new Uint8Array(first);
      } else {
        throw new Error('No LXFML file found in LXF archive');
      }
    }
  } else {
    xmlBytes = new Uint8Array(buffer);
  }
  const xmlText = new TextDecoder('utf-8').decode(xmlBytes);

  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) throw new Error(`LXFML parse error: ${parserError.textContent?.slice(0, 120)}`);

  // Both tables in parallel — Studio's ldraw.xml columns are primary (and the
  // LDraw filename source), the measured correction is the fallback.
  const [table, measured] = await Promise.all([loadPartMap(), loadMeasuredAlign()]);
  const result = buildLxfPlacements(readLxfParts(doc), table, measured);
  if (result.bricks.length === 0) throw new Error('No brick placements found in LXFML');
  return result;
}

/** `.lxf` → placements. Diagnostics-free wrapper for callers that don't need them. */
export async function parseLxf(buffer: ArrayBuffer): Promise<ParsedBrick[]> {
  return (await parseLxfWithDiagnostics(buffer)).bricks;
}
