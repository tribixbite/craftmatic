/**
 * scripts/release-mctools.ts (X-06): the mct output parser and the not-run policy. mct itself is never spawned:
 * a fake runner stands in for `bunx @minecraft/creator-tools`.
 *
 * NOTE: test/fixtures/mctools-output.txt is HAND-WRITTEN to the documented shape, not a recording: the live
 * 0.21.0 run did not get past a bunx dependency crash on the machine that wrote this (see the X-06 report).
 */
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCTOOLS_PACKAGE, MCTOOLS_VERSION, parseMctOutput, reportFromRun, unpackForMct, validateRelease, type MctRunResult } from '../scripts/release-mctools';

const ROOT = resolve(__dirname, '..');
const recorded = readFileSync(join(ROOT, 'test', 'fixtures', 'mctools-output.txt'), 'utf-8');
const ran = (stdout: string, exitCode = 0, stderr = ''): MctRunResult => ({ exitCode, stdout, stderr });

describe('release-mctools', () => {
  it('the parser counts Errors and Warnings on a recorded output fixture', () => {
    const p = parseMctOutput(recorded);
    expect(p.errors).toBe(2);
    expect(p.warnings).toBe(3);
    expect(p.rules).toHaveLength(5);
    expect(p.rules[0]).toEqual({
      id: 'ENTITY_MISSING_TEXTURE',
      severity: 'error',
      message: 'acme:thing: texture "textures/entity/acme/demo/thing" was not found in the resource pack.',
    });
    expect(p.rules.map((r) => r.id)).toEqual([
      'ENTITY_MISSING_TEXTURE',
      'BLOCK_STATE_TOO_MANY_VALUES',
      'PACK_ICON_MISSING',
      'MANIFEST_MIN_ENGINE_VERSION',
      'ANIMATION_UNUSED',
    ]);
    expect(reportFromRun(ran(recorded, 1))).toMatchObject({ status: 'ran', errors: 2, warnings: 3 });
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

  it('unpacks an archive into behavior_packs / resource_packs in a new folder and passes it to mct', () => {
    const fixtureZip = join(ROOT, 'test', 'fixtures', 'mcaddon', 'release-ok.zip');
    expect(existsSync(fixtureZip)).toBe(true);
    const base = mkdtempSync(join(tmpdir(), 'mct-test-'));
    let seenArgs: string[] = [];
    const report = validateRelease(fixtureZip, (args) => {
      seenArgs = args;
      return ran('Validation complete: 0 errors, 0 warnings', 0);
    }, base);
    expect(report).toEqual({ status: 'ran', errors: 0, warnings: 0, rules: [] });
    expect(seenArgs.slice(0, 2)).toEqual(['validate', '-i']);
    const project = seenArgs[2]!;
    expect(project.startsWith(base)).toBe(true);
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
