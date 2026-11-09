/**
 * Marketplace budget gate: the pure part (M06, BIZ-25; plan A section 7.6).
 *
 * `scripts/_marketplace_budget.ts` measures a built pack and hands the numbers here. This module owns
 *   - the budget TIERS, as data (one `standard` tier until the user answers U17; add a tier = add a record);
 *   - the platform limits Microsoft sets whatever the tier (size, files, permutations, texture sizes);
 *   - the static measures read from the pack's files (size, file count, block permutations, texture sizes, the
 *     cuboids each entity type's geometry ships);
 *   - `evaluateBudget`, which sets measures against a tier and returns a typed, JSON-serialisable report.
 *
 * Nothing here runs the simulator: the runtime numbers (live entities and cuboids after a placement, script ms
 * per tick) arrive as a `RuntimeMeasure` the script built from `web/src/sim`.
 */

/** One file of a pack, as `listZipEntries` / `extractFile` produce it. */
export interface BudgetFile { name: string; data: Uint8Array }

/** Where one tier limit came from. `source` names a file and, where it helps, the measurement. */
export interface TierEvidence { limit: string; source: string }

/** The per-tier numbers. Every limit carries the evidence it was derived from (`evidence`). */
export interface BudgetTier {
  id: string;
  label: string;
  /** Cuboids of every geometry the pack ships (definition side: the unit the phone's heap pays for). */
  maxResidentCuboids: number;
  /** Cuboids drawn at once by the entities a placement leaves in the world (instances x their geometry). */
  maxPlacedCuboids: number;
  /** Live entities a placement leaves in the world. */
  maxResidentEntities: number;
  /** Median script time per tick, host (Bun) ms. */
  maxScriptMsMedian: number;
  /** Uncompressed pack bytes. */
  maxUncompressedBytes: number;
  evidence: TierEvidence[];
}

/**
 * The tiers. ONE until the user answers U17 (docs/plans/README.md); a `low` / `high` tier is another record here
 * (plan A 7.6 proposes 30k / 60 / 2 ms / 15 MB and 120k / 200 / 6 ms) and needs its own evidence before it is added.
 *
 * TODO(m06-tiers): tiers other than `standard` wait for U17 and a Pixel/Saga measurement of a pack at each size.
 */
export const BUDGET_TIERS: Readonly<Record<string, BudgetTier>> = {
  standard: {
    id: 'standard',
    label: 'Standard: a Pixel 8 Pro / Saga class phone with other packs bound',
    maxResidentCuboids: 60_000,
    maxPlacedCuboids: 100_000,
    maxResidentEntities: 120,
    maxScriptMsMedian: 4,
    maxUncompressedBytes: 25 * 1024 * 1024,
    evidence: [
      {
        limit: 'maxResidentCuboids 60,000',
        source: 'The phone survived 487,856 cuboids summed over all bound packs at 60 fps (DEVICE_CUBOID_BUDGET 480,000, playable-addon.ts; '
          + 'output/device-919/ceiling/CEILING.md, Pixel 8 Pro 2026-09-19); 480,000 / 60,000 = 8 packs of this size fit. Heap = 739 MB + 3.08 kB per cuboid '
          + '(same comment): 60k is ~185 MB. 10303 default is ~62k (TASKS-BEDROCK-ADDON.md PIXEL MEMORY, round 30zu), so it sits 3 % over.',
      },
      {
        limit: 'maxPlacedCuboids 100,000',
        source: 'Cuboids drawn at once: "~50-100k visible hold 60 fps, ~150k hold 30" (DEVICE_CUBOID_BUDGET comment, playable-addon.ts). The top of the 60 fps range.',
      },
      {
        limit: 'maxResidentEntities 120',
        source: 'docs/bedrock-addon-guide.md entity-count table (Pixel): 500 idle entities cost +0 % frame time, 2,000 cost +100 %, 6,000 +600-800 %; '
          + '38.5-47.9 kB native heap each. 120 is a quarter of the largest count with no frame cost, leaving room for other packs; 120 x 40 kB is ~5 MB.',
      },
      {
        limit: 'maxScriptMsMedian 4',
        source: 'CLAUDE.md "A native call is not free": 26 packs bound took a median 24 ms of the 50 ms tick; after the shared roster the Saga median was 8.6 ms '
          + '(TASKS-BEDROCK-ADDON.md PIN-02), ~0.33 ms a pack. quirks/cost.ts TICK_BUDGET_WARN_MS is 25 ms: 4 ms a pack leaves room for six packs under it. '
          + 'The gate reads HOST (Bun) ms from the sim, not phone ms (no host/phone ratio is measured): TODO(m06-calibrate).',
      },
      {
        limit: 'maxUncompressedBytes 25 MiB',
        source: 'Microsoft Marketplace guideline of 25 MB uncompressed (plan A 7.6; RELEASE_MAX_BYTES in scripts/_mcaddon_check.py).',
      },
    ],
  },
};

/** The tier used when none is named. */
export const DEFAULT_TIER_ID = 'standard';

/** A tier by id; throws naming the known ids, so a typo on the command line is explained. */
export function tierById(id: string, tiers: Readonly<Record<string, BudgetTier>> = BUDGET_TIERS): BudgetTier {
  const t = tiers[id];
  if (!t) throw new Error(`unknown budget tier ${JSON.stringify(id)}; known: ${Object.keys(tiers).join(', ')}`);
  return t;
}

/** Limits Microsoft sets whatever the tier (same numbers as RELEASE_* in scripts/_mcaddon_check.py). */
export const PLATFORM_LIMITS = {
  maxFiles: 3_500,
  maxPermutations: 10_000,
  /** Texture folders `textures/blocks` and `textures/items`. */
  maxBlockTexturePx: 256,
  maxItemTexturePx: 256,
  /** Every other texture folder. */
  maxOtherTexturePx: 2_048,
} as const;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** How many values a block state declares: a list, or a `{ values: { min, max } }` range (as _mcaddon_check.py reads it). */
function stateValueCount(def: unknown): number {
  const vals = Array.isArray(def) ? def : asRecord(def)['values'] ?? def;
  if (Array.isArray(vals)) return vals.length;
  const r = asRecord(vals);
  if (typeof r['min'] === 'number' && typeof r['max'] === 'number') return r['max'] - r['min'] + 1;
  return 0;
}

export interface BlockPermutations { path: string; identifier: string; permutations: number }

/** Registered permutations of each custom block (the product of its state value counts, at least 1) and their sum. */
export function countBlockPermutations(blocks: ReadonlyArray<{ path: string; json: unknown }>): { total: number; blocks: BlockPermutations[] } {
  const out: BlockPermutations[] = [];
  for (const { path, json } of blocks) {
    const blk = asRecord(asRecord(json)['minecraft:block']);
    if (!Object.keys(blk).length) continue;
    const description = asRecord(blk['description']);
    let permutations = 1;
    for (const def of Object.values(asRecord(description['states']))) permutations *= Math.max(1, stateValueCount(def));
    out.push({ path, identifier: String(description['identifier'] ?? ''), permutations });
  }
  return { total: out.reduce((s, b) => s + b.permutations, 0), blocks: out };
}

/**
 * Cuboids per geometry id in one geometry file: the 1.12+ `minecraft:geometry` array, or the legacy
 * `geometry.<id>` top-level keys. Only `cubes` count (poly_mesh geometry does not occur in craftmatic packs).
 */
export function cuboidsOfGeometry(json: unknown): Record<string, number> {
  const root = asRecord(json);
  const bonesCubes = (bones: unknown): number => (Array.isArray(bones) ? bones : [])
    .reduce<number>((s, b) => s + (Array.isArray(asRecord(b)['cubes']) ? (asRecord(b)['cubes'] as unknown[]).length : 0), 0);
  const out: Record<string, number> = {};
  const modern = root['minecraft:geometry'];
  if (Array.isArray(modern)) {
    for (const g of modern) {
      const id = asRecord(asRecord(g)['description'])['identifier'];
      if (typeof id === 'string') out[id] = bonesCubes(asRecord(g)['bones']);
    }
  }
  for (const [k, v] of Object.entries(root)) if (k.startsWith('geometry.')) out[k] = bonesCubes(asRecord(v)['bones']);
  return out;
}

const dec = new TextDecoder();
/** Parse a JSON file's bytes (BOM tolerated); undefined when it is not JSON. */
function parseJson(f: BudgetFile): unknown {
  try { return JSON.parse(dec.decode(f.data).replace(/^﻿/, '')); } catch { return undefined; }
}

/** Every `.json` file of the pack, parsed, that satisfies `pick`. */
function jsonFiles(files: readonly BudgetFile[], pick: (name: string) => boolean): Array<{ path: string; json: unknown }> {
  return files.filter(f => f.name.endsWith('.json') && pick(f.name)).flatMap(f => { const json = parseJson(f); return json === undefined ? [] : [{ path: f.name, json }]; });
}

/** Cuboids of every geometry id the pack defines. */
function geometryTable(files: readonly BudgetFile[]): Map<string, number> {
  const table = new Map<string, number>();
  for (const { json } of jsonFiles(files, n => /\.geo\.json$/.test(n) || /(^|\/)models\//.test(n))) {
    for (const [id, n] of Object.entries(cuboidsOfGeometry(json))) table.set(id, n);
  }
  return table;
}

/**
 * Cuboids a client entity type draws: the sum over the DISTINCT geometries its `description.geometry` names (a
 * size-group or LOD variant is a geometry the entity keeps resident). A geometry the pack does not define counts 0.
 */
export function entityGeometryCubes(files: readonly BudgetFile[]): Map<string, number> {
  const geos = geometryTable(files);
  const out = new Map<string, number>();
  for (const { json } of jsonFiles(files, n => /(^|\/)entity\//.test(n))) {
    const d = asRecord(asRecord(asRecord(json)['minecraft:client_entity'])['description']);
    if (typeof d['identifier'] !== 'string') continue;
    const names = new Set(Object.values(asRecord(d['geometry'])).filter((v): v is string => typeof v === 'string'));
    out.set(d['identifier'], [...names].reduce((s, g) => s + (geos.get(g) ?? 0), 0));
  }
  return out;
}

/** An image's pixel size from its header: PNG (IHDR) or uncompressed/RLE TGA; undefined for anything else. */
export function imageSize(data: Uint8Array): { width: number; height: number } | undefined {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const isPng = data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  if (isPng) return { width: v.getUint32(16), height: v.getUint32(20) };
  // TGA has no magic; accept the standard image types with a plausible header.
  if (data.length >= 18 && [1, 2, 3, 9, 10, 11].includes(data[2]!)) return { width: v.getUint16(12, true), height: v.getUint16(14, true) };
  return undefined;
}

/** The size limit for a texture path (`textures/blocks`, `textures/items`, else the default). */
export function textureLimitPx(path: string): number {
  if (/(^|\/)textures\/blocks\//.test(path)) return PLATFORM_LIMITS.maxBlockTexturePx;
  if (/(^|\/)textures\/items\//.test(path)) return PLATFORM_LIMITS.maxItemTexturePx;
  return PLATFORM_LIMITS.maxOtherTexturePx;
}

/** What the files alone say (no simulator). */
export interface StaticMeasure {
  uncompressedBytes: number;
  fileCount: number;
  /** Registered block permutations summed over every custom block. */
  permutations: number;
  /** Custom blocks defined. */
  blocks: number;
  /** Textures with a side over their folder's limit. */
  oversizeTextures: Array<{ path: string; width: number; height: number; limit: number }>;
  /** Cuboids of every geometry the pack defines: what the phone holds once the pack is bound. */
  totalGeometryCuboids: number;
}

/** Measure a pack's files (directory entries excluded by the caller). */
export function staticMeasure(files: readonly BudgetFile[]): StaticMeasure {
  const perms = countBlockPermutations(jsonFiles(files, n => /(^|\/)blocks\//.test(n)));
  const oversize: StaticMeasure['oversizeTextures'] = [];
  for (const f of files) {
    if (!/(^|\/)textures\/.+\.(png|tga)$/i.test(f.name)) continue;
    const size = imageSize(f.data);
    const limit = textureLimitPx(f.name);
    if (size && Math.max(size.width, size.height) > limit) oversize.push({ path: f.name, ...size, limit });
  }
  return {
    uncompressedBytes: files.reduce((s, f) => s + f.data.length, 0),
    fileCount: files.length,
    permutations: perms.total,
    blocks: perms.blocks.length,
    oversizeTextures: oversize,
    totalGeometryCuboids: [...geometryTable(files).values()].reduce((s, n) => s + n, 0),
  };
}

/** What a placement on the simulator measured. */
export interface RuntimeMeasure {
  /** Valid non-player entities in the world after the placement settled. */
  residentEntities: number;
  /** Sum over those entities of the cuboids of their client geometry. */
  placedCuboids: number;
  scriptMsMedian: number;
  scriptMsP95: number;
  /** Ticks the script time was measured over. */
  ticks: number;
  entitiesByType: Record<string, number>;
}

export type RowStatus = 'pass' | 'fail' | 'not-measured';
export interface BudgetRow { metric: string; value: number | null; limit: number; status: RowStatus; source: 'tier' | 'platform'; note?: string }
export interface BudgetReport {
  tier: string;
  verdict: 'pass' | 'fail' | 'incomplete';
  rows: BudgetRow[];
  /** Why the runtime rows are not measured, when they are not. */
  runtimeReason?: string;
}

/** Median (mean of the middle two for an even count); 0 for an empty list. */
export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The value at fraction `q` (0..1) of the sorted list, nearest-rank; 0 for an empty list. */
export function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

/**
 * Set measures against a tier. A value equal to its limit passes. A runtime row with no runtime measure is
 * `not-measured`; the verdict is `fail` when any measured row fails (even with the runtime missing), else
 * `incomplete` when any row is unmeasured, else `pass`.
 */
export function evaluateBudget(
  m: { static: StaticMeasure; runtime: RuntimeMeasure | null; runtimeReason?: string },
  tier: BudgetTier,
): BudgetReport {
  const s = m.static, r = m.runtime;
  const row = (metric: string, value: number | null, limit: number, source: BudgetRow['source'], note?: string): BudgetRow => ({
    metric, value, limit, source, status: value === null ? 'not-measured' : value <= limit ? 'pass' : 'fail', ...(note ? { note } : {}),
  });
  const rows: BudgetRow[] = [
    row('uncompressed bytes', s.uncompressedBytes, tier.maxUncompressedBytes, 'tier'),
    row('file count', s.fileCount, PLATFORM_LIMITS.maxFiles, 'platform'),
    row('block permutations', s.permutations, PLATFORM_LIMITS.maxPermutations, 'platform'),
    row('textures over their size limit', s.oversizeTextures.length, 0, 'platform', s.oversizeTextures.slice(0, 4).map(t => `${t.path} ${t.width}x${t.height}`).join('; ') || undefined),
    row('resident cuboids', s.totalGeometryCuboids, tier.maxResidentCuboids, 'tier', 'cuboids of every geometry the pack defines'),
    row('placed cuboids', r ? r.placedCuboids : null, tier.maxPlacedCuboids, 'tier', 'instances x geometry after placement'),
    row('resident entities', r ? r.residentEntities : null, tier.maxResidentEntities, 'tier', 'live entities after placement'),
    row('script ms per tick (median)', r ? r.scriptMsMedian : null, tier.maxScriptMsMedian, 'tier', 'host ms on the simulator'),
  ];
  const verdict = rows.some(x => x.status === 'fail') ? 'fail' : rows.some(x => x.status === 'not-measured') ? 'incomplete' : 'pass';
  return { tier: tier.id, verdict, rows, ...(!r && m.runtimeReason ? { runtimeReason: m.runtimeReason } : {}) };
}
