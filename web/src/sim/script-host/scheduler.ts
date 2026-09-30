/**
 * `system.run` / `runTimeout` / `runInterval` / `runJob`, on the engine's
 * ticks. A callback due at tick t runs in the script phase of tick t; a
 * throw is a `script-error` on the timeline (the device logs it and carries
 * on), never an abort.
 *
 * `immediate` mode runs every timeout on the next microtask instead of after
 * its ticks: the fast-forward the older host tests were written against
 * (`test/_placement-host.ts`), where only the ORDER of events matters.
 */

import type { Timeline } from '../core/timeline.js';

interface Scheduled { id: number; due: number; every: number; fn: () => void; source?: string }

/** How long a job may run per tick, in generator steps. */
const JOB_STEPS_PER_TICK = 256;

export class Scheduler {
  private nextId = 1;
  private readonly runs = new Map<number, Scheduled>();
  private readonly jobs = new Map<number, Generator<unknown, unknown, unknown>>();
  currentTick = 0;

  constructor(private readonly timeline: Timeline, readonly mode: 'ticks' | 'immediate' = 'ticks') {}

  /** Report a throw from script code. */
  fault(e: unknown, where: string): void {
    const err = e as { name?: string; message?: string; stack?: string };
    const source = this.timeline.callerSource(err?.stack ?? '');
    if (err?.name === 'UnmodelledError') return; // already recorded where it was thrown
    this.timeline.add('script-error', `${where}: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`, source ? { source } : {});
  }

  private add(fn: () => void, delay: number, every: number): number {
    const id = this.nextId++;
    if (this.mode === 'immediate' && every === 0) {
      queueMicrotask(() => { if (!this.runs.has(id)) return; this.runs.delete(id); try { fn(); } catch (e) { this.fault(e, 'runTimeout'); } });
      this.runs.set(id, { id, due: -1, every: 0, fn });
      return id;
    }
    const source = this.timeline.callerSource();
    this.runs.set(id, { id, due: this.currentTick + Math.max(1, Math.floor(delay)), every, fn, ...(source ? { source } : {}) });
    return id;
  }

  run(fn: () => void): number { return this.add(fn, 1, 0); }
  runTimeout(fn: () => void, ticks = 1): number { return this.add(fn, ticks, 0); }
  runInterval(fn: () => void, ticks = 1): number { return this.add(fn, ticks, Math.max(1, Math.floor(ticks))); }
  clearRun(id: number): void { this.runs.delete(id); }
  runJob(gen: Generator<unknown, unknown, unknown>): number { const id = this.nextId++; this.jobs.set(id, gen); return id; }
  clearJob(id: number): void { this.jobs.delete(id); }

  /** The intervals registered, with their period (a test host drives them by hand). */
  intervals(): Array<{ id: number; every: number; fn: () => void }> { return [...this.runs.values()].filter(r => r.every > 0).map(r => ({ id: r.id, every: r.every, fn: r.fn })); }

  /** Run everything due at `tick`, in registration order, then step the jobs. */
  runDue(tick: number): void {
    this.currentTick = tick;
    const due = [...this.runs.values()].filter(r => r.due >= 0 && r.due <= tick).sort((a, b) => a.id - b.id);
    for (const r of due) {
      if (!this.runs.has(r.id)) continue;
      if (r.every > 0) r.due = tick + r.every; else this.runs.delete(r.id);
      try { r.fn(); } catch (e) { this.fault(e, r.every ? 'runInterval' : 'run'); }
    }
    for (const [id, gen] of this.jobs) {
      try {
        for (let i = 0; i < JOB_STEPS_PER_TICK; i++) { if (gen.next().done) { this.jobs.delete(id); break; } }
      } catch (e) { this.jobs.delete(id); this.fault(e, 'runJob'); }
    }
  }
}
