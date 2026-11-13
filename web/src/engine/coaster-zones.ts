/**
 * Coaster zones that ACT on the ride (WP-C04, BIZ-14): launches, cable lift and drives, block brakes and trims, and
 * the block sections that keep two trains apart.
 *
 * A generated route (`coaster-design.ts`) carries zones by arc distance (`CoasterZone`). `planCoasterZones` turns
 * them into a JSON plan the runtime config carries (`CoasterRoute.zonePlan`), and the runtime (`bedrock-coaster.ts`,
 * `coasterRuntime`) applies it with the two pure functions below. Both are SERIALISED into the pack with
 * `.toString()` exactly like `rideSubstep`, so each may reference nothing outside its own body (no imports, no
 * module constants); the caller passes `COASTER_ZONES` values as arguments.
 *
 * THE RULES (the design's own energy model, `coaster-design.ts` `advanceSpeed`, so the ride and the design agree):
 *  - `launch`: speed is PINNED to v^2 = v0^2 + (vt^2 - v0^2) s / L, v0 the speed on entry. Constant acceleration,
 *    exactly the target at the zone's end. Applies both ways (a launch entered faster than its target slows to it).
 *  - `hold` (a cable lift or a flat drive): the carriage's speed, approached at `holdAccel` from either side.
 *    The chain lift (`LIFT_SPEED`, 3.5) only ever catches a slower train; a cable lift runs faster.
 *  - `brake` (a block brake or a trim): sheds speed above its target at its deceleration, never speeds a train up.
 *
 * BLOCKS. A block is the stretch between two block boundaries; a train may not ENTER a gated block while another
 * train stands in it (it stops with its front `BLOCK_GAP` short of the entry and goes on when the block is clear).
 * The boundaries are the station's release, and the start and end of each block brake: the brake run is a block of
 * its own, so one train waits at the end of the brake run while another is in the station block, and the station's
 * departure never has to wait for the course (two trains need three blocks; with two they would deadlock).
 *
 * UNITS: arcs in model blocks, speeds in world blocks/s (as `COASTER_PHYSICS`).
 */

/** The zone rule a train can be under, by arc span. */
export interface CoasterZoneRule {
  kind: 'hold' | 'launch' | 'brake';
  from: number; to: number;
  /** hold: the carriage speed; launch: the target speed; brake: the speed it sheds down to. */
  speed: number;
  /** brake only: blocks/s^2. */
  decel?: number;
}

/** One block section: arcs `[from, to)` (a block whose `to` is past the route's length wraps the seam). */
export interface CoasterBlock { from: number; to: number; gated: boolean }

/** What a route carries into its runtime config. */
export interface CoasterZonePlan {
  rules: CoasterZoneRule[];
  /** In increasing `from`; empty when the route has no block brake. */
  blocks: CoasterBlock[];
}

/** Per-train state `coasterZoneSpeed` keeps: the launch the train is in and its entry speed squared. */
export interface CoasterZoneMemo { launch: number; v0sq: number }

export const COASTER_ZONES = {
  /** How far short of a gated block's entry a held train's front stops, blocks. */
  BLOCK_GAP: 0.5,
  /**
   * The fastest a generated route's train may run, world blocks/s, replacing the global `COASTER_PHYSICS.MAX_SPEED`.
   * 52 is the 3x sketch's design limit and the fastest the sim ran (2.6 blocks a tick) without an unloaded-block fault; a phone's
   * teleport and chunk loading at that speed is not measured. # TODO(C04-device): measure on a phone and lower it if they do not hold.
   */
  SPEED_CAP_BPS: 52,
} as const;

/** The design zone fields `planCoasterZones` reads (`CoasterZone` of `coaster-design.ts`, structurally). */
export interface PlannableZone { kind: string; from: number; to: number; params?: Record<string, number | string> }

/** What `planCoasterZones` needs of the ride physics (passed in: this module imports nothing from the runtime). */
export interface ZonePlanPhysics {
  /** `COASTER_PHYSICS.STATION_BRAKE`: a trim's deceleration; a block brake is twice it (`COASTER_DESIGN.BLOCK_BRAKE_DECEL`). */
  stationBrake: number;
}

/**
 * The rules and block sections of a route's zones.
 *
 * @param zones the design's zones (arc distance, blocks)
 * @param total the route's length, blocks
 * @throws when a launch, lift, brake or trim lacks its positive speed parameter
 */
export function planCoasterZones(zones: readonly PlannableZone[], total: number, physics: ZonePlanPhysics): CoasterZonePlan {
  const rules: CoasterZoneRule[] = [];
  const num = (z: PlannableZone, key: string): number => {
    const v = z.params?.[key];
    if (typeof v !== 'number' || !(v > 0)) throw new Error(`coaster zone ${z.kind} at arc ${z.from}: params.${key} must be a positive number.`);
    return v;
  };
  for (const z of zones) {
    if (!(z.to > z.from)) continue;
    switch (z.kind) {
      case 'launch': rules.push({ kind: 'launch', from: z.from, to: z.to, speed: num(z, 'toSpeedBps') }); break;
      case 'lift': rules.push({ kind: 'hold', from: z.from, to: z.to, speed: num(z, 'speedBps') }); break;
      case 'block-brake': rules.push({ kind: 'brake', from: z.from, to: z.to, speed: num(z, 'toSpeedBps'), decel: 2 * physics.stationBrake }); break;
      case 'trim': rules.push({ kind: 'brake', from: z.from, to: z.to, speed: num(z, 'toSpeedBps'), decel: physics.stationBrake }); break;
      default: break; // station, tunnel, dark, cloud, show: not a speed rule (the station is the runtime's own; C05 owns the show)
    }
  }
  rules.sort((a, b) => a.from - b.from);
  const gates = zones.filter(z => z.kind === 'block-brake' && z.to > z.from);
  const station = zones.find(z => z.kind === 'station');
  const blocks: CoasterBlock[] = [];
  if (gates.length) {
    const bounds: Array<{ at: number; gated: boolean }> = [];
    if (station) bounds.push({ at: station.to, gated: false });
    for (const g of gates) bounds.push({ at: g.from, gated: true }, { at: g.to, gated: true });
    bounds.sort((a, b) => a.at - b.at);
    bounds.forEach((b, i) => {
      const next = bounds[(i + 1) % bounds.length]!;
      blocks.push({ from: b.at, to: i + 1 < bounds.length ? next.at : next.at + total, gated: b.gated });
    });
  }
  return { rules, blocks };
}

/**
 * The train's speed after one substep of `dt` seconds with its centre at `arc`, under the zone rules. SERIALISED:
 * self-contained. `memo` is the train's `{ launch, v0sq }` (a planning copy for a prediction: it is written).
 */
export function coasterZoneSpeed(rules: readonly CoasterZoneRule[], arc: number, speed: number, dt: number, memo: CoasterZoneMemo, holdAccel: number): number {
  let active = -1;
  for (let i = 0; i < rules.length; i++) { const r = rules[i]!; if (arc >= r.from && arc < r.to) { active = i; break; } }
  const rule = active >= 0 ? rules[active]! : undefined;
  if (!rule || rule.kind !== 'launch') memo.launch = -1;
  if (!rule) return speed;
  if (rule.kind === 'launch') {
    if (memo.launch !== active) { memo.launch = active; memo.v0sq = speed * speed; }
    const f = Math.max(0, Math.min(1, (arc - rule.from) / (rule.to - rule.from)));
    return Math.sqrt(memo.v0sq + (rule.speed * rule.speed - memo.v0sq) * f);
  }
  if (rule.kind === 'hold') {
    const step = holdAccel * dt;
    return Math.abs(speed - rule.speed) <= step ? rule.speed : speed + Math.sign(rule.speed - speed) * step;
  }
  return speed > rule.speed ? Math.max(rule.speed, speed - (rule.decel ?? 0) * dt) : speed;
}

/**
 * Where a train must stop for an occupied block: the nearest gated block entry ahead of its front that another
 * train stands in, as `toStop` (centre travel to the stop) and `stopAt` (the centre's arc there), or null.
 * SERIALISED: self-contained. `others` are the other trains' CENTRES; every train is `extent` long. A train
 * already inside the block, or past its entry, is never held by it; a train stopped exactly at the gate reads
 * `toStop` 0 (rounding neither releases nor creeps it).
 */
export function coasterBlockStop(blocks: readonly CoasterBlock[], total: number, centre: number, extent: number, others: readonly number[], gap: number): { toStop: number; stopAt: number } | null {
  const EPS = 1e-6;
  const wrap = (v: number): number => ((v % total) + total) % total;
  let best: { toStop: number; stopAt: number } | null = null;
  for (const block of blocks) {
    if (!block.gated) continue;
    // Is another train's span [c - extent/2, c + extent/2] over the block (at either lap of its wrapped span)?
    const taken = others.some(c => {
      const lo = wrap(c - extent / 2), hi = lo + extent;
      for (const shift of [-total, 0, total]) if (lo + shift < block.to && hi + shift > block.from) return true;
      return false;
    });
    if (!taken) continue;
    const stopAt = wrap(block.from - gap - extent / 2);
    // Centre travel to the stop, in [-EPS, total - EPS): a rounding hair behind the stop is the stop itself.
    const toStop = wrap(stopAt - centre + EPS) - EPS;
    // Behind a gate by more than half a lap the train is past it (inside the block or beyond).
    if (toStop > total / 2) continue;
    if (!best || toStop < best.toStop) best = { toStop: Math.max(0, toStop), stopAt };
  }
  return best;
}
