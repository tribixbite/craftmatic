import { describe, it, expect } from 'vitest';
import {
  composeReport,
  contextInsufficientReport,
  summariseReport,
} from './report.js';
import type { ConsensusResult } from './consensus.js';
import type { ObjectiveResult } from './objective.js';
import type { JointEvidence } from '../fusion/types.js';

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
});
