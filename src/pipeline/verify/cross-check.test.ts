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

describe('unverified height (nothing to cross-check against)', () => {
  it('reports verified=false and warns when no independent source exists', () => {
    // The geisel case: photogrammetry said 72.9m for a ~33m library, at
    // confidence 0.95, with no OSM height/levels, Solar or Smarty to check
    // it. The old result was `ok: true, alternatives: []` — a check that
    // could not run, reported as a check that passed.
    const r = crossCheckHeight(ctx({}), heightEv(72.9, 'tiles'));
    expect(r.alternatives).toHaveLength(0);
    expect(r.verified).toBe(false);
    expect(r.warnings.join(' ')).toContain('UNVERIFIED');
    // `ok` keeps its established meaning — no DISAGREEMENT was found — so
    // existing consumers are unaffected by the new signal.
    expect(r.ok).toBe(true);
  });

  it('reports verified=true as soon as one independent source exists', () => {
    const r = crossCheckHeight(ctx({ levels: 24 }), heightEv(72.9, 'tiles'));
    expect(r.alternatives.length).toBeGreaterThan(0);
    expect(r.verified).toBe(true);
    expect(r.warnings.join(' ')).not.toContain('UNVERIFIED');
  });

  it('an agreeing independent source is verified AND ok', () => {
    const r = crossCheckHeight(ctx({ solarHeightM: 33 }), heightEv(33, 'tiles'));
    expect(r.verified).toBe(true);
    expect(r.ok).toBe(true);
  });
});
