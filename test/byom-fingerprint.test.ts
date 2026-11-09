/**
 * X-13 (BIZ-37, BIZ-06): the clean-room similarity core.
 *
 * Synthetic models pin the maths; corpus tests (gated on `C:/git/clego/lego_sets`, read INSIDE `it`) pin the
 * thresholds against real files. The calibration those thresholds come from is in TASKS-BUSINESS.md.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { sourceHash12 } from '../web/src/engine/pipeline-version.js';
import {
  cleanroomResult, compareFingerprints, estimateJaccard, FINGERPRINT_THRESHOLDS, fingerprintBricks, fingerprintLdrawBytes,
  matchDenylist, minhash, MINHASH_SIZE, parseStored, screenAgainst, toStored, verdictOf, type DenylistIndex,
} from '../web/src/engine/byom/fingerprint.js';

/** Deterministic pseudo-random design: `n` parts from a vocabulary, on a 20 LDU grid. */
function design(seed: number, n: number, vocab: string[]): ParsedBrick[] {
  let s = seed >>> 0;
  const next = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  return Array.from({ length: n }, () => ({
    part: `${vocab[Math.floor(next() * vocab.length)]}.dat`,
    color: Math.floor(next() * 6),
    x: Math.floor(next() * 12) * 20, y: Math.floor(next() * 8) * -24, z: Math.floor(next() * 12) * 20,
  }));
}
const VOCAB_A = ['3001', '3002', '3003', '3004', '3005', '3020', '3021', '3022', '3023', '3024', '3035', '3039', '3040', '3062b'];
const VOCAB_B = ['2412b', '2431', '2436', '2444', '3069b', '3070b', '3710', '3794', '4073', '4286', '4589', '6141', '87580', '98138'];

describe('byom-fingerprint minhash', () => {
  it('estimates Jaccard within sampling error and is deterministic', () => {
    const left = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const right = Array.from({ length: 300 }, (_, i) => `t${i + 100}`); // overlap 200 of 400 -> 0.5
    expect(minhash(left)).toEqual(minhash(left));
    expect(minhash(left)).toHaveLength(MINHASH_SIZE);
    expect(estimateJaccard(minhash(left), minhash(left))).toBe(1);
    expect(Math.abs(estimateJaccard(minhash(left), minhash(right)) - 0.5)).toBeLessThan(0.12);
    expect(estimateJaccard(minhash(left), minhash(right.map((t) => `x${t}`)))).toBeLessThan(0.06);
  });
});

describe('byom-fingerprint screen', () => {
  const official = design(1, 400, VOCAB_A);
  const db = [{ setId: '99001', name: 'Official', hash12: 'aaaaaaaaaaaa', fingerprint: fingerprintBricks(official) }];

  it('an official set\'s own LDraw file is blocked', () => {
    const own = fingerprintBricks(official);
    expect(compareFingerprints(own, db[0].fingerprint).score).toBeGreaterThan(0.99);
    expect(screenAgainst(own, db).verdict).toBe('blocked');
  });

  it('a part-shuffled copy (positions changed, same inventory) is still blocked', () => {
    const shuffled = official.map((b, i) => ({ ...b, x: official[(i * 7 + 3) % official.length].x, z: official[(i * 5 + 1) % official.length].z + 400 }));
    expect(screenAgainst(fingerprintBricks(shuffled), db).verdict).toBe('blocked');
  });

  it('an unrelated design is clear', () => {
    expect(screenAgainst(fingerprintBricks(design(2, 400, VOCAB_B)), db).verdict).toBe('clear');
  });
});

describe('byom-fingerprint synthetic extras', () => {
  const official = design(1, 400, VOCAB_A);
  const entry = { setId: '99001', fingerprint: fingerprintBricks(official) };

  it('a copy turned 90 degrees and moved is still blocked', () => {
    const turned = official.map((b) => ({ ...b, x: -b.z + 1000, z: b.x - 600 }));
    expect(screenAgainst(fingerprintBricks(turned, { orientations: true }), [entry]).verdict).toBe('blocked');
  });

  it('thresholds are pinned to the corpus calibration', () => {
    expect(FINGERPRINT_THRESHOLDS).toEqual({ review: 0.2, block: 0.5 });
    expect(verdictOf({ score: 0.49, sameFile: false })).toBe('review');
    expect(verdictOf({ score: 0.5, sameFile: false })).toBe('blocked');
    expect(verdictOf({ score: 0.19, sameFile: false })).toBe('clear');
    expect(verdictOf({ score: 0, sameFile: true })).toBe('blocked');
  });

  it('a stored fingerprint round-trips and compares like the original', () => {
    const stored = parseStored(JSON.parse(JSON.stringify(toStored(fingerprintBricks(official, { hash12: 'abc123abc123' })))));
    expect(stored.placement).toBeUndefined();
    expect(stored.hash12).toBe('abc123abc123');
    expect(compareFingerprints(fingerprintBricks(official), stored).score).toBe(1);
    expect(compareFingerprints(fingerprintBricks(official), stored).placementIoU).toBeNull();
  });

  it('the same bytes are the same file whatever the parts say', () => {
    const bytes = new TextEncoder().encode('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n');
    const a = fingerprintLdrawBytes(bytes);
    expect(a.hash12).toBe(sourceHash12(bytes));
    expect(compareFingerprints(a, a).sameFile).toBe(true);
  });

  it('a set with several files counts once and the placement IoU of a copy is 1', () => {
    const own = fingerprintBricks(official);
    expect(compareFingerprints(own, own).placementIoU).toBeCloseTo(1, 5);
    const db = [entry, { ...entry, fingerprint: fingerprintBricks(design(5, 400, VOCAB_B)) }];
    expect(screenAgainst(own, db).matches).toHaveLength(1);
  });

  it('the denylist matches names ignoring case and punctuation, and the clearance row hides the path', () => {
    const index: DenylistIndex = { sets: {
      '21061': { name: 'Notre-Dame de Paris', models: [{ src: 'io', path: 'IO/21061.io' }, { src: 'omr', path: 'OMR/21061-1.mpd' }] },
      '10001': { name: 'Metroliner', models: [{ src: 'ldr', path: 'LDR/10001.ldr' }] },
    } };
    const hits = matchDenylist(index, ['notre dame']);
    expect(hits.map((h) => h.setId)).toEqual(['21061']);
    expect(hits[0]!.paths).toHaveLength(2);
    const fp = fingerprintBricks(official);
    const row = cleanroomResult(compareFingerprints(fp, fp), 'OMR/21061-1.mpd', 'checker', '2026-11-09T00:00:00Z');
    expect(row.verdict).toBe('review');
    expect(row.checkedAgainst).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(row)).not.toContain('21061');
  });
});

const CORPUS = 'C:/git/clego/lego_sets/';
const hasCorpus = existsSync(CORPUS);
const corpusFp = (path: string, hash = true) => {
  const bytes = new Uint8Array(readFileSync(CORPUS + path));
  return hash ? fingerprintLdrawBytes(bytes, { orientations: true }) : fingerprintBricks(parseLDraw(new TextDecoder().decode(bytes)), { orientations: true });
};

describe('byom-fingerprint corpus', () => {
  it("an official set's own corpus file is blocked, and so is its other source", () => {
    if (!hasCorpus) return;
    const db = [{ setId: '21002', name: 'Empire State Building', fingerprint: corpusFp('OMR/21002-1.mpd') }];
    expect(screenAgainst(corpusFp('OMR/21002-1.mpd'), db).verdict).toBe('blocked');
    // The LDR source of the same set is a different file of the same model (measured score 0.70).
    expect(screenAgainst(corpusFp('LDR/21002 Empire State Building.mpd'), db).verdict).toBe('blocked');
  });

  it('a corpus model of another set is clear', () => {
    if (!hasCorpus) return;
    const db = [{ setId: '21002', name: 'Empire State Building', fingerprint: corpusFp('OMR/21002-1.mpd') }];
    expect(screenAgainst(corpusFp('LDR/10001 Metro Liner.ldr'), db).verdict).toBe('clear');
    expect(screenAgainst(corpusFp('OMR/21006-1.mpd'), db).verdict).toBe('clear');
  });

  it("the denylist lists the corpus's landmark sets for 'notre dame'", () => {
    const indexFile = 'web/public/lego-models-index.json';
    if (!existsSync(indexFile)) return;
    const hits = matchDenylist(JSON.parse(readFileSync(indexFile, 'utf-8')) as DenylistIndex, ['notre dame']);
    expect(hits.map((h) => h.setId)).toContain('21061');
    expect(hits.find((h) => h.setId === '21061')!.paths.length).toBeGreaterThanOrEqual(1);
  });
});
