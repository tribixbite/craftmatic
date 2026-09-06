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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  partAliasCandidates,
  resolvePartGeometry,
  substitutedDatNames,
  clearMpdInlines,
} from '../web/src/viewer/ldraw/parts.js';

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

/**
 * The alias branch only runs on a cache MISS, and `datTextCache` is
 * module-level — it outlives a model load. So the record of what was
 * substituted must outlive the load too, or only the first model to use an
 * aliased name reports the swap and every one after it renders the substitute
 * silently. `clearMpdInlines()` (called at the top of every viewer.load) must
 * therefore leave `substitutedDatNames` alone.
 */
describe('substitution reporting survives a model load boundary', () => {
  let realFetch: typeof globalThis.fetch;
  beforeAll(() => {
    realFetch = globalThis.fetch;
    // `6538` exists, `6538c` (the lettered mould revision the model asks for)
    // does not — the exact shape of the corpus's top offender.
    globalThis.fetch = (async (url: string | URL) => {
      const stem = String(url).split('/').pop()!.replace(/\.dat$/i, '');
      if (stem === 'aliastest6538') return new Response('0 BFC CERTIFY CCW\n3 16 0 0 0  10 0 0  0 0 10', { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  it('still reports the substitution after clearMpdInlines()', async () => {
    const g1 = await resolvePartGeometry('aliastest6538c');
    expect(g1.tris.length, 'the alias must actually resolve').toBe(1);
    expect(substitutedDatNames.get('aliastest6538c')).toBe('aliastest6538');

    // A new model load: inlines are dropped, but the .dat text cache is not —
    // so the second resolve returns from cache without re-entering the ladder.
    clearMpdInlines();
    const g2 = await resolvePartGeometry('aliastest6538c');
    expect(g2.tris.length).toBe(1);
    expect(substitutedDatNames.get('aliastest6538c'), 'swap must not go silent on a later load').toBe('aliastest6538');
  });
});

/**
 * Root-cause note (2026-09-05, 71043 Hogwarts "scrambled render" prod
 * incident): this race was the PRIME SUSPECT — if the alias ladder were ever
 * kicked off concurrently with the exact-name candidate probe and the first
 * responder won, a slow-but-real exact match could lose to a fast-but-wrong
 * alias, silently displacing every instance of a part that actually exists.
 * Investigation DISPROVED it as the cause of that incident (the corpus's own
 * `!LINEAGE io_model2_v2 good`-stamped reconstruction for that set has real
 * baked-in floating/side-model placement defects — see CLAUDE.md; zero alias
 * substitutions were ever recorded during the broken load). But the hazard
 * the coordinator described is real IN PRINCIPLE and worth guarding
 * permanently: `partAliasCandidates()` must only ever be consulted after the
 * exact name's own candidate volley returns a definitive, unanimous miss —
 * never raced against it for speed.
 */
describe('exact-name resolution always wins over alias, regardless of fetch timing', () => {
  let realFetch: typeof globalThis.fetch;
  let aliasTargetFetchCount = 0;

  beforeAll(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const s = String(url);
      // The authoritative batch endpoint: report a miss for everything so the
      // per-path parallel-probe volley (the prod-relevant path) runs.
      if (s.includes('/_batch')) {
        return new Response(JSON.stringify({ found: {} }), { status: 200 });
      }
      const stem = s.split('/').pop()!.replace(/\.dat$/i, '');
      // The alias TARGET (what `racetest6538c` would hop to). Answers
      // INSTANTLY with different, recognizably-wrong content — if timing ever
      // decided the winner, this fast responder would win the race.
      if (stem === 'racetest6538') {
        aliasTargetFetchCount++;
        return new Response('0 BFC CERTIFY CCW\n3 16 0 0 0  99 0 0  0 0 99', { status: 200 });
      }
      // The EXACT requested name's real geometry — genuinely exists, but only
      // one candidate path answers, and only after a real delay (simulating a
      // slow-but-successful upstream fetch).
      if (stem === 'racetest6538c' && s.includes('/parts/racetest6538c.dat')) {
        await new Promise(res => setTimeout(res, 40));
        return new Response('0 BFC CERTIFY CCW\n3 16 0 0 0  10 0 0  0 0 10', { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  it('returns the slow exact match, never the fast alias, and records no substitution', async () => {
    const geom = await resolvePartGeometry('racetest6538c');
    // The exact part's own triangle (side length 10), not the alias's (99).
    expect(geom.tris.length).toBe(1);
    expect(geom.tris[0]![1][0]).toBeCloseTo(10);
    expect(substitutedDatNames.has('racetest6538c'), 'exact match must not be recorded as a substitution').toBe(false);
    expect(aliasTargetFetchCount, 'the alias ladder must never be consulted when the exact name resolves').toBe(0);
  });
});
