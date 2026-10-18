import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPhysicsSpec, parseSpec, tolerance, valueFromFragment } from '../scripts/_physics_spec_check.ts';

/**
 * docs/physics-architecture.md is the physics guide for people and agents; this
 * keeps it from drifting. The first test is the gate itself; the rest pin the
 * checker's own rules on a tiny synthetic repo so a checker bug cannot make the
 * gate pass vacuously.
 */
describe('physics architecture spec', () => {
  it('matches the code: paths, exports, constants and module discovery', async () => {
    const problems = await checkPhysicsSpec();
    // Printed in full so a failure says exactly which row to update.
    expect(problems, problems.join('\n')).toEqual([]);
  }, 60_000);
});

/** A throwaway repo with one physics module and a spec over it. */
function fixture(spec: string, module: string): string {
  const root = mkdtempSync(join(tmpdir(), 'physics-spec-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'web/src/engine'), { recursive: true });
  mkdirSync(join(root, 'web/src/ui'), { recursive: true });
  writeFileSync(join(root, 'docs/physics-architecture.md'), spec);
  writeFileSync(join(root, 'web/src/engine/ride-physics.ts'), module);
  return root;
}

const MODULE = [
  'export const RIDE = { GRAVITY: 19.6, DRAG: 0.008 } as const;',
  'export function stepRide(v: number): number { const loss = v * 0.25; return v - loss; }',
  'export interface RideState { v: number }',
].join('\n');

const specWith = (exportsRows: string, constantRows: string, extra = ''): string => [
  '# spec', extra,
  '<!-- physics-spec:exports web/src/engine/ride-physics.ts -->',
  '| Export | Kind | Role |', '|---|---|---|', exportsRows,
  '<!-- /physics-spec:exports -->',
  '<!-- physics-spec:constants -->',
  '| Constant | Where | Value | Units | Why |', '|---|---|---|---|---|', constantRows,
  '<!-- /physics-spec:constants -->',
].join('\n');

const GOOD_EXPORTS = '| `RIDE` | const | constants |\n| `stepRide` | function | the step |\n| `RideState` | interface | state |';
const GOOD_CONSTANTS = '| `RIDE.GRAVITY` | `web/src/engine/ride-physics.ts` | 19.6 | blocks/s² | 2 g |\n| step loss | `web/src/engine/ride-physics.ts` `const loss = v * §;` | 0.25 | fraction | test |';

describe('physics spec checker rules', () => {
  it('passes a spec that matches its module', async () => {
    expect(await checkPhysicsSpec(fixture(specWith(GOOD_EXPORTS, GOOD_CONSTANTS), MODULE))).toEqual([]);
  });

  it('fails on an undocumented export, a missing one and a wrong kind', async () => {
    const problems = await checkPhysicsSpec(fixture(specWith('| `RIDE` | function | constants |\n| `gone` | const | x |', GOOD_CONSTANTS), MODULE));
    expect(problems.some(p => /`RIDE` .* is a const, the spec says "function"/.test(p))).toBe(true);
    expect(problems.some(p => /does not export `gone`/.test(p))).toBe(true);
    expect(problems.some(p => /exports function `stepRide`, which .* does not document/.test(p))).toBe(true);
  });

  it('fails when a constant or a literal in a function body changed', async () => {
    const changed = MODULE.replace('19.6', '25.1').replace('0.25', '0.3');
    const problems = await checkPhysicsSpec(fixture(specWith(GOOD_EXPORTS, GOOD_CONSTANTS), changed));
    expect(problems.some(p => /`RIDE.GRAVITY` is 25.1 .* the spec says 19.6/.test(p))).toBe(true);
    expect(problems.some(p => /`step loss` is 0.3 .* the spec says 0.25/.test(p))).toBe(true);
  });

  it('fails on a missing path and on an unclassified physics-named module', async () => {
    const root = fixture(specWith(GOOD_EXPORTS, GOOD_CONSTANTS, 'See `web/src/engine/nowhere.ts`.'), MODULE);
    writeFileSync(join(root, 'web/src/engine/train-physics.ts'), 'export const X = 1;');
    const problems = await checkPhysicsSpec(root);
    expect(problems.some(p => /`web\/src\/engine\/nowhere.ts` does not exist/.test(p))).toBe(true);
    expect(problems.some(p => /train-physics.ts looks like a physics module/.test(p))).toBe(true);
  });

  it('compares at the written precision and needs an unambiguous fragment', () => {
    expect(tolerance('1.41421')).toBeCloseTo(5e-6, 10);
    expect(tolerance('100')).toBeCloseTo(0.5, 10);
    expect(Number.isNaN(tolerance('2 g'))).toBe(true);
    expect(valueFromFragment('a = 1; a = 2;', 'a = §;')).toMatch(/matches 2 places/);
    expect(valueFromFragment('speed ?? .3, max', 'speed ?? §, max')).toBe(0.3);
    expect(parseSpec('<!-- physics-spec:constants -->\n| a |').errors[0]).toMatch(/never closed/);
  });
});
