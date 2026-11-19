/**
 * The Mecabricks Friends mini-dolls in the local clego corpus are assembled as LDraw's composites (VIEW-03,
 * TODO(mb-doll-frame) closed by clego `gen-dollframe`): the hips 92248 sit 29.4 under the torso and 1.2 behind it
 * (92248's `!HELP`), and every doll head is the real mould 92198 33.2 over the torso (92198p01c01), never the raw
 * Mecabricks names 94590 / 28650 that no library ships. Corpus-gated: the root is `CRAFTMATIC_CLEGO_SETS` or clego's
 * `lego_sets/`, and the files are the ones clego's row fix republished (`geograde/mb_doll_rows_publish_20261119.txt`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { partStem } from '../web/src/engine/part-id';

const ROOT = process.env.CRAFTMATIC_CLEGO_SETS ?? 'C:/git/clego/lego_sets';
/** Files that place a Friends doll torso, hips and head (a sample of the 38 republished). */
const FILES = ['MecabricksLDR/41395.ldr', 'MecabricksLDR/41369.ldr', 'MecabricksLDR/41375.ldr', 'MecabricksLDR/76781.ldr',
  'MecabricksLDR/41449.ldr', 'MecabricksSearchLDR/70828.ldr'];
const HAVE = FILES.every(f => existsSync(`${ROOT}/${f}`));

type Placement = { stem: string; p: number[]; R: number[] };

function placements(file: string): Placement[] {
  const out: Placement[] = [];
  for (const line of readFileSync(`${ROOT}/${file}`, 'utf8').split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] !== '1' || t.length < 15) continue;
    out.push({ stem: partStem(t[14]!), p: t.slice(2, 5).map(Number), R: t.slice(5, 14).map(Number) });
  }
  return out;
}

/** `b` in `a`'s local frame (R^T (q - p)) for every `a` whose nearest same-rotation `b` is within 60 LDU. */
function relative(list: Placement[], a: string, b: string): number[][] {
  const rel: number[][] = [];
  for (const x of list.filter(q => q.stem === a)) {
    const same = list.filter(q => q.stem === b && q.R.every((v, i) => Math.abs(v - x.R[i]!) < 2e-3));
    const d = (q: Placement): number => Math.hypot(...q.p.map((v, i) => v - x.p[i]!));
    const near = same.filter(q => d(q) < 60).sort((u, v) => d(u) - d(v))[0];
    if (!near) continue;
    const w = near.p.map((v, i) => v - x.p[i]!);
    rel.push([0, 1, 2].map(j => x.R[j]! * w[0]! + x.R[3 + j]! * w[1]! + x.R[6 + j]! * w[2]!));
  }
  return rel;
}

describe.skipIf(!HAVE)('Mecabricks Friends dolls in the local corpus', () => {
  it('draw their hips at LDraw 92248\'s place under the torso and a real 92198 head over it', () => {
    const hips: number[][] = [], heads: number[][] = [], raw: string[] = [];
    for (const f of FILES) {
      const list = placements(f);
      hips.push(...relative(list, '92241', '92248'));
      heads.push(...relative(list, '92241', '92198'));
      raw.push(...list.filter(q => /^(94590|28650)(d\d+)?$/.test(q.stem)).map(q => `${f}: ${q.stem}`));
    }
    expect(raw).toEqual([]);
    expect(hips.length).toBeGreaterThanOrEqual(10);
    expect(heads.length).toBeGreaterThanOrEqual(5);
    for (const h of hips) { expect(h[1]).toBeCloseTo(29.4, 0); expect(Math.abs(h[2]! + 1.2)).toBeLessThan(0.4); }
    for (const h of heads) { expect(h[1]).toBeCloseTo(-33.2, 0); expect(Math.abs(h[2]!)).toBeLessThan(0.4); }
  });
});
