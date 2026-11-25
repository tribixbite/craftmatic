/**
 * PROC-19 / audit A-16: the favourites gate must place the sizes a child can choose, not only the simulator's quick
 * default. `bun scripts/sim.ts` alone places 100 and 150 percent (`CHILD_PLAY_SIZES`): over the 2026-11-15 sweep it
 * passed 240 of 240 scenarios while 27 of 320 at 50, 200 and 400 percent failed in 15 packs. The gate
 * (`scripts/_favourites_gate.ts`) runs the sweep, then child play at `FAVOURITES_GATE_SIZES`, the vehicle course and
 * the regression set over the SAME directory, and writes one report.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MODELS_INDEX, packStem, readModelsIndex, sweepTargets } from '../scripts/favourite-sets.ts';
import { REGRESSIONS, regressionCasesForSets } from '../web/src/sim/adapters/craftmatic/regressions.ts';
import { FAVOURITES_GATE_SIZES, gateSteps } from '../scripts/_favourites_gate.ts';
import { CHILD_PLAY_SIZES } from '../web/src/sim/adapters/craftmatic/child-play.ts';

describe('favourites gate', () => {
  it('the favourites gate places every size the audit found failing (50, 200, 400) beside the default ones', () => {
    for (const s of [50, 100, 150, 200, 400]) expect(FAVOURITES_GATE_SIZES).toContain(s);
    for (const s of CHILD_PLAY_SIZES) expect(FAVOURITES_GATE_SIZES).toContain(s);
  });

  it('runs the sweep, child play at the gate sizes, the vehicle course and the regressions over one directory', () => {
    const steps = gateSteps({ dir: 'output/favgate-x', sets: [], withGabby: true, build: true });
    expect(steps.map(s => s.name)).toEqual(['sweep', 'child-play', 'vehicles', 'regressions']);
    const [sweep, play, vehicles, regressions] = steps;
    expect(sweep!.argv).toEqual(['scripts/_favorites_export_sweep.ts', '--out', 'output/favgate-x', '--with-gabby', '--with-regressions']);
    expect(play!.argv).toContain(`--sizes=${FAVOURITES_GATE_SIZES.join(',')}`);
    expect(play!.argv[1]).toBe('output/favgate-x');
    expect(vehicles!.argv).toContain('--scenario=vehicles');
    expect(regressions!.argv).toContain('--scenario=regressions');
    expect(regressions!.argv).toContain('--new=output/favgate-x');
    // Each simulator step writes its own JSON beside the packs, for the report.
    for (const s of [play, vehicles, regressions]) expect(s!.argv.some(a => a.startsWith('--json=output/favgate-x/'))).toBe(true);
  });

  it('the gate build makes every pack the regression set names (newStem), fixtures included, and passes --faces through', () => {
    // favgate-e7da6e47 left 10 regressions NOT TESTED: the sweep built no 7140 X-wing and no nimbus fixture.
    const sweep = gateSteps({ dir: 'd', sets: [], withGabby: false, build: true, faces: 'C:/faces' })[0]!;
    expect(sweep.argv).toContain('--with-regressions');
    expect(sweep.argv).toContain('--faces=C:/faces');
    const plan = sweepTargets({ sets: [], withGabby: false, regressionStems: REGRESSIONS.map(c => c.newStem) });
    const index = existsSync(MODELS_INDEX) ? readModelsIndex() : undefined;
    const missing: string[] = [];
    for (const stem of new Set(REGRESSIONS.map(c => c.newStem))) {
      if (plan.fixtures.some(f => f.stem === stem)) continue;
      const set = plan.sets.find(s => stem === s || stem.startsWith(`${s}-`));
      // With the models index here, the set must also be WRITTEN under that stem (its LEGO-tab name).
      if (!set || (index && packStem(set, index[set]?.name) !== stem)) missing.push(stem);
    }
    expect(missing).toEqual([]);
    expect(plan.unknown).toEqual([]);
    for (const f of plan.fixtures) expect(existsSync(f.file)).toBe(true);
  });

  it('without --build the packs already in the directory are judged, and named sets narrow the sweep', () => {
    expect(gateSteps({ dir: 'd', sets: [], withGabby: false, build: false }).map(s => s.name)).toEqual(['child-play', 'vehicles', 'regressions']);
    expect(gateSteps({ dir: 'd', sets: ['10303', '42639'], withGabby: false, build: true })[0]!.argv).toEqual(['scripts/_favorites_export_sweep.ts', '10303', '42639', '--out', 'd']);
  });

  it('named sets judge only their own regression cases and pass when they have no vehicle (PROC-20)', () => {
    // fav4-1124 gate-a (11377 and 6167, since corrected to 10316): the named-set build made only those packs, so 47 regression cases were NOT
    // TESTED for want of theirs and the vehicle course failed on 'no scripted vehicles' - two false FAILs.
    const steps = gateSteps({ dir: 'd', sets: ['11377', '10316'], withGabby: false, build: true });
    const vehicles = steps.find(s => s.name === 'vehicles')!, regressions = steps.find(s => s.name === 'regressions')!;
    expect(vehicles.argv).toContain('--allow-none');
    expect(regressions.argv).toContain('--sets=11377,10316');
    // The whole gate keeps both strict.
    const all = gateSteps({ dir: 'd', sets: [], withGabby: false, build: true });
    expect(all.find(s => s.name === 'vehicles')!.argv).not.toContain('--allow-none');
    expect(all.find(s => s.name === 'regressions')!.argv.some(a => a.startsWith('--sets='))).toBe(false);
  });

  it('regressionCasesForSets keeps the cases whose pack is one of the sets', () => {
    const picked = regressionCasesForSets(REGRESSIONS, ['10261']);
    expect(picked.length).toBeGreaterThan(0);
    for (const c of picked) expect(c.newStem.startsWith('10261-')).toBe(true);
    expect(regressionCasesForSets(REGRESSIONS, ['10316'])).toEqual([]);
  });
});
