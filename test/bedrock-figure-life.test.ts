/**
 * Minifig NPC life (web/src/engine/bedrock-figure-life.ts): the pure planner
 * over collision spans, and the SERIALISED `scripts/figures.js` runtime run
 * in the host world of figure-life-sim.ts - rooms with floor plates under a
 * ceiling (the Winter Chalet case where vanilla mob AI never moved), walls,
 * a drop, a doorway leaf, seats, and a figure pushed out of its area.
 */
import { describe, expect, it } from 'vitest';
import type { SourceCell } from '../web/src/engine/bedrock-collider-scale.js';
import { blockSpan, exploreWalkable, FIGURE_TUNING, figureLifeScript, pathTo, standFeetAt, type SpanLookup } from '../web/src/engine/bedrock-figure-life.js';
import { simulateFigureLife, type SimWorld } from '../web/src/engine/figure-life-sim.js';

const spansOf = (cells: SourceCell[], ground = 0): SpanLookup => {
  const m = new Map(cells.map(c => [`${c.x},${c.y},${c.z}`, c]));
  return (x, y, z) => {
    const c = m.get(`${x},${y},${z}`);
    if (c) return [y + c.lo / 16, y + c.hi / 16];
    return y < ground ? [y, y + 1] : null;
  };
};

/**
 * A 9 x 7 room: 3/16 floor plates, walls around (full cells, rows 0-2), a
 * ceiling slab 2.25 blocks over the floor (row 2, 4..16), a doorway gap in the
 * front wall at x = 4, and a 3-block pit at (6, 3).
 */
function room(): SourceCell[] {
  const cells: SourceCell[] = [];
  for (let x = 0; x < 9; x++) for (let z = 0; z < 7; z++) {
    const wall = x === 0 || x === 8 || z === 0 || z === 6;
    const door = z === 6 && x === 4;
    if (wall && !door) { for (let y = 0; y < 3; y++) cells.push({ x, y, z, lo: 0, hi: 16 }); continue; }
    if (!(x === 6 && z === 3)) cells.push({ x, y: 0, z, lo: 0, hi: 3 });
    cells.push({ x, y: 2, z, lo: 4, hi: 16 });
  }
  return cells;
}

describe('planner', () => {
  const span = spansOf(room(), -3);
  it('stands on a floor plate under a 2.25-block ceiling (1.8 body) and not in a wall', () => {
    expect(standFeetAt(span, 3, 3, 0, 1.8, 0.6, 0.6)).toBeCloseTo(3 / 16);
    expect(standFeetAt(span, 0, 3, 0.19, 1.8, 0.6, 0.6)).toBeNull();
    // A 2.2 body does not fit under the ceiling.
    expect(standFeetAt(span, 3, 3, 0, 2.2, 0.6, 0.6)).toBeNull();
  });
  it('does not step down into a pit (drop > 0.6) and explores the room only', () => {
    const cells = exploreWalkable(span, { x: 2, z: 2, feet: 3 / 16 }, 1.8, 0.6, 0.6, () => true, 500, standFeetAt);
    const keys = new Set(cells.map(c => `${c.x},${c.z}`));
    expect(keys.has('6,3')).toBe(false);
    expect(keys.has('0,2')).toBe(false);
    // Interior 7 x 5 minus the pit = 34, plus the doorway cell (standing on the ground below: a 3/16 drop).
    expect(keys.has('4,6')).toBe(true);
    expect(cells.every(c => c.x >= 1 && c.x <= 7 && c.z >= 1 && c.z <= 7)).toBe(true);
  });
  it('bounds the walk with the allowed predicate and reads a path back', () => {
    const cells = exploreWalkable(span, { x: 2, z: 2, feet: 3 / 16 }, 1.8, 0.6, 0.6, (x) => x <= 4, 500, standFeetAt);
    expect(cells.every(c => c.x <= 4)).toBe(true);
    const far = cells.findIndex(c => c.x === 4 && c.z === 5);
    const path = pathTo(cells, far);
    expect(path[path.length - 1]).toMatchObject({ x: 4, z: 5 });
    for (let i = 1; i < path.length; i++) expect(Math.max(Math.abs(path[i]!.x - path[i - 1]!.x), Math.abs(path[i]!.z - path[i - 1]!.z))).toBe(1);
  });
  it('never cuts a wall corner diagonally', () => {
    // An L of wall: (3,3) solid; from (2,2) the diagonal to (3,3)'s neighbour (3,2)->(4,3) must go round.
    const cells: SourceCell[] = [{ x: 3, y: 0, z: 3, lo: 0, hi: 16 }, { x: 3, y: 1, z: 3, lo: 0, hi: 16 }];
    const found = exploreWalkable(spansOf(cells), { x: 2, z: 2, feet: 0 }, 1.8, 0.6, 0.6, (x, z) => x >= 0 && x <= 5 && z >= 0 && z <= 5, 500, standFeetAt);
    const idx = found.findIndex(c => c.x === 4 && c.z === 4);
    const path = pathTo(found, idx);
    const prev = (i: number) => (i === 0 ? { x: 2, z: 2 } : path[i - 1]!);
    for (let i = 0; i < path.length; i++) {
      const a = prev(i), b = path[i]!;
      if (a.x !== b.x && a.z !== b.z) expect(`${a.x},${b.z}` !== '3,3' && `${b.x},${a.z}` !== '3,3').toBe(true);
    }
  });
  it('reads block spans: collider sixteenths, plants as nothing, carpet thin, the rest full', () => {
    const C = { block: 'craftmatic:collider' };
    expect(blockSpan('craftmatic:collider', false, false, 5, C, 0, 3)).toEqual([5, 5 + 3 / 16]);
    expect(blockSpan('minecraft:short_grass', false, false, 5, C, NaN, NaN)).toBeNull();
    expect(blockSpan('minecraft:white_carpet', false, false, 5, C, NaN, NaN)).toEqual([5, 5 + 1 / 16]);
    expect(blockSpan('minecraft:stone', false, false, 5, C, NaN, NaN)).toEqual([5, 6]);
    expect(blockSpan('minecraft:grass_block', false, false, 5, C, NaN, NaN)).toEqual([5, 6]);
    expect(blockSpan('minecraft:mushroom_stem', false, false, 5, C, NaN, NaN)).toEqual([5, 6]);
    expect(blockSpan('minecraft:red_tulip', false, false, 5, C, NaN, NaN)).toBeNull();
    expect(blockSpan('minecraft:air', true, false, 5, C, NaN, NaN)).toBeNull();
  });
});

describe('the serialised runtime', () => {
  const config = { figureTypes: ['craftmatic:a_fig1', 'craftmatic:a_fig2', 'craftmatic:a_fig3'], seatTypes: ['craftmatic:a_seat'], bodyHeights: {}, bodyHeight: 1.8, tuning: FIGURE_TUNING };
  it('serialises without references outside itself', () => {
    const js = figureLifeScript({ ...config, interactiveFamily: 'craftmatic_interactive' });
    expect(js).not.toMatch(/__name|import_|bedrock_figure_life/);
    expect(js).toContain("import { world, system } from '@minecraft/server'");
  });

  const inRoom = (w: SimWorld, tracks: ReturnType<typeof simulateFigureLife>) => tracks.map(t => ({
    path: t.reduce((s, p, i) => i ? s + Math.hypot(p.x - t[i - 1]!.x, p.z - t[i - 1]!.z) : 0, 0),
    outside: t.filter(p => p.x < w.area[0] || p.x > w.area[2] || p.z < w.area[1] || p.z > w.area[3]).length,
    minY: Math.min(...t.map(p => p.y)),
    riding: t.filter(p => p.riding).length,
  }));

  it('walks figures about a floor-plate room under a ceiling, inside it, never into the pit', () => {
    // The room stands on stilts: under its plates is a 3-block drop to the ground.
    const w: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: -3, figures: [
      { typeId: 'craftmatic:a_fig1', at: { x: 2.5, y: 3 / 16, z: 2.5 } },
      { typeId: 'craftmatic:a_fig2', at: { x: 5.5, y: 3 / 16, z: 4.5 } },
    ] };
    const r = inRoom(w, simulateFigureLife(w, config, 2400, 7));
    for (const f of r) {
      expect(f.path).toBeGreaterThan(4);
      expect(f.outside).toBe(0);
      expect(f.minY).toBeGreaterThan(0); // never into the pit, never off the doorway's edge
    }
  });

  it('keeps a figure standing on a 1-cell plinth where it is', () => {
    const cells: SourceCell[] = [{ x: 5, y: 0, z: 5, lo: 0, hi: 16 }];
    const w: SimWorld = { cells, area: [4, 4, 7, 7], ground: 0, figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 5.5, y: 1, z: 5.5 } }] };
    const [f] = inRoom(w, simulateFigureLife(w, config, 1200, 3));
    expect(f!.path).toBe(0);
    expect(f!.minY).toBe(1);
  });

  it('leaves a source-seated figure on its seat, and lets a roamer borrow a free seat and give it up', () => {
    const w: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: 0,
      seats: [{ typeId: 'craftmatic:a_seat', at: { x: 2.5, y: 0.6, z: 2.5 } }, { typeId: 'craftmatic:a_seat', at: { x: 6.5, y: 0.6, z: 1.5 } }],
      figures: [
        { typeId: 'craftmatic:a_fig1', at: { x: 2.5, y: 0.6, z: 2.5 }, mode: 'seated' },
        { typeId: 'craftmatic:a_fig2', at: { x: 5.5, y: 3 / 16, z: 3.5 } },
      ] };
    const tuning = { ...FIGURE_TUNING, seatChance: 1, sitMin: 100, sitMax: 120 };
    const r = inRoom(w, simulateFigureLife(w, { ...config, tuning }, 3000, 11));
    expect(r[0]!.riding).toBe(3000);
    expect(r[1]!.riding).toBeGreaterThan(50);
    expect(r[1]!.riding).toBeLessThan(3000);
  });

  it('walks a figure spawned inside a collider column into the free cell beside it, then keeps it there', () => {
    const cells: SourceCell[] = [0, 1, 2].map(y => ({ x: 2, y, z: 2, lo: 0, hi: 16 }));
    const w: SimWorld = { cells, area: [2, 2, 4, 3], ground: 0, figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 2.4, y: 0, z: 2.5 } }] };
    const [t] = simulateFigureLife(w, config, 800, 4);
    const last = t![t!.length - 1]!;
    expect(Math.floor(last.x)).toBe(3);
    expect(t!.slice(-200).every(p => Math.hypot(p.x - last.x, p.z - last.z) < 1e-6)).toBe(true);
  });

  it('sets a figure walled into a collider (no free column beside it) down on the nearest roomy floor', () => {
    // Column (5,5) and its eight neighbours are 3-block solids; open ground beyond.
    const cells: SourceCell[] = [];
    for (let x = 4; x <= 6; x++) for (let z = 4; z <= 6; z++) for (let y = 0; y < 3; y++) cells.push({ x, y, z, lo: 0, hi: 16 });
    const w: SimWorld = { cells, area: [0, 0, 11, 11], ground: 0, figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 5.5, y: 0, z: 5.5 } }] };
    const [t] = simulateFigureLife(w, config, 600, 9);
    const last = t![t!.length - 1]!;
    const inSolid = (p: { x: number; z: number }) => Math.floor(p.x) >= 4 && Math.floor(p.x) <= 6 && Math.floor(p.z) >= 4 && Math.floor(p.z) <= 6;
    expect(inSolid(last)).toBe(false);
    expect(Math.hypot(last.x - 5.5, last.z - 5.5)).toBeLessThan(9);
  });

  it('never stops next to a door leaf', () => {
    const w: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: 0, leaves: [{ x: 4.5, y: 0.2, z: 6 }], figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 4.5, y: 3 / 16, z: 3.5 } }] };
    const [t] = simulateFigureLife(w, config, 4000, 5);
    // Resting samples (no movement between ticks) are all clear of the leaf.
    const rests = t!.filter((p, i) => i > 0 && Math.hypot(p.x - t![i - 1]!.x, p.z - t![i - 1]!.z) < 1e-4);
    expect(rests.length).toBeGreaterThan(100);
    expect(rests.every(p => Math.hypot(p.x - 4.5, p.z - 6) >= 1.2)).toBe(true);
  });

  it('brings a figure pushed out of its area back in', () => {
    // Flat ground, a 6 x 6 area; the figure starts 4 blocks outside it.
    const w: SimWorld = { cells: [], area: [0, 0, 6, 6], ground: 0, figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 10.5, y: 0, z: 3.5 }, home: { x: 2.5, y: 0, z: 3.5 } }] };
    const [t] = simulateFigureLife(w, config, 600, 2);
    const last = t![t!.length - 1]!;
    expect(last.x).toBeLessThanOrEqual(6.5);
  });
});
