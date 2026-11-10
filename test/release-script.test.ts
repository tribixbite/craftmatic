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
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

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

/**
 * `prepare` without blocking the worker's event loop: a describe body that spawns several 15 s builds synchronously
 * holds the loop past vitest's 60 s RPC timeout ("Timeout calling onTaskUpdate") with every test green.
 */
function prepareAsync(root: string, args: string[], env: Record<string, string> = {}): Promise<SpawnSyncReturns<string>> {
  return new Promise(done => {
    const child = spawn('bun', [SCRIPT, 'prepare', ...args], { cwd: REPO, env: { ...process.env, CRAFTMATIC_RELEASE_ROOT: root, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    child.on('close', status => done({ status, stdout, stderr } as SpawnSyncReturns<string>));
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
const fixtureCommitted = git(REPO, 'ls-files', 'test/fixtures/release/root').stdout.trim() !== '';
const e2eReady = treeClean && fixtureCommitted && existsSync(join(LDRAW_REF, '_archives', 'complete.zip'));
const e2eReason = !treeClean ? 'tracked tree is dirty' : !fixtureCommitted ? 'fixture not committed' : !existsSync(join(LDRAW_REF, '_archives', 'complete.zip')) ? 'no local LDraw mirror' : 'ready';

/** The committed fixture data root copied to a scratch folder with this machine's pins filled in. */
function fixtureData(): string {
  const data = freshDir('data');
  cpSync(join(REPO, 'test', 'fixtures', 'release', 'root'), data, { recursive: true });
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
    expect(first.r.status, first.r.stdout + first.r.stderr).toBe(0);
    const v = JSON.parse(readFileSync(join(first.out, 'validation.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail: string }> };
    const bad = v.gates.filter(g => g.status === 'fail');
    expect(bad).toEqual([]);
    for (const g of v.gates.filter(x => x.status === 'skipped' || x.status === 'not-run')) expect(g.detail.length).toBeGreaterThan(10);
  });

  it('two prepares of one commit give the identical .mcaddon sha256', () => {
    expect(second.r.status, second.r.stdout + second.r.stderr).toBe(0);
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

  it('flags only the simulator stage as waiting (M14); M03 and M07 are real gates that pass', () => {
    const v = JSON.parse(readFileSync(join(first.out, 'validation.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail: string }> };
    const sim = v.gates.find(x => x.id === 'sim');
    expect(sim?.status).toBe('skipped');
    expect(sim?.detail).toMatch(/M14/);
    for (const id of ['brick-blocks', 'placement']) expect(v.gates.find(x => x.id === id)?.status, id).toBe('pass');
  });

  it('a release profile needs no waiver: the validator and the budget pass outright', () => {
    const v = JSON.parse(readFileSync(join(first.out, 'validation.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail: string }> };
    expect(JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'release', 'root', 'gate-waivers.json'), 'utf8'))).toEqual([]);
    for (const id of ['release-validator', 'budget']) expect(v.gates.find(x => x.id === id)?.status, id).toBe('pass');
  });
});

/* -- finalize, verify, status ------------------------------------------------------------------------------ */

/**
 * A local clone of this repo at HEAD: `finalize` needs a TAG, and a test must not leave tags in the real repo. The
 * clone shares node_modules (a junction) so the build worktree it creates can run.
 */
function cloneRepo(): string {
  const dir = join(freshDir('clone'), 'repo');
  expect(spawnSync('git', ['clone', '-q', '--local', REPO, dir], { encoding: 'utf8' }).status).toBe(0);
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'junction');
  return dir;
}

/** Any release.ts command, asynchronously (see `prepareAsync`). */
function releaseCmd(root: string, args: string[], env: Record<string, string>): Promise<SpawnSyncReturns<string>> {
  return new Promise(done => {
    const child = spawn('bun', [SCRIPT, ...args], {
      cwd: REPO,
      env: { ...process.env, CRAFTMATIC_RELEASE_ROOT: root, CRAFTMATIC_LDRAW_REF: LDRAW_REF, CRAFTMATIC_RELEASE_WORKTREES: join(SCRATCH, 'worktrees'), CRAFTMATIC_RELEASE_MCT: 'skip-for-test', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    child.on('close', status => done({ status, stdout, stderr } as SpawnSyncReturns<string>));
  });
}

describe.skipIf(!e2eReady)(`release-script: finalize, verify and status on a tagged clone (${e2eReason})`, () => {
  const root = e2eReady ? cloneRepo() : '';
  const data = e2eReady ? fixtureData() : '';
  const releases = e2eReady ? freshDir('releases') : '';
  const env = { CRAFTMATIC_RELEASE_DATA: data, CRAFTMATIC_RELEASES_DIR: releases };
  const prepared = join(releases, 'fixture', '1.0.0');
  const run = (args: string[]): Promise<SpawnSyncReturns<string>> => releaseCmd(root, args, env);
  const tags = (): string[] => git(root, 'tag', '--list').stdout.split('\n').filter(Boolean);
  const out = (r: SpawnSyncReturns<string>): string => `${r.stdout}\n${r.stderr}`;
  let tampered = '';
  let ledgerRun = '';

  // Copies of the prepared release, made BEFORE anything is finalized: one with a single hex digit changed.
  beforeAll(async () => {
    const prep = await prepareAsync(root, ['fixture', '--version', '1.0.0', '--out', prepared], env);
    expect(prep.status, out(prep)).toBe(0);
    tampered = join(freshDir('tampered'), '1.0.0');
    ledgerRun = join(freshDir('ledgerrun'), '1.0.0');
    cpSync(prepared, tampered, { recursive: true });
    cpSync(prepared, ledgerRun, { recursive: true });
    const file = join(tampered, 'release.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as { artifacts: Array<{ sha256: string }> };
    const sha = record.artifacts[0]!.sha256;
    record.artifacts[0]!.sha256 = `${sha[0] === 'a' ? 'b' : 'a'}${sha.slice(1)}`;
    writeFileSync(file, JSON.stringify(record, null, 2));
  }, 600_000);

  it('status lists the prepared version before anything is finalized', async () => {
    const r = await run(['status']);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/^fixture 1\.0\.0\s+prepared\s+-\s+-/m);
  });

  it('finalize refuses while the user has not created the tag, and creates none', async () => {
    const r = await run(['finalize', 'fixture', '1.0.0']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/tag fixture-v1\.0\.0 does not exist/);
    expect(tags()).toEqual([]);
    expect(existsSync(join(prepared, 'finalize.json'))).toBe(false);
  });

  it('finalize rebuilds from the tag, finds identical bytes and records it, creating no tag', async () => {
    expect(git(root, 'tag', 'fixture-v1.0.0', 'HEAD').status).toBe(0);
    const r = await run(['finalize', 'fixture', '1.0.0', '--device-evidence', 'round-test']);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/identical/i);
    const fin = JSON.parse(readFileSync(join(prepared, 'finalize.json'), 'utf8')) as { tag: string; deviceEvidence: string; artifacts: unknown[] };
    expect(fin).toMatchObject({ tag: 'fixture-v1.0.0', deviceEvidence: 'round-test' });
    expect(fin.artifacts.length).toBe(2);
    expect(existsSync(join(prepared, 'ledger-entry.json'))).toBe(true);
    expect(tags()).toEqual(['fixture-v1.0.0']);
    // The rebuild went into a NEW folder beside the prepared release; the prepared one is untouched.
    expect(readdirSync(join(releases, 'fixture', 'rebuilds')).length).toBe(1);
  });

  it('finalize refuses a tag whose rebuild differs by one byte', async () => {
    const r = await run(['finalize', 'fixture', '1.0.0', '--prepared', tampered]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/differs: prepared sha256 [0-9a-f]{64}/);
    expect(existsSync(join(tampered, 'finalize.json'))).toBe(false);
    expect(existsSync(join(tampered, 'ledger-entry.json'))).toBe(false);
  });

  it('finalize --write-ledger appends the entry to the ledger file, and verify still passes afterwards', async () => {
    const r = await run(['finalize', 'fixture', '1.0.0', '--prepared', ledgerRun, '--write-ledger']);
    expect(r.status, out(r)).toBe(0);
    const ledger = JSON.parse(readFileSync(join(data, 'identity-ledger.json'), 'utf8')) as Array<{ product: string; version: string; sha256: Record<string, string>; blockIds: string[] }>;
    expect(ledger.map(e => `${e.product} ${e.version}`)).toEqual(['fixture 1.0.0']);
    expect(Object.keys(ledger[0]!.sha256).sort()).toEqual(['fixture-1.0.0.mcaddon', 'fixture-1.0.0.zip']);
    expect(ledger[0]!.blockIds.some(id => id.includes(':brick_white'))).toBe(true);
    const v = await run(['verify', 'fixture', '1.0.0']);
    expect(v.status, out(v)).toBe(0);
    expect(v.stdout).toMatch(/identical/i);
  });

  it('status then lists the version as finalized and released', async () => {
    const r = await run(['status', 'fixture']);
    expect(r.stdout).toMatch(/^fixture 1\.0\.0\s+prepared\s+finalized\s+released\s+tag fixture-v1\.0\.0/m);
  });

  it('verify refuses a prepared release whose hashes do not match the rebuild, and writes nothing into it', async () => {
    const before = readdirSync(tampered).sort();
    const r = await run(['verify', 'fixture', '1.0.0', '--prepared', tampered]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/differs/);
    expect(readdirSync(tampered).sort()).toEqual(before);
  });
});

/* -- .io and .lxf models through the import service ------------------------------------------------------------ */

const LXFML_TWO = '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n<LXFML versionMajor="5" versionMinor="0" name="t"><Bricks>'
  + '<Brick refID="0" designID="3001"><Part refID="0" designID="3001" materials="21,0"><Bone refID="0" transformation="1,0,0,0,1,0,0,0,1,0,0,0"/></Part></Brick>'
  + '<Brick refID="1" designID="3020"><Part refID="1" designID="3020" materials="24,0"><Bone refID="1" transformation="1,0,0,0,1,0,0,0,1,0,1,0"/></Part></Brick>'
  + '</Bricks></LXFML>';

describe.skipIf(!e2eReady)(`release-script: .io and .lxf models end to end (${e2eReason})`, () => {
  const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
  const cottage = readFileSync(join(REPO, 'test', 'fixtures', 'release', 'root', 'models', 'fixture-cottage.ldr'), 'utf8');

  /** A fresh data root whose product builds `modelName` (a file the caller writes into models/). */
  function dataFor(modelName: string, bytes: Uint8Array): string {
    const dir = fixtureData();
    writeFileSync(join(dir, 'models', modelName), bytes);
    const sidecar = join(dir, 'builds', 'fixture.json');
    writeFileSync(sidecar, JSON.stringify({ ...JSON.parse(readFileSync(sidecar, 'utf8')), model: `models/${modelName}` }, null, 2));
    return dir;
  }
  const sha = (out: string): string => readFileSync(join(out, 'SHA256SUMS'), 'utf8').split('\n').filter(l => /\.mcaddon$/.test(l)).join('');
  let reference: { r: SpawnSyncReturns<string>; out: string };
  let io: typeof reference;
  let lxf: typeof reference;
  /** `runFixture`, asynchronously. */
  const runAsync = async (data: string): Promise<typeof reference> => {
    const out = join(freshDir('out'), 'release');
    const r = await prepareAsync(REPO, ['fixture', '--version', '1.0.0', '--out', out], {
      CRAFTMATIC_RELEASE_DATA: data, CRAFTMATIC_RELEASE_WORKTREES: join(SCRATCH, 'worktrees'), CRAFTMATIC_LDRAW_REF: LDRAW_REF, CRAFTMATIC_RELEASE_MCT: 'skip-for-test',
    });
    return { r, out };
  };
  beforeAll(async () => {
    const { createZip } = await import('../web/src/engine/zip-utils.js');
    reference = await runAsync(fixtureData());
    io = await runAsync(dataFor('fixture-cottage.io', await createZip([{ name: 'model.ldr', data: enc(cottage) }])));
    lxf = await runAsync(dataFor('two-bricks.lxf', await createZip([{ name: 'IMAGE100.LXFML', data: enc(LXFML_TWO) }])));
  }, 900_000);

  it('an .io of the same model builds the byte-identical archive as the .ldr', () => {
    expect(io.r.status, io.r.stdout + io.r.stderr).toBe(0);
    expect(sha(io.out)).toMatch(/\.mcaddon$/);
    expect(sha(io.out)).toBe(sha(reference.out));
    expect((JSON.parse(readFileSync(join(io.out, 'validation.json'), 'utf8')) as { gates: Array<{ id: string; detail: string }> }).gates.find(g => g.id === 'model')?.detail).toMatch(/from a \.io/);
  });

  it('an .lxf builds a release whose model gate reports the import', () => {
    expect(lxf.r.status, lxf.r.stdout + lxf.r.stderr).toBe(0);
    const gates = (JSON.parse(readFileSync(join(lxf.out, 'validation.json'), 'utf8')) as { gates: Array<{ id: string; status: string; detail: string }> }).gates;
    expect(gates.find(g => g.id === 'model')).toMatchObject({ status: 'pass', detail: expect.stringMatching(/2 bricks from a \.lxf/) });
    expect(gates.filter(g => g.status === 'fail')).toEqual([]);
  });
});
