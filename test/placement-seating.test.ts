/**
 * Seating a figure at placement, on the serialised placement runtime
 * (`test/_placement-host.ts`): a figure with `rideOf` is put on its seat
 * entity with `addRider`. The Pixel (2026-09-29, output/nimbus-pixel-0929/
 * 16-cloud-pos.jpg) refused the orbit companion's seat in the spawn tick and
 * the wand said "figure 1 could not take its seat; it stands instead" while
 * the ride runtime seated the same figure seconds later. The runtime now
 * retries the seat over the next ticks before reporting, and says nothing
 * for a seat that carries a ride (the orbit runtime adopts its figure).
 */
import { describe, expect, it } from 'vitest';
import { host } from './_placement-host.js';

const PIN_AT_FEET = 'Pin corner at my feet', PLACE = 'Place';
const SEAT = 'craftmatic:t_seat', FIG = 'craftmatic:t_fig1';

/** A seat actor (a chair's, or an orbit's when `ride` is given) and the figure that rides it. */
function spec(ride?: number) {
  return {
    stem: 'seated', label: 'Seated', width: 2, height: 2, length: 2,
    tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 2, height: 2, length: 2, nonAir: 4 }],
    actors: [
      { typeId: SEAT, label: 'seat', x: 0.5, y: 0.5, z: 0.5, ...(ride !== undefined ? { ride, ridePath: [[0, 0, 0], [1, 0, 0], [1, 0, 1]] as Array<[number, number, number]> } : {}) },
      { typeId: FIG, label: 'figure 1', x: 0.5, y: 0.5, z: 0.5, rideOf: 0 },
    ],
    settleTicks: 1, finalHoldTicks: 1,
  };
}

/**
 * Places the model with a seat whose `addRider` refuses the first `refusals`
 * calls (`null`: the seat has no rideable component at all), and returns who
 * ended up riding, how many times the seat was asked, and the wand's messages.
 */
async function place(ride: number | undefined, refusals: number | null) {
  const h = host(spec(ride));
  const dim = h.player.dimension;
  const riders: unknown[] = [];
  let calls = 0;
  const spawnEntity = dim.spawnEntity;
  dim.spawnEntity = (typeId: string, at: unknown) => {
    const e = spawnEntity(typeId, at);
    if (typeId === SEAT && refusals !== null) {
      e.getComponent = (n: string) => n === 'minecraft:rideable' ? { addRider: (r: unknown) => { calls++; if (calls <= refusals) return false; riders.push(r); return true; } } : undefined;
    }
    return e;
  };
  await h.open({ action: PIN_AT_FEET }, { canceled: true });
  await h.open({ action: PLACE }, { selection: 0 });
  await h.flush(2000);
  expect(h.player.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Placed Seated.'));
  const messages = (h.player.sendMessage.mock.calls as string[][]).map(c => c[0]!);
  return { riders, calls, messages, figure: h.spawned.find(s => s.typeId === FIG)!.entity, seat: h.spawned.find(s => s.typeId === SEAT)!.entity };
}

describe('placement: a figure takes its seat', () => {
  it('a chair seat that admits the figure at once: one addRider, no message', async () => {
    const r = await place(undefined, 0);
    expect(r.calls).toBe(1);
    expect(r.riders).toEqual([r.figure]);
    expect(r.messages.some(m => /could not take its seat/.test(m))).toBe(false);
  });

  it('a seat that refuses in the spawn tick is asked again over the next ticks and the figure rides; nothing is said', async () => {
    const r = await place(undefined, 1);
    expect(r.calls).toBe(2);
    expect(r.riders).toEqual([r.figure]);
    expect(r.messages.some(m => /could not take its seat/.test(m))).toBe(false);
  });

  it('a chair seat that keeps refusing is reported once, after every retry, with the count', async () => {
    const r = await place(undefined, 99);
    expect(r.calls).toBe(3);
    expect(r.riders).toEqual([]);
    const said = r.messages.filter(m => /could not take its seat/.test(m));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('§efigure 1 could not take its seat (the seat refused it, 3 tries); it stands instead.');
  });

  it('a seat with no rideable component is reported as such (and the placement still finishes)', async () => {
    const r = await place(undefined, null);
    expect(r.riders).toEqual([]);
    const said = r.messages.filter(m => /could not take its seat/.test(m));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('§efigure 1 could not take its seat (the seat is not rideable, 3 tries); it stands instead.');
  });

  it("an orbit seat (the actor carries a ride) that refuses is retried too but never reported: the ride runtime seats its figure", async () => {
    const r = await place(0, 99);
    expect(r.calls).toBe(3);
    expect(r.riders).toEqual([]);
    expect(r.messages.some(m => /could not take its seat/.test(m))).toBe(false);
    // The seat still carries its ride for scripts/rides.js to adopt.
    expect(r.seat.getDynamicProperty('craftmatic:ride')).toBe(0);
    expect(JSON.parse(r.seat.getDynamicProperty('craftmatic:ride_path') as string)).toHaveLength(3);
  });

  it('an orbit seat that admits the figure on a retry rides it (no message either way)', async () => {
    const r = await place(0, 2);
    expect(r.calls).toBe(3);
    expect(r.riders).toEqual([r.figure]);
    expect(r.messages.some(m => /could not take its seat/.test(m))).toBe(false);
  });
});
