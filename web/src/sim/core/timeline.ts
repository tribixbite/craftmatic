/**
 * Everything the simulated game SAYS and every fault it meets, in tick order:
 * chat, action-bar and title lines, form text, console lines, content-log
 * load errors, script exceptions and unmodelled API calls. A scenario's
 * invariants and its report read the timeline; nothing is printed as it
 * happens.
 *
 * Every entry names its SOURCE where one can be told: the pack script whose
 * code made the call (from the call stack), so a line one runtime shows and
 * another overwrites four ticks later is visible as exactly that.
 */

export type TimelineKind =
  | 'chat' | 'actionbar' | 'title' | 'form' | 'console' | 'content-log' | 'script-error'
  | 'unmodelled' | 'command' | 'event' | 'note';

export interface TimelineEntry {
  tick: number;
  kind: TimelineKind;
  text: string;
  /** The pack script that made the call (`scripts/flyer.js`), when the stack names one. */
  source?: string;
  /** The player or entity it concerns. */
  target?: string;
}

/** An API member the game has and the simulator does not model, with how often scripts reached it. */
export interface UnmodelledUse { member: string; count: number; sources: string[]; firstTick: number }

/** The engine's record. One per engine; scenarios read it. */
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  private readonly unmodelledUses = new Map<string, UnmodelledUse>();
  /** Script sources by stack-frame file name, set by the module loader. */
  private readonly sourceMarker: RegExp = /pack:\/\/[^\s)]*?(scripts\/[^\s):]+\.js)/;
  /** The current tick, set by the engine. */
  tick = 0;

  add(kind: TimelineKind, text: string, extra: { source?: string; target?: string } = {}): TimelineEntry {
    const e: TimelineEntry = { tick: this.tick, kind, text, ...extra };
    this.entries.push(e);
    return e;
  }

  /** The pack script at the top of the current call stack (the caller of the API), if any. */
  callerSource(stack = new Error().stack ?? ''): string | undefined {
    return this.sourceMarker.exec(stack)?.[1];
  }

  /** Record a use of an unmodelled API member. */
  unmodelled(member: string, source?: string): void {
    let u = this.unmodelledUses.get(member);
    if (!u) this.unmodelledUses.set(member, u = { member, count: 0, sources: [], firstTick: this.tick });
    u.count++;
    if (source && !u.sources.includes(source)) u.sources.push(source);
    if (u.count === 1) this.add('unmodelled', member, source ? { source } : {});
  }

  /** Unmodelled members, most used first. */
  unmodelledRanking(): UnmodelledUse[] { return [...this.unmodelledUses.values()].sort((a, b) => b.count - a.count || a.member.localeCompare(b.member)); }

  /** Entries of a kind, optionally for one target. */
  of(kind: TimelineKind, target?: string): TimelineEntry[] { return this.entries.filter(e => e.kind === kind && (target === undefined || e.target === target)); }
}
