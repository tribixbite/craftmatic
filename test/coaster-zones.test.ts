import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { COASTER_DESIGN, CoasterDesignError, frameRateDegPerTick, generateCoaster, type CoasterDesign } from '../web/src/engine/coaster-design';
import { COASTER_PHYSICS } from '../web/src/engine/bedrock-coaster';
import {
  COASTER_ZONES, coasterBlockStop, coasterZoneSpeed, planCoasterZones, type CoasterZoneMemo, type CoasterZonePlan, type CoasterZoneRule,
} from '../web/src/engine/coaster-zones';

const sketch = JSON.parse(readFileSync('test/fixtures/coaster/3x-sketch.json', 'utf8')) as CoasterDesign;
const PHYS = { stationBrake: COASTER_PHYSICS.STATION_BRAKE, holdAccel: COASTER_PHYSICS.LIFT_ACCEL };
const fresh = (): CoasterZoneMemo => ({ launch: -1, v0sq: 0 });

/** Drive one speed through `rules` along a straight track, `dt` per step, the way the runtime's substep does; returns [arc, speed] per step. */
function run(rules: CoasterZoneRule[], arc0: number, speed0: number, until: number, dt = 0.01, start?: CoasterZoneMemo): Array<[number, number]> {
  const memo = start ?? fresh();
  let arc = arc0, speed = speed0;
  const out: Array<[number, number]> = [[arc, speed]];
  while (arc < until) {
    speed = coasterZoneSpeed(rules, arc, speed, dt, memo, PHYS.holdAccel);
    arc += speed * dt;
    out.push([arc, speed]);
  }
  return out;
}

describe('coaster-zones', () => {
  it('a launch zone takes a train from 2 to 30 blocks/s within its length', () => {
    const rules: CoasterZoneRule[] = [{ kind: 'launch', from: 100, to: 170, speed: 30 }];
    const trace = run(rules, 90, 2, 200);
    const inside = trace.filter(([a]) => a >= 100 && a < 170);
    // Pinned to the design's profile v^2 = v0^2 + (vt^2 - v0^2) s / L: constant acceleration, never above the target.
    expect(Math.max(...trace.map(([, v]) => v))).toBeLessThanOrEqual(30 + 1e-9);
    const atEnd = trace.find(([a]) => a >= 169.5)!;
    expect(atEnd[1]).toBeGreaterThan(29.5);
    const mid = trace.find(([a]) => a >= 135)!;
    expect(mid[1]).toBeCloseTo(Math.sqrt(4 + (900 - 4) * 0.5), 0);
    // Monotone: a launch never slows a train that is slower than its target.
    for (let i = 1; i < inside.length; i++) expect(inside[i]![1]).toBeGreaterThanOrEqual(inside[i - 1]![1] - 1e-9);
  });

  it('a launch entered at speed starts from that speed, not from zero', () => {
    const rules: CoasterZoneRule[] = [{ kind: 'launch', from: 0, to: 28, speed: 52 }];
    const trace = run(rules, 0, 22, 40);
    expect(trace[1]![1]).toBeGreaterThan(21.9);
    expect(trace[1]![1]).toBeLessThan(23);
    expect(trace.find(([a]) => a >= 27.9)![1]).toBeGreaterThan(51.5);
  });

  it('a cable lift holds its speed above the chain lift and a slower or faster train is brought to it at the hold acceleration', () => {
    const rules: CoasterZoneRule[] = [{ kind: 'hold', from: 0, to: 400, speed: 8 }];
    const up = run(rules, 0, 3.5, 100);
    expect(up.at(-1)![1]).toBeCloseTo(8, 6);
    // 3.5 -> 8 at LIFT_ACCEL: 4.5 / 24 s, no jump in one 10 ms step.
    expect(up[1]![1] - up[0]![1]).toBeLessThanOrEqual(PHYS.holdAccel * 0.01 + 1e-9);
    const down = run(rules, 0, 40, 100);
    expect(down[1]![1]).toBeCloseTo(40 - PHYS.holdAccel * 0.01, 6);
    expect(down.at(-1)![1]).toBeCloseTo(8, 6);
  });

  it('a block brake sheds to its target at its deceleration and never speeds a slower train', () => {
    const rules: CoasterZoneRule[] = [{ kind: 'brake', from: 0, to: 90, speed: 4, decel: 14 }];
    const fast = run(rules, 0, 41, 90);
    expect(fast.at(-1)![1]).toBeCloseTo(4, 1);
    // v^2 falls by 2 a ds: 41 -> 4 takes (1681 - 16) / 28 = 59.5 blocks.
    expect(fast.find(([, v]) => v <= 4.0001)![0]).toBeCloseTo(59.5, 0);
    const slow = run(rules, 0, 1.5, 90);
    expect(Math.max(...slow.map(([, v]) => v))).toBeCloseTo(1.5, 9);
  });

  it('no rule acts outside its span, and a launch forgets its entry speed when the train leaves', () => {
    const rules: CoasterZoneRule[] = [{ kind: 'launch', from: 10, to: 20, speed: 30 }, { kind: 'launch', from: 50, to: 60, speed: 30 }];
    const memo = fresh();
    expect(coasterZoneSpeed(rules, 5, 7, 0.05, memo, PHYS.holdAccel)).toBe(7);
    expect(coasterZoneSpeed(rules, 15, 7, 0.05, memo, PHYS.holdAccel)).toBeGreaterThan(7);
    expect(memo.launch).toBe(0);
    expect(coasterZoneSpeed(rules, 30, 25, 0.05, memo, PHYS.holdAccel)).toBe(25);
    expect(memo.launch).toBe(-1);
    // The second zone records its own entry speed (4 -> the profile begins at 4, not at the first zone's 7).
    expect(coasterZoneSpeed(rules, 50, 4, 0.05, memo, PHYS.holdAccel)).toBeCloseTo(4, 5);
    expect(memo.launch).toBe(1);
  });

  describe('the plan of the 3x sketch', () => {
    const gen = generateCoaster(sketch);
    const total = gen.route.points.length ? gen.report.lengthB : 0;
    const plan = planCoasterZones(gen.zones, total, PHYS);

    it('turns its launches, lifts, drives, block brake and trims into rules, and nothing for station, tunnel, dark or cloud', () => {
      const count = (k: string) => plan.rules.filter(r => r.kind === k).length;
      expect(count('launch')).toBe(gen.zones.filter(z => z.kind === 'launch').length);
      expect(count("launch")).toBe(6);
      expect(count('hold')).toBe(gen.zones.filter(z => z.kind === 'lift').length);
      expect(count('brake')).toBe(2);
      expect(plan.rules.length).toBe(6 + gen.zones.filter(z => z.kind === 'lift').length + 2);
      const launch = plan.rules.find(r => r.kind === 'launch')!;
      expect(launch.speed).toBe(52);
      const cable = plan.rules.find(r => r.kind === 'hold' && r.speed === 8 && r.to - r.from > 150)!;
      expect(cable.speed).toBe(8);
      const block = plan.rules.find(r => r.kind === 'brake' && r.speed === 4)!;
      expect(block.decel).toBe(2 * PHYS.stationBrake);
      const trim = plan.rules.find(r => r.kind === 'brake' && r.decel === PHYS.stationBrake)!;
      expect(trim.to).toBeCloseTo(total, 6);
    });

    it('cuts the circuit into three block sections for two trains: the brake run, the course and the station block', () => {
      const brake = gen.zones.find(z => z.kind === 'block-brake')!;
      const station = gen.zones.find(z => z.kind === 'station')!;
      expect(plan.blocks.length).toBe(3);
      const starts = plan.blocks.map(b => b.from).sort((a, b) => a - b);
      expect(starts[0]).toBeCloseTo(station.to, 6);
      expect(starts[1]).toBeCloseTo(brake.from, 6);
      expect(starts[2]).toBeCloseTo(brake.to, 6);
      // The brake run and the block after it are gated at their entry; the course is entered at the station's release.
      expect(plan.blocks.filter(b => b.gated).map(b => b.from).sort((a, b) => a - b)).toEqual([brake.from, brake.to].sort((a, b) => a - b));
    });
  });

  describe('block holds', () => {
    const blocks: CoasterZonePlan['blocks'] = [
      { from: 16, to: 1512, gated: false }, { from: 1512, to: 1602, gated: true }, { from: 1602, to: 1872 + 16, gated: true },
    ];
    const total = 1872, extent = 15.5, gap = COASTER_ZONES.BLOCK_GAP;

    it('stops a train short of a block another train occupies, front at the entry less the gap', () => {
      // Train A's centre sits in the brake run; B is 100 blocks upstream.
      const stop = coasterBlockStop(blocks, total, 1400, extent, [1550], gap);
      expect(stop).not.toBeNull();
      expect(stop!.stopAt).toBeCloseTo(1512 - gap - extent / 2, 6);
      expect(stop!.toStop).toBeCloseTo(1512 - gap - extent / 2 - 1400, 6);
    });

    it('lets a train go when the block ahead is free, or when the other train is only touching its tail', () => {
      expect(coasterBlockStop(blocks, total, 1400, extent, [800], gap)).toBeNull();
      // The other train's tail still reaches the entry of the NEXT block only when its span overlaps it.
      expect(coasterBlockStop(blocks, total, 1400, extent, [1512 - extent / 2 - 0.5], gap)).toBeNull();
    });

    it('holds a stopped train at the gate (no creep from rounding) until the block is free', () => {
      const stopAt = 1512 - gap - extent / 2;
      expect(coasterBlockStop(blocks, total, stopAt, extent, [1550], gap)!.toStop).toBeCloseTo(0, 6);
      expect(coasterBlockStop(blocks, total, stopAt, extent, [800], gap)).toBeNull();
    });

    it('ignores a gate the train is already past, and wraps the seam', () => {
      expect(coasterBlockStop(blocks, total, 1560, extent, [1530], gap)).toBeNull();
      // A train 40 blocks before the seam, another train sitting in the (wrapping) station block: the gate is at 1602.
      const stop = coasterBlockStop(blocks, total, 1560, extent, [1860], gap);
      expect(stop!.stopAt).toBeCloseTo(1602 - gap - extent / 2, 6);
    });
  });
});

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const carText = readFileSync('test/fixtures/coaster/own-car.ldr', 'utf8');

describe.skipIf(!existsSync(LDRAW_ROOT))('coaster-zones (simulator, two trains on the 3x sketch)', () => {
  /** Build the sketch's pack, optionally with a long platform dwell so the first train holds the station block. */
  async function run(chase: boolean) {
    const { setLDrawRoot } = await import('../web/src/engine/ldraw-geometry');
    setLDrawRoot(LDRAW_ROOT);
    const { buildGeneratedCoasterPack } = await import('../web/src/engine/coaster-design-pack');
    const { scenarios } = await import('../scripts/_coaster_zones_scenarios');
    const { runScenario } = await import('../web/src/sim/scenario/runner');
    const { craftmaticHandlers } = await import('../web/src/sim/adapters/craftmatic/child-play');
    const { readCraftmaticPack } = await import('../web/src/sim/adapters/craftmatic/pack-facts');
    const { readAddon, packText } = await import('../web/src/sim/pack/pack');
    const built = await buildGeneratedCoasterPack(sketch, carText);
    const addon = await readAddon(built.result.bytes);
    if (chase) {
      // A long platform dwell (1,500 ticks, 75 s) keeps the first train in the station block while the second reaches
      // the end of the brake run: only the block gate can hold it there (the dispatcher's bay is a train length
      // before the platform, past the gate).
      const pack = addon.packs.find(p => packText(p, 'scripts/coaster.js'))!;
      const text = packText(pack, 'scripts/coaster.js')!;
      expect(text).toMatch(/"DWELL_EMPTY":100,/);
      pack.files.set('scripts/coaster.js', new TextEncoder().encode(text.replace('"DWELL_EMPTY":100,', '"DWELL_EMPTY":1500,')));
    }
    const pack = readCraftmaticPack(addon)!;
    const [scenario] = scenarios(pack);
    expect(scenario).toBeDefined();
    const result = await runScenario(scenario!, [addon], { handlers: craftmaticHandlers(pack, addon) });
    return { result, zones: result.state['zones'] as import('../scripts/_coaster_zones_scenarios').ZonesResult };
  }

  it('two trains run the circuit with block brakes keeping them apart, and every launch reaches its target speed', async () => {
    const { result, zones } = await run(false);
    expect(result.violations.map(v => `${v.invariant}: ${v.message}`)).toEqual([]);
    expect(zones.leadLaps).toBeGreaterThanOrEqual(2);
    expect(zones.sharedBlockTicks).toBe(0);
    expect(zones.launches.length).toBe(6);
    for (const l of zones.launches) expect(l.endSpeed).toBeGreaterThan(0.98 * l.target);
    // The cable lift is 8 blocks/s, faster than the chain's 3.5, and the route's own ceiling is the design's, not the global 28.3.
    expect(zones.peakBps).toBeGreaterThan(COASTER_PHYSICS.MAX_SPEED + 5);
  }, 300_000);

  it('a second train that reaches the end of the brake run while the station block is taken is held at the gate and never shares a gated block', async () => {
    const { result, zones } = await run(true);
    expect(result.violations.map(v => `${v.invariant}: ${v.message}`)).toEqual([]);
    expect(zones.sharedBlockTicks).toBe(0);
    expect(zones.gateHoldTicks).toBeGreaterThan(0);
  }, 300_000);
});

describe('the rider camera and the track (C02 finding: camera-continuous frames of 49-106 degrees on the generated track)', () => {
  // The sketch as C02 shipped it: zero-g rolls whose crest is 12-25 blocks long at 21-45 blocks/s.
  const fastRolls = JSON.parse(readFileSync('test/fixtures/coaster/3x-sketch-fast-rolls.json', 'utf8')) as CoasterDesign;

  it('a design whose car frame turns faster than the camera follows is refused by the validator, naming the element', () => {
    let error: unknown;
    try { generateCoaster(fastRolls); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CoasterDesignError);
    const issues = (error as CoasterDesignError).issues.filter(i => i.code === 'frame-rate');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/degrees per tick/);
  });

  it('the 3x sketch keeps the car frame under the limit everywhere (the limit leaves the runtime 1.4x the design speed under the 40-degree camera cap)', () => {
    const gen = generateCoaster(sketch);
    const worst = Math.max(...frameRateDegPerTick(gen));
    expect(worst).toBeLessThanOrEqual(COASTER_DESIGN.MAX_FRAME_RATE_DEG_PER_TICK);
    expect(COASTER_DESIGN.MAX_FRAME_RATE_DEG_PER_TICK * 1.4).toBeLessThanOrEqual(40);
  });
});

describe.skipIf(!existsSync(LDRAW_ROOT))('the rider camera on the 3x sketch (simulator)', () => {
  it('a train ridden once round the generated circuit draws no camera-continuous violation on either phone', async () => {
    const { setLDrawRoot } = await import('../web/src/engine/ldraw-geometry');
    setLDrawRoot(LDRAW_ROOT);
    const { buildGeneratedCoasterPack } = await import('../web/src/engine/coaster-design-pack');
    const { rideCamera } = await import('../scripts/_coaster_zones_camera');
    const built = await buildGeneratedCoasterPack(sketch, carText);
    for (const profile of ['pixel', 'saga'] as const) {
      const { result } = await rideCamera(built.result.bytes, `3x-sketch-${profile}`, profile, 1);
      const cut = result.violations.filter(v => v.invariant === 'camera-continuous').map(v => v.message);
      expect(cut, profile).toEqual([]);
      const ride = result.state['coasterCamera'] as { laps: number; animations: number };
      expect(ride.laps, profile).toBe(1);
      // The rolls and loops ARE animated: a ride with none would pass the invariant for free.
      expect(ride.animations, profile).toBeGreaterThanOrEqual(10);
    }
  }, 600_000);
});
