/**
 * Invariants: what must hold on every tick of every scenario, whatever the
 * child does. Each is small and independent; a scenario lists the ones it
 * runs (default: every core one), adapters add their own.
 *
 * Core:
 *   player-not-in-solid     the player's box never overlaps a block's collision;
 *   no-unprotected-fall     the player never lands from more than 3 blocks
 *                           without slow falling;
 *   nothing-below-ground    no entity ends up under the terrain surface (fell
 *                           through the world);
 *   rider-drag-reaches-look a riding player's drag turns its look (measured on
 *                           every drag, `input/drag.ts`); without a drag, a
 *                           scheme whose drag turns only the camera fails
 *                           (`DRAG_TO_CAMERA_SCHEMES`; Saga 30k, the Nimbus);
 *   no-script-error         no script exception, no module that failed to load;
 *   no-content-log-error    no definition the game refuses;
 *   no-unexpected-line      no chat / action-bar / console line matching a
 *                           fault pattern (`could not`, `stopped`, a
 *                           `*_NO_*` diagnostic...) unless the scenario allows it;
 *   actionbar-not-stolen    an action-bar line one script shows is not
 *                           replaced by ANOTHER script within a second.
 */

import type { SimEngine } from '../core/engine.js';
import type { TimelineEntry } from '../core/timeline.js';
import type { SimEntity } from '../entity/entity.js';
import { FLAT_GROUND_Y } from '../world/voxel-world.js';
import { plainText } from '../script-host/text.js';
import { DRAG_TO_CAMERA_SCHEMES } from '../input/scheme.js';
import { dragReach, dragRecords } from '../input/drag.js';

export interface Violation {
  invariant: string;
  tick: number;
  /** The step running when it was seen. */
  step?: string;
  message: string;
  /** Numbers and positions that prove it. */
  evidence?: Record<string, unknown>;
}

/** What an invariant can see. */
export interface InvariantContext {
  engine: SimEngine;
  player: SimEntity;
  /** Lines the scenario allows. */
  allowLines: RegExp[];
  /** Action-bar lines another script may replace at once (a status whose news is told elsewhere too; `Scenario.yieldingLines`). */
  yieldingLines?: RegExp[];
  /** The control scheme a script set on a player (`/controlscheme`), when the host keeps one. */
  controlScheme?(player: SimEntity): string | undefined;
  report(v: Omit<Violation, 'tick' | 'step'>): void;
}

/** Wrap a context so an invariant's reports are dropped while it is quiet. */
export function quietable(ctx: InvariantContext, quiet: () => ReadonlySet<string>): InvariantContext {
  return { ...ctx, report: v => { if (!quiet().has(v.invariant)) ctx.report(v); } };
}

export interface Invariant {
  id: string;
  description: string;
  /** Called once before the first tick (subscribe to engine events here). */
  setup?(ctx: InvariantContext): void;
  /** Called after every tick. */
  tick?(ctx: InvariantContext): void;
}

/** A fall longer than this without slow falling is a violation (blocks). */
export const MAX_UNPROTECTED_FALL = 3;
/** How long an action-bar line must stand before another script may replace it (ticks). */
export const ACTIONBAR_HOLD_TICKS = 20;
/** Lines that are faults when nobody expected them. */
export const FAULT_LINE_PATTERNS: readonly RegExp[] = [
  /could not/i, /stopped/i, /unavailable/i, /\b[A-Z]+(?:_[A-Z]+)*_(?:NO|FAILED|TIMEOUT|FALLBACK|MISSING|ERROR)(?:_[A-Z]+)*\b/, /\bError\b/, /\bfailed\b/i,
];

const round = (v: number): number => Math.round(v * 100) / 100;

/** Ticks a player may stay inside a solid before it counts (a teleport's set-down is resolved on the next physics pass). */
export const IN_SOLID_GRACE_TICKS = 2;

function playerNotInSolid(): Invariant {
  let inside = 0;
  return {
    id: 'player-not-in-solid', description: `The player never stays inside a block's collision (${IN_SOLID_GRACE_TICKS} ticks' grace for a teleport's set-down).`,
    tick(ctx) {
      const p = ctx.player;
      if (!p.valid || p.ridingOn) { inside = 0; return; }
      const w = ctx.engine.dimension(p.dimension);
      const { width, height } = p.collisionSize(), h = width / 2;
      const hit = w.overlapping({ x0: p.location.x - h, y0: p.location.y, z0: p.location.z - h, x1: p.location.x + h, y1: p.location.y + height, z1: p.location.z + h }, 0.02);
      inside = hit ? inside + 1 : 0;
      if (hit && inside === IN_SOLID_GRACE_TICKS) ctx.report({ invariant: 'player-not-in-solid', message: `player inside ${hit.block?.typeId ?? 'a block'} at ${hit.block ? `${hit.block.x},${hit.block.y},${hit.block.z}` : '?'}`, evidence: { feet: { x: round(p.location.x), y: round(p.location.y), z: round(p.location.z) }, solid: { x0: round(hit.x0), y0: round(hit.y0), z0: round(hit.z0), x1: round(hit.x1), y1: round(hit.y1), z1: round(hit.z1) } } });
    },
  };
}

function noUnprotectedFall(): Invariant {
  return {
    id: 'no-unprotected-fall', description: `The player never lands from more than ${MAX_UNPROTECTED_FALL} blocks without slow falling.`,
    setup(ctx) {
      ctx.engine.on('landed', ev => {
        if (ev.entity !== ctx.player || ev.slowFell || ev.fallDistance <= MAX_UNPROTECTED_FALL) return;
        ctx.report({ invariant: 'no-unprotected-fall', message: `player fell ${round(ev.fallDistance)} blocks without slow falling`, evidence: { landed: { x: round(ev.at.x), y: round(ev.at.y), z: round(ev.at.z) }, fall: round(ev.fallDistance) } });
      });
    },
  };
}

function nothingBelowGround(groundY = FLAT_GROUND_Y): Invariant {
  const seen = new Set<string>();
  return {
    id: 'nothing-below-ground', description: 'No entity ends up under the terrain surface (it fell through the world).',
    tick(ctx) {
      for (const e of ctx.engine.entities.values()) {
        if (!e.valid || seen.has(e.id) || e.location.y >= groundY - 1.5) continue;
        seen.add(e.id);
        ctx.report({ invariant: 'nothing-below-ground', message: `${e.isPlayer ? 'player' : e.typeId} is ${round(groundY - e.location.y)} blocks under the ground (y ${round(e.location.y)})`, evidence: { entity: e.typeId, at: { x: round(e.location.x), y: round(e.location.y), z: round(e.location.z) } } });
      }
    },
  };
}

/** Watches timeline entries of some kinds as they arrive. */
function timelineWatch(id: string, description: string, pick: (e: TimelineEntry, ctx: InvariantContext) => string | undefined): Invariant {
  let seen = 0;
  return {
    id, description,
    tick(ctx) {
      const entries = ctx.engine.timeline.entries;
      for (; seen < entries.length; seen++) {
        const e = entries[seen]!;
        const msg = pick(e, ctx);
        if (msg) ctx.report({ invariant: id, message: msg, evidence: { tick: e.tick, kind: e.kind, ...(e.source ? { source: e.source } : {}), text: e.text.slice(0, 300) } });
      }
    },
  };
}

function actionbarNotStolen(): Invariant {
  const last = new Map<string, TimelineEntry>();
  let seen = 0, riding: unknown, changedAt = -Infinity;
  return {
    id: 'actionbar-not-stolen', description: `An action-bar line one script shows stands ${ACTIONBAR_HOLD_TICKS} ticks before another script replaces it (unless the player got off something, or changed mount, in between).`,
    tick(ctx) {
      // A new line after the player got OFF something answers that ("Floating down"); it steals nothing, and nor does
      // the line of a mount the player HOPPED onto straight from another (bedrock-ride-hop.ts: a slide's "Wheee!" gives
      // way to the car the child slid into). Getting ON from foot is not exempt: a ride's HUD writing over the hint
      // that told the child how to ride is the fault (the Nimbus, 29c).
      if (ctx.player.ridingOn !== riding) { if (riding) changedAt = ctx.engine.tick; riding = ctx.player.ridingOn; }
      const entries = ctx.engine.timeline.entries;
      for (; seen < entries.length; seen++) {
        const e = entries[seen]!;
        if (e.kind !== 'actionbar' || !e.target) continue;
        const prev = last.get(e.target);
        last.set(e.target, e);
        if (!prev || !prev.source || !e.source || prev.source === e.source || !plainText(prev.text).trim()) continue;
        // The change is seen after the tick it happened in: a line shown in that same tick was the old mount's.
        if (changedAt >= prev.tick && changedAt <= e.tick) continue;
        if (ctx.yieldingLines?.some(r => r.test(plainText(prev.text)))) continue;
        if (e.tick - prev.tick < ACTIONBAR_HOLD_TICKS && plainText(e.text) !== plainText(prev.text)) {
          ctx.report({ invariant: 'actionbar-not-stolen', message: `${e.source} replaced ${prev.source}'s "${plainText(prev.text).slice(0, 80)}" after ${e.tick - prev.tick} ticks with "${plainText(e.text).slice(0, 80)}"`, evidence: { shown: prev.tick, replaced: e.tick, by: e.source, from: prev.source } });
        }
      }
    },
  };
}

// The drag-to-camera schemes live with the drag router (`input/scheme.ts`); re-exported for older readers.
export { DRAG_TO_CAMERA_SCHEMES };

/** A drag under this share of what it asked for did not reach the look (`dragReach`). */
export const DRAG_REACH_MIN = 0.5;

/**
 * `rider-drag-reaches-look`, a MEASUREMENT since 2026-10-08: every drag a riding player makes (`input/drag.ts`
 * records each one) must turn its look by at least `DRAG_REACH_MIN` of what the finger asked, read at the END of
 * the tick (after every script ran). On a seat whose `lock_rider_rotation` is 0 only the pitch is asked of it (the
 * yaw is held to the seat on the device, pinball). A riding player who never drags in the scenario is still held
 * to the rule (quirk `control-scheme-drag-to-camera`): a scheme that sends every drag to the camera fails once
 * per mount, so a scenario without a drag still catches the Nimbus's 30k fault.
 */
function riderDragReachesLook(): Invariant {
  let ruled: unknown, seen = 0;
  return {
    id: 'rider-drag-reaches-look', description: 'A riding player\'s drag turns its look (free look, a native mount\'s steering and its "look down + Jump"): measured on every drag, and a scheme whose drag turns only the camera fails even without one.',
    tick(ctx) {
      const p = ctx.player, mount = p.ridingOn;
      const recs = dragRecords(ctx.engine);
      let draggedNow = false;
      for (; seen < recs.length; seen++) {
        const r = recs[seen]!;
        if (r.playerId !== p.id || !r.mount) continue;
        draggedNow = true;
        // Measured against the look at the end of the tick: a script that put the look back counts as a drag lost.
        const end = { ...r, after: { yaw: p.rotation.y, pitch: p.rotation.x } };
        const pitchOnly = r.route === 'pitch-only';
        const asked = pitchOnly ? Math.abs(r.asked.pitchDeg) : Math.hypot(r.asked.yawDeg, r.asked.pitchDeg);
        if (asked < 1) continue;
        const reach = pitchOnly ? Math.min(1, Math.abs(end.after.pitch - end.before.pitch) / asked) : dragReach(end);
        if (reach < DRAG_REACH_MIN) ctx.report({ invariant: 'rider-drag-reaches-look', message: `a drag of ${Math.round(asked * 10) / 10} degrees on ${r.mount} turned the rider's look ${Math.round(reach * asked * 10) / 10} (route ${r.route}${r.scheme ? `, scheme \`${r.scheme}\`` : ''}): it neither looks round nor steers (Saga 30k, the Nimbus)`, evidence: { mount: r.mount, route: r.route, scheme: r.scheme ?? 'default', asked: r.asked, before: r.before, after: end.after } });
      }
      if (!mount) { ruled = undefined; return; }
      if (draggedNow || ruled === mount) return;
      const scheme = ctx.controlScheme?.(p);
      if (!scheme || !DRAG_TO_CAMERA_SCHEMES.has(scheme)) return;
      ruled = mount;
      ctx.report({ invariant: 'rider-drag-reaches-look', message: `the rider of ${mount.typeId} is held in \`${scheme}\`: a drag turns only the camera, so it neither looks round nor steers (Saga 30k, the Nimbus; rule check, no drag made)`, evidence: { mount: mount.typeId, scheme } });
    },
  };
}

/** The core invariants by id. */
export function coreInvariants(): Invariant[] {
  return [
    playerNotInSolid(),
    noUnprotectedFall(),
    nothingBelowGround(),
    riderDragReachesLook(),
    timelineWatch('no-script-error', 'No script exception, no module that failed to load.', e => (e.kind === 'script-error' ? `${e.source ?? 'script'}: ${e.text}` : undefined)),
    timelineWatch('no-content-log-error', 'No definition the game refuses.', e => (e.kind === 'content-log' ? e.text : undefined)),
    timelineWatch('no-unexpected-line', 'No chat, action-bar or console line that reads as a fault, unless the scenario allows it.', (e, ctx) => {
      if (e.kind !== 'chat' && e.kind !== 'actionbar' && e.kind !== 'console' && e.kind !== 'title') return undefined;
      const t = plainText(e.text);
      if (!FAULT_LINE_PATTERNS.some(r => r.test(t)) || ctx.allowLines.some(r => r.test(t))) return undefined;
      return `${e.kind} from ${e.source ?? '?'}: "${t.slice(0, 160)}"`;
    }),
    actionbarNotStolen(),
  ];
}
