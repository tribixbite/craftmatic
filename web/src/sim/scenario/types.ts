/**
 * The scenario language: what a child does, as data. A scenario is a list of
 * steps run in order on one simulated world; invariants are checked every
 * tick while it runs. Core steps move and look and touch; adapters register
 * their own (the craftmatic wand's `place` and `undo`).
 */

import type { Vec3 } from '../core/vec.js';
import type { SimEntity } from '../entity/entity.js';
import type { Simulation } from '../core/simulation.js';
import type { Violation } from './invariants.js';

/** Which entity a step means: by type (exact or pattern), family, nearest to the player or a point, or the n-th match. */
export interface EntitySelector {
  type?: string | RegExp;
  family?: string;
  /** Pick the one nearest this point (default: nearest the player). */
  near?: Vec3;
  /** The n-th match by id order (after `near` sorting when given). */
  index?: number;
  /** Any further test. */
  where?: (e: SimEntity) => boolean;
  /** How the report names it. */
  label?: string;
}

/** Hold the move stick for a while: -1..1 forward and strafe, optionally turning (degrees per tick). */
export interface StickHold { forward: number; strafe?: number; jump?: boolean; turnPerTick?: number; ticks: number }

/** Core steps. `kind` names the handler; an adapter's steps add kinds of their own. */
export type CoreStep =
  | { kind: 'wait'; ticks: number; label?: string }
  | { kind: 'teleport'; to: Vec3; yaw?: number; pitch?: number; label?: string }
  | { kind: 'look'; at: Vec3 | EntitySelector; label?: string }
  | { kind: 'walkLine'; from: Vec3; to: Vec3; maxTicks?: number; jumpWhenBlocked?: boolean; label?: string; /** The drop (blocks) the line may take; more is a violation. */ maxDrop?: number; /** The line must end within this distance of `to`. */ arriveWithin?: number }
  | { kind: 'tap'; target: EntitySelector; expectHit?: boolean; label?: string }
  | { kind: 'hold'; target: EntitySelector; ticks?: number; label?: string }
  | { kind: 'rideUntil'; maxTicks: number; until?: 'dismounted' | 'timeout'; label?: string }
  | { kind: 'drive'; hold: StickHold; label?: string }
  | { kind: 'sneak'; label?: string }
  | { kind: 'jumpHold'; ticks: number; label?: string }
  | { kind: 'useItem'; item: string; label?: string }
  | { kind: 'expect'; label: string; check: (ctx: StepContext) => string | undefined | Promise<string | undefined> };

/** A step of any registered kind, as a handler receives it. */
export interface AnyStep { kind: string; label?: string; [k: string]: unknown }

/** A step of any registered kind. */
export type Step = CoreStep | AnyStep;

/** What a step handler gets. */
export interface StepContext {
  sim: Simulation;
  player: SimEntity;
  /** The scenario-wide scratch space adapters share between their steps (the placement's anchor, say). */
  state: Record<string, unknown>;
  /** Record a violation found by the step itself. */
  violate(v: Omit<Violation, 'tick' | 'step'>): void;
  /** Note something for the report (not a failure). */
  note(text: string): void;
  /** Advance ticks with the invariants running. */
  run(ticks: number): Promise<void>;
  /** Resolve a selector to an entity (undefined when nothing matches). */
  find(sel: EntitySelector): SimEntity | undefined;
  /**
   * Silence invariants while a step does something they would flag on purpose
   * (a device line that starts in the air falls by design; the step reports
   * the fall itself). `quiet([])` restores them.
   */
  quiet(invariants: string[]): void;
}

/** A step handler. */
export type StepHandler = (step: AnyStep, ctx: StepContext) => Promise<void>;

/** A scenario. */
export interface Scenario {
  name: string;
  /** What it checks, one line for the report. */
  description?: string;
  /** Evidence this scenario reproduces (a device round's path), for regressions. */
  evidence?: string;
  steps: Step[];
  /** Invariant ids to run (default: all core ones). */
  invariants?: string[];
  /** Lines (chat, action bar, console) the scenario expects and the unexpected-line invariant must not flag. */
  allowLines?: RegExp[];
  /** Where the player starts. */
  start?: Vec3;
  /** Hotbar items (the wand). */
  items?: string[];
}
