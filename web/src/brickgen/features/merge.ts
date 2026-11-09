/**
 * Precedence between feature sources (A09): an annotation beats a mesh slice beats a tag.
 *
 * A lower-authority feature is dropped when a higher-authority one of the SAME KIND stands on the SAME VOLUME and
 * either of them has no edge (a volume-level feature such as a spire speaks for the whole volume), or both sit on
 * the same edge with overlapping extents. A feature of another kind, or on another edge, survives. Every drop is
 * recorded so a report can say what an annotation replaced.
 */
import type { FeatureSpec } from '../types.js';
import type { FeatureOrigin, OriginFeature, SupersededFeature } from './types.js';

const RANK: Readonly<Record<FeatureOrigin, number>> = { annotation: 3, mesh: 2, tags: 1 };

/** Along-edge and height extents of an edge feature (a run of `count` items spans `count x size`). */
function extents(f: FeatureSpec): { a0: number; a1: number; y0: number; y1: number } {
  const w = f.sizeM[0] * (f.count ?? 1);
  return { a0: f.atM[0] - w / 2, a1: f.atM[0] + w / 2, y0: f.atM[1], y1: f.atM[1] + f.sizeM[1] };
}

/** True when `lo` is covered by the authority of `hi`. */
function covers(hi: FeatureSpec, lo: FeatureSpec): boolean {
  if (hi.kind !== lo.kind || hi.volume !== lo.volume) return false;
  if (hi.edge === undefined || lo.edge === undefined) return true;
  if (hi.edge !== lo.edge) return false;
  const a = extents(hi), b = extents(lo);
  return a.a0 < b.a1 && b.a0 < a.a1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Total order for deterministic output. */
export function compareSpecs(a: FeatureSpec, b: FeatureSpec): number {
  return a.volume.localeCompare(b.volume) || a.kind.localeCompare(b.kind) || (a.edge ?? -1) - (b.edge ?? -1)
    || a.atM[0] - b.atM[0] || a.atM[1] - b.atM[1] || a.atM[2] - b.atM[2];
}

/** Applies the precedence rule; returns the survivors (sorted) and what was dropped. */
export function mergeFeatures(all: ReadonlyArray<OriginFeature>): { kept: OriginFeature[]; superseded: SupersededFeature[] } {
  const kept: OriginFeature[] = [];
  const superseded: SupersededFeature[] = [];
  for (const lo of all) {
    const by = all.find(hi => RANK[hi.origin] > RANK[lo.origin] && covers(hi.spec, lo.spec));
    if (by) superseded.push({ dropped: lo, by }); else kept.push(lo);
  }
  kept.sort((a, b) => compareSpecs(a.spec, b.spec));
  return { kept, superseded };
}
