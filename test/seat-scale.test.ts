/**
 * SEAT-01 at every wand size, offline: a rideable's seat as the device
 * realises it (the size group's declared seat times its `minecraft:scale`,
 * quirk `seat-scales-with-entity`) is in or on what the vehicle draws at
 * that scale (web/src/sim/adapters/craftmatic/seat-scale.ts). The Saga
 * (round 30k, 2026-10-07) found 76286's rider at 200 % six blocks over the
 * hull and fourteen ahead because the groups wrote their seats pre-scaled;
 * these tests pin the judgement, the shipped encoding and the old fault.
 */
import { describe, expect, it } from 'vitest';
import { SIZE_STEPS, withSizeGroups } from '../web/src/engine/bedrock-placement-pack.js';
import { RIDER_EYE_ABOVE_SEAT, seatPositionAt } from '../web/src/engine/cockpit-seat.js';
import { buildAddonAppearance } from '../web/src/sim/adapters/craftmatic/appearance.js';
import { SEAT_ON_DRAWN, describeSeatRow, seatOnDrawn, seatScaleAudit, seatScaleDrift } from '../web/src/sim/adapters/craftmatic/seat-scale.js';
import type { DrawnBox } from '../web/src/sim/adapters/craftmatic/drawn.js';
import { fixturePack } from '../web/src/sim/pack/fixture.js';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, glass = false): DrawnBox => ({ box: { x0, y0, z0, x1, y1, z1 }, glass });

describe('seatOnDrawn: in or on the drawn vehicle', () => {
  // A cabin: a floor slab, a roof slab and two side walls, 2 wide, 2.5 tall, 4 long, centred on the origin.
  const cabin = [box(-1, 0, -2, 1, 0.2, 2), box(-1, 2.3, -2, 1, 2.5, 2), box(-1, 0, -2, -0.9, 2.5, 2), box(0.9, 0, -2, 1, 2.5, 2)];
  it('a seat under the roof is inside; one on an open deck is on', () => {
    expect(seatOnDrawn({ x: 0, y: 0.6, z: 0 }, cabin)).toMatchObject({ verdict: 'on', ok: true, topUnder: 2.5 });
    expect(seatOnDrawn({ x: 0, y: 0.1, z: 0 }, cabin)).toMatchObject({ verdict: 'inside', ok: true });
    const deck = [box(-2, 0, -4, 2, 1, 4)];
    expect(seatOnDrawn({ x: 0, y: 1 + SEAT_ON_DRAWN.over, z: 1 }, deck)).toMatchObject({ verdict: 'on', ok: true, over: SEAT_ON_DRAWN.over });
  });
  it('over the drawn top, beside the hull, under it, or over nothing drawn is off the vehicle', () => {
    expect(seatOnDrawn({ x: 0, y: 2.5 + SEAT_ON_DRAWN.over + 0.01, z: 0 }, cabin)).toMatchObject({ verdict: 'over', ok: false, topUnder: 2.5 });
    expect(seatOnDrawn({ x: 0, y: 1, z: 2 + SEAT_ON_DRAWN.footprint + 0.01 }, cabin)).toMatchObject({ verdict: 'beside', ok: false });
    // Under: the rider's EYE (seat + 1.12) under the hull's bottom; the hips alone may dip under a floor (a small car below 100 %).
    expect(seatOnDrawn({ x: 0, y: -RIDER_EYE_ABOVE_SEAT - SEAT_ON_DRAWN.under - 0.01, z: 0 }, cabin)).toMatchObject({ verdict: 'under', ok: false });
    expect(seatOnDrawn({ x: 0, y: -0.8, z: 0 }, cabin)).toMatchObject({ verdict: 'on', ok: true });
    expect(seatOnDrawn({ x: 0, y: 1, z: 0 }, [])).toMatchObject({ verdict: 'nothing-drawn', ok: false });
    // Inside the hull's box but over a gap between two parts (between a hull and a wingtip) is beside the vehicle.
    expect(seatOnDrawn({ x: 0, y: 1, z: 0 }, [box(-5, 0, -1, -3, 1, 1), box(3, 0, -1, 5, 1, 1)])).toMatchObject({ verdict: 'beside', ok: false });
  });
});

describe('seatScaleDrift: where the 100 % seat sits, scaled once', () => {
  const seat100 = { x: 0.5, y: 0.4, z: -1 };
  it('is zero at 100 %, and accepts a plain-scaled seat and an eye-anchored one at every size', () => {
    expect(seatScaleDrift(seat100, seat100, 1)).toMatchObject({ ok: true, dx: 0, dy: 0, dz: 0 });
    for (const f of [0.25, 0.5, 1.5, 2, 4]) {
      const plain = { x: 0.5 * f, y: 0.4 * f, z: -f };
      const anchored = { x: 0.5 * f, y: (0.4 + RIDER_EYE_ABOVE_SEAT) * f - RIDER_EYE_ABOVE_SEAT, z: -f };
      expect(seatScaleDrift(plain, seat100, f).ok, `plain at ${f}`).toBe(true);
      expect(seatScaleDrift(anchored, seat100, f).ok, `anchored at ${f}`).toBe(true);
    }
  });
  it('rejects a seat scaled twice (the Saga 30k fault) and a seat moved sideways', () => {
    // 76286: seat (0, 4.58, 3.6); the device read (0, 20.56, 14.4) at 200 % - the eye-anchored seat scaled again.
    const milano = { x: 0, y: 4.58, z: 3.6 };
    const d = seatScaleDrift({ x: 0, y: 20.56, z: 14.4 }, milano, 2);
    expect(d.ok).toBe(false);
    expect(d.yBand[0]).toBeCloseTo(9.16, 9);
    expect(d.yBand[1]).toBeCloseTo(10.28, 9);
    expect(d.dy).toBeCloseTo(20.56 - 10.28, 9);
    expect(d.dz).toBeCloseTo(7.2, 9);
    expect(seatScaleDrift({ x: 0.5 * 2 + SEAT_ON_DRAWN.drift + 0.01, y: 0.8, z: -2 }, seat100, 2).ok).toBe(false);
  });
});

/**
 * A pack with one drawn vehicle: a 3 x 2 x 5-block cabin (floor, roof, sides,
 * JSON frame: 16 units = 1 block, the geometry is Z-mirrored in the world)
 * and a rideable whose size groups are `declare(pct)`.
 */
function vehiclePack(declare: (pct: number) => [number, number, number]) {
  const groups: Record<string, unknown> = {}, events: Record<string, unknown> = {};
  for (const pct of SIZE_STEPS) {
    const f = pct / 100;
    groups[`craftmatic:size_${pct}`] = { 'minecraft:scale': { value: f }, 'minecraft:collision_box': { width: 3 * f, height: 2 * f }, 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: declare(pct) } } };
    events[`craftmatic:size_${pct}`] = { add: { component_groups: [`craftmatic:size_${pct}`] } };
  }
  const entity = { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 'craftmatic:test_car' }, component_groups: groups, events, components: { 'minecraft:collision_box': { width: 3, height: 2 }, 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: declare(100) } } } } };
  const behavior = fixturePack({ files: { 'entities/test_car.json': entity } });
  const sources = new Map<string, string>([
    ['Test_RP/entity/test_car.entity.json', JSON.stringify({ 'minecraft:client_entity': { description: { identifier: 'craftmatic:test_car', geometry: { default: 'geometry.test_car' }, textures: { default: 'textures/entity/craftmatic_swatch_4' }, render_controllers: ['controller.render.default'] } } })],
    ['Test_RP/models/entity/test_car.geo.json', JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.test_car' }, bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [
      { origin: [-24, 0, -40], size: [48, 3, 80], uv: [0, 0] },     // floor
      { origin: [-24, 29, -40], size: [48, 3, 80], uv: [0, 0] },    // roof
      { origin: [-24, 0, -40], size: [2, 32, 80], uv: [0, 0] },     // left wall
      { origin: [22, 0, -40], size: [2, 32, 80], uv: [0, 0] },      // right wall
    ] }] }] })],
  ]);
  return { behavior, appearance: buildAddonAppearance(sources) };
}

describe('seatScaleAudit: every rideable at every wand size', () => {
  // The driver's eye at 100 %: 1.8 up (under the 2-block cabin's roof), 1 block aft of the middle.
  const EYE = 1.8;
  const seat100: [number, number, number] = [0, EYE - RIDER_EYE_ABOVE_SEAT, -1];

  it('a pack built by withSizeGroups (seat declared unscaled, eye-anchored) seats the rider in the cabin at every size', () => {
    const base = { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 'craftmatic:test_car' }, components: {} } };
    const built = withSizeGroups(base, { width: 3, height: 2 }, { seat_count: 1, family_types: ['player'], seats: { position: seat100 } }, { seatAt: seatPositionAt }) as { 'minecraft:entity': { component_groups: Record<string, { 'minecraft:rideable': { seats: { position: [number, number, number] } } }> } };
    const { behavior, appearance } = vehiclePack(pct => built['minecraft:entity'].component_groups[`craftmatic:size_${pct}`]!['minecraft:rideable'].seats.position);
    const { rows, skipped } = seatScaleAudit(behavior, appearance);
    expect(skipped).toEqual([]);
    expect(rows.map(r => r.pct)).toEqual([...SIZE_STEPS]);
    for (const r of rows) {
      expect(r.ok, describeSeatRow(r)).toBe(true);
      expect(r.drift.ok, describeSeatRow(r)).toBe(true);
      // In or on the cabin at the realised scale too, and the realised eye is the 100 % eye scaled with it.
      expect(r.place.ok, describeSeatRow(r)).toBe(true);
      expect(r.eye.y).toBeCloseTo(EYE * r.scale, 2);
      expect(r.seat.z).toBeCloseTo(-r.scale, 2);
    }
  });

  it('the old encoding (the seat written pre-scaled, as every pack before 2026-10-07) drifts from the 100 % seat at every size above it and puts the rider over the roof from 200 % (the Saga 30k fault)', () => {
    const { behavior, appearance } = vehiclePack(pct => seatPositionAt(seat100, pct / 100));
    const { rows } = seatScaleAudit(behavior, appearance);
    const at = (pct: number) => rows.find(r => r.pct === pct)!;
    expect(at(100).ok).toBe(true);
    expect(at(200).place.verdict).toBe('over');
    // Declared (EYE x 2 - 1.12), realised x 2 again: 4.96, a block over the 4-block roof, and
    // 2.48 past the band the 100 % seat scaled once allows.
    expect(at(200).seat.y).toBeCloseTo((EYE * 2 - RIDER_EYE_ABOVE_SEAT) * 2, 2);
    expect(at(200).drift.dy).toBeCloseTo((EYE * 2 - RIDER_EYE_ABOVE_SEAT) * 2 - (EYE * 2 - RIDER_EYE_ABOVE_SEAT), 2);
    expect(at(400).ok).toBe(false);
    // Below 100 % the error is (f - 1) x a small offset: under the drift tolerance here, as the
    // 25-75 % steps of the device packs were (never ridden on a device either way).
    expect(rows.filter(r => !r.ok).map(r => r.pct)).toEqual([150, 200, 300, 400]);
  });

  it('a rideable the pack draws nothing for is skipped and named, never judged', () => {
    const { behavior } = vehiclePack(() => seat100);
    const { rows, skipped } = seatScaleAudit(behavior, buildAddonAppearance(new Map()));
    expect(rows).toEqual([]);
    expect(skipped).toEqual([{ typeId: 'craftmatic:test_car', why: 'no-geometry' }]);
  });
});
