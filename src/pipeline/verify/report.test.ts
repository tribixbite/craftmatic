import { describe, it, expect } from 'vitest';
import {
  composeReport,
  contextInsufficientReport,
  summariseReport,
} from './report.js';
import type { ConsensusResult } from './consensus.js';
import type { ObjectiveResult } from './objective.js';
import type { JointEvidence } from '../fusion/types.js';
import type { BuildingContext } from '../context/types.js';
import { BlockGrid } from '../../schem/types.js';

// A small two-block-type body for the deterministic defect score.
function okGrid(): BlockGrid {
  const g = new BlockGrid(4, 4, 4);
  for (let y = 0; y < 3; y++) {
    for (let z = 0; z < 3; z++) {
      for (let x = 0; x < 3; x++) g.set(x, y, z, 'minecraft:stone');
    }
  }
  g.set(1, 1, 1, 'minecraft:bricks');
  g.set(2, 2, 2, 'minecraft:glass');
  return g;
}

// A 25-storey OSM record (≈87.5m) — independent of okEvidence's 24m tiles height.
function truncationCtx(): BuildingContext {
  return { levels: 25, rawSolar: null, rawSmarty: null } as unknown as BuildingContext;
}

// Varied confidences so the weakest link is deterministic: wall = inferred/0.20.
// Mean = (1 + 0.95 + 0.8 + 0.2 + 0.85 + 1) / 6 = 0.80.
function okEvidence(): JointEvidence {
  return {
    footprint: { value: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }], source: 'osm', confidence: 1 },
    heightM: { value: 24, source: 'tiles', confidence: 0.95 },
    levels: { value: 6, source: 'osm', confidence: 0.8 },
    wallPalette: { value: [[60, 4, 8]], source: 'inferred', confidence: 0.2 },
    roofPalette: { value: [[30, 0, 0]], source: 'sat', confidence: 0.85 },
    roofShape: { value: 'flat', source: 'osm', confidence: 1 },
    windowGrid: [null, null, null, null],
    cornice: { value: false, source: 'inferred', confidence: 0.5 },
    entry: { value: { edge: 0, offsetAlongEdge: 0.5 }, source: 'inferred', confidence: 0.3 },
    trees: [],
    roads: [],
  };
}

function okObjective(): ObjectiveResult {
  return {
    footprintIoU: 0.9,
    heightErr: 0.05,
    watertight: true,
    manifold: true,
    selfIntersect: 0,
    minWallThicknessMm: 2.2,
    voxelCount: 12_000,
    plinthWatertight: null,
    pass: true,
    failures: [],
  };
}

function failObjective(): ObjectiveResult {
  return {
    ...okObjective(),
    footprintIoU: 0.7,
    pass: false,
    failures: ['footprint IoU 0.70 < 0.85'],
  };
}

function okConsensus(): ConsensusResult {
  return {
    status: 'pass', rounds: 1,
    gemini: { color: 9, features: 9, massing: 9, overall: 9 },
    claude: { color: 9, features: 9, massing: 9, overall: 9 },
    gpt5:   { color: 9, features: 9, massing: 9, overall: 9 },
    min: 9, median: 9, spread: 0, pass: true,
  };
}

function humanReviewConsensus(): ConsensusResult {
  return {
    status: 'needs-human-review', rounds: 3,
    gemini: { color: 9, features: 9, massing: 9, overall: 9 },
    claude: { color: 5, features: 5, massing: 5, overall: 5 },
    gpt5:   { color: 9, features: 9, massing: 9, overall: 9 },
    min: 5, median: 8, spread: 4, pass: false,
  };
}

describe('composeReport', () => {
  it('status=pass when both gates pass', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus() });
    expect(r.status).toBe('pass');
  });

  it('status=fail-objective when objective fails', () => {
    const r = composeReport({ objective: failObjective(), consensus: okConsensus() });
    expect(r.status).toBe('fail-objective');
  });

  it('status=fail-consensus when objective passes but consensus missing', () => {
    const r = composeReport({ objective: okObjective() });
    expect(r.status).toBe('fail-consensus');
    expect(r.consensus).toBeNull();
  });

  it('status=needs-human-review when consensus terminal-fails', () => {
    const r = composeReport({ objective: okObjective(), consensus: humanReviewConsensus() });
    expect(r.status).toBe('needs-human-review');
  });

  it('lastRun is ISO-8601', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus() });
    expect(r.lastRun).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('provenance is null when no evidence is passed', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus() });
    expect(r.provenance).toBeNull();
  });

  it('summarises per-field provenance when evidence is passed', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus(), evidence: okEvidence() });
    expect(r.provenance).not.toBeNull();
    expect(r.provenance!.fields.map(f => f.field)).toEqual([
      'footprint', 'height', 'levels', 'wall', 'roof', 'roofShape',
    ]);
    // Weakest link = the inferred wall colour.
    expect(r.provenance!.weakest).toMatchObject({ field: 'wall', source: 'inferred', confidence: 0.2 });
    expect(r.provenance!.meanConfidence).toBeCloseTo(0.8);
    // Sources are carried through verbatim.
    expect(r.provenance!.fields.find(f => f.field === 'height')!.source).toBe('tiles');
  });

  it('provenance survives a fail-objective status', () => {
    const r = composeReport({ objective: failObjective(), evidence: okEvidence() });
    expect(r.status).toBe('fail-objective');
    expect(r.provenance?.weakest?.field).toBe('wall');
  });

  it('crossCheck is null without ctx, populated with ctx', () => {
    const noCtx = composeReport({ objective: okObjective(), consensus: okConsensus(), evidence: okEvidence() });
    expect(noCtx.crossCheck).toBeNull();
    const withCtx = composeReport({
      objective: okObjective(), consensus: okConsensus(), evidence: okEvidence(), ctx: truncationCtx(),
    });
    expect(withCtx.crossCheck).not.toBeNull();
    expect(withCtx.crossCheck!.truncationSuspected).toBe(true);
  });

  it('crossCheck is advisory — a truncation signal does NOT change status', () => {
    const r = composeReport({
      objective: okObjective(), consensus: okConsensus(), evidence: okEvidence(), ctx: truncationCtx(),
    });
    expect(r.status).toBe('pass'); // gates + consensus pass; cross-check is advisory only
    expect(r.crossCheck!.truncationSuspected).toBe(true);
  });

  it('defectScore is null without a grid, computed with one', () => {
    const noGrid = composeReport({ objective: okObjective(), consensus: okConsensus() });
    expect(noGrid.defectScore).toBeNull();
    const withGrid = composeReport({ objective: okObjective(), consensus: okConsensus(), grid: okGrid() });
    expect(withGrid.defectScore).not.toBeNull();
    expect(withGrid.defectScore!.score).toBeGreaterThanOrEqual(0);
    expect(withGrid.defectScore!.score).toBeLessThanOrEqual(10);
    expect(withGrid.defectScore!.grid.components).toBe(1);
  });
});

describe('contextInsufficientReport', () => {
  it('marks status + reason + nulls objective/consensus', () => {
    const r = contextInsufficientReport('no OSM polygon');
    expect(r.status).toBe('context-insufficient');
    expect(r.reason).toBe('no OSM polygon');
    expect(r.objective).toBeNull();
    expect(r.consensus).toBeNull();
    expect(r.provenance).toBeNull();
  });
});

describe('summariseReport', () => {
  it('includes IoU, height error, watertight, voxels in summary', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus() });
    const s = summariseReport(r);
    expect(s).toContain('status=pass');
    expect(s).toContain('iou=0.90');
    expect(s).toContain('watertight=true');
    expect(s).toContain('voxels=12000');
  });

  it('mentions failures[] when present', () => {
    const r = composeReport({ objective: failObjective(), consensus: okConsensus() });
    const s = summariseReport(r);
    expect(s).toContain('failures=');
  });

  it('mentions consensus scores when present', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus() });
    const s = summariseReport(r);
    expect(s).toContain('consensus_min=9.0');
    expect(s).toContain('median=9.0');
  });

  it('surfaces the weakest-confidence field when provenance is present', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus(), evidence: okEvidence() });
    const s = summariseReport(r);
    expect(s).toContain('prov_weak=wall/inferred/0.20');
    expect(s).toContain('prov_mean=0.80');
  });

  it('omits provenance fields when absent', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus() });
    expect(summariseReport(r)).not.toContain('prov_weak');
  });

  it('surfaces a truncation cross-check signal', () => {
    const r = composeReport({
      objective: okObjective(), consensus: okConsensus(), evidence: okEvidence(), ctx: truncationCtx(),
    });
    const s = summariseReport(r);
    expect(s).toContain('xcheck=truncated');
    expect(s).toMatch(/xcheck_max=\d+%/);
  });

  it('includes the deterministic defect score', () => {
    const r = composeReport({ objective: okObjective(), consensus: okConsensus(), grid: okGrid() });
    expect(summariseReport(r)).toMatch(/defect_score=\d+\.\d/);
  });
});

describe('resolution forensics', () => {
  it('captures osmId, polygonSource and pin quality from ctx', () => {
    const ctx = {
      polygonSource: 'osm',
      geocodeLocationType: 'RANGE_INTERPOLATED',
      rawOsm: { osmId: 'way/477297788', footprintAreaSqm: 96.5 },
    } as unknown as Parameters<typeof composeReport>[0]['ctx'];
    const grid = new BlockGrid(2, 2, 2);
    grid.set(0, 0, 0, 'minecraft:stone');
    const r = composeReport({ objective: okObjective(), ctx, grid });
    expect(r.resolution).toEqual({
      osmId: 'way/477297788',
      polygonSource: 'osm',
      geocodeLocationType: 'RANGE_INTERPOLATED',
      footprintAreaSqm: 96.5,
    });
  });
  it('is null without ctx', () => {
    const r = composeReport({ objective: okObjective() });
    expect(r.resolution).toBeNull();
  });
});
