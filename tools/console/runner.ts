/**
 * The job runner: spawns the real scripts, streams their output, enforces a
 * concurrency limit and a machine-load guard, supports cancel, and persists
 * every run under `output/console-runs/<runId>/` so a result set can be
 * exported and reproduced later.
 *
 * Load guard: `os.loadavg()` is always zero on Windows, so the guard samples
 * `os.cpus()` times and refuses to START new jobs while the box is busier than
 * `CPU_HOLD` — running jobs are never touched. This is the "don't melt the box"
 * rule: an orphaned load generator once cost a day.
 */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { buildCommand, cwdFor, itemProblem, parseJsonLast, parseRegexLines, getPath, type OptionValues } from './command.ts';
import type { ConsoleEvent, CpuSample, Job, Operation, Run, Selection, SelectionItem } from './types.ts';

export const CPU_HOLD = 0.85;
/** One global ceiling regardless of how many runs are queued: a quarter of the cores, at most 6. */
export const GLOBAL_MAX = Math.max(1, Math.min(6, Math.floor(cpus().length / 4)));
const LOG_CAP = 4 * 1024 * 1024; // bytes of stdout kept in memory for parsing; the log file holds all of it

export interface RunnerRoots { craftmatic: string; clego: string; runsDir: string }

interface Live { proc: ChildProcess; stdout: string; stderr: string }

export class Runner extends EventEmitter {
  readonly runs = new Map<string, Run>();
  private readonly live = new Map<string, Live>();
  private cpu: CpuSample = { busy: 0, cores: cpus().length, held: false, at: Date.now() };
  private lastCpu = cpuTimes();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly roots: RunnerRoots, private readonly ops: ReadonlyMap<string, Operation>) {
    super();
    mkdirSync(roots.runsDir, { recursive: true });
    this.loadPersisted();
  }

  /** Start the load sampler (2 s). Idempotent. */
  startSampler(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = cpuTimes();
      const total = now.total - this.lastCpu.total, idle = now.idle - this.lastCpu.idle;
      this.lastCpu = now;
      const busy = total > 0 ? 1 - idle / total : 0;
      const held = busy > CPU_HOLD && this.queuedCount() > 0;
      this.cpu = { busy, cores: cpus().length, held, at: Date.now() };
      this.emitEvent({ type: 'cpu', cpu: this.cpu });
      if (!held) this.tick();
    }, 2000);
  }

  stopSampler(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  cpuSample(): CpuSample { return this.cpu; }

  listRuns(): Run[] { return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt); }

  /** Create a run: one job per item (per-item) or one job for all (one-process). Jobs start on the next tick. */
  createRun(op: Operation, selection: Selection, values: OptionValues, concurrency: number): Run {
    const id = runId();
    const dir = `${this.roots.runsDir}/${id}`.replace(/\\/g, '/');
    mkdirSync(dir, { recursive: true });
    const run: Run = {
      id, opId: op.id, options: stripUndefined(values), selection, concurrency: Math.max(1, Math.min(GLOBAL_MAX, concurrency || 1)),
      createdAt: Date.now(), dir, jobs: [], state: 'queued',
    };
    const cwd = cwdFor(op, this.roots);
    const groups: (SelectionItem | null)[][] = op.batch === 'per-item'
      ? (op.input === 'none' ? [[null]] : selection.items.map(i => [i]))
      : [selection.items];
    groups.forEach((group, index) => {
      const items = group.filter((i): i is SelectionItem => i !== null);
      const job: Job = {
        id: index, runId: id, item: op.batch === 'per-item' ? (group[0] ?? null) : null,
        argv: [], display: '', cwd, env: {}, state: 'queued', exitCode: null, startedAt: null, endedAt: null,
        result: null, rows: [], evidence: [], logFile: `${dir}/job-${index}.log`,
      };
      // Per-item: an item the script cannot read is skipped up front, with the reason on the row.
      if (op.batch === 'per-item' && group[0]) {
        const problem = itemProblem(op, group[0]);
        if (problem) { job.state = 'skipped'; job.reason = problem; run.jobs.push(job); return; }
      }
      try {
        const usable = op.batch === 'one-process' ? items.filter(i => !itemProblem(op, i)) : items;
        const built = buildCommand(op, usable, values, { runDir: dir });
        for (const f of built.files) writeFileSync(f.path, f.content);
        job.argv = built.argv; job.display = built.display; job.env = built.env;
        job.evidence.push(...built.runDirPaths);
        const dropped = items.length - usable.length;
        if (dropped) job.reason = `${dropped} item(s) not accepted by the script were left out of the listing`;
      } catch (e) {
        job.state = 'skipped'; job.reason = (e as Error).message;
      }
      run.jobs.push(job);
    });
    this.runs.set(id, run);
    this.persist(run);
    this.emitEvent({ type: 'run', run });
    this.tick();
    return run;
  }

  cancel(runIdToCancel: string): boolean {
    const run = this.runs.get(runIdToCancel);
    if (!run) return false;
    for (const job of run.jobs) {
      if (job.state === 'queued') { job.state = 'cancelled'; job.endedAt = Date.now(); this.emitEvent({ type: 'job', runId: run.id, job }); }
      if (job.state === 'running') this.kill(`${run.id}/${job.id}`);
    }
    run.state = 'cancelled';
    this.persist(run);
    this.emitEvent({ type: 'run', run });
    return true;
  }

  /** Kill a process and its children (a bun script spawns nothing, a browser gate spawns Chrome). */
  private kill(key: string): void {
    const l = this.live.get(key);
    if (!l?.proc.pid) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(l.proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else l.proc.kill('SIGTERM');
  }

  private runningCount(): number { return this.live.size; }
  private queuedCount(): number { let n = 0; for (const r of this.runs.values()) for (const j of r.jobs) if (j.state === 'queued') n++; return n; }

  /** Dispatch: oldest run first, respecting the global ceiling, the run's own limit and the load guard. */
  private tick(): void {
    if (this.cpu.held) return;
    for (const run of [...this.runs.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (run.state === 'cancelled' || run.state === 'done') continue;
      for (const job of run.jobs) {
        if (this.runningCount() >= GLOBAL_MAX) return;
        if (run.jobs.filter(j => j.state === 'running').length >= run.concurrency) break;
        if (job.state !== 'queued') continue;
        this.start(run, job);
      }
      this.settle(run);
    }
  }

  private start(run: Run, job: Job): void {
    const op = this.ops.get(run.opId);
    if (!op) { job.state = 'failed'; job.reason = 'operation vanished from the inventory'; return; }
    job.state = 'running'; job.startedAt = Date.now();
    run.state = 'running';
    writeFileSync(job.logFile, `# ${job.display}\n# cwd ${job.cwd}\n# started ${new Date(job.startedAt).toISOString()}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, ...job.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', MSYS_NO_PATHCONV: '1' };
    let proc: ChildProcess;
    try {
      proc = spawn(job.argv[0]!, job.argv.slice(1), { cwd: job.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      job.state = 'failed'; job.reason = (e as Error).message; job.endedAt = Date.now();
      this.emitEvent({ type: 'job', runId: run.id, job }); this.persist(run); return;
    }
    const key = `${run.id}/${job.id}`;
    const l: Live = { proc, stdout: '', stderr: '' };
    this.live.set(key, l);
    this.emitEvent({ type: 'job', runId: run.id, job });
    const onData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      appendFileSync(job.logFile, text);
      if (l[stream].length < LOG_CAP) l[stream] += text;
      this.emitEvent({ type: 'log', runId: run.id, jobId: job.id, stream, text });
    };
    proc.stdout?.on('data', onData('stdout'));
    proc.stderr?.on('data', onData('stderr'));
    proc.on('error', err => { onData('stderr')(Buffer.from(`spawn error: ${err.message}\n`)); });
    proc.on('close', (code, signal) => {
      this.live.delete(key);
      job.exitCode = code; job.endedAt = Date.now();
      job.state = job.state === 'running' ? (code === 0 ? 'done' : (signal || run.state === 'cancelled') ? 'cancelled' : 'failed') : job.state;
      this.readResult(op, job, l.stdout);
      // A failed job carries the script's own last words on its row, so the table says WHY without opening the log.
      if (job.state === 'failed' && !job.reason) {
        const tail = (l.stderr.trim() || l.stdout.trim()).split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
        job.reason = `exit ${code ?? signal}${tail ? `: ${tail.slice(0, 300)}` : ''}`;
      }
      appendFileSync(job.logFile, `\n# exit ${code ?? signal} after ${((job.endedAt - (job.startedAt ?? job.endedAt)) / 1000).toFixed(1)} s\n`);
      this.emitEvent({ type: 'job', runId: run.id, job });
      this.settle(run);
      this.persist(run);
      this.tick();
    });
  }

  /** Parse what the script printed into the row the results table shows, and collect evidence paths. */
  private readResult(op: Operation, job: Job, stdout: string): void {
    if (op.parse.kind === 'json-last') {
      const parsed = parseJsonLast(stdout);
      if (parsed) {
        job.result = {};
        for (const c of op.columns) job.result[c.key] = getPath(parsed, c.path);
        job.result['_raw'] = parsed;
        if (op.evidence.fromJson) {
          const p = getPath(parsed, op.evidence.fromJson);
          if (typeof p === 'string' && p) job.evidence.push(absolute(p, job.cwd));
        }
      }
    } else if (op.parse.kind === 'regex-lines') {
      job.rows = parseRegexLines(stdout, op.parse.pattern, op.parse.groups);
      if (job.rows.length === 1) job.result = { ...job.rows[0] };
    }
    if (op.evidence.dir) job.evidence.push(absolute(op.evidence.dir, job.cwd));
    job.evidence = [...new Set(job.evidence)];
  }

  private settle(run: Run): void {
    if (run.state === 'cancelled') return;
    const open = run.jobs.some(j => j.state === 'queued' || j.state === 'running');
    run.state = open ? (run.jobs.some(j => j.state === 'running') ? 'running' : 'queued') : 'done';
    if (!open) this.emitEvent({ type: 'run', run });
  }

  private persist(run: Run): void {
    writeFileSync(`${run.dir}/run.json`, JSON.stringify(run, null, 1));
  }

  /** Earlier runs on disk are listed read-only (a job that was running when the server died is marked failed). */
  private loadPersisted(): void {
    if (!existsSync(this.roots.runsDir)) return;
    for (const name of readdirSync(this.roots.runsDir)) {
      const file = `${this.roots.runsDir}/${name}/run.json`;
      if (!existsSync(file)) continue;
      try {
        const run = JSON.parse(readFileSync(file, 'utf8')) as Run;
        for (const j of run.jobs) if (j.state === 'running' || j.state === 'queued') { j.state = 'failed'; j.reason = 'server restarted while the job was open'; }
        if (run.state !== 'cancelled') run.state = 'done';
        this.runs.set(run.id, run);
      } catch { /* a torn run.json is skipped */ }
    }
  }

  private emitEvent(e: ConsoleEvent): void { this.emit('event', e); }
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const c of cpus()) { idle += c.times.idle; total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle; }
  return { idle, total };
}

const runId = (): string => {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
};

const absolute = (p: string, cwd: string): string => (/^[A-Za-z]:[\\/]|^\//.test(p) ? p : `${cwd}/${p}`).replace(/\\/g, '/');

const stripUndefined = (v: OptionValues): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== '') out[k] = x;
  return out;
};
