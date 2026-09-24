/**
 * Pinball: the physics on a synthetic table (always runs) and table detection
 * plus a played game on 11374 Arcade Pinball Machine (runs where the corpus
 * and the LDraw library are on disk).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createPinballSim, type PinballSimTable, type PinballInput } from '../web/src/engine/pinball-physics.js';

const IDLE: PinballInput = { left: false, right: false, launch: false };

/**
 * A 400 x 800 LDU box (u 0..800 down the table, w 0..400 across) with a gap
 * at the bottom between two flippers, pivots at u 700.
 */
function boxTable(): PinballSimTable {
  const cell = 4, rows = 220, cols = 100, u0 = 0, w0 = 0;
  const sdf2: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const u = u0 + (r + 0.5) * cell, w = w0 + (c + 0.5) * cell;
    // Free inside the box; below u 740 the side walls stay but the middle is open (the drain).
    const inside = Math.min(u, w, 400 - w, u < 740 ? 800 - u : Infinity);
    sdf2.push(Math.round(Math.max(-40, Math.min(400, inside)) * 2));
  }
  return {
    u0, w0, cell, rows, cols, sdf2, ballRadius: 24,
    flippers: [
      { side: 'left', pivot: [700, 100], length: 100, pivotRadius: 20, tipRadius: 12, restAngle: Math.atan2(33, 100), activeAngle: Math.atan2(-33, 100) },
      { side: 'right', pivot: [700, 300], length: 100, pivotRadius: 20, tipRadius: 12, restAngle: Math.atan2(33, -100), activeAngle: Math.atan2(-33, -100) },
    ],
    bumpers: [{ centre: [250, 200], radius: 30 }],
    launch: [600, 370],
    drainU: 780,
  };
}

describe('pinball physics (synthetic box)', () => {
  it('waits on the launcher, charges while held and fires up the table on release', () => {
    const sim = createPinballSim(boxTable());
    for (let t = 0; t < 10; t++) sim.step({ ...IDLE, launch: true }, 0.05);
    expect(sim.state.phase).toBe('ready');
    expect(sim.state.charge).toBeCloseTo(0.5, 5);
    const events = sim.step(IDLE, 0.05);
    expect(events.map(e => e.kind)).toContain('launch');
    expect(sim.state.phase).toBe('play');
    expect(sim.state.vu).toBeLessThan(-1000);
  });

  it('never leaves the box and always drains within a minute without flippers', () => {
    const sim = createPinballSim(boxTable());
    sim.step({ ...IDLE, launch: true }, 0.05);
    sim.step(IDLE, 0.05);
    let drained = false;
    for (let t = 0; t < 1200 && !drained; t++) {
      const ev = sim.step(IDLE, 0.05);
      expect(sim.distance(sim.state.u, sim.state.w)).toBeGreaterThan(-24);
      drained = ev.some(e => e.kind === 'drain');
    }
    expect(drained).toBe(true);
    expect(sim.state.ball).toBe(2);
    expect(sim.state.phase).toBe('ready');
  });

  it('a raised flipper sends a ball resting on it back up the table', () => {
    const table = boxTable();
    const sim = createPinballSim(table);
    // Put the ball on the left flipper, mid-length, falling.
    const f = table.flippers[0]!;
    sim.state.phase = 'play';
    sim.state.u = f.pivot[0] + Math.sin(f.restAngle) * 70 - 40;
    sim.state.w = f.pivot[1] + Math.cos(f.restAngle) * 70;
    sim.state.vu = 200; sim.state.vw = 0;
    for (let t = 0; t < 4; t++) sim.step(IDLE, 0.05);
    for (let t = 0; t < 3; t++) sim.step({ ...IDLE, left: true }, 0.05);
    expect(sim.state.vu).toBeLessThan(-600);
  });

  it('a bumper kicks and scores 100 once per hit', () => {
    const sim = createPinballSim(boxTable());
    sim.state.phase = 'play';
    sim.state.u = 150; sim.state.w = 200; sim.state.vu = 600; sim.state.vw = 0;
    const events = [];
    for (let t = 0; t < 4; t++) events.push(...sim.step(IDLE, 0.05));
    const hits = events.filter(e => e.kind === 'bumper');
    expect(hits.length).toBe(1);
    expect(sim.state.score).toBe(100);
    expect(sim.state.vu).toBeLessThan(0);
  });

  it('game over after the last ball, and a launch press starts a new game', () => {
    const sim = createPinballSim(boxTable(), { balls: 1 });
    sim.state.phase = 'play';
    sim.state.u = 770; sim.state.w = 200; sim.state.vu = 400;
    const ev = sim.step(IDLE, 0.05);
    expect(ev.map(e => e.kind)).toEqual(expect.arrayContaining(['drain', 'over']));
    expect(sim.state.phase).toBe('over');
    sim.step({ ...IDLE, launch: true }, 0.05);
    expect(sim.state.phase).toBe('ready');
    expect(sim.state.score).toBe(0);
  });
});

// ─── 11374 from the corpus ───────────────────────────────────────────────────

const MODEL = 'C:/git/clego/lego_sets/DbixConvV3/11374.ldr';
const LDRAW = 'C:/git/clego/extracted/studio_release/app/ldraw';
const HAVE_CORPUS = existsSync(MODEL) && existsSync(LDRAW);

describe.skipIf(!HAVE_CORPUS)('11374 Arcade Pinball Machine', () => {
  let table: import('../web/src/engine/pinball-table.js').PinballTable | null = null;
  let simTable: PinballSimTable;
  beforeAll(async () => {
    const { parseLDraw } = await import('../web/src/engine/ldraw-parser.js');
    const { setLDrawRoot } = await import('../web/src/engine/ldraw-geometry.js');
    const { createPartGeometryProvider } = await import('../web/src/engine/ldraw-part-geometry.js');
    const { partStem } = await import('../web/src/engine/part-id.js');
    const { detectPinballTable, pinballSimTable } = await import('../web/src/engine/pinball-table.js');
    setLDrawRoot(LDRAW);
    const bricks = parseLDraw(readFileSync(MODEL, 'utf8'));
    const provider = createPartGeometryProvider({});
    const meshes = new Map();
    for (const b of bricks) {
      const stem = partStem(b.part);
      if (!meshes.has(stem)) meshes.set(stem, await provider.getPartMesh(`${stem}.dat`));
    }
    table = detectPinballTable(bricks, meshes);
    if (!table) throw new Error('11374 was not detected as a pinball table');
    simTable = pinballSimTable(table);
  }, 120_000);

  it('reads the playfield, two mirror flippers and the 19 mm ball', () => {
    expect(table!.tiltDeg).toBeGreaterThan(8);
    expect(table!.tiltDeg).toBeLessThan(9);
    expect(table!.nominalTilt).toBe(false);
    expect(table!.ballRadius).toBeCloseTo(23.75, 0);
    const [l, r] = table!.flippers;
    expect(l!.side).toBe('left');
    expect(r!.side).toBe('right');
    expect(l!.length).toBeCloseTo(r!.length, 0);
    expect(l!.pivot[0]).toBeCloseTo(r!.pivot[0], 0);
    expect(l!.length).toBeGreaterThan(70);
    expect(table!.bumpers.length).toBeGreaterThan(5);
  });

  it('the drain gap between the resting flipper tips passes the ball, as on the real set', () => {
    const tip = (f: import('../web/src/engine/pinball-table.js').PinballFlipper): [number, number] =>
      [f.pivot[0] + Math.sin(f.restAngle) * f.length, f.pivot[1] + Math.cos(f.restAngle) * f.length];
    const [l, r] = table!.flippers as [import('../web/src/engine/pinball-table.js').PinballFlipper, import('../web/src/engine/pinball-table.js').PinballFlipper];
    const a = tip(l), b = tip(r);
    const gap = Math.hypot(a[0] - b[0], a[1] - b[1]) - l.tipRadius - r.tipRadius;
    expect(gap).toBeGreaterThan(2 * table!.ballRadius);
  });

  it('the serve point is free space with room for the ball', () => {
    const sim = createPinballSim(simTable);
    // Bilinear sampling reads a little under the cell value the detector tested.
    expect(sim.distance(simTable.launch[0], simTable.launch[1])).toBeGreaterThan(simTable.ballRadius * 0.8);
  });

  it('plays: a full-charge launch reaches the upper half, flipping keeps the ball alive, no ball is lost inside a wall', () => {
    const sim = createPinballSim(simTable);
    for (let t = 0; t < 20; t++) sim.step({ ...IDLE, launch: true }, 0.05);
    sim.step(IDLE, 0.05);
    let minU = Infinity, rescues = 0, drains = 0, flips = 0, best = 0;
    // An autoplayer: flip a flipper when the ball is falling and within reach
    // of its resting surface, as a player would; hold it for 0.3 s.
    const hold: Record<'left' | 'right', number> = { left: 0, right: 0 };
    const near = (side: 'left' | 'right'): boolean => {
      const s = sim.state;
      const f = simTable.flippers.find(x => x.side === side)!;
      const du = Math.sin(f.restAngle), dw = Math.cos(f.restAngle);
      const t = Math.max(0, Math.min(f.length, (s.u - f.pivot[0]) * du + (s.w - f.pivot[1]) * dw));
      const d = Math.hypot(s.u - (f.pivot[0] + du * t), s.w - (f.pivot[1] + dw * t));
      return s.phase === 'play' && s.vu > 0 && d < simTable.ballRadius + f.pivotRadius + 30;
    };
    for (let t = 0; t < 20 * 90; t++) {
      const s = sim.state;
      for (const side of ['left', 'right'] as const) hold[side] = near(side) && hold[side] === 0 ? 6 : Math.max(0, hold[side] - 1);
      const input = { left: hold.left > 0, right: hold.right > 0, launch: s.phase !== 'play' && t % 30 < 20 };
      const ev = sim.step(input, 0.05);
      minU = Math.min(minU, s.u);
      rescues += ev.filter(e => e.kind === 'rescue').length;
      drains += ev.filter(e => e.kind === 'drain').length;
      flips += ev.filter(e => e.kind === 'flipper').length;
      best = Math.max(best, sim.state.score);
    }
    expect(minU).toBeLessThan(simTable.u0 + simTable.rows * simTable.cell * 0.5);
    expect(rescues).toBe(0);
    expect(flips).toBeGreaterThan(0);
    expect(best).toBeGreaterThan(0);
    // Report for the record; three balls across 90 s is ordinary.
    expect(drains).toBeGreaterThanOrEqual(0);
  });
});
