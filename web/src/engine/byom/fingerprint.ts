/**
 * The clean-room similarity core (X-13; BIZ-06 clean room, BIZ-37 official-set screen).
 *
 * One question: HOW SIMILAR is this brick model to that one? It is asked by two callers that share this file:
 *  - `scripts/_cleanroom_check.ts` scores a finished design against the corpus files of the landmark it depicts, so a
 *    second agent can write a `clearance` into the provenance log (the designer never opens the compared file);
 *  - the BYOM screen compares an upload with a database of official-set fingerprints and answers
 *    `clear` / `review` / `blocked`.
 *
 * What is compared (all pure functions of the placements; no DOM, no I/O, no module state):
 *  - INVENTORY  128-hash MinHash over the multiset of `partStem|colour` tokens (the k-th copy of a part in a colour is
 *    its own token, so the estimate is a multiset Jaccard). Survives any rearrangement of the same parts.
 *  - LAYOUT     128-hash MinHash over translation-invariant, position-quantised pair tokens: each part with its 4
 *    nearest neighbours as `stem|stem|dx|dy|dz` (10 / 8 / 10 LDU grid). Colour is left out on purpose: sources map
 *    colours differently, the shape is what a copy keeps. A query is hashed in all 8 yaw/mirror orientations (the
 *    database stores one), so a model turned 90 degrees or mirrored still matches.
 *  - COSINE     of the part-stem histograms (colour-free).
 *  - IoU        of aligned placement cells (20 / 8 / 20 LDU), best of 8 orientations x a vote-chosen shift. This is the
 *    OCCUPANCY of part origins, not a voxelisation of the part meshes: it needs no part library, so it runs in a
 *    Worker and in CI. TODO(fingerprint-voxel-iou): a mesh voxel IoU through `legolize/metrics.ts` for the rare
 *    `review` case a human wants a number for.
 *  - EXACT      `hash12` of the file's bytes equal: the same file.
 *
 * `score` is the larger of INVENTORY and LAYOUT; the others are reported as evidence. Thresholds are measured, not
 * guessed: see `FINGERPRINT_THRESHOLDS` and the calibration in TASKS-BUSINESS.md (`build-official-fingerprints.ts
 * --calibrate` reproduces it).
 */
import { parseLDraw, type ParsedBrick } from '../ldraw-parser.js';
import { partStem } from '../part-id.js';
import { sourceHash12 } from '../pipeline-version.js';
import type { CleanroomResult } from '../../brickgen/types.js';

/** The screen's answer. `review` is a flag for a human, never an automatic pass or fail. */
export type Verdict = 'clear' | 'review' | 'blocked';

/** Signature length: standard error of a Jaccard estimate is sqrt(J(1-J)/128) <= 0.044. */
export const MINHASH_SIZE = 128;

/** Quantisation of layout offsets, LDU: half a stud sideways, one plate high. */
const OFFSET_Q = { x: 10, y: 8, z: 10 } as const;
/** Quantisation of placement cells, LDU: one stud sideways, one plate high. */
const CELL_Q = { x: 20, y: 8, z: 20 } as const;
/** Neighbours per part in a layout token, and how far away one may sit (LDU). */
const LAYOUT_NEIGHBOURS = 4;
const LAYOUT_RADIUS = 80;
/** Bucket edge of the neighbour search (>= the radius would need 1 bucket; 2 buckets each way is exact for 80). */
const BUCKET = 40;

// ---------------------------------------------------------------------------------------------- hashing

/** FNV-1a over UTF-16 code units, then a murmur3 finaliser: a well-mixed 32-bit hash of a token. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return mix32(h);
}

/** murmur3's 32-bit finaliser (a bijection on uint32). */
function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The 128 hash-function seeds: fixed forever (a stored signature is only comparable under the same seeds). */
const SEEDS: Uint32Array = (() => {
  const seeds = new Uint32Array(MINHASH_SIZE);
  let state = 0x9e3779b9;
  for (let i = 0; i < MINHASH_SIZE; i++) { state = mix32(state + 0x9e3779b9); seeds[i] = state; }
  return seeds;
})();

/**
 * MinHash signature of a token SET (duplicates are harmless). An empty set gives all-ones, which estimates 1 against
 * another empty set and ~0 against anything else.
 *
 * @param tokens - the features; callers turn multisets into sets with an occurrence suffix
 */
export function minhash(tokens: Iterable<string>): Uint32Array {
  const signature = new Uint32Array(MINHASH_SIZE).fill(0xffffffff);
  for (const token of tokens) {
    const base = hashToken(token);
    for (let i = 0; i < MINHASH_SIZE; i++) {
      const h = mix32(base ^ SEEDS[i]!);
      if (h < signature[i]!) signature[i] = h;
    }
  }
  return signature;
}

/** The share of equal slots: an unbiased estimate of the Jaccard index of the two token sets. */
export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== MINHASH_SIZE || b.length !== MINHASH_SIZE) throw new Error('signatures must have 128 slots');
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_SIZE;
}

// ---------------------------------------------------------------------------------------------- features

/** One placement reduced to what the fingerprint reads. */
interface Point { stem: string; colour: number; x: number; y: number; z: number }

/** The 8 symmetries of the yaw axis: 4 quarter turns, each with and without a mirror in X. LDraw Y is untouched. */
const ORIENTATIONS: ReadonlyArray<(x: number, z: number) => readonly [number, number]> = [
  (x, z) => [x, z], (x, z) => [-z, x], (x, z) => [-x, -z], (x, z) => [z, -x],
  (x, z) => [-x, z], (x, z) => [-z, -x], (x, z) => [x, -z], (x, z) => [z, x],
];

const toPoints = (bricks: readonly ParsedBrick[]): Point[] =>
  bricks.map((b) => ({ stem: partStem(b.part), colour: b.color, x: b.x, y: b.y, z: b.z }));

/** Multiset of `stem|colour` as set tokens: the k-th copy is `stem|colour#k`. */
function inventoryTokens(points: readonly Point[]): string[] {
  const seen = new Map<string, number>();
  const tokens: string[] = [];
  for (const p of points) {
    const key = `${p.stem}|${p.colour}`;
    const k = (seen.get(key) ?? 0) + 1;
    seen.set(key, k);
    tokens.push(`${key}#${k}`);
  }
  return tokens;
}

/** Spatial bucket key (cell coordinates are small integers, so the product form is collision-free). */
const bucketKey = (bx: number, by: number, bz: number): string => `${bx},${by},${bz}`;

/**
 * Layout tokens of the points under one orientation: every part with its nearest neighbours, as
 * `stem|stem|dx|dy|dz`. Translation-invariant by construction (only offsets are read).
 */
function layoutTokens(points: readonly Point[], orient: (x: number, z: number) => readonly [number, number]): Set<string> {
  const moved = points.map((p) => { const [x, z] = orient(p.x, p.z); return { stem: p.stem, x, y: p.y, z }; });
  const buckets = new Map<string, number[]>();
  moved.forEach((p, i) => {
    const key = bucketKey(Math.floor(p.x / BUCKET), Math.floor(p.y / BUCKET), Math.floor(p.z / BUCKET));
    const list = buckets.get(key);
    if (list) list.push(i); else buckets.set(key, [i]);
  });
  const reach = Math.ceil(LAYOUT_RADIUS / BUCKET);
  const tokens = new Set<string>();
  moved.forEach((p, i) => {
    const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET), bz = Math.floor(p.z / BUCKET);
    const near: Array<{ d2: number; stem: string; dx: number; dy: number; dz: number }> = [];
    for (let ox = -reach; ox <= reach; ox++) for (let oy = -reach; oy <= reach; oy++) for (let oz = -reach; oz <= reach; oz++) {
      for (const j of buckets.get(bucketKey(bx + ox, by + oy, bz + oz)) ?? []) {
        if (j === i) continue;
        const q = moved[j]!;
        const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= LAYOUT_RADIUS * LAYOUT_RADIUS) near.push({ d2, stem: q.stem, dx, dy, dz });
      }
    }
    // Tie-break by (stem, dy, then the unordered |dx|,|dz|): all unchanged by a yaw turn or mirror, so equal-distance
    // neighbours are picked the same way in every orientation.
    near.sort((a, b) => a.d2 - b.d2 || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0) || a.dy - b.dy
      || Math.min(Math.abs(a.dx), Math.abs(a.dz)) - Math.min(Math.abs(b.dx), Math.abs(b.dz)));
    for (const n of near.slice(0, LAYOUT_NEIGHBOURS)) {
      tokens.add(`${p.stem}|${n.stem}|${Math.round(n.dx / OFFSET_Q.x)}|${Math.round(n.dy / OFFSET_Q.y)}|${Math.round(n.dz / OFFSET_Q.z)}`);
    }
  });
  return tokens;
}

/** Cosine of two count maps. */
function cosine(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of Object.entries(a)) { na += v * v; dot += v * (b[k] ?? 0); }
  for (const v of Object.values(b)) nb += v * v;
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------------------------- fingerprints

/** Placement cells of a model, kept only when the caller wants an IoU (a stored database entry drops them). */
export interface PlacementCells {
  /** Distinct stems; `cells` indexes into it. */
  stems: string[];
  /** Flattened `[cx, cy, cz, stemIndex]` per part. */
  cells: Int32Array;
}

export interface Fingerprint {
  /** Placements fingerprinted. */
  count: number;
  /** `sourceHash12` of the file's bytes when known: equal hashes are the same file. */
  hash12?: string;
  /** MinHash of the `stem|colour` multiset. */
  inventory: Uint32Array;
  /**
   * MinHash of the layout tokens: ONE entry (identity orientation) for a stored fingerprint, 8 for a query built with
   * `orientations: true`. `compareFingerprints` takes the best of them.
   */
  layout: Uint32Array[];
  /** Part-stem counts (colour-free), for the cosine. */
  histogram: Record<string, number>;
  /** Present for a freshly built fingerprint; absent after `toStored` / `parseStored`. */
  placement?: PlacementCells;
}

export interface FingerprintOptions {
  /** `sourceHash12` of the bytes, when the caller has them. */
  hash12?: string;
  /** Hash the layout in all 8 orientations (a query). Default false (a database entry). */
  orientations?: boolean;
  /** Keep placement cells for an IoU. Default true. */
  keepPlacement?: boolean;
}

/** Quantise the points to placement cells (x, z yaw-orientation applied by the caller when comparing). */
function placementOf(points: readonly Point[]): PlacementCells {
  const stems: string[] = [];
  const index = new Map<string, number>();
  const cells = new Int32Array(points.length * 4);
  points.forEach((p, i) => {
    let s = index.get(p.stem);
    if (s === undefined) { s = stems.length; stems.push(p.stem); index.set(p.stem, s); }
    cells.set([Math.round(p.x / CELL_Q.x), Math.round(p.y / CELL_Q.y), Math.round(p.z / CELL_Q.z), s], i * 4);
  });
  return { stems, cells };
}

/**
 * Fingerprint parsed placements.
 *
 * @param bricks - from `parseLDraw` / `importModelFile`; MPD sub-models must already be expanded
 */
export function fingerprintBricks(bricks: readonly ParsedBrick[], options: FingerprintOptions = {}): Fingerprint {
  const points = toPoints(bricks);
  const histogram: Record<string, number> = {};
  for (const p of points) histogram[p.stem] = (histogram[p.stem] ?? 0) + 1;
  const orientations = options.orientations ? ORIENTATIONS : ORIENTATIONS.slice(0, 1);
  return {
    count: points.length,
    ...(options.hash12 ? { hash12: options.hash12 } : {}),
    inventory: minhash(inventoryTokens(points)),
    layout: orientations.map((o) => minhash(layoutTokens(points, o))),
    histogram,
    ...(options.keepPlacement === false ? {} : { placement: placementOf(points) }),
  };
}

/** Fingerprint an LDraw / MPD file's bytes (hash12 of the bytes included). */
export function fingerprintLdrawBytes(bytes: Uint8Array, options: Omit<FingerprintOptions, 'hash12'> = {}): Fingerprint {
  return fingerprintBricks(parseLDraw(new TextDecoder().decode(bytes)), { ...options, hash12: sourceHash12(bytes) });
}

// ---------------------------------------------------------------------------------------------- IoU

/** `(cx, cy, cz)` packed into one safe integer: each axis is offset into [0, 4096). */
const packCell = (x: number, y: number, z: number): number => ((x + 2048) * 4096 + (y + 2048)) * 4096 + (z + 2048);

/** Cells of `placement` after an orientation, as `[x, y, z, stem]` arrays of plain numbers. */
function orientedCells(placement: PlacementCells, orient: (x: number, z: number) => readonly [number, number]): number[][] {
  const out: number[][] = [];
  const seen = new Set<number>(); // distinct cells only: two parts in one cell must not count twice in an IoU
  const c = placement.cells;
  for (let i = 0; i < c.length; i += 4) {
    const [x, z] = orient(c[i]!, c[i + 2]!);
    const key = packCell(x, c[i + 1]!, z);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([x, c[i + 1]!, z, c[i + 3]!]);
  }
  return out;
}

/**
 * Best placement-cell IoU of two models over the 8 orientations of `a` and a translation chosen by voting: sampled
 * parts of `a` pair with same-stem parts of `b`, the most voted shifts are scored and the best IoU wins.
 */
export function placementIoU(a: PlacementCells, b: PlacementCells): number {
  const bCells = orientedCells(b, ORIENTATIONS[0]!);
  const bSet = new Set(bCells.map(([x, y, z]) => packCell(x!, y!, z!)));
  const bByStem = new Map<string, number[][]>();
  for (const cell of bCells) {
    const stem = b.stems[cell[3]!]!;
    const list = bByStem.get(stem);
    if (list) list.push(cell); else bByStem.set(stem, [cell]);
  }
  let best = 0;
  for (const orient of ORIENTATIONS) {
    const aCells = orientedCells(a, orient);
    const aSet = new Set(aCells.map(([x, y, z]) => packCell(x!, y!, z!)));
    const votes = new Map<string, number>();
    const stride = Math.max(1, Math.floor(aCells.length / 300));
    for (let i = 0; i < aCells.length; i += stride) {
      const cell = aCells[i]!;
      const matches = bByStem.get(a.stems[cell[3]!]!);
      if (!matches) continue;
      const step = Math.max(1, Math.floor(matches.length / 40));
      for (let j = 0; j < matches.length; j += step) {
        const m = matches[j]!;
        const key = `${m[0]! - cell[0]!},${m[1]! - cell[1]!},${m[2]! - cell[2]!}`;
        votes.set(key, (votes.get(key) ?? 0) + 1);
      }
    }
    const top = [...votes.entries()].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).slice(0, 4);
    for (const [key] of top) {
      const [sx, sy, sz] = key.split(',').map(Number) as [number, number, number];
      let inter = 0;
      for (const [x, y, z] of aCells) if (bSet.has(packCell(x! + sx, y! + sy, z! + sz))) inter++;
      const union = aSet.size + bSet.size - inter;
      if (union > 0) best = Math.max(best, inter / union);
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------- comparison

export interface Similarity {
  /** Multiset-Jaccard estimate of `stem|colour` inventories. */
  inventory: number;
  /** Jaccard estimate of the layout tokens, best orientation. */
  layout: number;
  /** Cosine of colour-free part histograms. */
  cosine: number;
  /** Best aligned placement-cell IoU, or null when either side carries no placement cells. */
  placementIoU: number | null;
  /** True when both files' bytes hash the same. */
  sameFile: boolean;
  /** The verdict number: 1 for the same file, else `max(inventory, layout)`. */
  score: number;
}

/** Compare two fingerprints. Symmetric up to the orientation search (a query with 8 orientations is the stronger side). */
export function compareFingerprints(a: Fingerprint, b: Fingerprint): Similarity {
  const sameFile = a.hash12 !== undefined && a.hash12 === b.hash12;
  const inventory = estimateJaccard(a.inventory, b.inventory);
  let layout = 0;
  for (const la of a.layout) for (const lb of b.layout) layout = Math.max(layout, estimateJaccard(la, lb));
  const iou = a.placement && b.placement ? placementIoU(a.placement, b.placement) : null;
  return {
    inventory, layout, cosine: cosine(a.histogram, b.histogram), placementIoU: iou, sameFile,
    score: sameFile ? 1 : Math.max(inventory, layout),
  };
}

/**
 * The verdict thresholds on `Similarity.score`, MEASURED on the clego corpus and pinned by `test/byom-fingerprint`.
 * `blocked` at or above `block`; `review` at or above `review`. See TASKS-BUSINESS.md for the distributions.
 * TODO(fingerprint-thresholds): re-measure after the official-set database grows beyond the local corpus (U10).
 */
export const FINGERPRINT_THRESHOLDS = { review: 0.2, block: 0.5 } as const;

export interface Thresholds { review: number; block: number }

/** Map a score to a verdict; a same-file match is always blocked. */
export function verdictOf(sim: Pick<Similarity, 'score' | 'sameFile'>, thresholds: Thresholds = FINGERPRINT_THRESHOLDS): Verdict {
  if (sim.sameFile || sim.score >= thresholds.block) return 'blocked';
  return sim.score >= thresholds.review ? 'review' : 'clear';
}

/** One official model in the screen's database (several entries may share a `setId`: one per source file). */
export interface FingerprintEntry {
  /** The set the file belongs to: the unit thresholds are calibrated and reported on. */
  setId: string;
  name?: string;
  /** `sourceHash12` of the file (also in `fingerprint.hash12`). */
  hash12?: string;
  fingerprint: Fingerprint;
}

export interface ScreenMatch { setId: string; name?: string; similarity: Similarity; verdict: Verdict }

export interface ScreenResult {
  verdict: Verdict;
  /** The best match per DISTINCT set, highest score first, only those at `review` or above (max 5). */
  matches: ScreenMatch[];
}

/**
 * Screen a query against the database: the worst verdict over every distinct set wins. Several files of one set count
 * once (their best score), so a set with 9 source files is not nine times as likely to flag.
 */
export function screenAgainst(query: Fingerprint, db: readonly FingerprintEntry[], thresholds: Thresholds = FINGERPRINT_THRESHOLDS): ScreenResult {
  const bestBySet = new Map<string, ScreenMatch>();
  for (const entry of db) {
    const similarity = compareFingerprints(query, entry.fingerprint);
    const prior = bestBySet.get(entry.setId);
    if (!prior || similarity.score > prior.similarity.score) {
      bestBySet.set(entry.setId, {
        setId: entry.setId, ...(entry.name ? { name: entry.name } : {}), similarity, verdict: verdictOf(similarity, thresholds),
      });
    }
  }
  const ranked = [...bestBySet.values()].sort((a, b) => b.similarity.score - a.similarity.score || (a.setId < b.setId ? -1 : 1));
  const flagged = ranked.filter((m) => m.verdict !== 'clear');
  const verdict: Verdict = flagged.some((m) => m.verdict === 'blocked') ? 'blocked' : flagged.length > 0 ? 'review' : 'clear';
  return { verdict, matches: flagged.slice(0, 5) };
}

// ---------------------------------------------------------------------------------------------- storage

/** JSON form of a stored fingerprint (signatures base64, little-endian uint32; no placement cells). */
export interface StoredFingerprint {
  count: number;
  hash12?: string;
  inventory: string;
  layout: string[];
  histogram: Record<string, number>;
}

const toBase64 = (sig: Uint32Array): string => {
  const bytes = new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fromBase64 = (text: string): Uint32Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const sig = new Uint32Array(bytes.buffer);
  if (sig.length !== MINHASH_SIZE) throw new Error(`stored signature has ${sig.length} slots, expected ${MINHASH_SIZE}`);
  return sig;
};

/** The database form: identity-orientation layout only, no placement cells. Little-endian hosts only (all of ours). */
export function toStored(fp: Fingerprint): StoredFingerprint {
  return {
    count: fp.count, ...(fp.hash12 ? { hash12: fp.hash12 } : {}),
    inventory: toBase64(fp.inventory), layout: [toBase64(fp.layout[0]!)], histogram: fp.histogram,
  };
}

/** Inverse of `toStored`. */
export function parseStored(stored: StoredFingerprint): Fingerprint {
  return {
    count: stored.count, ...(stored.hash12 ? { hash12: stored.hash12 } : {}),
    inventory: fromBase64(stored.inventory), layout: stored.layout.map(fromBase64), histogram: stored.histogram,
  };
}

// ---------------------------------------------------------------------------------------------- clean room

/** The slice of the models index the denylist reads. */
export interface DenylistIndex {
  sets: Record<string, { name: string; models: Array<{ src: string; path: string }> }>;
}

export interface DenylistEntry { setId: string; name: string; paths: string[] }

/** Lower-case letters and digits only, so "Notre-Dame de Paris" contains "notre dame". */
const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Every set whose name contains ANY keyword (case, spaces and punctuation ignored), with every corpus path the index
 * lists for it. The clean-room brief gives a designer this list as "never open".
 */
export function matchDenylist(index: DenylistIndex, keywords: readonly string[]): DenylistEntry[] {
  const needles = keywords.map(squash).filter((k) => k.length > 0);
  return Object.entries(index.sets)
    .filter(([, set]) => needles.some((needle) => squash(set.name).includes(needle)))
    .map(([setId, set]) => ({ setId, name: set.name, paths: set.models.map((m) => m.path) }))
    .sort((a, b) => (a.setId < b.setId ? -1 : 1));
}

/**
 * The `CleanroomResult` row of a provenance log for one comparison. The compared path is stored HASHED so the log a
 * designer may read does not name the file; `partHistogramCosine` and `alignedVoxelIoU` are the contract's field names
 * (the IoU is the placement-cell IoU, 0 when no cells were available). A blocked or review verdict reads `review`: a
 * flag for the user and a lawyer, never an automatic fail.
 */
export function cleanroomResult(sim: Similarity, corpusPath: string, by: string, at: string): CleanroomResult {
  return {
    checkedAgainst: sourceHash12(new TextEncoder().encode(corpusPath.replace(/\\/g, '/'))),
    partHistogramCosine: sim.cosine,
    alignedVoxelIoU: sim.placementIoU ?? 0,
    verdict: verdictOf(sim) === 'clear' ? 'independent' : 'review',
    by, at,
  };
}
