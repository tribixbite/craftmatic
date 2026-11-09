/**
 * `bun scripts/release.ts prepare <product>` (D-08, BIZ-56 / BIZ-51 / BIZ-54).
 *
 * The refusals run in a throwaway git repo (CRAFTMATIC_RELEASE_ROOT) so they never depend on the state of this
 * checkout. The end-to-end run builds the committed original fixture model in a NEW worktree of THIS repo, so it
 * needs a clean tracked tree and a local LDraw mirror (`CRAFTMATIC_LDRAW_REF`); without either it is skipped with
 * that reason in its name, never silently passed.
 *
 * Nothing here deletes anything: scratch repos, worktrees and output folders are left in place under `output/`
 * (gitignored) with a NEW name per run.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'release.ts');
const SCRATCH = join(REPO, 'output', 'release-script-test');
const LDRAW_REF = process.env.CRAFTMATIC_LDRAW_REF ?? 'C:/git/clego/ldraw_ref';

const git = (cwd: string, ...args: string[]): SpawnSyncReturns<string> =>
  spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

/** A NEW scratch folder name per call (never reused, never cleared). */
function freshDir(label: string): string {
  const dir = join(SCRATCH, `${label}-${Date.now()}-${randomBytes(3).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A committed throwaway repo holding `release/` data (and a bun.lock so pins can be computed). */
function scratchRepo(product: object): string {
  const dir = freshDir('repo');
  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'release', 'products'), { recursive: true });
  writeFileSync(join(dir, 'release', 'products', `${(product as { id: string }).id}.json`), `${JSON.stringify(product, null, 2)}\n`);
  writeFileSync(join(dir, 'release', 'identity-ledger.json'), '[]\n');
  writeFileSync(join(dir, 'bun.lock'), 'lock\n');
  git(dir, 'add', '-A');
  expect(git(dir, 'commit', '-q', '-m', 'seed').status).toBe(0);
  return dir;
}

function prepare(root: string, args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync('bun', [SCRIPT, 'prepare', ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 600_000,
    env: { ...process.env, CRAFTMATIC_RELEASE_ROOT: root, ...env },
  });
}

const sampler = JSON.parse(readFileSync(join(REPO, 'release', 'products', 'sampler.json'), 'utf8')) as Record<string, any>;

describe('release-script: preconditions', () => {
  it('prepare refuses a dirty tree', () => {
    const product = { ...sampler, identity: { ...sampler.identity, namespace: 'tst_sampler' }, placeholders: [] };
    const root = scratchRepo(product);
    writeFileSync(join(root, 'bun.lock'), 'lock changed after the commit\n');
    const r = prepare(root, ['sampler']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/working tree is not clean/i);
    expect(r.stderr).toContain('bun.lock');
  });

  it('prepare refuses the sampler product while its namespace is null (U1)', () => {
    const root = scratchRepo(sampler);
    const r = prepare(root, ['sampler']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/namespace is null/);
    expect(r.stderr).toContain('U1');
  });

  it('prepare refuses a product that still lists placeholders', () => {
    const product = { ...sampler, identity: { ...sampler.identity, namespace: 'tst_sampler' } };
    const root = scratchRepo(product);
    const r = prepare(root, ['sampler']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/placeholder/i);
    expect(r.stderr).toContain('publisher');
  });

  it('prepare refuses an unknown product and a missing id', () => {
    const root = scratchRepo(sampler);
    expect(prepare(root, ['nonesuch']).status).toBe(1);
    expect(prepare(root, []).status).toBe(2);
  });
});

describe('release-script: no upload code', () => {
  it('release sources contain no upload calls', () => {
    const sources = [
      join(REPO, 'scripts', 'release.ts'),
      ...readdirSync(join(REPO, 'web', 'src', 'release')).filter(f => /^(prepare.*|checksums)\.ts$/.test(f)).map(f => join(REPO, 'web', 'src', 'release', f)),
    ];
    expect(sources.length).toBeGreaterThan(1);
    const forbidden: Array<[string, RegExp]> = [
      ['fetch(', /\bfetch\s*\(/], ['butler', /\bbutler\b/i], ['wrangler', /wrangler/i], ['api.curseforge', /api\.curseforge/i],
      ['itch.io/api', /itch\.io\/api/i], ['git push', /git\s+push/], ['git tag', /git\s+tag/],
      ['git, push (argv form)', /['"]push['"]/], ['git, tag (argv form)', /\[\s*['"]tag['"]/],
    ];
    const hits = sources.flatMap(file => {
      const text = readFileSync(file, 'utf8');
      return forbidden.filter(([, re]) => re.test(text)).map(([name]) => `${file}: ${name}`);
    });
    expect(hits).toEqual([]);
  });
});

/* -- end to end ------------------------------------------------------------------------------------------- */

const treeClean = ((): boolean => {
  const s = git(REPO, 'status', '--porcelain', '--untracked-files=no');
  return s.status === 0 && s.stdout.trim() === '';
})();
const fixtureCommitted = git(REPO, 'ls-files', 'test/fixtures/release/data').stdout.trim() !== '';
const e2eReady = treeClean && fixtureCommitted && existsSync(join(LDRAW_REF, '_archives', 'complete.zip'));
const e2eReason = !treeClean ? 'tracked tree is dirty' : !fixtureCommitted ? 'fixture not committed' : !existsSync(join(LDRAW_REF, '_archives', 'complete.zip')) ? 'no local LDraw mirror' : 'ready';

/** The committed fixture data root copied to a scratch folder with this machine's pins filled in. */
function fixtureData(): string {
  const data = freshDir('data');
  cpSync(join(REPO, 'test', 'fixtures', 'release', 'data'), data, { recursive: true });
  const file = join(data, 'products', 'fixture.json');
  const product = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  product.toolchain.bun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout.trim();
  product.toolchain.lockfileSha256 = createHash('sha256').update(readFileSync(join(REPO, 'bun.lock'))).digest('hex');
  product.toolchain.ldrawLibrary.sha256 = createHash('sha256').update(readFileSync(join(LDRAW_REF, '_archives', 'complete.zip'))).digest('hex');
  writeFileSync(file, `${JSON.stringify(product, null, 2)}\n`);
  return data;
}

function runFixture(data: string): { r: SpawnSyncReturns<string>; out: string } {
  const out = join(freshDir('out'), 'release');
  const r = prepare(REPO, ['fixture', '--version', '1.0.0', '--out', out], {
    CRAFTMATIC_RELEASE_DATA: data,
    CRAFTMATIC_RELEASE_WORKTREES: join(SCRATCH, 'worktrees'),
    CRAFTMATIC_LDRAW_REF: LDRAW_REF,
    CRAFTMATIC_RELEASE_MCT: 'skip-for-test',
  });
  return { r, out };
}

describe.skipIf(!e2eReady)(`release-script: fixture product end to end (${e2eReason})`, () => {
  const data = e2eReady ? fixtureData() : '';
  const first = e2eReady ? runFixture(data) : null!;
  const second = e2eReady ? runFixture(data) : null!;
  const sumsOf = (out: string): string => readFileSync(join(out, 'SHA256SUMS'), 'utf8');

  it('prepares a release and every gate passes or is flagged with a reason', () => {
    expect(first.r.stderr + first.r.stdout).not.toMatch(/Error:/);
    expect(first.r.status).toBe(0);
    const v = JSON.parse(readFileSync(join(first.out, 'validation.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail: string }> };
    const bad = v.gates.filter(g => g.status === 'fail');
    expect(bad).toEqual([]);
    for (const g of v.gates.filter(x => x.status === 'skipped' || x.status === 'not-run')) expect(g.detail.length).toBeGreaterThan(10);
  });

  it('two prepares of one commit give the identical .mcaddon sha256', () => {
    expect(second.r.status).toBe(0);
    const pick = (out: string): string => sumsOf(out).split('\n').filter(l => /\.mcaddon$/.test(l)).join('');
    expect(pick(first.out)).toMatch(/^[0-9a-f]{64} {2}.*\.mcaddon$/);
    expect(pick(second.out)).toBe(pick(first.out));
  });

  it('SHA256SUMS verifies with sha256sum -c', () => {
    const r = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: first.out, encoding: 'utf8' });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toMatch(/\.mcaddon: OK/);
    expect(r.status).toBe(0);
  });

  it('APPROVAL.md lists every outward action unchecked', () => {
    const text = readFileSync(join(first.out, 'APPROVAL.md'), 'utf8');
    const items = text.split('\n').filter(l => /^- \[[ x]\] /.test(l));
    expect(items.length).toBeGreaterThanOrEqual(8);
    expect(items.every(l => l.startsWith('- [ ] '))).toBe(true);
    expect(text).toMatch(/git tag -a fixture-v1\.0\.0/);
  });

  it('writes the artifacts, the notices and a stub for every channel', () => {
    for (const f of ['CHANGELOG.md', 'NOTICE.txt', 'CREDITS-LDRAW.txt', 'release.json', 'validation.json', 'SHA256SUMS']) expect(existsSync(join(first.out, f)), f).toBe(true);
    expect(readdirSync(join(first.out, 'dist')).some(f => f.endsWith('.mcaddon'))).toBe(true);
    expect(readdirSync(join(first.out, 'dist')).some(f => f.endsWith('.zip'))).toBe(true);
    expect(readdirSync(join(first.out, 'channels')).sort()).toEqual(['affiliate', 'curseforge', 'itch', 'kofi', 'mcpedl', 'patreon', 'site']);
    expect(readFileSync(join(first.out, 'NOTICE.txt'), 'utf8')).toContain('NOT AN OFFICIAL MINECRAFT PRODUCT.');
  });

  it('flags the stages whose dependencies are not merged, with the reason', () => {
    const v = JSON.parse(readFileSync(join(first.out, 'validation.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail: string }> };
    for (const id of ['brick-blocks', 'placement', 'sim']) {
      const g = v.gates.find(x => x.id === id);
      expect(g?.status, id).toBe('skipped');
      expect(g?.detail).toMatch(/M03|M07|M14/);
    }
  });
});
