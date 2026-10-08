/**
 * Runs a scenario: a fresh simulated world, the add-ons loaded as shipped, a
 * player, the steps in order and the invariants after every tick. The result
 * says what happened and how sure it is:
 *
 *   fail     an invariant or a step's own check was violated;
 *   error    a step could not run (its target never existed, say);
 *   unknown  nothing was violated, but scripts reached API members the
 *            simulator does not model - UNKNOWN is never a pass;
 *   pass     nothing violated and everything the scripts touched is modelled.
 */

import { Simulation, type SimulationOptions } from '../core/simulation.js';
import type { UnmodelledUse, TimelineEntry } from '../core/timeline.js';
import { distance, lookAngles, type Vec3 } from '../core/vec.js';
import type { SimEntity } from '../entity/entity.js';
import { aimPoint, interact, lookAt, pick, tap, useItem } from '../input/touch.js';
import { findApproach } from './approach.js';
import { quirkValue } from '../quirks/registry.js';
import { teleport } from '../script-host/facades.js';
import type { Addon } from '../pack/pack.js';
import { FLAT_GROUND_Y } from '../world/voxel-world.js';
import { coreInvariants, quietable, type Invariant, type InvariantContext, type Violation } from './invariants.js';
import type { AnyStep, EntitySelector, Scenario, StepContext, StepHandler } from './types.js';

export type ScenarioStatus = 'pass' | 'fail' | 'error' | 'unknown';

export interface StepResult { kind: string; label: string; ok: boolean; startTick: number; ticks: number; error?: string }

export interface ScenarioResult {
  name: string;
  description?: string;
  evidence?: string;
  status: ScenarioStatus;
  violations: Violation[];
  notes: string[];
  steps: StepResult[];
  ticks: number;
  ms: number;
  unmodelled: UnmodelledUse[];
  /** The steps' shared state at the end (findings the adapters recorded), without the engine caches. */
  state: Record<string, unknown>;
  /** The whole timeline, when asked for (`keepTimeline`). */
  timeline?: TimelineEntry[];
}

export interface RunOptions extends SimulationOptions {
  /** Step handlers beyond the core ones (an adapter's). */
  handlers?: Record<string, StepHandler>;
  /** Invariants beyond the core ones. */
  invariants?: Invariant[];
  /** Keep the timeline in the result. */
  keepTimeline?: boolean;
  /** Called with the simulation after the packs load, before the first step. */
  prepare?: (sim: Simulation, player: SimEntity) => void | Promise<void>;
}

/** How many times one invariant may report the same message before it is summarised. */
const REPEAT_LIMIT = 3;

/** Resolve a selector among the loaded entities. */
export function findEntity(sim: Simulation, player: SimEntity, sel: EntitySelector): SimEntity | undefined {
  const typeOk = (e: SimEntity): boolean => sel.type === undefined || (typeof sel.type === 'string' ? e.typeId === sel.type : sel.type.test(e.typeId));
  let list = sim.engine.loadedEntities(player.dimension).filter(e => !e.isPlayer && typeOk(e) && (!sel.family || e.families().includes(sel.family)) && (!sel.where || sel.where(e)));
  const at = sel.near ?? player.location;
  list = list.sort((a, b) => distance(a.location, at) - distance(b.location, at));
  return list[sel.index ?? 0];
}

/** The core step handlers. */
export const CORE_HANDLERS: Record<string, StepHandler> = {
  async wait(step, ctx) { await ctx.run(Number(step['ticks'] ?? 1)); },
  async teleport(step, ctx) {
    const s = step as unknown as { to: Vec3; yaw?: number; pitch?: number };
    teleport(ctx.sim.host, ctx.player, s.to);
    ctx.player.rotation = { x: s.pitch ?? ctx.player.rotation.x, y: s.yaw ?? ctx.player.rotation.y };
    await ctx.run(1);
  },
  async look(step, ctx) {
    const at = step['at'] as Vec3 | EntitySelector;
    if ('x' in at && typeof at.x === 'number') lookAt(ctx.player, at as Vec3);
    else { const e = ctx.find(at as EntitySelector); if (!e) throw new Error(`look: no ${describe(at as EntitySelector)}`); lookAt(ctx.player, aimPoint(ctx.player, e)); }
  },
  async walkLine(step, ctx) {
    const s = step as unknown as { from: Vec3; to: Vec3; maxTicks?: number; jumpWhenBlocked?: boolean; maxDrop?: number; arriveWithin?: number; label?: string; autoJump?: boolean; maxFall?: number };
    const p = ctx.player;
    const autoJumpWas = !!ctx.sim.controls.get(p.id).autoJump;
    ctx.sim.controls.set(p.id, { autoJump: !!s.autoJump });
    teleport(ctx.sim.host, p, s.from);
    p.onGround = false;
    // Settle onto whatever holds the start point before measuring the walk.
    for (let i = 0; i < 40 && !p.onGround; i++) await ctx.run(1);
    const dir = { x: s.to.x - s.from.x, z: s.to.z - s.from.z }, len = Math.hypot(dir.x, dir.z) || 1;
    const u = { x: dir.x / len, z: dir.z / len };
    const along = (q: Vec3): number => (q.x - s.from.x) * u.x + (q.z - s.from.z) * u.z;
    const startY = p.location.y;
    let lowest = startY, best = along(p.location), stall = 0, jumps = 0;
    // The deepest single fall: from the last floor stood on to the next landing (a walk off an edge), and where it left.
    let floor: Vec3 = { ...p.location }, fall = 0, fallFrom: Vec3 | undefined, highest = startY;
    const maxTicks = s.maxTicks ?? Math.ceil(len / 0.2) + 60;
    for (let t = 0; t < maxTicks; t++) {
      const wasGround = p.onGround;
      if (wasGround) floor = { ...p.location };
      // Steer back onto the line: aim at a point 1.5 blocks ahead of the feet's projection.
      const a = Math.min(len, along(p.location) + 1.5);
      const aim = { x: s.from.x + u.x * a, z: s.from.z + u.z * a };
      p.rotation.y = lookAngles({ x: aim.x - p.location.x, y: 0, z: aim.z - p.location.z }).yaw;
      const before = { ...p.location };
      ctx.sim.controls.set(p.id, { forward: 1, strafe: 0, jump: false });
      await ctx.run(1);
      lowest = Math.min(lowest, p.location.y); highest = Math.max(highest, p.location.y);
      if (p.onGround && !wasGround && floor.y - p.location.y > fall) { fall = floor.y - p.location.y; fallFrom = floor; }
      const moved = Math.hypot(p.location.x - before.x, p.location.z - before.z);
      if (s.jumpWhenBlocked && moved < 0.02 && p.onGround) { ctx.sim.controls.set(p.id, { jump: true }); jumps++; }
      if (along(p.location) > best + 0.01) { best = along(p.location); stall = 0; } else if (++stall > 30) break;
      if (along(p.location) >= len) break;
    }
    ctx.sim.controls.set(p.id, { forward: 0, jump: false, autoJump: autoJumpWas });
    await ctx.run(2);
    const drop = startY - lowest;
    if (s.maxFall !== undefined && fall > s.maxFall + 1e-6) ctx.violate({ invariant: 'walk-no-deep-fall', message: `${s.label ?? 'walk'}: fell ${Math.round(fall * 100) / 100} blocks off an edge (at most ${s.maxFall} allowed)`, evidence: { from: s.from, to: s.to, fallFrom: fallFrom ? { x: Math.round(fallFrom.x * 1000) / 1000, y: Math.round(fallFrom.y * 1000) / 1000, z: Math.round(fallFrom.z * 1000) / 1000 } : null, end: { ...p.location } } });
    const maxDrop = s.maxDrop ?? Infinity;
    if (drop > maxDrop + 1e-6) ctx.violate({ invariant: 'walk-holds-floor', message: `${s.label ?? 'walk'}: dropped ${Math.round(drop * 100) / 100} blocks (at most ${maxDrop} allowed)`, evidence: { from: s.from, to: s.to, lowestY: Math.round(lowest * 1000) / 1000, startY: Math.round(startY * 1000) / 1000, end: { ...p.location } } });
    const miss = Math.hypot(p.location.x - s.to.x, p.location.z - s.to.z);
    if (s.arriveWithin !== undefined && miss > s.arriveWithin) ctx.violate({ invariant: 'walk-arrives', message: `${s.label ?? 'walk'}: stopped ${Math.round((len - best) * 100) / 100} blocks short of the end`, evidence: { from: s.from, to: s.to, end: { x: Math.round(p.location.x * 1000) / 1000, y: Math.round(p.location.y * 1000) / 1000, z: Math.round(p.location.z * 1000) / 1000 }, jumps } });
    ctx.state['lastWalk'] = { drop, miss, end: { ...p.location }, jumps, fall, fallFrom, highest };
  },
  async tap(step, ctx) {
    const sel = step['target'] as EntitySelector;
    const target = ctx.find(sel);
    if (!target) throw new Error(`tap: no ${describe(sel)}`);
    await reachFor(ctx, target, describe(sel));
    const r = tap(ctx.sim.engine, ctx.player, target);
    ctx.state['lastTap'] = r;
    if (step['expectHit'] !== false && r.entity !== target) {
      ctx.violate({ invariant: 'tap-target-reachable', message: `tap on ${describe(sel)} picked ${r.entity ? r.entity.typeId : r.blockedBy ? `the block ${r.blockedBy}` : 'nothing'}`, evidence: { target: target.typeId, targetAt: target.location, eye: ctx.player.headLocation(), distance: r.distance } });
    }
    await ctx.run(2);
  },
  async hold(step, ctx) {
    const sel = step['target'] as EntitySelector;
    const target = ctx.find(sel);
    if (!target) throw new Error(`hold: no ${describe(sel)}`);
    await reachFor(ctx, target, describe(sel));
    lookAt(ctx.player, aimPoint(ctx.player, target));
    await ctx.run(Number(step['ticks'] ?? quirkValue('hold-is-interact', 'holdTicks')));
    const r = interact(ctx.sim.engine, ctx.player, target, (p, t) => ctx.sim.host.before('playerInteractWithEntity', { player: ctx.sim.host.entity(p), target: ctx.sim.host.entity(t) }));
    ctx.state['lastHold'] = r;
    await ctx.run(1);
  },
  async rideUntil(step, ctx) {
    const max = Number(step['maxTicks'] ?? 600);
    let t = 0;
    for (; t < max && ctx.player.ridingOn; t++) await ctx.run(1);
    ctx.state['rideTicks'] = t;
    if (step['until'] === 'dismounted' && ctx.player.ridingOn) ctx.note(`${String(step['label'] ?? 'ride')}: still riding after ${max} ticks`);
  },
  async drive(step, ctx) {
    const h = step['hold'] as { forward: number; strafe?: number; jump?: boolean; turnPerTick?: number; ticks: number };
    for (let t = 0; t < h.ticks; t++) {
      ctx.player.rotation.y += h.turnPerTick ?? 0;
      ctx.sim.controls.set(ctx.player.id, { forward: h.forward, strafe: h.strafe ?? 0, jump: h.jump ?? false });
      await ctx.run(1);
    }
    ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false });
  },
  async sneak(_step, ctx) {
    ctx.sim.controls.set(ctx.player.id, { sneak: true });
    await ctx.run(1);
    ctx.sim.controls.set(ctx.player.id, { sneak: false });
    await ctx.run(1);
  },
  async jumpHold(step, ctx) {
    ctx.sim.controls.set(ctx.player.id, { jump: true });
    await ctx.run(Number(step['ticks'] ?? 1));
    ctx.sim.controls.set(ctx.player.id, { jump: false });
  },
  async useItem(step, ctx) { useItem(ctx.sim.engine, ctx.player, String(step['item'])); await ctx.run(1); },
  async expect(step, ctx) {
    const check = step['check'] as (c: StepContext) => string | undefined | Promise<string | undefined>;
    const msg = await check(ctx);
    if (msg) ctx.violate({ invariant: `expect:${String(step['label'] ?? 'check')}`, message: msg });
  },
};

/**
 * Stand where a tap picks the target: stay when the view already picks it,
 * else move to the nearest spot within reach that does (`findApproach`).
 * # TODO(sim-walk): the child is TELEPORTED to the spot; walking there (and
 * failing to) is the doorway and path steps' job, not the tap's.
 */
async function reachFor(ctx: StepContext, target: SimEntity, label: string): Promise<void> {
  lookAt(ctx.player, aimPoint(ctx.player, target));
  if (ctx.player.ridingOn || pick(ctx.sim.engine, ctx.player).entity === target) return;
  const spot = findApproach(ctx.sim.engine, ctx.player, target);
  if (!spot) {
    ctx.violate({ invariant: 'tap-target-reachable', message: `no standing spot within reach picks ${label}`, evidence: { target: target.typeId, at: target.location } });
    return;
  }
  teleport(ctx.sim.host, ctx.player, spot.feet);
  ctx.player.onGround = true;
  await ctx.run(1);
  // Aim where the search proved the tap picks the target (the pick box nearest the eye there).
  lookAt(ctx.player, spot.aim);
}

const describe = (sel: EntitySelector): string => sel.label ?? (sel.type ? String(sel.type) : sel.family ?? 'entity');

/** Run one scenario over add-ons. */
export async function runScenario(scenario: Scenario, addons: readonly Addon[], options: RunOptions = {}): Promise<ScenarioResult> {
  const t0 = performance.now();
  const sim = new Simulation(options);
  for (const a of addons) sim.loadAddon(a);
  const player = sim.addPlayer('Child', scenario.start ?? { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 }, scenario.items ?? []);
  const violations: Violation[] = [], notes: string[] = [], steps: StepResult[] = [];
  const repeats = new Map<string, number>();
  let currentStep = '';
  const report = (v: Omit<Violation, 'tick' | 'step'>): void => {
    const key = `${v.invariant}|${v.message}`;
    const n = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, n);
    if (n <= REPEAT_LIMIT) violations.push({ ...v, tick: sim.engine.tick, ...(currentStep ? { step: currentStep } : {}) });
  };
  const all = [...coreInvariants(), ...(options.invariants ?? [])].filter(i => !scenario.invariants || scenario.invariants.includes(i.id));
  let quiet: ReadonlySet<string> = new Set();
  const ictx: InvariantContext = quietable({ engine: sim.engine, player, allowLines: scenario.allowLines ?? [], ...(scenario.yieldingLines ? { yieldingLines: scenario.yieldingLines } : {}), controlScheme: p => sim.host.playerState(p).controlScheme, report }, () => quiet);
  for (const inv of all) inv.setup?.(ictx);
  const run = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) { await sim.engine.step(); for (const inv of all) inv.tick?.(ictx); }
  };
  const handlers = { ...CORE_HANDLERS, ...(options.handlers ?? {}) };
  const state: Record<string, unknown> = {};
  const ctx: StepContext = { sim, player, state, violate: report, note: t => notes.push(`[tick ${sim.engine.tick}] ${t}`), run, find: sel => findEntity(sim, player, sel), quiet: ids => { quiet = new Set(ids); } };
  await options.prepare?.(sim, player);
  let errored = false;
  for (const step of scenario.steps) {
    const label = String(step.label ?? step.kind);
    currentStep = label;
    const start = sim.engine.tick;
    const handler = handlers[step.kind];
    const res: StepResult = { kind: step.kind, label, ok: true, startTick: start, ticks: 0 };
    try {
      if (!handler) throw new Error(`no handler for step kind ${step.kind}`);
      await handler(step as AnyStep, ctx);
    } catch (e) {
      res.ok = false; res.error = (e as Error).message; errored = true;
    }
    quiet = new Set();
    res.ticks = sim.engine.tick - start;
    steps.push(res);
    if (!res.ok) break;
  }
  currentStep = '';
  for (const [key, n] of repeats) if (n > REPEAT_LIMIT) notes.push(`${key.split('|')[0]}: ${n - REPEAT_LIMIT} more of "${key.split('|')[1]!.slice(0, 100)}"`);
  const unmodelled = sim.engine.timeline.unmodelledRanking();
  const status: ScenarioStatus = violations.length ? 'fail' : errored ? 'error' : unmodelled.length ? 'unknown' : 'pass';
  return {
    name: scenario.name, ...(scenario.description ? { description: scenario.description } : {}), ...(scenario.evidence ? { evidence: scenario.evidence } : {}),
    status, violations, notes, steps, ticks: sim.engine.tick, ms: Math.round(performance.now() - t0), unmodelled,
    state: Object.fromEntries(Object.entries(state).filter(([k]) => !/staticDrawn|craftmatic.snapshot$/.test(k))),
    ...(options.keepTimeline ? { timeline: sim.engine.timeline.entries } : {}),
  };
}
