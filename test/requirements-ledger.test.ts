import { describe, expect, it } from 'vitest';
import { checkGuard, checkLedger, checkRepoLedger, parseLedger } from '../scripts/requirements-ledger.js';

/**
 * REQUIREMENTS.md is the master list of the user's requests. A row marked
 * DONE must name a guard that exists, so a deleted or renamed test cannot
 * leave a requirement looking protected while nothing checks it.
 */
describe('requirements ledger', () => {
  it('REQUIREMENTS.md parses, ids are unique and every DONE row has a live guard', () => {
    const { rows, problems } = checkRepoLedger();
    expect(problems).toEqual([]);
    expect(rows.length).toBeGreaterThan(100);
  });

  const table = (row: string) =>
    ['| id | requirement | status | implementation | guards | device | gap |', '|---|---|---|---|---|---|---|', row].join('\n');

  it('rejects a DONE row without a guard', () => {
    const { problems } = checkLedger(table('| `VEH-99` | x | DONE-OFFLINE | - | none | never | - |'));
    expect(problems.join('\n')).toContain('names no guard');
  });

  it('rejects a guard whose substring is not in the named test file', () => {
    // A fake reader: naming this file would find the needle in this very line.
    const read = () => 'it("the test that really exists")';
    expect(checkGuard('test/x.test.ts :: a renamed test', read)).toContain('not found');
    expect(checkGuard('test/gone.test.ts :: anything', () => undefined)).toContain('guard file missing');
  });

  it('accepts a live test guard, a sim guard and a user-scoped rule', () => {
    const read = (rel: string) => (rel === 'scripts/sim.ts' ? 'scenario vehicles' : 'it("real name")');
    expect(checkGuard('test/x.test.ts :: real name', read)).toBeUndefined();
    expect(checkGuard('sim:vehicles', read)).toBeUndefined();
    expect(checkGuard('rule:~/.claude/CLAUDE.md', () => undefined)).toBeUndefined();
  });

  it('flags unknown statuses, bad ids and duplicates', () => {
    const md = [
      '| id | requirement | status | implementation | guards | device | gap |',
      '|---|---|---|---|---|---|---|',
      '| `A-01` | x | MAYBE | - | none | never | - |',
      '| bad | x | OPEN | - | none | never | - |',
      '| `B-01` | x | OPEN | - | none | never | - |',
      '| `B-01` | y | OPEN | - | none | never | - |',
    ].join('\n');
    const problems = checkLedger(md).problems.join('\n');
    expect(problems).toContain('unknown status');
    expect(problems).toContain('bad id');
    expect(problems).toContain('duplicate id B-01');
    expect(parseLedger(md).rows.map((r) => r.id)).toEqual(['bad', 'B-01', 'B-01']);
  });
});
