/**
 * The walker's simulator: the headless Bedrock simulator (web/src/sim,
 * docs/sim-engine.md) run in a module Worker over the SAME `.mcaddon` bytes
 * the walk reads, so what the walker shows is what `scripts/sim.ts` runs -
 * the pack's own `placement.js`, `figures.js`, `coaster.js`,
 * `interactives.js`, `vehicles.js`, `rides.js`, `pinball.js` unmodified, over
 * the blocks the wand itself lays, with the core invariants checked every
 * tick. The page (`addon-preview.ts`) is a renderer and an input device over
 * it; `addon-sim-client.ts` is the protocol.
 *
 * `AddonSimSession` is the whole of it and runs on any thread: the Worker
 * entry at the bottom wires it to `postMessage`; the page's inline fallback
 * and the parity test (`test/addon-walk.test.ts`, "the walker's tick equals
 * scripts/sim.ts's tick") drive it directly. Its tick IS the scenario
 * runner's tick - `engine.step()` then the invariants - and a scenario step
 * (`runStep`) runs through the same handlers the CLI's scenarios use.
 *
 * Nothing under `web/src/sim` is changed by this: the session consumes
 * `Simulation`, `ControlState`, `playerState().camera` and the timeline as
 * they are. Where a client-side hook of another package is not there yet
 * (`SimHooks`), the session does the direct thing and the HUD says so.
 */

import { Simulation } from '../sim/core/simulation.js';
import { readAddon, type Addon } from '../sim/pack/pack.js';
import { readCraftmaticPack, type CraftmaticPack, type Placed } from '../sim/adapters/craftmatic/pack-facts.js';
import { CRAFTMATIC_ALLOWED_LINES, CRAFTMATIC_YIELDING_LINES, craftmaticHandlers } from '../sim/adapters/craftmatic/child-play.js';
import { PLACED_KEY } from '../sim/adapters/craftmatic/wand.js';
import { CORE_HANDLERS, findEntity } from '../sim/scenario/runner.js';
import { coreInvariants, quietable, type Invariant, type InvariantContext, type Violation } from '../sim/scenario/invariants.js';
import type { AnyStep, StepContext, StepHandler } from '../sim/scenario/types.js';
import { FLAT_GROUND_Y } from '../sim/world/voxel-world.js';
import { interact, pick, tap } from '../sim/input/touch.js';
import { IDLE_CONTROLS, stickToWorld } from '../sim/input/controls.js';
import { teleport } from '../sim/script-host/facades.js';
import { plainText } from '../sim/script-host/text.js';
import type { FormAnswer, ShownForm } from '../sim/script-host/ui-module.js';
import type { SimEntity } from '../sim/entity/entity.js';
import type { TimelineKind } from '../sim/core/timeline.js';
import type { PlacementRotation } from '@engine/bedrock-placement-pack.js';
import {
  SIM_TICK_MS, wrapDeg,
  type BlockChange, type EntityPose, type PageToWorker, type ReadyInfo, type RunStepMessage, type SimFrame, type SimHooks, type SimLine, type WalkerInput, type WorkerToPage,
} from './addon-sim-client.js';

/** How many ticks one pump may run to catch up with the wall clock before it lets the thread breathe. */
const MAX_CATCHUP_TICKS = 3;
/** The timeline kinds the HUD shows. */
const SHOWN_LINE_KINDS: ReadonlySet<TimelineKind> = new Set(['chat', 'actionbar', 'title', 'form', 'console', 'script-error', 'content-log']);
/** How many times one invariant may repeat one message before it is summarised (the scenario runner's limit). */
const REPEAT_LIMIT = 3;
/** Free-fly speed (the walker's own inspection mode), blocks per tick; sprint doubles it. */
const FLY_SPEED = 0.45;

/**
 * The client-side modules other packages add to the simulator, found at build
 * time: package B's drawn camera, package C's drag routing and screen pick.
 * An absent module is `{}` here (Vite's glob of nothing), and the session does
 * the direct thing instead. Declared loosely: the web tsconfig carries no
 * `vite/client` types (lego.ts does the same for `import.meta.env`).
 */
declare global {
  interface ImportMeta { glob?: (patterns: string[]) => Record<string, () => Promise<unknown>> }
}
function detectHooks(): SimHooks {
  let found: Record<string, unknown> = {};
  // Vite rewrites the literal call to an object of the files that exist; outside Vite `glob` is undefined and the catch answers.
  try { found = import.meta.glob!(['../sim/client/camera.ts', '../sim/input/drag.ts', '../sim/input/screen.ts']) ?? {}; } catch { found = {}; }
  const keys = Object.keys(found);
  return {
    clientCamera: keys.some(k => /client\/camera\.ts$/.test(k)),
    drag: keys.some(k => /input\/drag\.ts$/.test(k)),
    tapScreen: keys.some(k => /input\/screen\.ts$/.test(k)),
    sneakToggle: 'sneakToggle' in IDLE_CONTROLS,
  };
}

const idle = (): WalkerInput => ({ seq: 0, forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, autoJump: true, dyaw: 0, dpitch: 0 });

/** A frame with nothing new, to merge the next ticks into. */
const emptyFrame = (f: SimFrame): SimFrame => ({ ...f, entities: [], removed: [], lines: [], violations: [], blocks: [] });

export interface SessionOptions {
  /** Running on the page's own thread (the HUD says so). */
  inline?: boolean;
  /** No wall clock: the caller ticks the session itself (tests). */
  clock?: boolean;
  /** The scripts' `Math.random` seed (default 1, as `scripts/sim.ts`). */
  seed?: number;
}

export class AddonSimSession {
  sim: Simulation | null = null;
  player: SimEntity | null = null;
  pack: CraftmaticPack | null = null;
  addon: Addon | null = null;
  placed: Placed | null = null;
  readonly hooks: SimHooks = detectHooks();
  private handlers: Record<string, StepHandler> = {};
  private invariants: Invariant[] = [];
  private ictx: InvariantContext | null = null;
  private quietSet: ReadonlySet<string> = new Set();
  private ctx: StepContext | null = null;
  private input: WalkerInput = idle();
  private appliedSeq = 0;
  private pendingSlot: number | undefined;
  private pendingTap = false;
  private pendingHold = false;
  private readonly pendingViolations: Violation[] = [];
  private readonly repeats = new Map<string, number>();
  private timelineSeen = 0;
  private readonly propsSent = new Map<string, string>();
  private seenIds = new Set<string>();
  private readonly dirtyBlocks = new Map<string, [number, number, number]>();
  private readonly forms = new Map<number, (a: FormAnswer) => void>();
  private formId = 0;
  private stepLabel: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private clockAt = 0;
  private pumping = false;
  private paused = false;
  private disposed = false;
  private tickMs = 0;

  constructor(private readonly post: (m: WorkerToPage) => void, private readonly options: SessionOptions = {}) {}

  /** A message from the page. */
  async receive(m: PageToWorker): Promise<void> {
    try {
      switch (m.type) {
        case 'load': {
          const info = await this.load(m.bytes, m.sizePct, m.rotation);
          this.post({ type: 'ready', info });
          if (this.options.clock !== false) this.startClock();
          break;
        }
        case 'input': this.setInput(m.input); break;
        case 'teleport': this.teleportTo(m.x, m.y, m.z, m.yaw, m.pitch, m.fly); break;
        case 'respawn': this.respawn(); break;
        case 'pause': this.paused = m.on; break;
        case 'formAnswer': { const r = this.forms.get(m.id); this.forms.delete(m.id); r?.('cancel' in m.answer ? { cancel: true } : { button: m.answer.button }); break; }
        case 'runStep': {
          const r = await this.runStep(m.step, m.target);
          this.post({ type: 'stepDone', id: m.id, ok: r.ok, ...(r.error ? { error: r.error } : {}), notes: r.notes, state: r.state });
          break;
        }
        case 'fastForward': await this.fastForward(m.ticks, m.every); break;
        default: break;
      }
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  // ─── Loading and placing ──────────────────────────────────────────────────

  /**
   * A fresh simulator over the pack, a player standing on the flat world, the
   * pack placed by its own wand at the size and turn through the SAME `place`
   * step child-play runs (the wand's forms read as a child reads them). The
   * player stays where it placed from - six blocks off the model's -X edge,
   * facing it, which is where the walk used to spawn.
   */
  async load(bytes: ArrayBuffer | Uint8Array, sizePct: number, rotation: PlacementRotation): Promise<ReadyInfo> {
    this.stopClock();
    const sim = new Simulation({ seed: this.options.seed ?? 1 });
    const addon = await readAddon(bytes, 'walker');
    sim.loadAddon(addon);
    const pack = readCraftmaticPack(addon);
    if (!pack) throw new Error('Not a craftmatic pack: no scripts/placement.js with a CONFIG literal.');
    const player = sim.addPlayer('Child', { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 }, []);
    this.sim = sim; this.addon = addon; this.pack = pack; this.player = player; this.placed = null;
    this.handlers = { ...CORE_HANDLERS, ...craftmaticHandlers(pack, addon) };
    this.input = idle(); this.appliedSeq = 0; this.pendingSlot = undefined; this.pendingTap = this.pendingHold = false;
    this.pendingViolations.length = 0; this.repeats.clear(); this.timelineSeen = 0;
    this.propsSent.clear(); this.seenIds = new Set(); this.dirtyBlocks.clear(); this.forms.clear(); this.stepLabel = undefined;
    // The invariants, as the scenario runner wires them (quietable while a step asks).
    this.invariants = coreInvariants();
    const report = (v: Omit<Violation, 'tick' | 'step'>): void => {
      const key = `${v.invariant}|${v.message}`;
      const n = (this.repeats.get(key) ?? 0) + 1;
      this.repeats.set(key, n);
      if (n <= REPEAT_LIMIT) this.pendingViolations.push({ ...v, tick: sim.engine.tick, ...(this.stepLabel ? { step: this.stepLabel } : {}) });
    };
    this.ictx = quietable({ engine: sim.engine, player, allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES], controlScheme: p => sim.host.playerState(p).controlScheme, report }, () => this.quietSet);
    for (const inv of this.invariants) inv.setup?.(this.ictx);
    const state: Record<string, unknown> = {};
    this.ctx = {
      sim, player, state, violate: report,
      note: t => this.post({ type: 'status', text: `[tick ${sim.engine.tick}] ${t}`, kind: 'info' }),
      run: async n => { for (let i = 0; i < n; i++) this.post({ type: 'frame', frame: await this.tick() }); },
      find: sel => findEntity(sim, player, sel),
      quiet: ids => { this.quietSet = new Set(ids); },
    };
    // Every block the runtime lays or changes from here on is drawn (the wand's colliders, a doorway cut, a lane's obstacle).
    sim.engine.dimension(player.dimension).onWrite = (x, y, z) => { this.dirtyBlocks.set(`${x},${y},${z}`, [x, y, z]); };
    this.post({ type: 'status', text: `Placing ${pack.placement.label} at ${sizePct} percent, turn ${rotation}, with the pack's own wand…`, kind: 'info' });
    this.stepLabel = 'place';
    await this.handlers['place']!({ kind: 'place', size: sizePct, rotation }, this.ctx);
    this.stepLabel = undefined;
    this.quietSet = new Set();
    const placed = state[PLACED_KEY] as Placed | undefined;
    if (!placed) throw new Error('The wand placed nothing (no placement record).');
    this.placed = placed;
    // Forms the scripts show from now on are the player's to answer (the wand's menu, a computer screen).
    sim.host.chooser = (form: ShownForm): Promise<FormAnswer> => new Promise(resolve => {
      const id = ++this.formId;
      this.forms.set(id, resolve);
      this.post({ type: 'form', id, kind: form.kind, title: plainText(form.title), body: plainText(form.body), buttons: form.buttons.map(plainText) });
    });
    return {
      anchor: { ...placed.anchor }, from: { ...placed.from }, to: { ...placed.to }, sizePct, rotation, playerId: player.id,
      vehicleTypes: [...pack.vehicleTypes], nativeMountTypes: [...pack.nativeMountTypes], hooks: this.hooks, inline: !!this.options.inline,
    };
  }

  // ─── The tick ─────────────────────────────────────────────────────────────

  /** The latest input; its look turn is applied once, on the next tick. */
  setInput(i: WalkerInput): void {
    const prev = this.input;
    this.input = { ...i, dyaw: prev.dyaw + i.dyaw, dpitch: prev.dpitch + i.dpitch };
    if (i.slot !== undefined) this.pendingSlot = i.slot;
    if (i.tap) this.pendingTap = true;
    if (i.hold) this.pendingHold = true;
  }

  /**
   * One tick: the input into the controls and the look, the engine's step
   * (every system in order, the scripts last), the invariants, then the frame
   * - exactly the scenario runner's `run(1)`.
   */
  async tick(): Promise<SimFrame> {
    const sim = this.sim, p = this.player;
    if (!sim || !p || !p.valid) throw new Error('no simulation loaded');
    const t0 = performance.now();
    this.applyInput();
    await sim.engine.step();
    if (this.ictx) for (const inv of this.invariants) inv.tick?.(this.ictx);
    this.tickMs = performance.now() - t0;
    return this.frame();
  }

  private applyInput(): void {
    const sim = this.sim!, p = this.player!, i = this.input;
    this.appliedSeq = i.seq;
    // A running scenario step owns the controls and the look (it steers the child itself); the page's input waits.
    if (this.stepLabel) { this.input = { ...i, dyaw: 0, dpitch: 0 }; this.pendingTap = this.pendingHold = false; return; }
    if (this.pendingSlot !== undefined) { sim.host.playerState(p).selectedSlot = this.pendingSlot; this.pendingSlot = undefined; }
    // The look: a drag turns the player's yaw and pitch directly. TODO(engine-c): route through package C's
    // `sim/input/drag.ts` (the control-scheme router) once it lands; `hooks.drag` says whether it has.
    if (i.dyaw || i.dpitch) {
      p.rotation = { x: Math.max(-89.9, Math.min(89.9, p.rotation.x + i.dpitch)), y: wrapDeg(p.rotation.y + i.dyaw) };
      this.input = { ...i, dyaw: 0, dpitch: 0 };
    }
    sim.controls.set(p.id, { forward: i.forward, strafe: i.strafe, jump: i.jump, sneak: i.sneak, sprint: i.sprint, autoJump: i.autoJump });
    if (i.fly && !p.ridingOn) {
      // Free-fly is the WALKER's inspection mode: the engine hangs a flying player (`SimEntity.flying`) and this moves it.
      p.flying = true;
      const speed = FLY_SPEED * (i.sprint ? 2 : 1);
      const w = stickToWorld({ forward: i.forward, strafe: i.strafe }, p.rotation.y);
      const up = (i.jump ? 1 : 0) - (i.sneak ? 1 : 0);
      p.location = { x: p.location.x + w.x * speed, y: Math.max(FLAT_GROUND_Y - 2, p.location.y + up * speed), z: p.location.z + w.z * speed };
    } else if (p.flying) p.flying = false;
    // A tap is a hit at the crosshair, a hold the interact (quirks `tap-is-hit`, `hold-is-interact`). TODO(engine-c): a
    // screen-space tap (`sim/input/screen.ts`, `tapScreen {u, v}`) once package C lands; `hooks.tapScreen` says so.
    if (this.pendingTap) { this.pendingTap = false; tap(sim.engine, p); }
    if (this.pendingHold) {
      this.pendingHold = false;
      const r = pick(sim.engine, p);
      if (r.entity) interact(sim.engine, p, r.entity, (a, b) => sim.host.before('playerInteractWithEntity', { player: sim.host.entity(a), target: sim.host.entity(b) }));
    }
  }

  /** What changed this tick, for the page. */
  private frame(): SimFrame {
    const sim = this.sim!, p = this.player!, engine = sim.engine;
    const entities: EntityPose[] = [];
    const ids = new Set<string>();
    for (const e of engine.loadedEntities(p.dimension)) {
      if (e.isPlayer) continue;
      ids.add(e.id);
      const pose: EntityPose = { id: e.id, typeId: e.typeId, x: e.location.x, y: e.location.y, z: e.location.z, yaw: e.rotation.y, pitch: e.rotation.x, scale: e.scale(), riding: e.ridingOn?.id ?? null };
      if (e.properties.size) {
        const props = Object.fromEntries(e.properties);
        const key = JSON.stringify(props);
        if (this.propsSent.get(e.id) !== key) { this.propsSent.set(e.id, key); pose.props = props; }
      }
      entities.push(pose);
    }
    const removed = [...this.seenIds].filter(id => !ids.has(id));
    for (const id of removed) this.propsSent.delete(id);
    this.seenIds = ids;
    const lines: SimLine[] = [];
    const entries = engine.timeline.entries;
    for (; this.timelineSeen < entries.length; this.timelineSeen++) {
      const e = entries[this.timelineSeen]!;
      if (SHOWN_LINE_KINDS.has(e.kind)) lines.push({ tick: e.tick, kind: e.kind, text: plainText(e.text), ...(e.source ? { source: e.source } : {}) });
    }
    const cam = sim.host.playerState(p).camera;
    const st = sim.host.playerState(p);
    const aimed = pick(engine, p);
    const frame: SimFrame = {
      tick: engine.tick, seq: this.appliedSeq, ms: Math.round(this.tickMs * 100) / 100,
      player: { x: p.location.x, y: p.location.y, z: p.location.z, yaw: p.rotation.y, pitch: p.rotation.x, onGround: p.onGround, sneaking: sim.controls.get(p.id).sneak, flying: p.flying, riding: p.ridingOn?.id ?? null, slot: st.selectedSlot },
      camera: cam.preset ? { ...cam, ...(cam.rotation ? { rotation: { ...cam.rotation } } : {}), ...(cam.location ? { location: { ...cam.location } } : {}), ...(cam.facing ? { facing: { ...cam.facing } } : {}) } : null,
      aim: aimed.entity ? { id: aimed.entity.id, typeId: aimed.entity.typeId, distance: aimed.distance ?? 0 } : null,
      entities, removed, lines,
      violations: this.pendingViolations.splice(0),
      unmodelled: engine.timeline.unmodelledRanking().map(u => u.member),
      ...(this.stepLabel ? { step: this.stepLabel } : {}),
    };
    if (this.dirtyBlocks.size) { frame.blocks = this.blockChanges(); }
    return frame;
  }

  /**
   * The blocks written since the last frame, as the boxes the physics
   * collides with. Full cubes stacked in a column are merged into one box
   * (the placement's first frame is the whole collider grid: tens of
   * thousands of blocks at 100 %, over a million cells at 400 %).
   */
  private blockChanges(): BlockChange[] {
    const w = this.sim!.engine.dimension(this.player!.dimension);
    const cells = [...this.dirtyBlocks.values()].sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    this.dirtyBlocks.clear();
    const out: BlockChange[] = [];
    let run: BlockChange | null = null, runTop = -Infinity;
    for (const [x, y, z] of cells) {
      const id = w.rawId(x, y, z);
      const typeId = w.palette.get(id).typeId;
      const shape = id === 0 ? undefined : w.shapeOf(id);
      const boxes = (shape?.collision ?? []).map(b => [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1] as [number, number, number, number, number, number]);
      const full = boxes.length === 1 && boxes[0]![0] === 0 && boxes[0]![1] === 0 && boxes[0]![2] === 0 && boxes[0]![3] === 1 && boxes[0]![4] === 1 && boxes[0]![5] === 1;
      if (full && run && run.x === x && run.z === z && run.typeId === typeId && y === runTop + 1) { run.boxes[0]![4] += 1; runTop = y; continue; }
      run = full ? { x, y, z, typeId, boxes } : null;
      runTop = y;
      out.push({ x, y, z, typeId, boxes });
    }
    return out;
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  private teleportTo(x: number, y: number, z: number, yaw?: number, pitch?: number, fly?: boolean): void {
    const sim = this.sim, p = this.player;
    if (!sim || !p) return;
    teleport(sim.host, p, { x, y, z });
    if (yaw !== undefined || pitch !== undefined) p.rotation = { x: pitch ?? p.rotation.x, y: yaw ?? p.rotation.y };
    if (fly !== undefined) { this.input = { ...this.input, fly }; p.flying = fly; }
    p.onGround = false;
  }

  /** Back to where the child placed from (child-play's `craftmatic.start`), facing the model. */
  private respawn(): void {
    const sim = this.sim, p = this.player, start = this.ctx?.state['craftmatic.start'] as { x: number; y: number; z: number } | undefined;
    if (!sim || !p || !start) return;
    this.input = { ...this.input, fly: false };
    p.flying = false;
    teleport(sim.host, p, start);
    p.rotation = { x: 5, y: -90 };
    p.onGround = false;
  }

  /** A scenario step by kind, through the same handlers `scripts/sim.ts` runs. */
  async runStep(step: RunStepMessage['step'], target?: { typeId: string }): Promise<{ ok: boolean; error?: string; notes: string[]; state: Record<string, unknown> }> {
    const ctx = this.ctx;
    const handler = this.handlers[step.kind];
    if (!ctx) return { ok: false, error: 'no simulation loaded', notes: [], state: {} };
    if (!handler) return { ok: false, error: `no handler for step kind ${step.kind}`, notes: [], state: {} };
    const notes: string[] = [];
    const noting = { ...ctx, note: (t: string) => { notes.push(`[tick ${ctx.sim.engine.tick}] ${t}`); ctx.note(t); } };
    const s: AnyStep = { ...step, ...(target ? { target: { type: target.typeId, label: target.typeId } } : {}) };
    const wasPaused = this.paused;
    this.paused = true;
    this.stepLabel = String(step['label'] ?? step.kind);
    try {
      await handler(s, noting);
      return { ok: true, notes, state: this.stepState(ctx.state) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), notes, state: this.stepState(ctx.state) };
    } finally {
      this.stepLabel = undefined;
      this.quietSet = new Set();
      this.paused = wasPaused;
    }
  }

  /** The step state without the engine caches (as the runner reports it) and anything that cannot cross a message. */
  private stepState(state: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(state)) {
      if (/staticDrawn|craftmatic\.snapshot$|^lastTap$|^lastHold$/.test(k)) continue;
      try { out[k] = JSON.parse(JSON.stringify(v)); } catch { /* not serialisable */ }
    }
    return out;
  }

  /** Many ticks as fast as the thread allows, a merged frame every `every`. */
  async fastForward(ticks: number, every: number): Promise<void> {
    const wasPaused = this.paused;
    this.paused = true;
    try {
      let acc: SimFrame | null = null;
      for (let t = 0; t < ticks && !this.disposed; t++) {
        const f = await this.tick();
        acc = acc ? mergeFrames(acc, f) : f;
        if ((t + 1) % every === 0 || t === ticks - 1) { this.post({ type: 'frame', frame: acc }); acc = null; }
      }
    } finally { this.paused = wasPaused; }
  }

  // ─── The clock ────────────────────────────────────────────────────────────

  private startClock(): void {
    this.stopClock();
    this.clockAt = performance.now();
    this.timer = setInterval(() => { void this.pump(); }, SIM_TICK_MS);
  }

  private stopClock(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run the ticks the wall clock owes, up to `MAX_CATCHUP_TICKS`; a running step or a pause owns the engine meanwhile. */
  private async pump(): Promise<void> {
    if (this.pumping || this.paused || this.disposed || !this.sim) return;
    const now = performance.now();
    let due = Math.floor((now - this.clockAt) / SIM_TICK_MS);
    if (due <= 0) return;
    if (due > MAX_CATCHUP_TICKS) { due = MAX_CATCHUP_TICKS; this.clockAt = now - due * SIM_TICK_MS; }
    this.pumping = true;
    try {
      for (let i = 0; i < due && !this.paused && !this.disposed; i++) {
        this.clockAt += SIM_TICK_MS;
        this.post({ type: 'frame', frame: await this.tick() });
      }
    } catch (e) {
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      this.stopClock();
    } finally { this.pumping = false; }
  }

  dispose(): void {
    this.disposed = true;
    this.stopClock();
    this.sim = null;
  }
}

/** Two consecutive frames as one: the later poses, every line, violation and block change of both. */
export function mergeFrames(a: SimFrame, b: SimFrame): SimFrame {
  const props = new Map<string, Record<string, number | boolean | string>>();
  for (const e of a.entities) if (e.props) props.set(e.id, e.props);
  const entities = b.entities.map(e => (e.props || !props.has(e.id) ? e : { ...e, props: props.get(e.id)! }));
  const blocks = new Map<string, BlockChange>();
  for (const c of [...(a.blocks ?? []), ...(b.blocks ?? [])]) blocks.set(`${c.x},${c.y},${c.z}`, c);
  return {
    ...emptyFrame(b), entities, removed: [...new Set([...a.removed, ...b.removed])], lines: [...a.lines, ...b.lines], violations: [...a.violations, ...b.violations],
    ...(blocks.size ? { blocks: [...blocks.values()] } : {}),
  };
}

// Worker entry: only when running as one (the page's inline fallback and the tests import the session).
if (typeof self !== 'undefined' && typeof (self as { importScripts?: unknown }).importScripts === 'function') {
  const worker = self as unknown as Worker;
  const session = new AddonSimSession(m => worker.postMessage(m));
  self.onmessage = (e: MessageEvent<PageToWorker>) => { void session.receive(e.data); };
}
