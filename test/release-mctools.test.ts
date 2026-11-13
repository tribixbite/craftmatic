/**
 * scripts/release-mctools.ts (X-06): the mct output parser and the not-run policy. mct itself is never spawned:
 * a fake runner stands in for `bunx @minecraft/creator-tools`.
 *
 * test/fixtures/mctools-output.txt and test/fixtures/mct/* are REAL recordings of `mct validate` 0.21.0 (2026-11-12) over
 * test/fixtures/mcaddon/release-ok.zip: the console output and the CSV report each suite writes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCT_SUITES, MCTOOLS_PACKAGE, MCTOOLS_VERSION, parseMctCsv, parseMctOutput, reportFromRun, unpackForMct, validateRelease, type MctRunResult } from '../scripts/release-mctools';

const ROOT = resolve(__dirname, '..');
const recorded = readFileSync(join(ROOT, 'test', 'fixtures', 'mctools-output.txt'), 'utf-8');
const ran = (stdout: string, exitCode = 0, stderr = ''): MctRunResult => ({ exitCode, stdout, stderr });

describe('release-mctools', () => {
  const fx = (name: string): string => readFileSync(join(ROOT, 'test', 'fixtures', 'mct', name), 'utf-8');

  it('the console parser counts the Error lines of a real recording and skips the per-test summaries', () => {
    const p = parseMctOutput(recorded);
    // 6 CADDONIREQ + 2 CADDONREQ findings; the two "Test Fail: Found N errors in ..." lines are summaries.
    expect(p.errors).toBe(8);
    expect(p.warnings).toBe(0);
    expect(p.rules).toHaveLength(8);
    expect(p.rules[0]).toEqual({
      id: 'unknown',
      severity: 'error',
      message: 'JSON namespaced identifier is not in the expected form of creatorshortname_projectshortname:myitem: acme:slab - /Acme_Demo_BP/blocks/acme/demo/slab.json',
    });
  });

  it('the CSV parser reads Error and Warning rows with Test:TestId rule ids and ignores Info / Recommendation / Unknown', () => {
    const addon = parseMctCsv(fx('release-ok-addon.csv'));
    expect(addon.errors).toBe(8);
    expect(addon.warnings).toBe(0);
    expect(addon.rules[0]).toEqual({
      id: 'CADDONIREQ:112',
      severity: 'error',
      message: 'JSON namespaced identifier is not in the expected form of creatorshortname_projectshortname:myitem: acme:slab (/Acme_Demo_BP/blocks/acme/demo/slab.json)',
    });
    const main = parseMctCsv(fx('release-ok-main.csv'));
    expect(main.errors).toBe(1);
    expect(main.warnings).toBe(1);
    expect(main.rules.map((r) => `${r.severity} ${r.id}`)).toEqual(['error CPACKICON:101', 'warning UNLINK:191']);
    // An unquoted multi-value Data cell ("1,21,30") on an Info row must not derail the row.
    expect(parseMctCsv(fx('release-ok-main.csv')).rules.some((r) => r.id.startsWith('FORMATVER'))).toBe(false);
  });

  it('a run that carries CSV reports uses them, and the exit code does not matter (mct exits 4 on findings)', () => {
    expect(reportFromRun({ ...ran(fx('release-ok-main.stdout.txt'), 4), csv: [fx('release-ok-main.csv')] })).toMatchObject({ status: 'ran', errors: 1, warnings: 1 });
  });

  it('a missing EULA yields not-run with a reason', () => {
    const out = reportFromRun(ran('', 1, 'The Minecraft EULA has not been accepted. Run "mct eula" to accept it.'));
    expect(out.status).toBe('not-run');
    if (out.status === 'not-run') {
      expect(out.reason).toMatch(/needs user EULA acceptance/);
      expect(out.reason).toContain(MCTOOLS_PACKAGE);
    }
  });

  it('a failed bunx yields not-run with the first error line', () => {
    const out = reportFromRun(ran('', 1, 'TypeError: Cannot read properties of undefined (reading \'ReactCurrentOwner\')\n  at ...'));
    expect(out).toMatchObject({ status: 'not-run' });
    if (out.status === 'not-run') expect(out.reason).toMatch(/exit 1.*ReactCurrentOwner/);
  });

  it('a clean run with no findings is 0 errors, not not-run', () => {
    expect(reportFromRun(ran('Validation complete\n', 0))).toEqual({ status: 'ran', errors: 0, warnings: 0, rules: [] });
  });

  it('the version is pinned in one constant', () => {
    expect(MCTOOLS_VERSION).toBe('0.21.0');
    expect(MCTOOLS_PACKAGE).toBe(`@minecraft/creator-tools@${MCTOOLS_VERSION}`);
  });

  it('unpacks an archive into behavior_packs / resource_packs, runs every suite into its own folder and merges the CSVs', () => {
    const fixtureZip = join(ROOT, 'test', 'fixtures', 'mcaddon', 'release-ok.zip');
    expect(existsSync(fixtureZip)).toBe(true);
    const base = mkdtempSync(join(tmpdir(), 'mct-test-'));
    const seen: string[][] = [];
    const csvBySuite: Record<string, string> = { main: fx('release-ok-main.csv'), addon: fx('release-ok-addon.csv') };
    const report = validateRelease(fixtureZip, (args) => {
      seen.push(args);
      mkdirSync(args[args.indexOf('-o') + 1]!, { recursive: true }); // the real runner reads the CSVs back from here
      return { ...ran('', 4), csv: [csvBySuite[args[1]!]!] };
    }, base);
    expect(report).toMatchObject({ status: 'ran', errors: 9, warnings: 1 });
    expect(seen.map((a) => a[1])).toEqual([...MCT_SUITES]);
    expect(seen[0]!.slice(0, 1)).toEqual(['validate']);
    const project = seen[0]!.at(seen[0]!.indexOf('-i') + 1)!;
    expect(project.startsWith(base)).toBe(true);
    expect(seen[1]!.at(seen[1]!.indexOf('-i') + 1)).toBe(project);
    expect(seen[0]![seen[0]!.indexOf('-o') + 1]).not.toBe(seen[1]![seen[1]!.indexOf('-o') + 1]);
    expect(readdirSync(project).sort()).toEqual(['behavior_packs', 'resource_packs']);
    expect(existsSync(join(project, 'behavior_packs', 'Acme_Demo_BP', 'manifest.json'))).toBe(true);
    expect(existsSync(join(project, 'resource_packs', 'Acme_Demo_RP', 'textures', 'entity', 'acme', 'demo', 'thing.png'))).toBe(true);
    // a second unpack goes to a different NEW folder
    expect(unpackForMct(fixtureZip, base)).not.toBe(project);
  });

  it('a missing input is not-run, not a crash', () => {
    expect(validateRelease(join(tmpdir(), 'no-such-pack-x06.mcaddon'), () => ran('')).status).toBe('not-run');
  });
});
