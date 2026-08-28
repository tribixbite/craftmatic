/**
 * Independent height cross-check (measured-reality guard).
 *
 * The objective height gate (`./objective.ts`) compares the generated mesh's
 * Y-span to the *fused* expected height — but both flow from the same fusion,
 * so it mainly catches synthesis bugs, not data-fidelity errors. If fusion
 * accepted a truncated photogrammetry height, synthesis builds to it and the
 * gate passes while reality is taller.
 *
 * This re-derives height estimates from raw sources that did NOT drive the
 * chosen value (OSM `building:levels`, Solar, Smarty) and flags disagreement —
 * especially the case where an independent survey says the building is
 * materially TALLER than what we built (the Google-3D-Tiles LOD truncation
 * signature). Adapted from Tekton's V09 "measured reality wins; never normalise
 * toward an ideal" guard.
 *
 * Advisory by design: it reports a signal, it does NOT flip `objective.pass`.
 * OSM levels and Solar are themselves estimates, so a hard block on every
 * disagreement would false-fail legitimate builds. The signal lets the iterate
 * loop / a human act on a likely truncation that the gates alone would miss.
 */

import type { BuildingContext } from '../context/types.js';
import type { JointEvidence, EvidenceSource } from '../fusion/types.js';

/** Storeys → metres. Matches the documented OSM-levels→height conversion. */
const METRES_PER_LEVEL = 3.5;
/** |alt − chosen| / chosen beyond this is a disagreement worth surfacing. */
const DISAGREE_RATIO = 0.25;
/** An independent source this much TALLER than the build ⇒ suspect truncation. */
const TRUNCATION_RATIO = 0.25;

export interface HeightEstimate {
  readonly source: EvidenceSource;
  readonly heightM: number;
  /** How the estimate was derived — shown in the report. */
  readonly basis: string;
}

export interface CrossCheckResult {
  readonly chosenSource: EvidenceSource;
  readonly chosenHeightM: number;
  /** Independent estimates from sources OTHER than the chosen one. */
  readonly alternatives: readonly HeightEstimate[];
  /** Max |alt − chosen| / chosen across alternatives (0 when none). */
  readonly maxDisagreement: number;
  /** An independent source says the build is materially TALLER than reality. */
  readonly truncationSuspected: boolean;
  /** Advisory: true = no disagreement past threshold (or nothing to compare). */
  readonly ok: boolean;
  /**
   * An independent source actually existed to check against.
   *
   * `ok` deliberately conflates "agreed" with "nothing to compare", which
   * makes an UNVERIFIABLE height indistinguishable from a verified one.
   * Geisel shipped at 72.9m — more than double its real ~33m — sourced from
   * photogrammetry at confidence 0.95, with `ok: true, alternatives: []`.
   * Nothing had checked it; the report said the check passed. Consumers that
   * care whether the height was actually corroborated must read THIS field.
   */
  readonly verified: boolean;
  readonly warnings: readonly string[];
}

function smartyStories(ctx: BuildingContext): number | null {
  const s = ctx.rawSmarty as unknown as { storiesNumber?: number; stories?: number } | null;
  const n = s?.storiesNumber ?? s?.stories;
  return n != null && n > 0 ? n : null;
}

function solarHeight(ctx: BuildingContext): number | null {
  const h = (ctx.rawSolar as unknown as { estimatedHeightM?: number | null } | null)?.estimatedHeightM;
  return h != null && h > 2 ? h : null;
}

/** Independent height estimates keyed by source, derived from raw context. */
function gatherEstimates(ctx: BuildingContext): HeightEstimate[] {
  const out: HeightEstimate[] = [];
  if (ctx.levels != null && ctx.levels > 0) {
    out.push({
      source: 'osm',
      heightM: ctx.levels * METRES_PER_LEVEL,
      basis: `${ctx.levels} levels × ${METRES_PER_LEVEL}m`,
    });
  }
  const solar = solarHeight(ctx);
  if (solar != null) {
    out.push({ source: 'solar', heightM: solar, basis: 'Solar estimatedHeightM' });
  }
  const stories = smartyStories(ctx);
  if (stories != null) {
    out.push({
      source: 'smarty',
      heightM: stories * METRES_PER_LEVEL,
      basis: `${stories} stories × ${METRES_PER_LEVEL}m`,
    });
  }
  return out;
}

export function crossCheckHeight(ctx: BuildingContext, evidence: JointEvidence): CrossCheckResult {
  const chosenSource = evidence.heightM.source;
  const chosenHeightM = evidence.heightM.value;

  // Only estimates from a DIFFERENT source are independent of the chosen value.
  const alternatives = gatherEstimates(ctx).filter(e => e.source !== chosenSource);

  let maxDisagreement = 0;
  let truncationSuspected = false;
  const warnings: string[] = [];

  for (const alt of alternatives) {
    if (chosenHeightM <= 0) continue;
    const ratio = (alt.heightM - chosenHeightM) / chosenHeightM;
    const absRatio = Math.abs(ratio);
    if (absRatio > maxDisagreement) maxDisagreement = absRatio;

    if (ratio >= TRUNCATION_RATIO) {
      truncationSuspected = true;
      warnings.push(
        `${alt.source} (${alt.basis}) implies ${alt.heightM.toFixed(0)}m — ` +
        `${(ratio * 100).toFixed(0)}% taller than the built ${chosenHeightM.toFixed(0)}m (${chosenSource})`,
      );
    } else if (absRatio > DISAGREE_RATIO) {
      warnings.push(
        `${alt.source} (${alt.basis}) ${alt.heightM.toFixed(0)}m disagrees with ` +
        `${chosenSource} ${chosenHeightM.toFixed(0)}m by ${(ratio * 100).toFixed(0)}%`,
      );
    }
  }

  // Photogrammetry the capture layer did NOT flag truncated, yet an independent
  // survey says taller, is the classic Google-3D-Tiles LOD miss — call it out.
  if (truncationSuspected && chosenSource === 'tiles') {
    warnings.unshift('photogrammetry height likely truncated (LOD) — independent survey is taller');
  }

  // No independent source: say so out loud rather than reporting a pass.
  // A silent unverified height is how a 2x error reached the goldens.
  if (alternatives.length === 0) {
    warnings.push(
      `height ${chosenHeightM.toFixed(0)}m from ${chosenSource} is UNVERIFIED — ` +
      'no independent source (OSM height/levels, Solar, Smarty) to cross-check against',
    );
  }

  return {
    chosenSource,
    chosenHeightM,
    alternatives,
    maxDisagreement,
    truncationSuspected,
    // `ok` keeps its established meaning (no DISAGREEMENT past threshold) so
    // existing consumers are unaffected; an unverified height is surfaced via
    // `verified` + the warning, not by flipping this.
    ok: !warnings.some(w => !w.includes('UNVERIFIED')),
    verified: alternatives.length > 0,
    warnings,
  };
}
