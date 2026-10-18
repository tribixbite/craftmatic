/**
 * The Node side of pack provenance (`scripts/pipeline-stamp.ts`): the import
 * closure, the LF-normalised content hash, and the git facts. The git cases
 * run in a throwaway repository so they hold on any machine and in CI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PIPELINE_ROOTS, REPO_ROOT, computePipelineStamp, pipelineClosure, pipelineContentHash } from '../scripts/pipeline-stamp.ts';
import { pipelineStampText } from '../web/src/engine/pipeline-version.js';

const NOW = new Date('2026-09-23T10:11:12Z');

describe('pipeline closure of this repository', () => {
  const closure = pipelineClosure();
  it('starts at the pack builders and reaches their real dependencies through both alias schemes', () => {
    for (const root of PIPELINE_ROOTS) expect(closure).toContain(root);
    expect(closure).toContain('web/src/engine/ldraw-entity-compiler.ts'); // ./x.js
    expect(closure).toContain('web/src/engine/bedrock-coaster.ts');       // dynamic import('./x.js')
    expect(closure).toContain('src/schem/types.ts');                       // @craft/x.js
    expect(closure.length).toBeGreaterThan(40);
  });
  it('is sorted, unique and repo-relative with forward slashes', () => {
    expect(closure).toEqual([...new Set(closure)].sort());
    expect(closure.every(f => !f.includes('\\') && !f.startsWith('/') && !/^[A-Za-z]:/.test(f))).toBe(true);
  });
  it('produces the same stamp for the same tree, twice', () => {
    const a = computePipelineStamp(REPO_ROOT, { now: NOW, noGit: true });
    const b = computePipelineStamp(REPO_ROOT, { now: NOW, noGit: true });
    expect(a).toEqual(b);
    expect(a.kind).toBe('stamped');
    expect(a.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(a.files).toBe(closure.length);
  });
});

describe('content hash', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'pipeline-hash-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  const write = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };

  it('ignores CRLF vs LF but not a code change', () => {
    write('a.ts', "import { b } from './b.js';\nexport const a = b + 1;\n");
    write('b.ts', 'export const b = 1;\n');
    const lf = pipelineContentHash(pipelineClosure(dir, ['a.ts']), dir);
    write('b.ts', 'export const b = 1;\r\n');
    write('a.ts', "import { b } from './b.js';\r\nexport const a = b + 1;\r\n");
    expect(pipelineContentHash(pipelineClosure(dir, ['a.ts']), dir)).toBe(lf);
    write('b.ts', 'export const b = 2;\n');
    expect(pipelineContentHash(pipelineClosure(dir, ['a.ts']), dir)).not.toBe(lf);
  });
  it('reports unstamped when no root exists rather than hashing nothing', () => {
    const s = computePipelineStamp(dir, { roots: ['missing.ts'], now: NOW, noGit: true });
    expect(s.kind).toBe('unstamped');
    expect(s.reason).toContain('no pipeline root');
  });
});

describe('git facts in a throwaway repository', () => {
  let dir: string;
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (rel: string, text: string) => writeFileSync(join(dir, rel), text);
  const stamp = () => computePipelineStamp(dir, { roots: ['a.ts'], now: NOW });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pipeline-git-'));
    git('init', '-q', '-b', 'main');
    write('a.ts', "import { b } from './b.js';\nexport const a = b;\n");
    write('b.ts', 'export const b = 1;\n');
    write('README.md', 'unrelated\n');
    git('add', '.');
    git('commit', '-q', '-m', 'pipeline v1');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('stamps a clean tree with the commit and its date, and reads as clean', () => {
    const s = stamp();
    expect(s.kind).toBe('stamped');
    expect(s.dirty).toBe(false);
    expect(s.dirtyFiles).toEqual([]);
    expect(s.treeDirty).toBe(false);
    expect(s.shallow).toBe(false);
    expect(s.commit).toBe(git('rev-parse', '--short=8', 'HEAD'));
    expect(s.head).toBe(s.commit);
    expect(s.date).toBe(git('log', '-1', '--format=%cs'));
    expect(pipelineStampText(s)).toBe(`${s.date} ${s.commit}`);
  });

  it('reports an edited closure file as DIRTY with the same base commit and a new hash', () => {
    const clean = stamp();
    write('b.ts', 'export const b = 2;\n');
    const s = stamp();
    expect(s.dirty).toBe(true);
    expect(s.dirtyFiles).toEqual(['b.ts']);
    expect(s.commit).toBe(clean.commit);
    expect(s.hash).not.toBe(clean.hash);
    expect(pipelineStampText(s)).toBe(`2026-09-23 ${s.commit}+dirty`);
    expect(pipelineStampText(s)).not.toBe(pipelineStampText(clean));
  });

  it('counts an untracked module the pipeline now imports as dirty too', () => {
    write('c.ts', 'export const c = 3;\n');
    write('a.ts', "import { b } from './b.js';\nimport { c } from './c.js';\nexport const a = b + c;\n");
    const s = stamp();
    expect(s.dirtyFiles).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(s.files).toBe(3);
  });

  it('keeps the closure commit while HEAD advances on unrelated commits, and separates treeDirty from dirty', () => {
    git('add', '.');
    git('commit', '-q', '-m', 'pipeline v2');
    const v2 = stamp();
    expect(v2.dirty).toBe(false);
    write('README.md', 'unrelated edit\n');
    git('commit', '-q', '-am', 'docs only');
    write('README.md', 'unrelated uncommitted edit\n');
    const s = stamp();
    expect(s.head).toBe(git('rev-parse', '--short=8', 'HEAD'));
    expect(s.head).not.toBe(v2.commit);
    expect(s.commit).toBe(v2.commit);   // the last commit touching the closure, not HEAD
    expect(s.hash).toBe(v2.hash);       // same pipeline, same identity
    expect(s.dirty).toBe(false);        // the pack name stays clean…
    expect(s.treeDirty).toBe(true);     // …while the record admits the tree is not
  });

  it('flags a shallow clone, where the closure commit can only be HEAD', () => {
    const shallowDir = mkdtempSync(join(tmpdir(), 'pipeline-shallow-'));
    try {
      const r = spawnSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(dir).href, shallowDir], { encoding: 'utf8', windowsHide: true });
      expect(r.status, r.stderr).toBe(0);
      const s = computePipelineStamp(shallowDir, { roots: ['a.ts'], now: NOW });
      expect(s.shallow).toBe(true);
      expect(s.commit).toBe(s.head);
      expect(s.hash).toBe(stamp().hash); // content identity is unaffected by clone depth
    } finally {
      rmSync(shallowDir, { recursive: true, force: true });
    }
  });
});
