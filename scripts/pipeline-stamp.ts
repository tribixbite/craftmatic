/**
 * Compute the export pipeline's PROVENANCE STAMP from the working tree.
 *
 * Node-only: reads sources and asks git. `web/vite.config.ts` runs it at build
 * time and injects the result as `__PIPELINE_STAMP__`; the CLI exporters
 * (`scripts/_playable_ref.ts`) run it directly. The browser never sees this
 * file — `web/src/engine/pipeline-version.ts` is the consumer side.
 *
 *   bun scripts/pipeline-stamp.ts            # print the stamp as JSON
 *   bun scripts/pipeline-stamp.ts --files    # also list the closure
 *
 * What "the relevant files" are is not a hand-kept list: it is the transitive
 * import closure of the export entry points (`PIPELINE_ROOTS`), walked over
 * the same alias table Vite uses. A new module the pipeline starts importing
 * joins the closure on its own; a module nobody imports any more leaves it.
 *
 * The identity is a content hash, not an mtime and not a commit:
 *   - mtimes are not preserved by clone/checkout, so they differ per machine
 *     and per CI run for identical code;
 *   - "last commit touching the files" is reproducible but blind to
 *     uncommitted edits (how most device packs are built) and wrong in a
 *     shallow clone, where the only commit is HEAD;
 *   - a content hash over LF-normalised sources is identical everywhere,
 *     needs no git, and changes exactly when the pipeline's code changes.
 * Git is still consulted, for the HUMAN half: the short sha + date of the last
 * commit touching the closure (what the pack name shows), whether the closure
 * is dirty against it (and which files), HEAD, and whether the clone is
 * shallow. All of that is optional; without git the hash alone is reported.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PipelineStamp } from '../web/src/engine/pipeline-version.ts';

/** Repository root (this file lives in `<root>/scripts/`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Entry points of everything that can produce a Bedrock pack. `schem-worker.ts`
 * is what the browser runs; `schem-pipeline.ts` is the shared body the CLI
 * calls directly; the rest are the pack builders it reaches lazily (dynamic
 * imports are walked too, but naming them keeps the roots honest if that
 * changes).
 */
export const PIPELINE_ROOTS: readonly string[] = [
  'web/src/engine/schem-worker.ts',
  'web/src/engine/schem-pipeline.ts',
  'web/src/engine/playable-addon.ts',
  'web/src/engine/mcpack.ts',
  'web/src/engine/bedrock-placement-pack.ts',
  'web/src/engine/pipeline-version.ts',
];

/** The alias table from `web/tsconfig.json` / `web/vite.config.ts`, repo-relative. */
const ALIASES: ReadonlyArray<readonly [prefix: string, dir: string]> = [
  ['@engine/', 'web/src/engine/'],
  ['@viewer/', 'web/src/viewer/'],
  ['@ui/', 'web/src/ui/'],
  ['@craft/', 'src/'],
];

/** Every `from '…'`, `import '…'` and `import('…')` specifier in a module. */
const IMPORT_RE = /\b(?:from|import)\s*\(?\s*['"]([^'"\n]+)['"]/g;

const toPosix = (p: string): string => p.split(sep).join('/');

/**
 * Resolve one import specifier to a repo-relative file, or null when it is
 * external (a bare package, `node:*`) or does not exist on disk.
 */
function resolveSpecifier(spec: string, fromFile: string, root: string): string | null {
  const clean = spec.replace(/[?#].*$/, '');
  let target: string | null = null;
  if (clean.startsWith('.')) target = resolve(root, dirname(fromFile), clean);
  else {
    const alias = ALIASES.find(([prefix]) => clean.startsWith(prefix));
    if (!alias) return null;
    target = resolve(root, alias[1], clean.slice(alias[0].length));
  }
  const candidates = /\.(m?js)$/.test(target)
    ? [target.replace(/\.m?js$/, '.ts'), target]
    : /\.(ts|json|mjs|css|svg|txt)$/.test(target)
      ? [target]
      : [`${target}.ts`, `${target}/index.ts`, target];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return toPosix(relative(root, c));
  }
  return null;
}

/**
 * Transitive import closure of `roots`, sorted, repo-relative with `/`.
 * Files are read as text; the walk is exact for our own sources and merely
 * generous elsewhere (an import mentioned in a comment resolves to a real
 * file or is skipped — either way the result is deterministic).
 */
export function pipelineClosure(root = REPO_ROOT, roots: readonly string[] = PIPELINE_ROOTS): string[] {
  const seen = new Set<string>();
  const queue = roots.map(r => toPosix(r)).filter(r => existsSync(resolve(root, r)));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(m?js|ts)$/.test(file)) continue;
    const text = readFileSync(resolve(root, file), 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const hit = resolveSpecifier(m[1]!, file, root);
      if (hit && !seen.has(hit)) queue.push(hit);
    }
  }
  return [...seen].sort();
}

/**
 * sha256/12 over `path\0content\0` for each closure file, content with CRLF
 * folded to LF. The repo holds BOTH endings in its blobs (`git ls-files --eol`
 * shows `i/crlf` beside `i/lf`), and a checkout under a different `autocrlf`
 * would otherwise change the hash without changing a line of code.
 */
export function pipelineContentHash(files: readonly string[], root = REPO_ROOT): string {
  const h = createHash('sha256');
  for (const file of files) {
    h.update(file); h.update('\0');
    h.update(readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n')); h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

/** Run git in `root`; null on any failure (no git, not a repo, bad args). */
function git(root: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.replace(/\r?\n$/, '');
}

/** Paths from `git status --porcelain=v1` lines (`XY path` / `XY old -> new`). */
function porcelainPaths(out: string): string[] {
  return out.split(/\r?\n/).filter(l => l.length > 3).map(l => {
    const p = l.slice(3);
    const arrow = p.lastIndexOf(' -> ');
    const path = arrow >= 0 ? p.slice(arrow + 4) : p;
    return path.startsWith('"') && path.endsWith('"') ? JSON.parse(path) as string : path;
  });
}

export interface StampOptions {
  /** Entry points; defaults to `PIPELINE_ROOTS`. */
  roots?: readonly string[];
  /** Stamp instant (tests pin it). */
  now?: Date;
  /** Skip git entirely (tests, or a tree that is not a checkout). */
  noGit?: boolean;
}

/** The stamp for the working tree at `root`. Never throws for git reasons. */
export function computePipelineStamp(root = REPO_ROOT, opts: StampOptions = {}): PipelineStamp & { closure: string[] } {
  const computedAt = (opts.now ?? new Date()).toISOString();
  const closure = pipelineClosure(root, opts.roots);
  if (!closure.length) {
    return { kind: 'unstamped', hash: null, files: 0, commit: null, date: null, head: null, headDate: null, dirty: false, dirtyFiles: [], treeDirty: false, shallow: false, computedAt, reason: `no pipeline root exists under ${root}`, closure };
  }
  const hash = pipelineContentHash(closure, root);
  const base: PipelineStamp & { closure: string[] } = { kind: 'stamped', hash, files: closure.length, commit: null, date: null, head: null, headDate: null, dirty: false, dirtyFiles: [], treeDirty: false, shallow: false, computedAt, closure };
  if (opts.noGit) return base;
  const head = git(root, ['rev-parse', '--short=8', 'HEAD']);
  if (!head) return base; // no git / not a repository / no commits yet
  const headDate = git(root, ['log', '-1', '--format=%cs', 'HEAD']);
  // The last commit that touched ANY closure file: the pack name's date + sha.
  const touch = git(root, ['log', '-1', '--format=%H %cs', '--', ...closure]);
  const [touchSha, touchDate] = touch ? touch.split(' ') : [null, null];
  // Dirty = a closure file differs from the index/HEAD, or is untracked.
  const dirtyFiles = porcelainPaths(git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...closure]) ?? '')
    .filter(p => closure.includes(p)).sort();
  const treeDirty = (git(root, ['status', '--porcelain=v1', '--untracked-files=no']) ?? '').trim().length > 0;
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']) === 'true';
  return {
    ...base,
    commit: touchSha ? touchSha.slice(0, 8) : head,
    date: touchDate ?? headDate,
    head, headDate,
    dirty: dirtyFiles.length > 0, dirtyFiles, treeDirty, shallow,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const { closure, ...stamp } = computePipelineStamp();
  console.log(JSON.stringify(process.argv.includes('--files') ? { ...stamp, closure } : stamp, null, 2));
}
