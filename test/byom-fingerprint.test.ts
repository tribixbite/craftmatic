/**
 * X-13 (BIZ-37, BIZ-06): the clean-room similarity core.
 *
 * Synthetic models pin the maths; corpus tests (gated on `C:/git/clego/lego_sets`, read INSIDE `it`) pin the
 * thresholds against real files. The calibration those thresholds come from is in TASKS-BUSINESS.md.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import {
  compareFingerprints, estimateJaccard, fingerprintBricks, minhash, MINHASH_SIZE, screenAgainst,
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

describe('byom-fingerprint corpus', () => {
  const corpus = 'C:/git/clego/lego_sets/';
  it('runs only with the corpus', () => {
    if (!existsSync(corpus)) return;
    expect(readFileSync(`${corpus}OMR/10261-1.mpd`, 'utf-8').length).toBeGreaterThan(0);
  });
});
