/**
 * Header-based source-quality classification for LEGO model files.
 *
 * The clego corpus ships several lineages of the same set; craftmatic gates
 * and labels them from the first ~600 bytes of provenance comments. Pure
 * TEXT→classification — no DOM/fetch — so it lives in engine/ and is
 * offline-tested (test/source-quality.test.ts). Keep it in sync with the
 * header conventions in C:/git/clego/TASKS-FROM-CRAFTMATIC.md §6.
 */

export type SourceQuality = 'good' | 'approximate' | 'dbix' | 'broken';

/** Shared caveat for the legacy 'dbix' class (see reconstructionQuality). */
export const DBIX_WARNING =
  'legacy DBIX conversion — sub-models may overlap at one origin or float, and some parts are dropped; a corrected "dbix_conv_v2" source usually exists in the source menu';

/**
 * Classify a clego-reconstructed LDR by its header provenance comments.
 * - 'good': assembled from an already-LDraw source (model2.ldr, or a
 *   `0 !LINEAGE <tool> good` stamp) — faithful.
 * - 'approximate': vision-reconstructed from instruction pages, a `partial`
 *   lineage stamp, or a synthetic multi-model layout — placements are
 *   heuristic (floaters/mis-orientations are in the DATA).
 * - 'dbix': LEGACY v1 DBIX conversion (`0 LEGO DBIX` with no `0 !LINEAGE`
 *   line / `download_dbix_lxfml.py`) — dropped parts (72153: 5,366/6,838)
 *   and lost sub-assembly transforms (collapsed piles, floaters). The v2
 *   reconverter (2026-08-28) fixed both; v2 files carry `0 !LINEAGE`
 *   and classify through that path instead.
 * - 'broken': converted from DBIX LXFML without per-part LDD→LDraw origin
 *   alignment — renders scrambled; colors are raw material ids.
 */
export function reconstructionQuality(ldrText: string): SourceQuality {
  const head = ldrText.slice(0, 600);
  // Canonical lineage stamp — clego converters emit `0 !LINEAGE <tool>
  // <good|partial>` as of 2026-08-28. It takes precedence over the legacy
  // sniffs: the v2 DBIX reconverter's files also start with `0 LEGO DBIX v2`,
  // which the legacy regex below would misclassify as the warn-class.
  const lineage = /^0 !LINEAGE\s+\S+\s+(good|partial)\b/im.exec(head);
  if (lineage) {
    // Multi-model set whose original arrangement wasn't recoverable — the
    // converter laid the models out side-by-side synthetically.
    if (/^0 DBIX MULTIMODEL UNPLACED/im.test(head)) return 'approximate';
    return lineage[1] === 'good' ? 'good' : 'approximate';
  }
  if (/^0 LEGO DBIX|Author:\s*download_dbix_lxfml/im.test(head)) return 'dbix';
  if (/Source:\s*DBIX_LXFML/i.test(head)) return 'broken';
  // convert_lxf.py output is the same class under a different header: colors
  // are raw LDD material ids and parts lack per-part LDD→LDraw alignment.
  // Visual QA (2026-07-20): 10255 rendered as stacked buildings, 1924 as an
  // exploded ferry, 8849 with ghost tires — all `Author: convert_lxf.py`.
  if (/Author:\s*convert_lxf\.py/i.test(head)) return 'broken';
  // NOTE (2026-07-20): a color-palette fingerprint for LXF lineage was tried
  // and removed — LDRAW_COLOR_RGB already contains the extended/Studio ids
  // (10047, 10070 …), so table-membership cannot discriminate. Files that
  // launder LXF conversions through other containers WITHOUT the headers
  // above (10255's ".io" and its recon derivatives) are not text-detectable;
  // their defect is stacked PLACEMENT (LXF workspace layout), which needs
  // lineage metadata upstream in the model index to catch.
  // Vision/PDF reconstruction lineages — placements are heuristic. recon_v3
  // renders as a semi-coherent pile for many sets (visual QA 2026-08-21:
  // ReconV3/2879 = interpenetrating bricks); it's the ONLY source for ~2.2k
  // sets, so it loads — but always labeled, never silently.
  if (/reconstructed by recon_v3|Reconstructed from PDF|inverse isometric projection|blob (fallback|detection)/i.test(head)) return 'approximate';
  return 'good';
}

/**
 * User-facing caveat for a classified source, or null when nothing needs
 * saying. Reads the same header window as reconstructionQuality; call sites
 * route the result through currentSourceWarning so it survives to the final
 * render status. 'broken' is phrased per-call-site (upload vs indexed).
 */
export function sourceCaveat(ldrText: string, q: SourceQuality): string | null {
  const head = ldrText.slice(0, 600);
  if (/^0 DBIX MULTIMODEL UNPLACED/im.test(head)) {
    return 'multi-model set — the original arrangement was not recoverable, so the models are laid out side-by-side (synthetic layout; the models themselves are faithful)';
  }
  if (q === 'dbix') return DBIX_WARNING;
  if (q === 'approximate') {
    if (/^0 !LINEAGE\s+\S+\s+partial\b/im.test(head)) {
      return 'partially recovered conversion — some parts may be missing or misplaced (noted in the source file)';
    }
    return 'vision-based reconstruction — part placements are approximate';
  }
  // Faithful conversions can still carry an upstream data note: a cluster of
  // parts positioned in mid-air in the ORIGINAL file (e.g. 60502's airplane
  // display) — flag it so users don't report it as a rendering defect.
  const float = /^0 DBIX FLOATING CLUSTER\s+n=(\d+)/im.exec(head);
  if (float) {
    return `note: ${float[1]} parts sit detached above the model — that placement is in the original source data, not a rendering defect`;
  }
  return null;
}
