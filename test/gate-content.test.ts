/**
 * PROC-19 / generality census 2026-11-16: the favourites gate measures CONTENT, not only behaviour. The 60-set census
 * (`output/gengate-6fa0afa6`) passed its sweep with every pack "OK" while most of its figures wore the default face,
 * 2507 drew two placements as boxes and 51515 shipped 95 % of its placements coarsened - none of which any gate step
 * reported. `scripts/pack-content.ts` reads the sweep's per-set build reports (`<stem>.json`) into one row per pack
 * and the gate prints the totals and the worst packs. It REPORTS: content never fails the gate (the favourites keep
 * their own corpus floors, test/favourites-faces.test.ts).
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coarsenedShareOf, contentSection, contentTotals, packContent, readBuildReports } from '../scripts/pack-content.ts';
import { gateSteps } from '../scripts/_favourites_gate.ts';

/** A build report with the fields the content section reads, shaped as `_playable_ref.ts` prints them. */
const report = {
  label: 'Fire Temple (2507-1)',
  warnings: [
    'fire_2507_shell: 34 placements in 5 pieces do not touch the rest of the model; 34 parts in 5 pieces float more than a stud clear of it, up to 7.1 studs - those are loose in the SOURCE and will look like floating pieces in game (worst: ...)',
    'Frame: this export is the model in its true handedness',
  ],
  entities: {
    fire_2507_shell: {
      aabbFallbackParts: [{ part: '38117', count: 2, reason: 'no geometry resolved' }],
      unresolvedParts: ['38117'],
      substitutedParts: [{ part: '3626bpb0271', alias: '3626bp8i' }, { part: '973c01', alias: '973' }],
      defaultFaces: 2,
      orphans: { clusters: 5, placements: 34, floatingParts: 34, floatingGroups: 5, worstClearanceLdu: 142 },
      grainPlan: { requestedMicrocellLdu: 2, placementsAtGrain: { 2: 90, 4: 10 } },
    },
    fire_2507_figure_1: {
      aabbFallbackParts: [], unresolvedParts: [], substitutedParts: [], defaultFaces: 0,
      faceTextures: { printed: 1, art: 0, default: 1, atlas: [32, 16] },
      grainPlan: { requestedMicrocellLdu: 2, placementsAtGrain: { 2: 8 } },
    },
  },
};

describe('gate content section (PROC-19, generality census)', () => {
  it('reads one row per pack: boxed placements, unresolved and substituted parts, faces, loose parts, coarsening', () => {
    const row = packContent('2507-fire-temple', report);
    expect(row).toMatchObject({
      stem: '2507-fire-temple', label: 'Fire Temple (2507-1)', entities: 2,
      boxedPlacements: 2, boxedParts: ['38117'], unresolvedParts: ['38117'],
      substitutedParts: 2, headSubstitutions: 1,
      realFaces: 1, defaultFaces: 3, floatingParts: 34, looseWarnings: 1,
    });
    // 10 of 108 placements left the requested grain.
    expect(row.coarsenedShare).toBeCloseTo(10 / 108, 4);
  });

  it('measures the coarsened share as the sweep does (placements away from the requested grain)', () => {
    expect(coarsenedShareOf({ a: { grainPlan: { requestedMicrocellLdu: 2, placementsAtGrain: { 2: 3, 8: 1 } } } })).toBe(0.25);
    expect(coarsenedShareOf({ a: {} })).toBeNull();
  });

  it('totals the rows and names the worst packs per measure in the markdown section', () => {
    const clean = packContent('1-clean', { label: 'Clean', warnings: [], entities: { e: { faceTextures: { printed: 4, art: 0, default: 0, atlas: [1, 1] }, grainPlan: { requestedMicrocellLdu: 2, placementsAtGrain: { 2: 10 } } } } });
    const rows = [packContent('2507-fire-temple', report), clean];
    const t = contentTotals(rows);
    expect(t).toMatchObject({ packs: 2, boxedPlacements: 2, packsWithBoxes: 1, unresolvedParts: 1, realFaces: 5, defaultFaces: 3, floatingParts: 34 });
    const md = contentSection(rows);
    expect(md).toMatch(/^## content: reported, not judged/m);
    expect(md).toMatch(/real face 5 of 8/);
    expect(md).toMatch(/2507-fire-temple/);
    // The clean pack is never named as a worst pack.
    expect(md.split('### worst')[1] ?? '').not.toMatch(/1-clean/);
  });

  it('is not a gate step: the content section cannot fail the gate', () => {
    for (const build of [true, false]) expect(gateSteps({ dir: 'd', sets: [], withGabby: false, build }).map(s => s.name)).not.toContain('content');
  });
});

const CENSUS = 'C:/git/craftmatic/output/gengate-6fa0afa6';
describe.skipIf(!existsSync(`${CENSUS}/2507-fire-temple.json`))('gate content over the 2026-11-16 census (corpus)', () => {
  it('reads every build report in a sweep directory and none of the gate\'s own files', () => {
    const reports = readBuildReports(CENSUS);
    expect(reports.length).toBe(60);
    expect(reports.some(r => r.stem.startsWith('gate') || r.stem === 'summary')).toBe(false);
    const row = packContent('2507-fire-temple', reports.find(r => r.stem === '2507-fire-temple')!.report);
    expect(row.boxedParts).toEqual(['38117']);
  });
});

describe('the gate report carries the content section (PROC-19, 2026-11-16)', () => {
  // The first gate runs with the content code merged wrote no content section at all, and `--content-only` rewrote
  // gate.md with an empty body reading "passed", deleting the step results (output/gengate2-cda5f7b9).
  it('appends the content section after the step rows', async () => {
    const { withContentSection } = await import('../scripts/_favourites_gate.ts');
    const steps = '# Favourites gate\n\nDirectory: `x`; FAILED.\n\n## child-play: FAIL (exit 1), 6.8 min\n\nrows\n';
    const out = withContentSection(steps, '## content (reported, not judged)\n\ntotals\n');
    expect(out).toContain('## child-play: FAIL (exit 1)');
    expect(out).toContain('## content (reported, not judged)');
    expect(out.indexOf('## child-play')).toBeLessThan(out.indexOf('## content'));
  });

  it('a content-only run replaces only the content section and keeps the steps and their verdict', async () => {
    const { withContentSection } = await import('../scripts/_favourites_gate.ts');
    const first = withContentSection('# Favourites gate\n\nDirectory: `x`; FAILED.\n\n## vehicles: PASS, 0.7 min\n\nok\n', '## content (reported, not judged)\n\nold totals\n');
    const again = withContentSection(first, '## content (reported, not judged)\n\nnew totals\n');
    expect(again).toContain('FAILED');
    expect(again).toContain('## vehicles: PASS');
    expect(again).toContain('new totals');
    expect(again).not.toContain('old totals');
    expect(again.match(/## content/g)?.length).toBe(1);
  });
});
