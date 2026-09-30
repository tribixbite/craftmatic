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
  report(v: Omit<Violation, 'tick' | 'step'>): void;
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
  let seen = 0;
  return {
    id: 'actionbar-not-stolen', description: `An action-bar line one script shows stands ${ACTIONBAR_HOLD_TICKS} ticks before another script replaces it.`,
    tick(ctx) {
      const entries = ctx.engine.timeline.entries;
      for (; seen < entries.length; seen++) {
        const e = entries[seen]!;
        if (e.kind !== 'actionbar' || !e.target) continue;
        const prev = last.get(e.target);
        last.set(e.target, e);
        if (!prev || !prev.source || !e.source || prev.source === e.source || !plainText(prev.text).trim()) continue;
        if (e.tick - prev.tick < ACTIONBAR_HOLD_TICKS && plainText(e.text) !== plainText(prev.text)) {
          ctx.report({ invariant: 'actionbar-not-stolen', message: `${e.source} replaced ${prev.source}'s "${plainText(prev.text).slice(0, 80)}" after ${e.tick - prev.tick} ticks with "${plainText(e.text).slice(0, 80)}"`, evidence: { shown: prev.tick, replaced: e.tick, by: e.source, from: prev.source } });
        }
      }
    },
  };
}

/** The core invariants by id. */
export function coreInvariants(): Invariant[] {
  return [
    playerNotInSolid(),
    noUnprotectedFall(),
    nothingBelowGround(),
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
