/**
 * The LEGO tab's compact diagnostic bundle.
 *
 * Why it exists: a user report of the form "the hair floats on 10316" is not
 * reproducible. The same set number resolves to a different FILE depending on
 * the index generation, the try-order, which sources happened to fail, and
 * which part-library revision the browser had cached — and none of that is
 * visible in a screenshot. This bundle records exactly those identifiers so a
 * defect can be re-loaded from the same bytes.
 * (docs/lego-3d-generation-audit-2026-09-08.md, P1 item 4, last bullet.)
 *
 * Pure data assembly — no DOM, no fetch — so it is offline-testable
 * (test/lego-diagnostics.test.ts) and the caller owns the download.
 *
 * HONESTY RULES baked in here, because a diagnostic that overstates what it
 * knows is worse than none:
 *  • `intended` vs `loaded` are separate fields, and `fellBack` is derived
 *    from them rather than asserted by the caller.
 *  • `appVersion` is a BUILD DATE (vite `__APP_VERSION__`), not a commit — the
 *    bundle says so in `notes` so nobody maps it to a revision.
 *  • absent measurements are `null`/omitted, never zero. `assembly:
 *    'unverified'` means not measured.
 */

import {
  assemblyStatus, tryOrderReason,
  type AssemblyStatus, type IndexModel, type LegoModelsIndex,
} from '@engine/lego-sources.js';

/** Everything the LEGO tab knows about the current load, as plain data. */
export interface LegoDiagnosticsInput {
  setNum?: string | undefined;
  setName?: string | undefined;
  /** The models index (for its `generated`/`schema`/`geograde` provenance). */
  index?: LegoModelsIndex | null | undefined;
  /** The set's index entries, in index order (NOT try order). */
  models?: IndexModel[] | null | undefined;
  /** Entry the try-order meant to load first; null for non-indexed loads. */
  intendedIndex?: number | null | undefined;
  /** Entry that actually rendered; null when nothing indexed rendered. */
  loadedIndex?: number | null | undefined;
  /** Sources the loader walked past, in attempt order, with why they failed. */
  attempts?: readonly { src: string; path: string; error: string }[] | undefined;
  /** Absolute/relative URL the rendered bytes came from (any load path). */
  sourceUrl?: string | undefined;
  /** Label for a load that has no index entry (upload, OMR chain, BFF). */
  fallbackLoader?: string | undefined;
  /** The user-facing source-quality caveat shown with the render, if any. */
  warning?: string | undefined;
  /**
   * Index hash vs the hash of the bytes that actually rendered.
   * `match: null` = not comparable (schema-1 entry, or no WebCrypto), which is
   * NOT a mismatch. Only `false` means the deployed file differs from the one
   * the index's grade/lineage/defects describe.
   */
  contentHash?: { expected: string | null; actual: string | null; match: boolean | null } | undefined;
  /** vite `__APP_VERSION__` (a build date). */
  appVersion?: string | undefined;
  /** Data-table revisions that affect placement/resolution. */
  mapping?: {
    lddPartMapEntries?: number | null;
    /** The MEASURED LDD alignment table — the one that fixed 71043. */
    lddMeasuredAlignEntries?: number | null;
    partAliasEntries?: number | null;
    /** Persistent .dat cache FORMAT version (parts.ts IDB_VERSION_KEY). */
    datCacheVersion?: string | null;
    /** Deployed parts-library revision the cache is pinned to; null = unknown. */
    libraryRevision?: string | null;
  } | undefined;
  /** Render state at the moment the bundle was taken. */
  render?: {
    mode?: 'direct-3d' | 'voxel';
    bricks?: number | null;
    steps?: number | null;
    sliderMode?: string | null;
    maxStep?: number | null;
    explodeFactor?: number | null;
    edgesDropped?: boolean;
  } | undefined;
  /** Part-resolution outcomes from the viewer (empty arrays are meaningful). */
  parts?: {
    missing?: readonly { part: string; count: number }[];
    substituted?: readonly { part: string; renderedAs: string; count: number }[];
    unresolvedSubparts?: readonly string[];
  } | undefined;
  /** Last contact-candidate audit result, if the user ran one. */
  contactAudit?: {
    pieces: number; components: number; largestPct: number;
    detached: number; resolutionLDU: number;
    snapAssisted?: number;
  } | null | undefined;
  /** Injected for deterministic tests; defaults to now. */
  now?: string | undefined;
}

/** One source entry as recorded in the bundle. */
interface DiagSource {
  src: string;
  path: string;
  n: number;
  tier: number;
  assembly: AssemblyStatus;
  conv?: boolean;
  severity?: number;
  defects?: string[];
  lineage?: string;
  hash?: string;
  variant?: string;
}

function diagSource(m: IndexModel): DiagSource {
  const out: DiagSource = {
    src: m.src, path: m.path, n: m.n, tier: m.tier,
    assembly: assemblyStatus(m),
  };
  if (m.conv) out.conv = true;
  if (m.sev != null) out.severity = m.sev;
  if (m.defects?.length) out.defects = [...m.defects];
  if (m.lineage) out.lineage = m.lineage;
  if (m.hash) out.hash = m.hash;
  if (m.variant) out.variant = m.variant;
  return out;
}

/**
 * Assemble the diagnostic bundle. Everything is optional: an upload with no
 * index entry still produces a valid bundle (source/assembly simply say so).
 */
export function buildLegoDiagnostics(input: LegoDiagnosticsInput): Record<string, unknown> {
  const models = input.models ?? null;
  const intended = pick(models, input.intendedIndex);
  const loaded = pick(models, input.loadedIndex);
  const fellBack = intended != null && loaded != null && intended.path !== loaded.path;

  return {
    kind: 'craftmatic-lego-diagnostics',
    version: 1,
    generated: input.now ?? new Date().toISOString(),
    app: {
      version: input.appVersion ?? null,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    },
    set: {
      setNum: input.setNum ?? null,
      name: input.setName ?? null,
    },
    index: {
      generated: input.index?.generated ?? null,
      schema: input.index?.schema ?? 1,
      geograde: input.index?.geograde ?? null,
    },
    source: {
      url: input.sourceUrl ?? null,
      loader: loaded ? 'indexed' : (input.fallbackLoader ?? null),
      intended: intended ? diagSource(intended) : null,
      loaded: loaded ? diagSource(loaded) : null,
      fellBack,
      /** Why the try-order's first pick differs from the index's own order. */
      pickReason: models ? tryOrderReason(models) : null,
      attempts: [...(input.attempts ?? [])],
      available: models ? models.map(diagSource) : null,
      warning: input.warning ?? null,
      contentHash: input.contentHash ?? null,
    },
    mapping: {
      lddPartMapEntries: input.mapping?.lddPartMapEntries ?? null,
      lddMeasuredAlignEntries: input.mapping?.lddMeasuredAlignEntries ?? null,
      partAliasEntries: input.mapping?.partAliasEntries ?? null,
      datCacheVersion: input.mapping?.datCacheVersion ?? null,
      libraryRevision: input.mapping?.libraryRevision ?? null,
    },
    render: {
      mode: input.render?.mode ?? null,
      bricks: input.render?.bricks ?? null,
      steps: input.render?.steps ?? null,
      sliderMode: input.render?.sliderMode ?? null,
      maxStep: input.render?.maxStep ?? null,
      explodeFactor: input.render?.explodeFactor ?? null,
      edgesDropped: input.render?.edgesDropped ?? null,
    },
    parts: {
      missing: [...(input.parts?.missing ?? [])],
      substituted: [...(input.parts?.substituted ?? [])],
      unresolvedSubparts: [...(input.parts?.unresolvedSubparts ?? [])],
    },
    contactAudit: input.contactAudit ?? null,
    notes: [
      'app.version is the build DATE from vite __APP_VERSION__, not a git commit.',
      'source.loaded.assembly "unverified" means the file was never measured by'
        + ' the geometry audit (or was modified after it was) — it is not a defect claim.',
      'contactAudit reports surface-contact CANDIDATES, not certified mechanical'
        + ' assembly; see web/src/viewer/ldraw/connectivity-audit.ts for its limits.',
      'mapping.libraryRevision null means the deployed parts-library revision could'
        + ' not be established (no IndexedDB, no /ldraw-parts/_rev endpoint, or'
        + ' offline) — it is not a claim that the library is unversioned.',
      'source.loaded.hash is the index\'s sha256/12 of the model file bytes: the'
        + ' identity to re-fetch for an exact reproduction.',
    ],
  };
}

function pick(models: IndexModel[] | null, i: number | null | undefined): IndexModel | null {
  if (!models || i == null || i < 0) return null;
  return models[i] ?? null;
}

/** Suggested filename: `craftmatic-diag-10316-1-2026-09-09.json`. */
export function diagnosticsFilename(setNum: string | undefined, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `craftmatic-diag-${setNum ? `${setNum}-` : ''}${day}.json`;
}
