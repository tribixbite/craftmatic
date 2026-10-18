/**
 * Operator console server — `bun run console` (or `bun tools/console/server.ts`).
 *
 * Serves the single-page UI and a small JSON API over `node:http` (so the
 * same file runs under bun or node), streams job output over SSE, and shells
 * out to the REAL entry points listed in `inventory.ts`. Nothing here
 * re-implements a script; the only logic is selection, queueing and export.
 *
 *   bun tools/console/server.ts [--port 4600] [--host 127.0.0.1]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { OPERATIONS, STALE, GROUPS, operationById, CLEGO_ROOT } from './inventory.ts';
import { applyFilter, loadIndex, resolveItems, rowToItem, srcClasses } from './index-store.ts';
import { parseCsv, parseTextList, toCsv } from './csv.ts';
import { buildCommand, cwdFor, itemProblem, validateRequest, type OptionValues } from './command.ts';
import { GLOBAL_MAX, Runner } from './runner.ts';
import type { ConsoleEvent, IndexFilter, Operation, Run, Selection, SelectionItem } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..').replace(/\\/g, '/');
const ROOTS = { craftmatic: REPO, clego: CLEGO_ROOT, runsDir: `${REPO}/output/console-runs` };
const INDEX_PATH = `${REPO}/web/public/lego-models-index.json`;

const argFlag = (name: string, fallback: string): string => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] ?? fallback : fallback; };
const PORT = Number(argFlag('port', '4600'));
const HOST = argFlag('host', '127.0.0.1');

const index = loadIndex(INDEX_PATH);
const ops = new Map(OPERATIONS.map(o => [o.id, o]));
const runner = new Runner(ROOTS, ops);
runner.startSampler();

// ── SSE fan-out ──────────────────────────────────────────────────────────────
const clients = new Set<ServerResponse>();
runner.on('event', (e: ConsoleEvent) => {
  const payload = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(payload);
});

// ── helpers ──────────────────────────────────────────────────────────────────
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const text = (res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
};
const readBody = (req: IncomingMessage): Promise<string> => new Promise((ok, bad) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  req.on('error', bad);
});

/** Turn the request's selection description into concrete items (the index is never shipped to the client). */
function materialise(sel: { source: Selection['source']; filter?: IndexFilter; raw?: string; items?: SelectionItem[] }): { selection: Selection; unresolved: string[] } {
  switch (sel.source) {
    case 'index': {
      const filter = sel.filter ?? {};
      return { selection: { source: 'index', filter, items: applyFilter(index.rows, filter).map(rowToItem) }, unresolved: [] };
    }
    case 'csv': {
      const parsed = parseCsv(sel.raw ?? '');
      const r = resolveItems(index.rows, parsed.records);
      return { selection: { source: 'csv', raw: sel.raw ?? '', items: r.items }, unresolved: r.unresolved };
    }
    case 'text': {
      const r = resolveItems(index.rows, parseTextList(sel.raw ?? ''));
      return { selection: { source: 'text', raw: sel.raw ?? '', items: r.items }, unresolved: r.unresolved };
    }
    case 'packs':
      return { selection: { source: 'packs', items: (sel.items ?? []).filter(i => i.pack) }, unresolved: [] };
    default:
      return { selection: { source: 'none', items: [] }, unresolved: [] };
  }
}

/** Built .mcaddon files under output/ (depth ≤ 3), newest first. */
function listPacks(): SelectionItem[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3 && n !== 'console-runs') walk(p, depth + 1); }
      else if (/\.mcaddon$/i.test(n)) out.push({ path: p.replace(/\\/g, '/'), mtime: st.mtimeMs });
    }
  };
  walk(join(REPO, 'output'), 0);
  return out.sort((a, b) => b.mtime - a.mtime).map(p => ({ id: p.path.replace(/^.*\//, ''), pack: p.path, label: p.path.replace(REPO + '/', '') }));
}

/** Rows for the export: one per job (json-last) or per matched line (regex-lines), each carrying the item and the command. */
function exportRows(run: Run, op: Operation): { columns: string[]; rows: Record<string, unknown>[] } {
  const base = ['run', 'op', 'job', 'item', 'set', 'path', 'state', 'exitCode', 'seconds', 'reason'];
  const cols = op.columns.map(c => c.key);
  const rows: Record<string, unknown>[] = [];
  for (const j of run.jobs) {
    const head = {
      run: run.id, op: run.opId, job: j.id, item: j.item?.id ?? '', set: j.item?.set ?? '', path: j.item?.indexPath ?? j.item?.model ?? j.item?.pack ?? '',
      state: j.state, exitCode: j.exitCode, seconds: j.startedAt && j.endedAt ? Math.round((j.endedAt - j.startedAt) / 100) / 10 : '', reason: j.reason ?? '',
    };
    const tail = { evidence: j.evidence.join(' | '), command: j.display };
    if (j.rows.length > 1 || (j.rows.length === 1 && !j.result)) for (const r of j.rows) rows.push({ ...head, ...r, ...tail });
    else rows.push({ ...head, ...Object.fromEntries(cols.map(c => [c, j.result?.[c]])), ...tail });
  }
  return { columns: [...base, ...cols, 'evidence', 'command'], rows };
}

/** A preview of the command(s) a request would run, without creating a run. */
function preview(op: Operation, selection: Selection, values: OptionValues): { commands: string[]; problems: string[]; skipped: { id: string; reason: string }[] } {
  const commands: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const ctx = { runDir: `${ROOTS.runsDir}/<run-id>` };
  const problems = validateRequest(op, selection.items, values, op.id); // confirm is checked at run time, not here
  try {
    if (op.batch === 'per-item') {
      const items: (SelectionItem | null)[] = op.input === 'none' ? [null] : selection.items;
      for (const it of items.slice(0, 3)) {
        const problem = it ? itemProblem(op, it) : null;
        if (problem) { skipped.push({ id: it!.id, reason: problem }); continue; }
        commands.push(buildCommand(op, it ? [it] : [], values, ctx).display);
      }
      if (items.length > 3) commands.push(`… ${items.length - 3} more`);
      for (const it of selection.items.slice(3)) { const p = itemProblem(op, it); if (p) skipped.push({ id: it.id, reason: p }); }
    } else {
      const usable = selection.items.filter(i => !itemProblem(op, i));
      for (const it of selection.items) { const p = itemProblem(op, it); if (p) skipped.push({ id: it.id, reason: p }); }
      commands.push(buildCommand(op, usable, values, ctx).display);
    }
  } catch (e) { problems.push((e as Error).message); }
  return { commands: commands.map(c => `(cd ${cwdFor(op, ROOTS)}) ${c}`), problems, skipped };
}

// ── UI assets (TypeScript transpiled on request, so the UI stays TS with no build step) ──
let appJsCache: { mtime: number; js: string } | null = null;
function appJs(): string {
  const file = join(HERE, 'ui', 'app.ts');
  const mtime = statSync(file).mtimeMs;
  if (appJsCache && appJsCache.mtime === mtime) return appJsCache.js;
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  appJsCache = { mtime, js };
  return js;
}

// ── routes ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/') return text(res, 200, readFileSync(join(HERE, 'ui', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/app.js') return text(res, 200, appJs(), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && path === '/style.css') return text(res, 200, readFileSync(join(HERE, 'ui', 'style.css'), 'utf8'), 'text/css; charset=utf-8');
    if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && path === '/api/inventory') {
      return json(res, 200, {
        operations: OPERATIONS, stale: STALE, groups: GROUPS,
        index: { generated: index.generated, entries: index.rows.length, sets: new Set(index.rows.map(r => r.set)).size, srcClasses: srcClasses(index.rows) },
        roots: ROOTS, maxConcurrency: GLOBAL_MAX, cores: runner.cpuSample().cores, devServer: 'http://localhost:4000',
      });
    }
    if (req.method === 'GET' && path === '/api/packs') return json(res, 200, { items: listPacks() });
    if (req.method === 'GET' && path === '/api/status') return json(res, 200, { cpu: runner.cpuSample(), running: runner.listRuns().filter(r => r.state === 'running').length });

    if (req.method === 'POST' && path === '/api/select') {
      const body = JSON.parse(await readBody(req)) as { source: Selection['source']; filter?: IndexFilter; raw?: string; items?: SelectionItem[] };
      const { selection, unresolved } = materialise(body);
      return json(res, 200, { count: selection.items.length, sample: selection.items.slice(0, 200), unresolved: unresolved.slice(0, 50), unresolvedCount: unresolved.length });
    }
    if (req.method === 'POST' && path === '/api/preview') {
      const body = JSON.parse(await readBody(req)) as { opId: string; selection: Parameters<typeof materialise>[0]; options: OptionValues };
      const op = operationById(body.opId);
      if (!op) return json(res, 404, { error: `unknown operation ${body.opId}` });
      const { selection } = materialise(body.selection);
      return json(res, 200, { count: selection.items.length, ...preview(op, selection, body.options ?? {}) });
    }
    if (req.method === 'POST' && path === '/api/runs') {
      const body = JSON.parse(await readBody(req)) as { opId: string; selection: Parameters<typeof materialise>[0]; options: OptionValues; concurrency?: number; confirm?: string };
      const op = operationById(body.opId);
      if (!op) return json(res, 404, { error: `unknown operation ${body.opId}` });
      const { selection } = materialise(body.selection);
      const problems = validateRequest(op, selection.items, body.options ?? {}, body.confirm);
      if (problems.length) return json(res, 400, { error: problems.join('; '), problems });
      const run = runner.createRun(op, selection, body.options ?? {}, body.concurrency ?? 2);
      return json(res, 201, { run });
    }
    if (req.method === 'GET' && path === '/api/runs') return json(res, 200, { runs: runner.listRuns() });

    const runMatch = /^\/api\/runs\/([^/]+)(?:\/(cancel|log\/(\d+)|export\.(csv|json)))?$/.exec(path);
    if (runMatch) {
      const run = runner.runs.get(runMatch[1]!);
      if (!run) return json(res, 404, { error: 'no such run' });
      const op = operationById(run.opId);
      if (req.method === 'GET' && !runMatch[2]) return json(res, 200, { run });
      if (req.method === 'POST' && runMatch[2] === 'cancel') return json(res, 200, { ok: runner.cancel(run.id) });
      if (req.method === 'GET' && runMatch[3] !== undefined) {
        const job = run.jobs[Number(runMatch[3])];
        if (!job) return json(res, 404, { error: 'no such job' });
        return text(res, 200, existsSync(job.logFile) ? readFileSync(job.logFile, 'utf8') : '');
      }
      if (req.method === 'GET' && runMatch[4] && op) {
        const { columns, rows } = exportRows(run, op);
        const name = `console-${run.id}-${run.opId}`;
        if (runMatch[4] === 'json') {
          return text(res, 200, JSON.stringify({ run: { id: run.id, op: run.opId, options: run.options, concurrency: run.concurrency, createdAt: run.createdAt, dir: run.dir, state: run.state, selection: { source: run.selection.source, filter: run.selection.filter ?? null, raw: run.selection.raw ?? null, count: run.selection.items.length } }, columns, rows, jobs: run.jobs }, null, 1),
            'application/json; charset=utf-8', { 'content-disposition': `attachment; filename="${name}.json"` });
        }
        const filterLine = `# op=${run.opId} run=${run.id} source=${run.selection.source} filter=${JSON.stringify(run.selection.filter ?? run.selection.raw ?? null)} options=${JSON.stringify(run.options)}\r\n`;
        return text(res, 200, filterLine + toCsv(columns, rows), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${name}.csv"` });
      }
    }

    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', runs: runner.listRuns(), cpu: runner.cpuSample() } satisfies ConsoleEvent)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    json(res, 404, { error: `no route for ${req.method} ${path}` });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`craftmatic console  http://${HOST}:${PORT}   (${OPERATIONS.length} operations, index ${index.generated}: ${index.rows.length} entries, global concurrency ceiling ${GLOBAL_MAX})`);
  console.log(`runs are persisted under ${ROOTS.runsDir}`);
});
