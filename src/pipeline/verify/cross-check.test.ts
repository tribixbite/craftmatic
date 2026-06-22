import { describe, it, expect } from 'vitest';
import { crossCheckHeight } from './cross-check.js';
import type { BuildingContext } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';

// crossCheckHeight only reads ctx.levels / ctx.rawSolar / ctx.rawSmarty and
// evidence.heightM — partial casts keep the fixtures focused.
function ctx(partial: {
  levels?: number | null;
  solarHeightM?: number | null;
  smartyStories?: number | null;
}): BuildingContext {
  return {
    levels: partial.levels ?? null,
    rawSolar: partial.solarHeightM != null ? { estimatedHeightM: partial.solarHeightM } : null,
    rawSmarty: partial.smartyStories != null ? { storiesNumber: partial.smartyStories } : null,
  } as unknown as BuildingContext;
}

function heightEv(value: number, source: JointEvidence['heightM']['source']): JointEvidence {
  return { heightM: { value, source, confidence: 0.9 } } as unknown as JointEvidence;
}

describe('crossCheckHeight', () => {
  it('flags truncation when an independent survey is much taller than tiles', () => {
    // 25-storey OSM building ≈ 87.5m, but photogrammetry only captured 35m.
    const r = crossCheckHeight(ctx({ levels: 25 }), heightEv(35, 'tiles'));
    expect(r.truncationSuspected).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.alternatives.map(a => a.source)).toContain('osm');
    expect(r.warnings.join(';')).toMatch(/truncated/i);
    expect(r.maxDisagreement).toBeGreaterThan(0.25);
  });

  it('passes when independent sources agree within tolerance', () => {
    // tiles 24m; OSM 7 levels ≈ 24.5m; Solar 25m — all within 25%.
    const r = crossCheckHeight(ctx({ levels: 7, solarHeightM: 25 }), heightEv(24, 'tiles'));
    expect(r.truncationSuspected).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('ignores the estimate that shares the chosen source', () => {
    // Chosen source is OSM, so the OSM levels estimate is NOT independent.
    const r = crossCheckHeight(ctx({ levels: 25 }), heightEv(35, 'osm'));
    expect(r.alternatives).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.maxDisagreement).toBe(0);
  });

  it('warns on large disagreement that is not an under-build (build is taller)', () => {
    // tiles 40m but OSM says 5 levels ≈ 17.5m — disagreement, but not truncation.
    const r = crossCheckHeight(ctx({ levels: 5 }), heightEv(40, 'tiles'));
    expect(r.truncationSuspected).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.warnings.join(';')).toMatch(/disagrees/i);
  });

  it('is ok (unverifiable) when no independent source exists', () => {
    const r = crossCheckHeight(ctx({}), heightEv(30, 'tiles'));
    expect(r.alternatives).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.truncationSuspected).toBe(false);
  });

  it('uses Smarty stories as an independent source', () => {
    // Chosen Solar 20m; Smarty 12 stories ≈ 42m → truncation suspected.
    const r = crossCheckHeight(ctx({ smartyStories: 12 }), heightEv(20, 'solar'));
    expect(r.alternatives.map(a => a.source)).toContain('smarty');
    expect(r.truncationSuspected).toBe(true);
  });
});
