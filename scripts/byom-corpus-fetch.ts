/**
 * Polite fetcher for the BYOM test corpus (BIZ-48 / WP B29).
 *
 *   bun scripts/byom-corpus-fetch.ts [--only=F01,P02] [--include-unlicensed] [--refetch]
 *
 * Reads `test/fixtures/byom-corpus.manifest.json` and downloads ONE item at a time into the gitignored
 * `data/byom-corpus/{files,photos}/<id>/`. Rules (plan B section 5):
 *  - at least 2.5 s between ANY two requests (robots.txt fetches included), strictly sequential;
 *  - robots.txt is read per host and honoured (a disallowed path is `skipped`, never fetched). One documented
 *    exception: Wikimedia's `/w/api.php`, the machine interface its API etiquette asks bots to use (see
 *    `ROBOTS_API_EXEMPT`); every other Wikimedia path still obeys robots.txt;
 *  - never logs in, never accepts terms: a 4xx, a login redirect or an HTML page where a file was expected is
 *    recorded as `unresolved` WITH its HTTP status, never as "absent";
 *  - a 429 waits out `Retry-After` (else 60 s doubling) before retrying;
 *  - items whose licence is not stated are `skipped` unless `--include-unlicensed` (then flagged import-only);
 *  - `manual` items print their exact steps and download nothing.
 * Nothing under `data/` is ever committed. Results (sha256, fetchedAt, licence per file) go to
 * `data/byom-corpus/results.json`, beside the bytes.
 */
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CORPUS_ROOT,
  corpusDirFor,
  isImportOnly,
  isInsideCorpus,
  safeFileName,
  validateManifest,
  type CorpusEntry,
} from '../web/src/engine/byom/corpus-manifest';

/** Product token matched against robots.txt `User-agent` lines. */
export const ROBOTS_TOKEN = 'craftmatic-corpus';
export const USER_AGENT = `${ROBOTS_TOKEN}-fetch/1.0 (local test corpus; https://github.com/tribixbite)`;
/** Minimum gap between two requests (plan B section 5). */
export const MIN_GAP_MS = 2500;
/** Per-file size cap: a corpus fixture larger than this is skipped, not downloaded blind. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Hosts+paths exempt from robots.txt because the operator documents them as THE interface for bots.
 * Wikimedia's robots.txt disallows `/w/` for `*`, yet https://www.mediawiki.org/wiki/API:Etiquette asks API clients
 * to send a descriptive User-Agent and work in series, which this client does. The plan (B section 5) names the
 * Commons `imageinfo` API as the source of per-file licences.
 */
export const ROBOTS_API_EXEMPT: readonly { host: string; pathPrefix: string }[] = [
  { host: 'commons.wikimedia.org', pathPrefix: '/w/api.php' },
];

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

/** Where downloaded bytes go; the real one writes under the repo root, tests keep them in memory. */
export interface FileSink {
  write(relPath: string, data: Uint8Array): Promise<void>;
}

export type ItemStatus = 'fetched' | 'partial' | 'unresolved' | 'skipped' | 'manual';

export interface FileRecord {
  /** Repo-relative path under data/byom-corpus. */
  path: string;
  sourceUrl: string;
  sha256: string;
  bytes: number;
  /** Licence for THIS file: the API/page value for Commons, else the manifest's stated licence. */
  licence: string;
  author?: string;
  importOnly: boolean;
  width?: number;
  height?: number;
}

export interface ItemResult {
  id: string;
  kind: CorpusEntry['kind'];
  status: ItemStatus;
  /** HTTP status of the failing request for `unresolved` (never absent for an HTTP failure). */
  httpStatus?: number;
  reason?: string;
  files: FileRecord[];
  /** Files seen but not downloaded (non-free licence, too large, wrong type). */
  skippedFiles?: { name: string; reason: string }[];
  fetchedAt: string;
}

export interface FetchContext {
  client: PoliteClient;
  sink: FileSink;
  print: (line: string) => void;
  includeUnlicensed: boolean;
}

/** `Disallow`/`Allow` matcher for one robots.txt and one agent token. */
export type RobotsRules = (pathAndQuery: string) => boolean;

/** Parses robots.txt (RFC 9309 subset: groups, Allow/Disallow, `*` and `$`, longest match, Allow wins ties). */
export function parseRobots(text: string, agentToken: string): RobotsRules {
  type Rule = { allow: boolean; re: RegExp; len: number };
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === 'allow' || field === 'disallow') && current && value !== '') {
      const body = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const anchored = body.endsWith('\\$') ? `${body.slice(0, -2)}$` : body;
      current.rules.push({ allow: field === 'allow', re: new RegExp(`^${anchored}`), len: value.length });
    }
  }
  const token = agentToken.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  return (pathAndQuery) => {
    let best: Rule | null = null;
    for (const r of rules) {
      if (!r.re.test(pathAndQuery)) continue;
      if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
    }
    return best ? best.allow : true;
  };
}

export interface HttpResult {
  /** HTTP status; 0 when no response arrived (network error) or robots forbade the request. */
  status: number;
  ok: boolean;
  body: Uint8Array;
  headers: Headers;
  finalUrl: string;
  /** Set when robots.txt forbade the request, so nothing was sent. */
  blockedByRobots?: boolean;
  error?: string;
}

export interface PoliteClientOptions {
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  minGapMs?: number;
  /** Attempts after a 429 before giving up (each waits out the window). */
  max429Retries?: number;
}

const EMPTY = new Uint8Array(0);

/** Sequential, paced, robots-honouring HTTP client. Never throws on an HTTP or network failure. */
export class PoliteClient {
  private lastAt = Number.NEGATIVE_INFINITY;
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private readonly gap: number;
  private readonly retries: number;

  constructor(private readonly opts: PoliteClientOptions) {
    this.gap = opts.minGapMs ?? MIN_GAP_MS;
    this.retries = opts.max429Retries ?? 4;
  }

  /** One paced request, 429s waited out. No robots check (used for robots.txt itself). */
  private async rawRequest(url: string): Promise<HttpResult> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastAt + this.gap - this.opts.now();
      if (wait > 0) await this.opts.sleep(wait);
      this.lastAt = this.opts.now();
      let res: Response;
      try {
        res = await this.opts.fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
      } catch (e) {
        return { status: 0, ok: false, body: EMPTY, headers: new Headers(), finalUrl: url, error: String(e) };
      }
      if (res.status === 429 && attempt < this.retries) {
        // Wait the window out: Retry-After seconds when given, else 60 s doubling.
        const given = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(given) && given > 0 ? given * 1000 : 60_000 * 2 ** attempt;
        await res.arrayBuffer().catch(() => undefined);
        await this.opts.sleep(waitMs);
        continue;
      }
      let body: Uint8Array = EMPTY;
      try {
        body = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        return { status: res.status, ok: false, body, headers: res.headers, finalUrl: res.url || url, error: String(e) };
      }
      return { status: res.status, ok: res.ok, body, headers: res.headers, finalUrl: res.url || url };
    }
  }

  private rulesFor(origin: string): Promise<RobotsRules> {
    let p = this.robots.get(origin);
    if (!p) {
      p = this.rawRequest(`${origin}/robots.txt`).then((r) => {
        if (r.status === 0 || r.status >= 500) return () => false; // RFC 9309: unreachable server = disallow all
        if (!r.ok) return () => true; // 4xx = no robots.txt
        return parseRobots(new TextDecoder().decode(r.body), ROBOTS_TOKEN);
      });
      this.robots.set(origin, p);
    }
    return p;
  }

  /** GET `url` once robots.txt allows it. */
  async get(url: string): Promise<HttpResult> {
    const u = new URL(url);
    const exempt = ROBOTS_API_EXEMPT.some((x) => x.host === u.host && u.pathname.startsWith(x.pathPrefix));
    if (!exempt) {
      const allowed = (await this.rulesFor(u.origin))(u.pathname + u.search);
      if (!allowed) {
        return { status: 0, ok: false, body: EMPTY, headers: new Headers(), finalUrl: url, blockedByRobots: true };
      }
    }
    return this.rawRequest(url);
  }
}

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** github.com blob/raw page URL -> raw.githubusercontent.com (the HTML site is not scraped). */
export function toRawGithub(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/.exec(url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}` : url;
}

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
const LOGIN_REDIRECT_RE = /\/(log-?in|sign-?in|signin|accounts\/login|session\/new)\b/i;
/** Licences Commons files may carry for us to keep: Creative Commons (any variant) or public domain. */
const COMMONS_OK_RE = /^(CC[ -]|Public domain|PD[ -]?|Attribution)/i;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface Outcome {
  status: ItemStatus;
  httpStatus?: number;
  reason?: string;
}

type DownloadMeta = Pick<FileRecord, "licence" | "author" | "width" | "height" | "importOnly">;

/** Downloads one file and records it; returns a failure outcome instead of throwing. */
async function download(
  ctx: FetchContext,
  entry: CorpusEntry,
  url: string,
  fileName: string,
  meta: DownloadMeta,
  expectHtml = false,
): Promise<{ file: FileRecord } | { fail: Outcome }> {
  const r = await ctx.client.get(url);
  if (r.blockedByRobots) return { fail: { status: 'skipped', reason: `robots.txt disallows ${new URL(url).pathname}` } };
  if (r.status === 0) return { fail: { status: 'unresolved', reason: `network error: ${r.error ?? 'no response'}` } };
  if (!r.ok) return { fail: { status: 'unresolved', httpStatus: r.status, reason: `HTTP ${r.status}` } };
  const type = r.headers.get('content-type') ?? '';
  if (!expectHtml && (/text\/html/i.test(type) || (LOGIN_REDIRECT_RE.test(new URL(r.finalUrl).pathname) && r.finalUrl !== url))) {
    return {
      fail: { status: 'unresolved', httpStatus: r.status, reason: 'got an HTML page or a login redirect (login/terms wall); not downloaded' },
    };
  }
  if (r.body.length > MAX_FILE_BYTES) {
    return { fail: { status: 'skipped', reason: `file is ${r.body.length} bytes, over the ${MAX_FILE_BYTES} cap` } };
  }
  const rel = `${corpusDirFor(entry)}/${safeFileName(fileName)}`;
  await ctx.sink.write(rel, r.body);
  return { file: { path: rel, sourceUrl: url, sha256: sha256Hex(r.body), bytes: r.body.length, ...meta } };
}

function summarise(entry: CorpusEntry, files: FileRecord[], fails: Outcome[], skipped: ItemResult['skippedFiles'], wanted: number): ItemResult {
  const base = { id: entry.id, kind: entry.kind, files, fetchedAt: new Date().toISOString() };
  const skippedFiles = skipped && skipped.length > 0 ? { skippedFiles: skipped } : {};
  if (files.length > 0 && files.length >= wanted && fails.length === 0) return { ...base, ...skippedFiles, status: 'fetched' };
  if (files.length > 0) {
    const f = fails[0];
    return { ...base, ...skippedFiles, status: 'partial', httpStatus: f?.httpStatus, reason: f?.reason };
  }
  const f = fails[0] ?? { status: 'unresolved' as ItemStatus, reason: 'nothing to download' };
  return { ...base, ...skippedFiles, status: f.status, httpStatus: f.httpStatus, reason: f.reason };
}

/** Fetches one manifest entry. Never throws; every outcome is a result row. */
export async function fetchEntry(entry: CorpusEntry, ctx: FetchContext): Promise<ItemResult> {
  const now = new Date().toISOString();
  const row = (status: ItemStatus, reason?: string): ItemResult => ({
    id: entry.id,
    kind: entry.kind,
    status,
    reason,
    files: [],
    fetchedAt: now,
  });

  if (entry.manual !== undefined || !entry.fetch) {
    ctx.print(`[${entry.id}] MANUAL ${entry.title} (${entry.licence})`);
    ctx.print(`    page:  ${entry.url}`);
    ctx.print(`    steps: ${entry.manual ?? 'none recorded'}`);
    ctx.print(`    save into: ${corpusDirFor(entry)}/`);
    return row('manual', 'needs a human: ' + (entry.manual ?? ''));
  }

  const strategy = entry.fetch;
  const importOnly = isImportOnly(entry);
  // Commons licences are read per file below; every other strategy is gated on the stated licence.
  if (strategy.type !== 'commons-category' && importOnly && !ctx.includeUnlicensed) {
    return row('skipped', `licence not stated (${entry.licence}); import-only items need --include-unlicensed`);
  }
  const meta: DownloadMeta = { licence: entry.licence, author: entry.author, importOnly };
  const files: FileRecord[] = [];
  const fails: Outcome[] = [];
  const skipped: NonNullable<ItemResult['skippedFiles']> = [];
  const take = async (url: string, name: string, m: DownloadMeta = meta, expectHtml = false): Promise<void> => {
    const out = await download(ctx, entry, url, name, m, expectHtml);
    if ('file' in out) files.push(out.file);
    else fails.push(out.fail);
  };

  switch (strategy.type) {
    case 'direct': {
      const url = strategy.url ?? toRawGithub(entry.url);
      await take(url, decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'file'));
      return summarise(entry, files, fails, skipped, 1);
    }
    case 'page-link': {
      const page = await ctx.client.get(entry.url);
      if (page.blockedByRobots) return row('skipped', `robots.txt disallows ${new URL(entry.url).pathname}`);
      if (!page.ok) return { ...row('unresolved', page.status ? `HTTP ${page.status}` : `network error: ${page.error}`), httpStatus: page.status || undefined };
      const html = new TextDecoder().decode(page.body);
      const re = new RegExp(`href="([^"]*${strategy.pattern}[^"]*)"`, 'i');
      const href = re.exec(html)?.[1];
      if (!href) return { ...row('unresolved', `no link matching /${strategy.pattern}/ on the page`), httpStatus: page.status };
      const target = new URL(href.replace(/&amp;/g, '&'), page.finalUrl).href;
      await take(target, decodeURIComponent(new URL(target).pathname.split('/').pop() ?? 'file'));
      return summarise(entry, files, fails, skipped, 1);
    }
    case 'github-tree': {
      const ref = strategy.ref ?? 'HEAD';
      const tree = await ctx.client.get(`https://api.github.com/repos/${strategy.repo}/git/trees/${ref}?recursive=1`);
      if (tree.blockedByRobots) return row('skipped', 'robots.txt disallows the GitHub API');
      if (!tree.ok) return { ...row('unresolved', tree.status ? `HTTP ${tree.status}` : `network error: ${tree.error}`), httpStatus: tree.status || undefined };
      const parsed = JSON.parse(new TextDecoder().decode(tree.body)) as { tree?: { path: string; type: string; size?: number }[] };
      const include = new RegExp(strategy.include);
      const exclude = strategy.exclude ? new RegExp(strategy.exclude) : null;
      const picked = (parsed.tree ?? [])
        .filter((n) => n.type === 'blob' && include.test(n.path) && !(exclude && exclude.test(n.path)))
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, strategy.max);
      if (picked.length === 0) {
        return { ...row('unresolved', `repo tree (${parsed.tree?.length ?? 0} entries) has no file matching /${strategy.include}/`), httpStatus: tree.status };
      }
      for (const n of picked) {
        await take(`https://raw.githubusercontent.com/${strategy.repo}/${ref}/${n.path.split('/').map(encodeURIComponent).join('/')}`, n.path.replace(/\//g, '__'));
      }
      return summarise(entry, files, fails, skipped, picked.length);
    }
    case 'commons-category': {
      const q = new URLSearchParams({
        action: 'query',
        format: 'json',
        generator: 'categorymembers',
        gcmtitle: `Category:${strategy.category}`,
        gcmtype: 'file',
        gcmlimit: '40',
        prop: 'imageinfo',
        iiprop: 'url|mime|size|extmetadata',
        iiurlwidth: '1280', // a standard Wikimedia thumbnail step; keeps every dimension below 2000 px for landscape shots
        iiextmetadatafilter: 'LicenseShortName|Artist|Credit|UsageTerms',
      });
      const api = await ctx.client.get(`https://commons.wikimedia.org/w/api.php?${q}`);
      if (!api.ok) return { ...row('unresolved', api.status ? `HTTP ${api.status}` : `network error: ${api.error}`), httpStatus: api.status || undefined };
      type Info = {
        url: string;
        thumburl?: string;
        mime?: string;
        thumbwidth?: number;
        thumbheight?: number;
        extmetadata?: Record<string, { value?: string }>;
      };
      const pages = Object.values(
        (JSON.parse(new TextDecoder().decode(api.body)) as { query?: { pages?: Record<string, { title: string; imageinfo?: Info[] }> } }).query?.pages ?? {},
      ).sort((a, b) => a.title.localeCompare(b.title));
      if (pages.length === 0) return { ...row('unresolved', 'the category API returned no files'), httpStatus: api.status };
      let wanted = 0;
      for (const page of pages) {
        if (wanted >= strategy.max) break;
        const name = page.title.replace(/^File:/, '');
        const info = page.imageinfo?.[0];
        const licence = info?.extmetadata?.LicenseShortName?.value?.trim() ?? '';
        if (!info) skipped.push({ name, reason: 'no imageinfo' });
        else if (!IMAGE_MIME.has(info.mime ?? '')) skipped.push({ name, reason: `type ${info.mime ?? 'unknown'} is not a photo format` });
        else if (!COMMONS_OK_RE.test(licence)) skipped.push({ name, reason: `licence "${licence || 'not stated'}" is not Creative Commons or public domain` });
        else {
          wanted++;
          const author = stripTags(info.extmetadata?.Artist?.value ?? info.extmetadata?.Credit?.value ?? '') || undefined;
          const before = files.length;
          await take(info.thumburl ?? info.url, name, { licence, author, width: info.thumbwidth, height: info.thumbheight, importOnly: false });
          if (files.length === before) skipped.push({ name, reason: fails[fails.length - 1]?.reason ?? 'download failed' });
        }
      }
      if (wanted === 0) return { ...summarise(entry, files, fails, skipped, 0), status: 'unresolved', reason: 'no file with an acceptable licence' };
      return summarise(entry, files, fails, skipped, wanted);
    }
  }
}

/** Disk sink: writes only inside `data/byom-corpus/` under `repoRoot`. */
export function diskSink(repoRoot: string): FileSink {
  return {
    async write(rel, data) {
      if (!isInsideCorpus(rel)) throw new Error(`refusing to write outside ${CORPUS_ROOT}: ${rel}`);
      const abs = path.join(repoRoot, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, data);
    },
  };
}

interface Args {
  only: string[] | null;
  includeUnlicensed: boolean;
  refetch: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { only: null, includeUnlicensed: false, refetch: false };
  for (const a of argv) {
    if (a.startsWith('--only=')) args.only = a.slice(7).split(',').filter(Boolean);
    else if (a === '--include-unlicensed') args.includeUnlicensed = true;
    else if (a === '--refetch') args.refetch = true;
    else throw new Error(`unknown option ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parseArgs(process.argv.slice(2));
  const manifest = validateManifest(JSON.parse(await readFile(path.join(repoRoot, 'test/fixtures/byom-corpus.manifest.json'), 'utf8')));
  if (manifest.errors.length > 0) throw new Error(`manifest invalid:\n${manifest.errors.join('\n')}`);

  const resultsPath = path.join(repoRoot, CORPUS_ROOT, 'results.json');
  let results: Record<string, ItemResult> = {};
  try {
    results = JSON.parse(await readFile(resultsPath, 'utf8')) as Record<string, ItemResult>;
  } catch {
    /* first run */
  }

  const client = new PoliteClient({ fetch: (u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(120_000) }), now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  const ctx: FetchContext = { client, sink: diskSink(repoRoot), print: (l) => console.log(l), includeUnlicensed: args.includeUnlicensed };

  for (const entry of manifest.entries) {
    if (args.only && !args.only.includes(entry.id)) continue;
    if (!args.refetch && results[entry.id]?.status === 'fetched') {
      console.log(`[${entry.id}] already fetched (${results[entry.id].files.length} files); use --refetch to redo`);
      continue;
    }
    const r = await fetchEntry(entry, ctx);
    results[entry.id] = r;
    if (r.status !== 'manual') {
      console.log(`[${entry.id}] ${r.status}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ''}: ${r.files.length} files${r.reason ? ` — ${r.reason}` : ''}`);
    }
    await mkdir(path.dirname(resultsPath), { recursive: true });
    await writeFile(resultsPath, JSON.stringify(results, null, 2));
  }

  const rows = Object.values(results);
  const count = (s: ItemStatus, k?: string): number => rows.filter((r) => r.status === s && (!k || r.kind === k)).length;
  console.log('\nsummary (distinct items):');
  for (const s of ['fetched', 'partial', 'unresolved', 'skipped', 'manual'] as const) {
    console.log(`  ${s}: ${count(s)} (models ${count(s, 'model')}, photo sets ${count(s, 'photos')})`);
  }
  console.log(`  files on disk: ${rows.reduce((n, r) => n + r.files.length, 0)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
