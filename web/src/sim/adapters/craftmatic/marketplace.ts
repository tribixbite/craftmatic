/**
 * `--scenario=marketplace` (T02, BIZ-26 / BIZ-29): a store-ready pack played the way a Marketplace reviewer and a
 * child would play it.
 *
 * It covers, per pack:
 *   - install: no content-log or script fault the sim models, the wand's runtime ready, the pack's ids in its own
 *     namespace, its custom blocks within the Marketplace's 10,000-permutation cap;
 *   - first join: ONE chat line of 28 characters or fewer, once per player (a second player gets their own, a re-join
 *     and a reopened world get none), and the Guide a button away;
 *   - the wand: placement into AIR only. On clear ground it places without a prompt; over foreign blocks it shows the
 *     "n foreign blocks" prompt (Find a clear spot / Move / Cancel) and writes NOTHING until the child chooses; Cancel
 *     and Move leave the world byte for byte as it was; Find a clear spot builds on a footprint that was air; no
 *     player block is ever replaced;
 *   - an exact Undo (every block of every region the placement could touch, every entity it spawned) that leaves no
 *     ticking area behind (nor does anything else the wand does);
 *   - two players placing and undoing without cross-talk;
 *   - the pack's brick blocks (M03) and compact collider states (M05) colliding like the dev encoding: with a
 *     `reference` pack (the same model built without `brickBlocks` / `compactColliderStates`) every cell's collision
 *     boxes are compared at 100 % and at a resized step;
 *   - no LEGO word in any player-facing text the sim shows (X-05's `lintText` over form titles, bodies and buttons,
 *     chat, action bar and title lines), in EVERY scenario;
 *   - the pack's own child play (every door, seat, vehicle and ride) at 100 %, which already runs through the same
 *     wand, so a store pack is also judged as a dev pack is.
 *
 * Scenarios are data (`marketplaceScenarios`); the steps are `marketplaceHandlers`; `runMarketplace` runs one pack
 * (what the CLI and the test call). A pack that is not a store pack (no `marketplacePlacement`) fails on purpose:
 * its wand replaces blocks, which `foreign-block-replaced` reports.
 */

import type { Invariant } from '../../scenario/invariants.js';
import type { RunOptions, ScenarioResult } from '../../scenario/runner.js';
import { runScenario } from '../../scenario/runner.js';
import type { AnyStep, Scenario, Step, StepContext, StepHandler } from '../../scenario/types.js';
import type { FormAnswer, FormChooser, ShownForm } from '../../script-host/ui-module.js';
import type { SimEngine } from '../../core/engine.js';
import type { SimEntity } from '../../entity/entity.js';
import type { Vec3 } from '../../core/vec.js';
import type { VoxelWorld } from '../../world/voxel-world.js';
import { Simulation } from '../../core/simulation.js';
import { FLAT_GROUND_Y } from '../../world/voxel-world.js';
import { teleport } from '../../script-host/facades.js';
import { plainText } from '../../script-host/text.js';
import { readAddon } from '../../pack/pack.js';
import { lintText } from '../../../engine/pack-text/lint.js';
import { CRAFTMATIC_ALLOWED_LINES, CRAFTMATIC_YIELDING_LINES, childPlayScenarios, craftmaticHandlers } from './child-play.js';
import { readCraftmaticPack, type CraftmaticPack } from './pack-facts.js';
import { DEV_NAMESPACE } from './namespace.js';
import { SNAPSHOT_KEY, aimAtGround, confirmSummary, holdWand, menuState, openMenu, waitForChat, wandHandlers } from './wand.js';

/** The Marketplace's cap on a pack's block permutations (M03/M05 keep the store pack under it). */
export const MARKETPLACE_PERMUTATION_CAP = 10_000;
/** A first-join chat line may not exceed this many characters (the Marketplace chat rule, M07). */
export const FIRST_JOIN_MAX_CHARS = 28;
/** A wand flow that takes longer than this many ticks is taken to be stuck. */
const FLOW_TIMEOUT_TICKS = 6000;
/** Blocks round a placement box that are captured too, so a write that spills past the box is seen. */
const REGION_MARGIN = 3;
/** The most prompts a "Place" press may bring back before the flow is taken to be refused. */
const MAX_MENU_PRESSES = 3;

// ─── Regions: the world as a snapshot, and what changed ───

/** A box of the world as raw block ids, taken before something that must not change it (or must undo exactly). */
interface Region { name: string; origin: Vec3; dims: { w: number; h: number; l: number }; ids: number[] }

const AIR = 'minecraft:air';
const typeName = (w: VoxelWorld, id: number): string => w.palette.get(id).typeId;
const isAir = (type: string): boolean => type === AIR || type === 'minecraft:unknown';

/** Capture `origin .. origin + dims` widened by `margin` on every side. */
function capture(world: VoxelWorld, name: string, origin: Vec3, dims: Region['dims'], margin = REGION_MARGIN): Region {
  const o = { x: origin.x - margin, y: origin.y - margin, z: origin.z - margin }, d = { w: dims.w + 2 * margin, h: dims.h + 2 * margin, l: dims.l + 2 * margin };
  const ids: number[] = [];
  for (let x = 0; x < d.w; x++) for (let y = 0; y < d.h; y++) for (let z = 0; z < d.l; z++) ids.push(world.rawId(o.x + x, o.y + y, o.z + z));
  return { name, origin: o, dims: d, ids };
}

interface Changed { at: Vec3; before: string; after: string }

/** Every cell of a region whose block is not what it was. */
function changed(world: VoxelWorld, r: Region): Changed[] {
  const out: Changed[] = [];
  let i = 0;
  for (let x = 0; x < r.dims.w; x++) for (let y = 0; y < r.dims.h; y++) for (let z = 0; z < r.dims.l; z++, i++) {
    const now = world.rawId(r.origin.x + x, r.origin.y + y, r.origin.z + z);
    if (now !== r.ids[i]) out.push({ at: { x: r.origin.x + x, y: r.origin.y + y, z: r.origin.z + z }, before: typeName(world, r.ids[i]!), after: typeName(world, now) });
  }
  return out;
}

const sample = (list: readonly Changed[], n = 4): string =>
  list.slice(0, n).map(c => `${c.at.x},${c.at.y},${c.at.z} ${c.before} -> ${c.after}`).join('; ');

/** Cells of a region that held a block (not air) when it was captured. */
const occupiedCells = (world: VoxelWorld, r: Region): Array<{ at: Vec3; type: string }> => {
  const out: Array<{ at: Vec3; type: string }> = [];
  let i = 0;
  for (let x = 0; x < r.dims.w; x++) for (let y = 0; y < r.dims.h; y++) for (let z = 0; z < r.dims.l; z++, i++) {
    const type = typeName(world, r.ids[i]!);
    if (!isAir(type) && !/^minecraft:(grass_block|dirt|stone|bedrock|grass|snow)$/.test(type)) out.push({ at: { x: r.origin.x + x, y: r.origin.y + y, z: r.origin.z + z }, type });
  }
  return out;
};

// ─── The form spy and the player-text lint ───

/** Every form a scenario's chooser was asked to answer (title, body and buttons, which the timeline line leaves out of its body). */
const SHOWN = new WeakMap<SimEngine, ShownForm[]>();

/**
 * Wrap `host.chooser` so every assignment (the wand steps set their own) is recorded: the lint reads each form's BODY,
 * which the timeline's `form` line does not carry.
 */
function spyOnForms(sim: Simulation): void {
  const forms: ShownForm[] = [];
  SHOWN.set(sim.engine, forms);
  let inner: FormChooser = sim.host.chooser;
  Object.defineProperty(sim.host, 'chooser', {
    configurable: true, enumerable: true,
    get: (): FormChooser => (form: ShownForm) => { forms.push(form); return inner(form); },
    set: (c: FormChooser) => { inner = c; },
  });
}

/** The forms a sim's chooser has seen. */
const shownForms = (engine: SimEngine): ShownForm[] => SHOWN.get(engine) ?? [];

/**
 * `player-text-lint`: nothing the sim shows a player may carry a trademark, set number, licensed name, developer stamp
 * or `craftmatic` (X-05's rules, `lintText`). Reads form titles, bodies and buttons, chat, action bar and title lines;
 * each distinct finding is reported once.
 */
export function playerTextLint(): Invariant {
  let line = 0, formsSeen = 0;
  const seen = new Set<string>();
  return {
    id: 'player-text-lint',
    description: 'No LEGO mark, set number, licensed name, developer stamp or working name in any text shown to a player.',
    tick(ctx) {
      const check = (where: string, text: string): void => {
        for (const f of lintText(plainText(text), { surface: 'prose' })) {
          const key = `${f.ruleId}|${f.match}|${where}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ctx.report({ invariant: 'player-text-lint', message: `${f.ruleId} "${f.match}" in ${where}: ${plainText(f.context).slice(0, 140)}`, evidence: { rule: f.ruleId } });
        }
      };
      const entries = ctx.engine.timeline.entries;
      for (; line < entries.length; line++) {
        const e = entries[line]!;
        if (e.kind === 'chat' || e.kind === 'actionbar' || e.kind === 'title') check(e.kind, e.text);
      }
      const forms = shownForms(ctx.engine);
      for (; formsSeen < forms.length; formsSeen++) {
        const f = forms[formsSeen]!;
        check(`form "${plainText(f.title).slice(0, 40)}"`, [f.title, f.body, ...f.buttons].join('\n'));
      }
    },
  };
}

/** The run options every marketplace scenario takes: the lint invariant and the form spy. */
export function marketplaceRunOptions(): Pick<RunOptions, 'invariants' | 'prepare'> {
  return { invariants: [playerTextLint()], prepare: sim => spyOnForms(sim) };
}

// ─── Driving the wand ───

/** What one wand flow showed and chose. */
interface WandRun {
  forms: ShownForm[];
  confirm?: ShownForm;
  summary: ReturnType<typeof confirmSummary>;
  /** The "Placed ..." / "Placement stopped" line, when the flow reached one. */
  line?: string;
  /** Set by a `decide` that has said what it wanted; the flow ends. */
  done: boolean;
  presses: number;
}

/** Answers one form: undefined leaves the default (the menu adjusts, then presses Place; the confirm presses Place now). */
type Decide = (form: ShownForm, run: WandRun) => FormAnswer | undefined;

interface WandOptions { size: number; rotation: number; ahead: number; decide?: Decide; until?: RegExp }

const NOT_A_FLOW = /^$/;

/**
 * Select the wand and answer its forms as a child would: turn and size it to the asked step, press Place, and let
 * `decide` take over any form it wants (a foreign-block prompt, the confirm). Returns what was shown.
 */
async function driveWand(ctx: StepContext, pack: CraftmaticPack, o: WandOptions): Promise<WandRun> {
  const run: WandRun = { forms: [], summary: {}, done: false, presses: 0 };
  const target = aimAtGround(ctx, o.ahead);
  void target;
  ctx.sim.host.chooser = (form: ShownForm): FormAnswer => {
    run.forms.push(form);
    const title = plainText(form.title);
    const mine = o.decide?.(form, run);
    if (mine) return mine;
    if (/· Brick Wand$/.test(title)) {
      const s = menuState(form);
      if (s.rotation !== undefined && s.rotation !== o.rotation) return { button: 'Rotate' };
      if (s.size !== undefined && s.size !== o.size) return { button: 'Size' };
      if (++run.presses > MAX_MENU_PRESSES) { run.done = true; return { cancel: true }; }
      return { button: 'Place' };
    }
    if (/^Place .*\?$/.test(title) && form.buttons.some(b => plainText(b) === 'Place now')) {
      run.confirm = form; run.summary = confirmSummary(form);
      return { button: 'Place now' };
    }
    return { cancel: true };
  };
  const since = ctx.sim.engine.timeline.entries.length;
  await openMenu(ctx, pack, since);
  const line = await waitForChat(ctx, o.until ?? /Placed |Placement stopped/, FLOW_TIMEOUT_TICKS, since, () => run.done);
  if (line) run.line = line;
  holdWand(ctx, pack, false);
  ctx.sim.host.chooser = () => ({ cancel: true });
  await ctx.run(6);
  return run;
}

/** How far ahead the footprint's centre is aimed: the child stands clear of the model. */
const aheadFor = (pack: CraftmaticPack, size: number, rotation: number): number => {
  const w = rotation % 180 ? pack.placement.length : pack.placement.width, l = rotation % 180 ? pack.placement.width : pack.placement.length;
  return Math.ceil(Math.max(w, l) * (size / 100) / 2) + 6;
};

// ─── Small world checks shared by the steps ───

const areaNames = (ctx: StepContext): string[] => [...ctx.sim.engine.tickingAreas.keys()].sort();

/** The pack's own entities the wand tagged (`cmu_...`): what an Undo must take away. */
const placedActors = (ctx: StepContext): SimEntity[] =>
  [...ctx.sim.engine.entities.values()].filter(e => e.valid && !e.isPlayer && [...e.tags].some(t => t.startsWith('cmu_')));

const structureLoads = (ctx: StepContext): number => ctx.sim.engine.timeline.of('command').filter(e => /^structure load\b/.test(e.text)).length;

/** Violate when a ticking area exists that did not before the flow. */
function noLeftoverAreas(ctx: StepContext, baseline: readonly string[], where: string): void {
  const left = areaNames(ctx).filter(n => !baseline.includes(n));
  if (left.length) ctx.violate({ invariant: 'ticking-area-left', message: `${where}: ${left.length} ticking area(s) still exist: ${left.slice(0, 4).join(', ')}`, evidence: { areas: left } });
}

/** Violate for every captured cell that held a block and does not now (a player's block replaced). */
function noForeignChanged(ctx: StepContext, world: VoxelWorld, regions: readonly Region[], where: string): number {
  let total = 0;
  const lost: Changed[] = [];
  for (const r of regions) {
    const was = new Map(occupiedCells(world, r).map(c => [`${c.at.x},${c.at.y},${c.at.z}`, c.type] as const));
    for (const c of changed(world, r)) if (was.has(`${c.at.x},${c.at.y},${c.at.z}`)) lost.push(c);
  }
  total = lost.length;
  if (total) ctx.violate({ invariant: 'foreign-block-replaced', message: `${where}: ${total} block(s) that were already there changed: ${sample(lost)}`, evidence: { count: total, sample: lost.slice(0, 8) } });
  return total;
}

// ─── The scenarios ───

/** Distinct options a marketplace run takes. */
export interface MarketplaceScenarioOptions {
  /** A dev-encoding twin was given: add the collider-parity scenario. */
  reference?: boolean;
  /** Also run the pack's own child play at 100 % (default true). */
  childPlay?: boolean;
  /** Short drives and lives in the child play (default true; the dev pack's `--quick`). */
  quick?: boolean;
}

/** A closing step every scenario ends with: nothing left ticking, nothing placed left standing unexplained. */
const closing: Step = { kind: 'mpQuiet', label: 'no ticking area left' };

/** The marketplace scenarios for one pack. */
export function marketplaceScenarios(pack: CraftmaticPack, options: MarketplaceScenarioOptions = {}): Scenario[] {
  const common = { allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES] };
  const out: Scenario[] = [
    { name: 'mp-install', description: 'The pack installs clean: no content-log fault, scripts ready, own namespace, blocks under the permutation cap.', steps: [{ kind: 'mpInstall' }, closing], ...common },
    { name: 'mp-first-join', description: 'One first-join chat line of 28 characters or fewer per player, never repeated; the Guide opens.', steps: [{ kind: 'mpFirstJoin' }, { kind: 'mpGuide' }, closing], ...common },
    { name: 'mp-clear-ground', description: 'Placing on clear ground gives no prompt and replaces nothing; Undo is exact; no ticking area is left; the placed blocks are the pack\'s own.', steps: [{ kind: 'mpClearGround' }, closing], ...common },
    { name: 'mp-cluttered', description: 'Over foreign blocks the wand prompts and writes nothing until asked: Cancel and Move change nothing, Find a clear spot builds on air, no block is replaced, Undo is exact.', steps: [{ kind: 'mpCluttered' }, closing], ...common },
    { name: 'mp-two-players', description: 'Two players place and undo in turn: each Undo takes away only that player\'s placement; each player is told only their own.', steps: [{ kind: 'mpTwoPlayers' }, closing], ...common },
  ];
  if (options.reference) out.push({ name: 'mp-collider-parity', description: 'The pack\'s brick blocks and compact collider states collide like the dev encoding (cell by cell).', steps: [{ kind: 'mpColliderParity' }, closing], ...common });
  if (options.childPlay !== false) {
    // The pack's own play (every door, seat, vehicle, ride) at 100 % through the same wand, with the lint on.
    for (const s of childPlayScenarios(pack, { quick: options.quick ?? true, sizes: [100] })) if (s.name === 'place-100-0' || s.name === 'play-100-0') out.push({ ...s, name: `mp-${s.name}`, steps: [...s.steps, closing] });
  }
  return out;
}

// ─── The step handlers ───

/** Custom blocks and how many permutations each declares (the product of its states' value counts, 1 with none). */
function permutationCount(world: VoxelWorld): { total: number; blocks: Array<{ id: string; n: number }> } {
  const blocks: Array<{ id: string; n: number }> = [];
  const types = world.types as unknown as { custom?: Map<string, unknown> };
  for (const id of types.custom ? [...types.custom.keys()] : []) {
    const states = world.types.declaredStates(id);
    let n = 1;
    for (const v of states?.values() ?? []) n *= Array.isArray(v) ? v.length : v.max - v.min + 1;
    blocks.push({ id, n });
  }
  return { total: blocks.reduce((a, b) => a + b.n, 0), blocks };
}

/** The reference (dev-encoding) pack's bytes, read afresh per use. */
export interface MarketplaceHandlerOptions { reference?: Uint8Array }

/** The steps `marketplaceScenarios` names, for one pack. */
export function marketplaceHandlers(pack: CraftmaticPack, handlerOptions: MarketplaceHandlerOptions = {}): Record<string, StepHandler> {
  const wand = wandHandlers(pack);
  const nameOf = (p: SimEntity): string => p.nameTag;
  const lines = (ctx: StepContext, kind: 'chat' | 'actionbar', p?: SimEntity, since = 0): string[] =>
    ctx.sim.engine.timeline.entries.slice(since).filter(e => e.kind === kind && (!p || e.target === nameOf(p))).map(e => plainText(e.text));
  const worldOf = (ctx: StepContext, p = ctx.player): VoxelWorld => ctx.sim.engine.dimension(p.dimension);
  /** `playerSpawn` as the game raises it (the sim does not on its own: scripts load before any player). */
  const spawn = async (ctx: StepContext, p: SimEntity, initialSpawn: boolean): Promise<void> => {
    ctx.sim.host.deliver('playerSpawn', { player: ctx.sim.host.entity(p), initialSpawn });
    await ctx.run(2);
  };

  /** The placement a wand run made (must have reached a confirm form). */
  const needSummary = (run: WandRun, what: string): { origin: Vec3; dims: Region['dims'] } => {
    const { origin, dims } = run.summary;
    if (!origin || !dims) throw new Error(`${what}: the wand showed no confirm form (forms: ${run.forms.map(f => plainText(f.title)).join(' | ') || 'none'})`);
    return { origin, dims: { w: dims.w, h: dims.h, l: dims.l } };
  };

  /** Undo as the player does (the menu's button), without the shared handler's audit; returns the line it said. */
  const undoOnce = async (ctx: StepContext): Promise<string | undefined> => {
    ctx.sim.host.chooser = (form: ShownForm): FormAnswer => (/· Brick Wand$/.test(plainText(form.title)) ? { button: 'Undo last placement' } : { cancel: true });
    const since = ctx.sim.engine.timeline.entries.length;
    await openMenu(ctx, pack, since);
    const line = await waitForChat(ctx, /Undo complete|Nothing to undo|Undo stopped/, FLOW_TIMEOUT_TICKS, since);
    holdWand(ctx, pack, false);
    ctx.sim.host.chooser = () => ({ cancel: true });
    await ctx.run(6);
    return line;
  };

  /** The placed box's blocks: unknown ids, and vanilla concrete where the pack ships brick blocks. */
  const censusOfPlaced = (ctx: StepContext, world: VoxelWorld, origin: Vec3, dims: Region['dims']): void => {
    const counts = new Map<string, number>();
    for (let x = 0; x < dims.w; x++) for (let y = 0; y < dims.h; y++) for (let z = 0; z < dims.l; z++) {
      const t = typeName(world, world.rawId(origin.x + x, origin.y + y, origin.z + z));
      if (!isAir(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const unknown = [...counts].filter(([t]) => !world.types.exists(t));
    if (unknown.length) ctx.violate({ invariant: 'unknown-block-placed', message: `the placement wrote ${unknown.length} block type(s) the pack does not define: ${unknown.slice(0, 4).map(([t, n]) => `${t} x${n}`).join(', ')}`, evidence: { unknown } });
    const custom = [...counts].filter(([t]) => world.types.isCustom(t)), concrete = [...counts].filter(([t]) => /^minecraft:.*_concrete$/.test(t));
    const brickBlocks = custom.filter(([t]) => /:(brick|plate)_/.test(t));
    ctx.note(`placed blocks: ${[...counts].reduce((a, [, n]) => a + n, 0)} in ${counts.size} types (${custom.length} custom, ${brickBlocks.length} brick/plate, ${concrete.length} vanilla concrete)`);
    // The pack DECLARES brick/plate blocks (M03's flag was on) yet its structure still writes vanilla concrete.
    const declared = permutationCount(world).blocks.filter(b => /:(brick|plate)_/.test(b.id)).length;
    if (declared && concrete.length) ctx.violate({ invariant: 'brick-blocks-unused', message: `the pack ships ${declared} brick/plate block(s) and its placement still writes vanilla concrete (${brickBlocks.length} brick types placed): ${concrete.slice(0, 3).map(([t, n]) => `${t} x${n}`).join(', ')}`, evidence: { concrete } });
  };

  return {
    // ── install ──
    async mpInstall(_step: AnyStep, ctx: StepContext) {
      await ctx.run(40);
      const engine = ctx.sim.engine, world = worldOf(ctx);
      const faults = [...engine.timeline.of('content-log'), ...engine.timeline.of('script-error')];
      if (faults.length) ctx.violate({ invariant: 'install-fault', message: `${faults.length} fault(s) while installing: ${faults.slice(0, 3).map(f => f.text.slice(0, 120)).join(' | ')}` });
      if (world.types.loadErrors.length) ctx.violate({ invariant: 'install-fault', message: `block definitions with errors: ${world.types.loadErrors.slice(0, 3).join(' | ')}` });
      if (!engine.timeline.of('console').some(e => /BRICK_WAND_READY/.test(e.text))) ctx.violate({ invariant: 'wand-not-ready', message: 'the wand runtime never reported BRICK_WAND_READY' });
      if (pack.namespace === DEV_NAMESPACE) ctx.violate({ invariant: 'dev-namespace', message: `the pack's ids are in the dev namespace "${DEV_NAMESPACE}", not a product namespace` });
      const text = new TextDecoder().decode(pack.pack.files.get('scripts/placement.js') ?? new Uint8Array());
      if (!/"marketplace":true/.test(text)) ctx.violate({ invariant: 'marketplace-placement-off', message: 'the wand was not built with marketplacePlacement: it replaces whatever is in the footprint (BIZ-26)' });
      const perms = permutationCount(world);
      ctx.note(`custom blocks: ${perms.blocks.length}, permutations ${perms.total}`);
      if (perms.total > MARKETPLACE_PERMUTATION_CAP) ctx.violate({ invariant: 'permutation-cap', message: `${perms.total} block permutations exceed the Marketplace's ${MARKETPLACE_PERMUTATION_CAP}`, evidence: { top: perms.blocks.sort((a, b) => b.n - a.n).slice(0, 5) } });
      if (world.types.unknownVanilla.size) ctx.note(`vanilla ids the sim could not size: ${[...world.types.unknownVanilla.keys()].slice(0, 6).join(', ')}`);
    },

    // ── first join ──
    async mpFirstJoin(_step: AnyStep, ctx: StepContext) {
      const a = ctx.player, b = ctx.sim.addPlayer('Second', { x: 0.5, y: FLAT_GROUND_Y, z: 30.5 }, []);
      const since = ctx.sim.engine.timeline.entries.length;
      const said = (p: SimEntity, from = since): string[] => lines(ctx, 'chat', p, from);
      await spawn(ctx, a, true);
      const first = said(a);
      if (first.length !== 1) ctx.violate({ invariant: 'first-join-chat', message: `the first join gave ${first.length} chat line(s) (want exactly 1): ${first.join(' | ').slice(0, 160)}` });
      for (const l of first) if (l.length > FIRST_JOIN_MAX_CHARS) ctx.violate({ invariant: 'chat-too-long', message: `"${l}" is ${l.length} characters (the Marketplace rule is ${FIRST_JOIN_MAX_CHARS})` });
      const now = ctx.sim.engine.timeline.entries.length;
      await spawn(ctx, a, true);
      await spawn(ctx, a, false);
      if (said(a, now).length) ctx.violate({ invariant: 'first-join-repeated', message: `a re-join / respawn of the same player gave another chat line: ${said(a, now).join(' | ')}` });
      ctx.sim.reloadScripts();
      await ctx.run(4);
      const reopened = ctx.sim.engine.timeline.entries.length;
      await spawn(ctx, a, true);
      if (said(a, reopened).length) ctx.violate({ invariant: 'first-join-repeated', message: 'after the world was reopened the same player was welcomed again' });
      const bFrom = ctx.sim.engine.timeline.entries.length;
      await spawn(ctx, b, true);
      if (said(b, bFrom).length !== 1) ctx.violate({ invariant: 'first-join-chat', message: `a second player's first join gave ${said(b, bFrom).length} chat line(s) (want 1: the welcome is remembered per player)` });
      if (said(a, bFrom).length) ctx.violate({ invariant: 'cross-talk', message: `the second player's join sent chat to the first: ${said(a, bFrom).join(' | ')}` });
      const other = lines(ctx, 'chat').filter(l => !first.includes(l) && !said(b, bFrom).includes(l));
      if (other.length) ctx.violate({ invariant: 'chat-on-join', message: `chat other than the one welcome line: ${other.slice(0, 3).join(' | ')}` });
      ctx.note(`first-join line: "${first[0] ?? ''}" (${first[0]?.length ?? 0} characters)`);
    },

    async mpGuide(_step: AnyStep, ctx: StepContext) {
      const seen: string[] = [];
      ctx.sim.host.chooser = (form: ShownForm): FormAnswer => {
        const title = plainText(form.title);
        if (/· Brick Wand$/.test(title) && !seen.length) { seen.push('menu'); return form.buttons.some(b => plainText(b) === 'Guide') ? { button: 'Guide' } : { cancel: true }; }
        if (/^Guide \d+\/\d+$/.test(title)) { seen.push(title); return /^Guide 1\//.test(title) ? { button: 'Next' } : { button: 'Close' }; }
        return { cancel: true };
      };
      const since = ctx.sim.engine.timeline.entries.length;
      await openMenu(ctx, pack, since);
      await ctx.run(20);
      holdWand(ctx, pack, false);
      ctx.sim.host.chooser = () => ({ cancel: true });
      await ctx.run(4);
      if (!seen.some(s => /^Guide 1\//.test(s))) ctx.violate({ invariant: 'guide-missing', message: `the wand menu has no Guide button that opens (forms: ${seen.join(', ') || 'none'})` });
      else if (!seen.some(s => /^Guide 2\//.test(s))) ctx.violate({ invariant: 'guide-missing', message: 'the Guide has no second page' });
    },

    // ── the wand on clear ground ──
    async mpClearGround(_step: AnyStep, ctx: StepContext) {
      const world = worldOf(ctx), baseline = areaNames(ctx);
      const regions: Region[] = [];
      let prompted = false;
      const run = await driveWand(ctx, pack, {
        size: 100, rotation: 0, ahead: aheadFor(pack, 100, 0),
        decide: (form, r) => {
          if (/foreign block/.test(plainText(form.title))) { prompted = true; r.done = true; return { cancel: true }; }
          if (/^Place .*\?$/.test(plainText(form.title))) {
            const s = confirmSummary(form);
            if (s.origin && s.dims) regions.push(capture(world, 'footprint', s.origin, { w: s.dims.w, h: s.dims.h, l: s.dims.l }));
          }
          return undefined;
        },
      });
      if (prompted) { ctx.violate({ invariant: 'prompt-on-clear-ground', message: 'the wand reported foreign blocks on clear ground' }); return; }
      if (!run.line || /stopped/.test(run.line)) { ctx.violate({ invariant: 'placement-completes', message: run.line ?? 'no "Placed" line' }); return; }
      const { origin, dims } = needSummary(run, 'clear ground');
      const confirmText = plainText(run.confirm!.body);
      if (/will be replaced/i.test(confirmText)) ctx.violate({ invariant: 'replace-warning', message: 'the confirm form still says blocks will be replaced' });
      if (!changed(world, regions[0]!).length) ctx.violate({ invariant: 'placed-nothing', message: 'the placement changed no block of its footprint' });
      noLeftoverAreas(ctx, baseline, 'after Place');
      if (!placedActors(ctx).length && pack.placement.actors.length) ctx.violate({ invariant: 'placed-nothing', message: 'the placement spawned none of the pack\'s entities' });
      censusOfPlaced(ctx, world, origin, dims);
      ctx.state[SNAPSHOT_KEY] = { origin: regions[0]!.origin, dims: regions[0]!.dims, ids: regions[0]!.ids };
      await wand['undo']!({ kind: 'undo' }, ctx);
      const after = changed(world, regions[0]!);
      if (after.length) ctx.violate({ invariant: 'undo-inexact', message: `${after.length} block(s) of the placement's region differ after Undo: ${sample(after)}`, evidence: { sample: after.slice(0, 8) } });
      noLeftoverAreas(ctx, baseline, 'after Undo');
    },

    // ── the wand over foreign blocks ──
    async mpCluttered(_step: AnyStep, ctx: StepContext) {
      const world = worldOf(ctx), baseline = areaNames(ctx), engine = ctx.sim.engine;
      const size = 100, rotation = 0, ahead = aheadFor(pack, size, rotation);
      // 1. A probe: where the footprint is, without writing (the confirm form is backed out of).
      const probe = await driveWand(ctx, pack, {
        size, rotation, ahead, until: NOT_A_FLOW,
        decide: (form, r) => {
          if (/^Place .*\?$/.test(plainText(form.title))) { r.confirm = form; r.summary = confirmSummary(form); return { button: 'Back' }; }
          if (/· Brick Wand$/.test(plainText(form.title)) && r.confirm) { r.done = true; return { cancel: true }; }
          return undefined;
        },
      });
      const { origin, dims } = needSummary(probe, 'probe');
      // 2. The child's own blocks: a lattice over the two lowest layers of the footprint (every third column), so
      //    any model that builds at its foot meets them, and their count is known exactly.
      const clutter: Array<{ at: Vec3; type: string }> = [];
      const types = ['minecraft:diamond_block', 'minecraft:gold_block', 'minecraft:oak_planks'];
      for (let x = 0; x < dims.w; x += 3) for (let z = 0; z < dims.l; z += 3) for (let y = 0; y < Math.min(2, dims.h); y++) clutter.push({ at: { x: origin.x + x, y: origin.y + y, z: origin.z + z }, type: types[(x / 3 + z / 3 + y) % types.length]! });
      for (const c of clutter) world.setPermutation(c.at.x, c.at.y, c.at.z, ctx.sim.host.resolvePermutation(c.type));
      const original = capture(world, 'original footprint', origin, dims);
      const entitiesBefore = engine.entities.size, loadsBefore = structureLoads(ctx);
      const regions: Region[] = [original];
      const intact = (where: string): void => {
        const lost = clutter.filter(c => typeName(world, world.rawId(c.at.x, c.at.y, c.at.z)) !== c.type);
        if (lost.length) ctx.violate({ invariant: 'foreign-block-replaced', message: `${where}: ${lost.length} of the child's ${clutter.length} blocks were replaced: ${lost.slice(0, 3).map(c => `${c.at.x},${c.at.y},${c.at.z} ${c.type} -> ${typeName(world, world.rawId(c.at.x, c.at.y, c.at.z))}`).join('; ')}`, evidence: { lost: lost.length, of: clutter.length } });
      };
      const unchanged = (where: string): void => {
        const diff = changed(world, original);
        if (diff.length) ctx.violate({ invariant: 'foreign-prompt-wrote', message: `${where}: ${diff.length} block(s) changed although nothing was chosen: ${sample(diff)}`, evidence: { sample: diff.slice(0, 8) } });
      };
      const promptOf = (run: WandRun): ShownForm | undefined => run.forms.find(f => /foreign block/.test(plainText(f.title)));
      let promptChecked = false;
      const checkPrompt = (f: ShownForm): void => {
        if (promptChecked) return;
        promptChecked = true;
        const title = plainText(f.title), body = plainText(f.body), buttons = f.buttons.map(plainText);
        const n = Number(/(\d+) foreign block/.exec(title)?.[1] ?? NaN);
        if (n !== clutter.length) ctx.violate({ invariant: 'foreign-count-wrong', message: `the prompt counts ${Number.isNaN(n) ? 'no number' : n} foreign block(s) in "${title}"; the child put ${clutter.length} there` });
        for (const want of ['Find a clear spot', 'Move', 'Cancel']) if (!buttons.some(b => b.startsWith(want))) ctx.violate({ invariant: 'prompt-buttons', message: `the foreign-block prompt has no "${want}" button (${buttons.join(' / ')})` });
        ctx.note(`foreign-block prompt: "${title}" buttons ${buttons.join(' / ')}`);
        if (!/never replaces/i.test(body)) ctx.violate({ invariant: 'prompt-text', message: 'the prompt does not tell the child the wand never replaces blocks' });
      };
      const missing = (run: WandRun, where: string): boolean => {
        if (promptOf(run)) return false;
        const confirm = run.forms.find(f => /^Place .*\?$/.test(plainText(f.title)));
        ctx.violate({ invariant: 'foreign-prompt-missing', message: `${where}: the wand went on to ${confirm ? `"${plainText(confirm.title)}" (${/replaced/.test(plainText(confirm.body)) ? 'blocks in this area will be replaced' : 'confirm'})` : 'nothing'} over ${clutter.length} foreign blocks instead of prompting` });
        return true;
      };

      // 3. Place over them, answer Cancel: nothing may be written, spawned, loaded or held.
      const cancelled = await driveWand(ctx, pack, {
        size, rotation, ahead,
        decide: (form, r) => {
          if (/foreign block/.test(plainText(form.title))) { checkPrompt(form); r.done = true; return { button: 'Cancel' }; }
          return undefined;
        },
      });
      if (missing(cancelled, 'Place')) {
        // The dev wand placed over the child's blocks. Say what it replaced and take the placement back.
        intact('Place over foreign blocks');
        noForeignChanged(ctx, world, regions, 'Place over foreign blocks');
        if (cancelled.line) await wand['undo']!({ kind: 'undo' }, ctx);
        return;
      }
      unchanged('after Cancel');
      if (structureLoads(ctx) !== loadsBefore) ctx.violate({ invariant: 'foreign-prompt-wrote', message: `Cancel: ${structureLoads(ctx) - loadsBefore} structure load(s) ran` });
      if (engine.entities.size !== entitiesBefore) ctx.violate({ invariant: 'foreign-prompt-wrote', message: `Cancel: the world has ${engine.entities.size - entitiesBefore} more entit(ies)` });
      noLeftoverAreas(ctx, baseline, 'after the foreign-block prompt (Cancel)');

      // 4. Move: back to the menu, nothing written.
      const moved = await driveWand(ctx, pack, {
        size, rotation, ahead,
        decide: (form, r) => {
          if (/foreign block/.test(plainText(form.title))) return { button: 'Move' };
          if (/· Brick Wand$/.test(plainText(form.title)) && promptOf(r)) { r.done = true; return { cancel: true }; }
          return undefined;
        },
      });
      if (!moved.forms.some((f, i) => /· Brick Wand$/.test(plainText(f.title)) && moved.forms.slice(0, i).some(g => /foreign block/.test(plainText(g.title))))) ctx.violate({ invariant: 'move-no-menu', message: 'Move did not bring back the wand menu' });
      unchanged('after Move');
      noLeftoverAreas(ctx, baseline, 'after Move');

      // 5. Find a clear spot: the pack moves the pin to a footprint that is air, and places there.
      let relocated: Region | undefined;
      const found = await driveWand(ctx, pack, {
        size, rotation, ahead,
        decide: (form, r) => {
          if (/foreign block/.test(plainText(form.title))) return { button: 'Find a clear spot' };
          if (/^Place .*\?$/.test(plainText(form.title)) && promptOf(r)) {
            const s = confirmSummary(form);
            if (s.origin && s.dims) {
              relocated = capture(world, 'clear spot', s.origin, { w: s.dims.w, h: s.dims.h, l: s.dims.l });
              const busy = occupiedCells(world, capture(world, 'clear spot', s.origin, { w: s.dims.w, h: s.dims.h, l: s.dims.l }, 0));
              if (busy.length) ctx.violate({ invariant: 'clear-spot-not-clear', message: `"Find a clear spot" offered a footprint with ${busy.length} block(s) in it: ${busy.slice(0, 3).map(c => `${c.at.x},${c.at.y},${c.at.z} ${c.type}`).join('; ')}` });
            }
          }
          return undefined;
        },
      });
      if (!found.line || /stopped/.test(found.line) || !relocated) {
        ctx.violate({ invariant: 'clear-spot-failed', message: `Find a clear spot did not end in a placement (${found.line ?? 'no "Placed" line'}; forms: ${found.forms.map(f => plainText(f.title)).join(' | ').slice(0, 200)})` });
      } else {
        regions.push(relocated);
        const moved2 = found.summary.origin!;
        ctx.note(`Find a clear spot: ${origin.x},${origin.y},${origin.z} -> ${moved2.x},${moved2.y},${moved2.z}`);
        if (moved2.x === origin.x && moved2.y === origin.y && moved2.z === origin.z) ctx.violate({ invariant: 'clear-spot-same', message: 'Find a clear spot placed at the same corner' });
        if (moved2.y !== origin.y) ctx.violate({ invariant: 'clear-spot-height', message: `Find a clear spot changed the height (${origin.y} -> ${moved2.y})` });
        intact('after Find a clear spot');
        noForeignChanged(ctx, world, regions, 'after Find a clear spot');
        if (!placedActors(ctx).length && pack.placement.actors.length) ctx.violate({ invariant: 'placed-nothing', message: 'the relocated placement spawned none of the pack\'s entities' });
        noLeftoverAreas(ctx, baseline, 'after Find a clear spot');
        ctx.state[SNAPSHOT_KEY] = { origin: relocated.origin, dims: relocated.dims, ids: relocated.ids };
        // 6. Undo: the relocated footprint and the child's blocks as they were.
        await wand['undo']!({ kind: 'undo' }, ctx);
      }
      for (const r of regions) {
        const diff = changed(world, r);
        if (diff.length) ctx.violate({ invariant: 'undo-inexact', message: `${r.name}: ${diff.length} block(s) differ after Undo: ${sample(diff)}`, evidence: { sample: diff.slice(0, 8) } });
      }
      intact('after Undo');
      noLeftoverAreas(ctx, baseline, 'after Undo');
    },

    // ── two players ──
    async mpTwoPlayers(_step: AnyStep, ctx: StepContext) {
      const engine = ctx.sim.engine, baseline = areaNames(ctx);
      const size = 100, rotation = 0, ahead = aheadFor(pack, size, rotation);
      const gap = Math.max(pack.placement.width, pack.placement.length) + 24;
      const a = ctx.player;
      const b = ctx.sim.addPlayer('Second', { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 + gap }, []);
      const ctxB: StepContext = { ...ctx, player: b, state: {} };
      const world = worldOf(ctx);
      const flow = async (c: StepContext, who: string): Promise<{ run: WandRun; region: Region } | undefined> => {
        let region: Region | undefined;
        const run = await driveWand(c, pack, {
          size, rotation, ahead,
          decide: (form, r) => {
            if (/foreign block/.test(plainText(form.title))) { r.done = true; return { cancel: true }; }
            if (/^Place .*\?$/.test(plainText(form.title))) { const s = confirmSummary(form); if (s.origin && s.dims) region = capture(world, `${who}'s footprint`, s.origin, { w: s.dims.w, h: s.dims.h, l: s.dims.l }); }
            return undefined;
          },
        });
        if (!run.line || /stopped/.test(run.line) || !region) { ctx.violate({ invariant: 'placement-completes', message: `${who}: ${run.line ?? 'no "Placed" line'} (forms: ${run.forms.map(f => plainText(f.title)).join(' | ').slice(0, 160)})` }); return undefined; }
        return { run, region };
      };
      const aPlaced = await flow(ctx, 'player A');
      const bPlaced = await flow(ctxB, 'player B');
      if (!aPlaced || !bPlaced) return;
      const mine = (p: SimEntity): number => placedActors(ctx).filter(e => (e.dynamic.get('owner') ?? '') === p.id).length;
      void mine;
      const aAfter = capture(world, 'A after placing', aPlaced.region.origin, aPlaced.region.dims, 0);
      const actorsBoth = placedActors(ctx).length;
      if (!actorsBoth && pack.placement.actors.length) ctx.violate({ invariant: 'placed-nothing', message: 'neither placement spawned the pack\'s entities' });
      // B undoes: only B's placement goes.
      const bFrom = engine.timeline.entries.length;
      const bLine = await undoOnce(ctxB);
      if (!bLine || !/Undo complete/.test(bLine)) ctx.violate({ invariant: 'undo-failed', message: `B's Undo said: ${bLine ?? 'nothing'}` });
      const bDiff = changed(world, bPlaced.region);
      if (bDiff.length) ctx.violate({ invariant: 'undo-inexact', message: `B's region: ${bDiff.length} block(s) differ after B's Undo: ${sample(bDiff)}` });
      const aDiff = changed(world, aAfter);
      if (aDiff.length) ctx.violate({ invariant: 'cross-talk', message: `B's Undo changed ${aDiff.length} block(s) of A's placement: ${sample(aDiff)}`, evidence: { sample: aDiff.slice(0, 8) } });
      const actorsAfterB = placedActors(ctx).length;
      if (actorsBoth && actorsAfterB === 0) ctx.violate({ invariant: 'cross-talk', message: `B's Undo removed A's entities too (${actorsBoth} placed, 0 left)` });
      if (actorsBoth && actorsAfterB === actorsBoth) ctx.violate({ invariant: 'undo-inexact', message: `B's Undo removed none of B's entities (${actorsBoth} still standing)` });
      const toA = lines(ctx, 'actionbar', a, bFrom).concat(lines(ctx, 'chat', a, bFrom)).filter(l => /Undo|Placed|Undone/.test(l));
      if (toA.length) ctx.violate({ invariant: 'cross-talk', message: `player A was told about B's Undo: ${toA.slice(0, 2).join(' | ')}` });
      // A undoes: everything is as it was.
      const aLine = await undoOnce(ctx);
      if (!aLine || !/Undo complete/.test(aLine)) ctx.violate({ invariant: 'undo-failed', message: `A's Undo said: ${aLine ?? 'nothing'}` });
      for (const r of [aPlaced.region, bPlaced.region]) {
        const diff = changed(world, r);
        if (diff.length) ctx.violate({ invariant: 'undo-inexact', message: `${r.name}: ${diff.length} block(s) differ after both Undos: ${sample(diff)}` });
      }
      if (placedActors(ctx).length) ctx.violate({ invariant: 'nothing-left-after-undo', message: `${placedActors(ctx).length} placed entit(ies) left after both players undid` });
      noLeftoverAreas(ctx, baseline, 'after both Undos');
    },

    // ── collider parity against the dev encoding ──
    async mpColliderParity(_step: AnyStep, ctx: StepContext) {
      if (!handlerOptions.reference) { ctx.note('mpColliderParity: NOT TESTED, no reference pack was given (--reference=<dir of dev-encoding twins>)'); return; }
      const refAddon = await readAddon(handlerOptions.reference, 'reference');
      const steps: Array<[number, number]> = [[100, 0]];
      if (pack.placement.resizable && pack.placement.sizes.includes(200)) steps.push([200, 90]);
      // The twin lives in its own simulation, placed by the same child at the same spot; each step is undone in
      // both worlds so the next starts on clear ground (a second placement over the first would be a prompt).
      const refSim = new Simulation();
      refSim.loadAddon(refAddon);
      const refPlayer = refSim.addPlayer('Child', { x: 0.5, y: FLAT_GROUND_Y, z: 0.5 }, []);
      const refCtx: StepContext = { ...ctx, sim: refSim, player: refPlayer, state: {}, run: n => refSim.run(n) };
      const refPack = readCraftmaticPack(refAddon)!;
      const refWorld = worldOf(refCtx);
      for (const [size, rotation] of steps) {
        const place = async (c: StepContext, p: CraftmaticPack, label: string): Promise<{ origin: Vec3; dims: Region['dims'] } | undefined> => {
          const run = await driveWand(c, p, { size, rotation, ahead: aheadFor(p, size, rotation) });
          if (!run.line || /stopped/.test(run.line)) { ctx.violate({ invariant: 'placement-completes', message: `parity ${size} % (${label}): ${run.line ?? 'no "Placed" line'}` }); return undefined; }
          return needSummary(run, `parity ${size} % (${label})`);
        };
        const mine = await place(ctx, pack, 'store pack');
        const theirs = await place(refCtx, refPack, 'dev encoding');
        const myWorld = worldOf(ctx);
        try {
          if (!mine || !theirs) continue;
          if (mine.origin.x !== theirs.origin.x || mine.origin.y !== theirs.origin.y || mine.origin.z !== theirs.origin.z || mine.dims.w !== theirs.dims.w || mine.dims.h !== theirs.dims.h || mine.dims.l !== theirs.dims.l) {
            ctx.violate({ invariant: 'collider-encoding-differs', message: `parity ${size} %: the store pack places a ${mine.dims.w}x${mine.dims.h}x${mine.dims.l} footprint at ${mine.origin.x},${mine.origin.y},${mine.origin.z}; the dev encoding ${theirs.dims.w}x${theirs.dims.h}x${theirs.dims.l} at ${theirs.origin.x},${theirs.origin.y},${theirs.origin.z}` });
            continue;
          }
          const key = (w: VoxelWorld, x: number, y: number, z: number): string =>
            w.shapeAt(x, y, z).collision.map(b => [b.x0, b.y0, b.z0, b.x1, b.y1, b.z1].map(v => v.toFixed(4)).join(',')).sort().join('|');
          let differ = 0, solid = 0;
          const rows: string[] = [];
          for (let x = 0; x < mine.dims.w; x++) for (let y = 0; y < mine.dims.h; y++) for (let z = 0; z < mine.dims.l; z++) {
            const at = { x: mine.origin.x + x, y: mine.origin.y + y, z: mine.origin.z + z };
            const a = key(myWorld, at.x, at.y, at.z), b = key(refWorld, at.x, at.y, at.z);
            if (a) solid++;
            if (a !== b) { differ++; if (rows.length < 4) rows.push(`${at.x},${at.y},${at.z} store ${typeName(myWorld, myWorld.rawId(at.x, at.y, at.z))} [${a || 'no box'}] dev ${typeName(refWorld, refWorld.rawId(at.x, at.y, at.z))} [${b || 'no box'}]`); }
          }
          ctx.note(`collider parity ${size} % turn ${rotation}: ${solid} solid cells, ${differ} differ`);
          if (differ) ctx.violate({ invariant: 'collider-encoding-differs', message: `parity ${size} %: ${differ} of ${mine.dims.w * mine.dims.h * mine.dims.l} cells collide differently from the dev encoding: ${rows.join('; ')}`, evidence: { differ, solid } });
        } finally {
          if (mine) await undoOnce(ctx);
          if (theirs) await undoOnce(refCtx);
        }
      }
    },

    // ── closing ──
    async mpQuiet(_step: AnyStep, ctx: StepContext) {
      await ctx.run(20);
      const left = areaNames(ctx);
      if (left.length) ctx.violate({ invariant: 'ticking-area-left', message: `at the end of the scenario ${left.length} ticking area(s) still exist: ${left.slice(0, 4).join(', ')}`, evidence: { areas: left } });
      void teleport;
    },
  };
}

// ─── Running one pack ───

/** What a marketplace run needs. */
export interface MarketplaceRunOptions extends Omit<MarketplaceScenarioOptions, 'reference'> {
  /** Where the pack came from (the report's name). */
  source: string;
  /** The same model built WITHOUT `brickBlocks` / `compactColliderStates`: the collider parity scenario's reference. */
  reference?: Uint8Array;
  /** Only scenarios whose name contains this. */
  only?: string;
}

/** Run every marketplace scenario over one pack's bytes, each on a fresh world. */
export async function runMarketplace(bytes: Uint8Array, options: MarketplaceRunOptions): Promise<{ pack?: CraftmaticPack; results: ScenarioResult[] }> {
  const probe = readCraftmaticPack(await readAddon(bytes, options.source));
  if (!probe) throw new Error(`${options.source}: not a craftmatic pack (no scripts/placement.js)`);
  const results: ScenarioResult[] = [];
  const scenarioOptions: MarketplaceScenarioOptions = { ...(options.childPlay !== undefined ? { childPlay: options.childPlay } : {}), ...(options.quick !== undefined ? { quick: options.quick } : {}), ...(options.reference ? { reference: true } : {}) };
  for (const s of marketplaceScenarios(probe, scenarioOptions).filter(x => !options.only || x.name.includes(options.only))) {
    const addon = await readAddon(bytes, options.source);
    const pack = readCraftmaticPack(addon)!;
    const handlers = { ...craftmaticHandlers(pack, addon), ...marketplaceHandlers(pack, options.reference ? { reference: options.reference } : {}) };
    results.push(await runScenario(s, [addon], { handlers, ...marketplaceRunOptions() }));
  }
  return { pack: probe, results };
}
