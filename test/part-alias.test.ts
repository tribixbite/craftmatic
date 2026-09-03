/**
 * Offline tests for the part-name alias ladder (`partAliasCandidates` in
 * viewer/ldraw/parts.ts).
 *
 * Converted models name pieces by mould/decoration variants that exist in NO
 * LDraw library — mecabricks writes `3626d1024`/`30367v2`, BrickLink-lineage
 * sources write `6538c`/`4085d` and printed `98138pb042`. The ladder strips one
 * suffix group per hop so the resolver can fall back to a sibling mould or the
 * undecorated base instead of leaving a hole. Every candidate is verified
 * against the real library before use, so the risk of a hop is a wasted cache
 * lookup — but a hop that fires on a name it should NOT touch (a real part like
 * `3001` or a primitive like `1-4cyli`) would substitute wrong geometry, which
 * is what these tests pin down.
 */

import { describe, it, expect } from 'vitest';
import { partAliasCandidates } from '../web/src/viewer/ldraw/parts.js';

describe('partAliasCandidates', () => {
  it('strips mecabricks decoration and mould-version suffixes', () => {
    expect(partAliasCandidates('3626d1024')).toContain('3626');
    expect(partAliasCandidates('3814d444')).toContain('3814');
    expect(partAliasCandidates('30367v2')).toContain('30367');
  });

  it('strips lettered mould revisions (the corpus-wide top offenders)', () => {
    // 6538c/4085d/4589b/6628a alone account for ~11k orphaned placements.
    expect(partAliasCandidates('6538c')[0]).toBe('6538');
    expect(partAliasCandidates('4085d')[0]).toBe('4085');
    expect(partAliasCandidates('4589b')[0]).toBe('4589');
    expect(partAliasCandidates('6628a')[0]).toBe('6628');
    // A letter after a letter still peels one at a time: 3626av → 3626a → 3626.
    expect(partAliasCandidates('3626av')).toEqual(['3626a', '3626']);
  });

  it('strips print/pattern suffixes down to the plain part', () => {
    expect(partAliasCandidates('98138pb042')).toContain('98138');
    expect(partAliasCandidates('60169p1')).toContain('60169');
    expect(partAliasCandidates('973pb1137')).toContain('973');
    expect(partAliasCandidates('29p3')).toEqual(['29']);
    // Printed part on a lettered mould: the mould letter survives one hop, so
    // the closest match (3626c) is offered before the bare base.
    const h = partAliasCandidates('3626cpb0728');
    expect(h[0]).toBe('3626c');
    expect(h).toContain('3626');
  });

  it('chains suffixes (u9132v1d1 → u9132v1 → u9132)', () => {
    expect(partAliasCandidates('u9132v1d1')).toEqual(['u9132v1', 'u9132']);
  });

  it('offers nothing for names with no strippable suffix', () => {
    for (const stem of ['3001', '3023', 'x346', '88355', 'stud', 'bl_5093']) {
      expect(partAliasCandidates(stem), stem).toEqual([]);
    }
  });

  it('leaves LDraw primitive names alone', () => {
    // A primitive mangled into a "mould variant" would swap in wrong geometry
    // inside every part that references it — far worse than a missing part.
    for (const stem of ['1-4cyli', '1-4disc', '4-4cyli', '2-4ndis', 'stud4', 'box5']) {
      expect(partAliasCandidates(stem), stem).toEqual([]);
    }
  });

  it('maps re-tooled design ids that share no suffix with their LDraw name', () => {
    // The 10316 Rivendell class: LEGO re-tooled the mould and issued a new
    // design id; LDraw kept the original part number, so nothing is strippable.
    expect(partAliasCandidates('42923')[0]).toBe('63868');
    expect(partAliasCandidates('44860')[0]).toBe('60897');
    expect(partAliasCandidates('26169')[0]).toBe('4865b');
    expect(partAliasCandidates('49755')[0]).toBe('23443');
    // Decorated flag: the suffix hop lands on 72154, whose own lookup maps on
    // to the real LDraw flag — the resolver recurses, so one hop is enough here.
    expect(partAliasCandidates('72154d13')).toEqual(['72154']);
    expect(partAliasCandidates('72154')[0]).toBe('30292a');
  });

  it('leaves the deliberately-unmapped ids alone', () => {
    // 20926/20932 (2K leg halves) and 1000341 (a Mecabricks-internal sword id)
    // have no safe LDraw equivalent — see ldraw-part-aliases.ts. A hole is
    // honest; a misplaced substitute is not.
    for (const stem of ['20926', '20932', '1000341']) {
      expect(partAliasCandidates(stem), stem).toEqual([]);
    }
  });

  it('terminates and never repeats a candidate', () => {
    for (const stem of ['3626cpb0728', 'u9132v1d1', '4085d', '98138pb042v2']) {
      const out = partAliasCandidates(stem);
      expect(out.length).toBeLessThanOrEqual(4);
      expect(new Set(out).size).toBe(out.length);
      expect(out).not.toContain(stem);
      // Strictly shrinking guarantees the recursive resolver bottoms out.
      for (let i = 1; i < out.length; i++) expect(out[i]!.length).toBeLessThan(out[i - 1]!.length);
    }
  });
});
