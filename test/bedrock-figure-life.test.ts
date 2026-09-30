/**
 * Minifig NPC life (web/src/engine/bedrock-figure-life.ts): the pure planner
 * over collision spans, and the SERIALISED `scripts/figures.js` runtime run
 * on the headless simulator (sim/adapters/craftmatic/figure-life.ts) - rooms with floor plates under a
 * ceiling (the Winter Chalet case where vanilla mob AI never moved), walls,
 * a drop, a doorway leaf, seats, and a figure pushed out of its area.
 */
import { describe, expect, it } from 'vitest';
import type { SourceCell } from '../web/src/engine/bedrock-collider-scale.js';
import { host } from './_placement-host.js';
import { blockSpan, exploreWalkable, FIGURE_SEATING_GRACE_MS, FIGURE_SEATING_PROPERTY, FIGURE_TUNING, figureLifeScript, pathTo, resolveFigureSpawn, separateFigureSpawns, spawnLift, standFeetAt, type SpanLookup } from '../web/src/engine/bedrock-figure-life.js';
import { simulateFigureLife, type SimWorld } from '../web/src/sim/adapters/craftmatic/figure-life.js';

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

describe('spawn resolution (resolveFigureSpawn, at export)', () => {
  const opts = { maxUp: FIGURE_TUNING.maxUp, maxDown: FIGURE_TUNING.maxDown, minRoom: FIGURE_TUNING.minRoamCells };
  const inside = (w: number, l: number) => (x: number, z: number): boolean => x >= 0 && z >= 0 && x < w && z < l;
  it('keeps a figure its own column carries, snapped onto the plate it stands on', () => {
    const span = spansOf(room(), 0);
    const s = resolveFigureSpawn(span, { x: 3.4, y: 0.15, z: 3.6 }, 1.8, inside(9, 7), opts);
    expect(s.kind).toBe('kept');
    expect([s.x, s.z]).toEqual([3.4, 3.6]);
    expect(s.y).toBeCloseTo(3 / 16);
  });
  it('sets a box-art line-up figure (standing on no part, 2 blocks up) down on the ground, not onto a ledge', () => {
    // A model base 2.4-3.1 blocks up beside the figure's column (21360's line-up); nothing under the figure.
    const cells: SourceCell[] = [];
    for (let x = 0; x < 8; x++) for (let z = 3; z < 6; z++) { cells.push({ x, y: 2, z, lo: 6, hi: 16 }); cells.push({ x, y: 3, z, lo: 0, hi: 2 }); }
    const span = spansOf(cells, 0);
    const s = resolveFigureSpawn(span, { x: 4.4, y: 2.1, z: 2.9 }, 1.8, inside(8, 6), opts);
    expect(s.kind).toBe('grounded');
    expect(s.y).toBe(0);
    expect([s.x, s.z]).toEqual([4.4, 2.9]);
    // The placement's own lift would have left it in the air (nothing overlaps its body): it fell.
    expect(spawnLift(span, 4.4, 2.9, 2.1, 1.8, 3)).toBe(2.1);
  });
  it('grounds a line-up figure far above the ground (a model standing on stray low parts)', () => {
    const cells: SourceCell[] = [];
    for (let x = 0; x < 6; x++) for (let z = 4; z < 6; z++) cells.push({ x, y: 5, z, lo: 0, hi: 4 });
    const s = resolveFigureSpawn(spansOf(cells, 0), { x: 1.5, y: 5.25, z: 1.5 }, 1.8, inside(6, 6), opts);
    expect(s.kind).toBe('grounded');
    expect(s.y).toBe(0);
    // Beside the base on its own level, the base itself is the nearest surface: one step across.
    const beside = resolveFigureSpawn(spansOf(cells, 0), { x: 1.5, y: 5.25, z: 3.5 }, 1.8, inside(6, 6), opts);
    expect(beside.kind).toBe('moved');
    expect(beside.y).toBe(5.25);
  });
  it('moves a figure standing inside a solid column onto the roomy floor beside it, never onto the roof', () => {
    // 71040's case: a floor plate at 0-0.19, a solid tower column 0-5.4 at (3, 3) where the figure stands.
    const cells: SourceCell[] = [];
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) cells.push({ x, y: 0, z, lo: 0, hi: 3 });
    for (let y = 0; y < 5; y++) cells.push({ x: 3, y, z: 3, lo: 0, hi: 16 });
    cells.push({ x: 3, y: 5, z: 3, lo: 0, hi: 7 });
    const span = spansOf(cells, 0);
    // The spawn lift puts it on the tower (5.44 blocks up), where one cell is all there is.
    expect(spawnLift(span, 3.5, 3.5, 0.19, 1.8, 6)).toBeCloseTo(5 + 7 / 16);
    const s = resolveFigureSpawn(span, { x: 3.5, y: 0.19, z: 3.5 }, 1.8, inside(8, 8), opts);
    expect(s.kind).toBe('moved');
    expect(s.y).toBeCloseTo(3 / 16);
    expect(s.shift).toBeCloseTo(1);
    expect(s.room).toBeGreaterThanOrEqual(FIGURE_TUNING.minRoamCells);
    expect(spawnLift(span, s.x, s.z, s.y, 1.8, 3)).toBeCloseTo(s.y);
  });
  it('prefers a spot with room over a nearer one-cell ledge', () => {
    // Figure inside a wall at (2, 2); west of it a 1-cell ledge boxed in by walls, 3 cells east an open floor.
    const cells: SourceCell[] = [];
    for (let y = 0; y < 4; y++) for (let z = 0; z < 5; z++) { cells.push({ x: 2, y, z, lo: 0, hi: 16 }); cells.push({ x: 0, y, z, lo: 0, hi: 16 }); }
    for (let y = 0; y < 4; y++) { cells.push({ x: 1, y, z: 1, lo: 0, hi: 16 }); cells.push({ x: 1, y, z: 3, lo: 0, hi: 16 }); }
    for (let x = 3; x < 8; x++) for (let z = 0; z < 5; z++) cells.push({ x, y: 0, z, lo: 0, hi: 3 });
    const s = resolveFigureSpawn(spansOf(cells, 0), { x: 2.3, y: 0.19, z: 2.5 }, 1.8, inside(8, 5), opts);
    expect(s.kind).toBe('moved');
    expect(Math.floor(s.x)).toBe(3);
    expect(s.room).toBeGreaterThanOrEqual(FIGURE_TUNING.minRoamCells);
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

  it('walks a Minifig Creator figure like a set figure, but only once the wand releases its draft', () => {
    // No home record (the wand writes none): the runtime makes one where it stands when it adopts it.
    const w: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: -3, figures: [
      { typeId: 'craftmatic:a_minifig', at: { x: 3.5, y: 3 / 16, z: 3.5 }, noHome: true, draftUntil: 600 },
    ] };
    const t = simulateFigureLife(w, { ...config, figureTypes: [...config.figureTypes, 'craftmatic:a_minifig'], draftTypes: ['craftmatic:a_minifig'] }, 2400, 5)[0]!;
    const moved = (from: number, to: number): number => t.slice(from, to).reduce((s, p, i, a) => i ? s + Math.hypot(p.x - a[i - 1]!.x, p.z - a[i - 1]!.z) : 0, 0);
    expect(moved(0, 600)).toBe(0); // held by the wand
    expect(moved(600, 2400)).toBeGreaterThan(3);
    expect(t.every(p => p.x > 0 && p.x < 9 && p.z > 0 && p.z < 7 && p.y > 0)).toBe(true);
  });

  it('never borrows a seat on the storey below it (Pixel 76269: a figure sat 6 blocks down through the floor)', () => {
    // A 2 x 2 upper floor (4 cells: enough to roam) 3 blocks over the ground, and a free
    // seat on the ground under its middle: within 1.6 blocks sideways of every cell.
    const cells: SourceCell[] = [];
    for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) cells.push({ x, y: 3, z, lo: 0, hi: 3 });
    const w: SimWorld = { cells, area: [0, 0, 2, 2], ground: 0,
      seats: [{ typeId: 'craftmatic:a_seat', at: { x: 1, y: 0.6, z: 1 } }],
      figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 0.5, y: 3 + 3 / 16, z: 0.5 } }] };
    const tuning = { ...FIGURE_TUNING, seatChance: 1 };
    const [t] = simulateFigureLife(w, { ...config, tuning }, 3000, 13);
    expect(t!.filter(p => p.riding)).toHaveLength(0);
    expect(Math.min(...t!.map(p => p.y))).toBeGreaterThan(3);
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

  it('gives a source-seated figure\'s seat to a player who comes to it, and takes it back after the player leaves', () => {
    const w: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: 0,
      seats: [{ typeId: 'craftmatic:a_seat', at: { x: 2.5, y: 0.6, z: 2.5 } }],
      figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 2.5, y: 0.6, z: 2.5 }, mode: 'seated' }],
      // The player stands beside the chair for 600 ticks, then walks away.
      player: { x: 3.5, y: 3 / 16, z: 2.5 }, playerLeavesAt: 600 };
    const [t] = simulateFigureLife(w, config, 1200, 5);
    // Up within a tick of the player arriving, and off the seat while the player is there.
    expect(t!.slice(2, 600).every(p => !p.riding)).toBe(true);
    // Back on its seat within the 100-tick retry once the player has gone.
    expect(t!.slice(720).every(p => p.riding)).toBe(true);
  });

  it('tells the content log of a missing seat on the second retake check in a row, not while a placement is still spawning its seats', () => {
    // A seated figure is adopted the tick it spawns; a large placement (10261, ~2 min) spawns its
    // seats later. Both phones logged FIGURE_RETAKE_NO_SEAT for 10261's kiosk figure at that first
    // check, before its seat existed, and the figure sat on it afterwards (Saga round 2026-09-29c).
    const tuning = { ...FIGURE_TUNING, idleMin: 20, idleMax: 30 }; // the first check at tick 21..31, the second 100 later
    const late: string[] = [];
    const seatComes: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: 0,
      seats: [{ typeId: 'craftmatic:a_seat', at: { x: 2.5, y: 0.6, z: 2.5 }, spawnAt: 60 }],
      figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 2.5, y: 0.6, z: 2.5 }, mode: 'seated' }],
      onWarn: l => late.push(l) };
    const [t] = simulateFigureLife(seatComes, { ...config, tuning }, 400, 5);
    expect(late.filter(l => l.includes('FIGURE_RETAKE'))).toEqual([]);
    // Seated on it by the second check.
    expect(t!.slice(200).every(p => p.riding)).toBe(true);
    // No seat ever: the line once, on the second miss (two checks, 10 s), never on the first.
    const never: string[] = [];
    simulateFigureLife({ ...seatComes, seats: [], onWarn: l => never.push(l) }, { ...config, tuning }, 400, 5);
    expect(never.filter(l => l.includes('FIGURE_RETAKE_NO_SEAT'))).toHaveLength(1);
    expect(never[0]).toMatch(/FIGURE_RETAKE_NO_SEAT craftmatic:a_fig1 near 3,1,3 \(2 checks, 10 s\)/);
    const early: string[] = [];
    simulateFigureLife({ ...seatComes, seats: [], onWarn: l => early.push(l) }, { ...config, tuning }, 100, 5);
    expect(early).toEqual([]);
  });

  it('says nothing while the placement is still seating the figure, however long its seat takes to spawn (10261, ~2 min)', () => {
    // 10261's placement spawns its actors over ~2 minutes, the kiosk figure long before its seat:
    // both phones logged FIGURE_RETAKE_NO_SEAT ~2 min into every placement (Saga round 2026-09-29c).
    // The seat comes at tick 2400 (2 min); the placement's seating mark is on the figure until then.
    const late: string[] = [];
    const slow: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: 0,
      seats: [{ typeId: 'craftmatic:a_seat', at: { x: 2.5, y: 0.6, z: 2.5 }, spawnAt: 2400 }],
      figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 2.5, y: 0.6, z: 2.5 }, mode: 'seated', seatingUntil: 2400 }],
      onWarn: l => late.push(l) };
    const [t] = simulateFigureLife(slow, config, 2800, 5);
    expect(late.filter(l => l.includes('FIGURE_RETAKE'))).toEqual([]);
    // Once the mark goes the retake runs and seats it (the placement's own pass would have first, on the device).
    expect(t!.slice(2600).every(p => p.riding)).toBe(true);
    // Without the mark (a pack built before it) two misses in a row are not enough grace for a 2-minute placement.
    const unmarked: string[] = [];
    simulateFigureLife({ ...slow, figures: [{ ...slow.figures[0]!, seatingUntil: undefined }], onWarn: l => unmarked.push(l) }, config, 2800, 5);
    expect(unmarked.filter(l => l.includes('FIGURE_RETAKE_NO_SEAT'))).toHaveLength(1);
  });

  it('spells the seating mark and its grace as the constants say, in both serialised runtimes', () => {
    const js = figureLifeScript({ ...config, interactiveFamily: 'craftmatic_interactive' });
    const quoted = new RegExp(`["']${FIGURE_SEATING_PROPERTY}["']`);
    expect(js).toMatch(quoted);
    // The transpiler may spell the number differently (6e5): compare values.
    expect(Number(/SEATING_GRACE_MS = ([^,;\s]+)/.exec(js)?.[1])).toBe(FIGURE_SEATING_GRACE_MS);
    const tile = { identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 4, height: 2, length: 2, nonAir: 4 };
    const h = host({ stem: 'marks', label: 'Marks', width: 4, height: 2, length: 2, tiles: [tile], actors: [], settleTicks: 1, finalHoldTicks: 1 });
    expect(h.assets.script).toMatch(quoted);
  });

  it('the placement marks a source-seated figure until its seating pass is done with it', async () => {
    // The figure spawns BEFORE its seat (10261's order); the host's seat is not rideable, so the
    // pass retries and gives up - the mark must go either way.
    const tile = { identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 4, height: 2, length: 2, nonAir: 4 };
    const h = host({ stem: 'seated', label: 'Seated', width: 4, height: 2, length: 2, tiles: [tile],
      actors: [
        { typeId: 'craftmatic:seated_fig1', label: 'Figure 1', x: 1, y: 1, z: 1, rideOf: 1 },
        { typeId: 'craftmatic:seated_seat', label: 'Seat', x: 1, y: 0.5, z: 1 },
        { typeId: 'craftmatic:seated_fig2', label: 'Figure 2', x: 2, y: 1, z: 1 },
      ],
      settleTicks: 1, finalHoldTicks: 1 });
    const dim = h.world.getDimension('overworld') as { spawnEntity: (t: string, at: unknown) => unknown };
    const spawn = dim.spawnEntity;
    let markWhileSeatSpawns: unknown = 'unset';
    dim.spawnEntity = (t: string, at: unknown) => {
      if (t === 'craftmatic:seated_seat') markWhileSeatSpawns = h.spawned.find(s => s.typeId === 'craftmatic:seated_fig1')!.entity.getDynamicProperty(FIGURE_SEATING_PROPERTY);
      return spawn(t, at);
    };
    await h.open({ action: 'Pin corner at my feet' }, { canceled: true });
    await h.open({ action: 'Place' }, { selection: 0 });
    await h.flush(2000);
    expect(typeof markWhileSeatSpawns).toBe('number');
    const fig1 = h.spawned.find(s => s.typeId === 'craftmatic:seated_fig1')!.entity;
    const fig2 = h.spawned.find(s => s.typeId === 'craftmatic:seated_fig2')!.entity;
    expect(fig1.getDynamicProperty(FIGURE_SEATING_PROPERTY)).toBeUndefined();
    // A roaming figure is never marked.
    expect(fig2.getDynamicProperty(FIGURE_SEATING_PROPERTY)).toBeUndefined();
    expect(JSON.parse(String(fig1.getDynamicProperty('craftmatic:fig'))).mode).toBe('seated');
  });

  it('retakes a seat whose entity sits 2 blocks under the figure\'s home (10261\'s kiosk, round 2026-09-29b)', () => {
    const w: SimWorld = { cells: room(), area: [0, 0, 9, 7], ground: 0,
      seats: [{ typeId: 'craftmatic:a_seat', at: { x: 2.5, y: 0.6, z: 2.5 } }],
      figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 2.5, y: 2.6, z: 2.5 }, mode: 'seated' }],
      player: { x: 3.5, y: 3 / 16, z: 2.5 }, playerLeavesAt: 600 };
    const [t] = simulateFigureLife(w, config, 1200, 5);
    expect(t!.slice(720).every(p => p.riding)).toBe(true);
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

  it('re-homes a figure whose spawn point had nothing under it where it landed, and lets it roam there', () => {
    // Spawned 2 blocks up over open ground (a display stand the collider grid does not carry).
    const w: SimWorld = { cells: [], area: [0, 0, 10, 10], ground: 0, figures: [{ typeId: 'craftmatic:a_fig1', at: { x: 5.5, y: 2.1, z: 5.5 } }] };
    const [t] = simulateFigureLife(w, config, 2400, 6);
    const after = t!.slice(40);
    expect(Math.max(...after.map(p => p.y))).toBeLessThan(0.01); // never put back up in the air
    let path = 0;
    for (let i = 1; i < after.length; i++) path += Math.hypot(after[i]!.x - after[i - 1]!.x, after[i]!.z - after[i - 1]!.z);
    expect(path).toBeGreaterThan(4);
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

describe('figures recorded on one spot (separateFigureSpawns, at export)', () => {
  const opts = { maxUp: FIGURE_TUNING.maxUp, maxDown: FIGURE_TUNING.maxDown };
  const inside = (w: number, l: number) => (x: number, z: number): boolean => x >= 0 && z >= 0 && x < w && z < l;
  it('moves the later of two coincident figures to the nearest free standable column and leaves the others alone', () => {
    const span = spansOf(room(), 0);
    const figs = [{ x: 3.5, y: 3 / 16, z: 3.5, body: 1.8 }, { x: 5.5, y: 3 / 16, z: 3.5, body: 1.8 }, { x: 3.5, y: 3 / 16, z: 3.5, body: 1.8 }];
    const r = separateFigureSpawns(span, figs, inside(9, 7), opts);
    expect(r.moved).toEqual([2]);
    expect(r.at[0]).toEqual({ x: 3.5, y: 3 / 16, z: 3.5 });
    expect(r.at[1]).toEqual({ x: 5.5, y: 3 / 16, z: 3.5 });
    const p = r.at[2]!;
    expect(Math.hypot(p.x - 3.5, p.z - 3.5)).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(3 / 16);
  });
  it('leaves figures a body apart, or one floor above another, where they are', () => {
    const span = spansOf(room(), 0);
    const figs = [{ x: 3.5, y: 3 / 16, z: 3.5, body: 1.8 }, { x: 4.2, y: 3 / 16, z: 3.5, body: 1.8 }, { x: 3.5, y: 4, z: 3.5, body: 1.8 }];
    expect(separateFigureSpawns(span, figs, inside(9, 7), opts).moved).toEqual([]);
  });
});
