/**
 * The per-size carve (engine/collider-carve.ts, SCALE-06): every block the scaled 100 % grid lays at a whole
 * size is cut to the drawn geometry inside it, never adding a collider.
 */
import { describe, expect, it } from 'vitest';
import { carvesAt, decodeSizeCarve, encodeSizeCarve, encodeTurnedCarve, planSizeCarve, sizeCarveAt, turnModelBox, type ModelBox, type ShippedCarves } from '../web/src/engine/collider-carve.js';
import { COLLIDER_KIT } from '../web/src/engine/collider-form.js';
import { QUARTER_TURNS, ScaledColliderGrid, rotatedCell, type SourceCell } from '../web/src/engine/bedrock-collider-scale.js';

/** The world-block boxes (blocks from the pin) a form occupies at block (x, y, z). */
const worldBoxes = (x: number, y: number, z: number, form: { v: number; lo: number; hi: number }): number[][] =>
  COLLIDER_KIT.formBoxes(form.v, form.lo, form.hi).map(b => [x + b[0] / 16, x + b[1] / 16, y + b[2] / 16, y + b[3] / 16, z + b[4] / 16, z + b[5] / 16]);

describe('collider carve (SCALE-06)', () => {
  // A doorway 0.6 wide between two jambs 0.2 thick, all inside one 100 % cell (2, 0..1, 2): the 1-block grid
  // holds it as two full cells, a wall at every size.
  const dims = { width: 5, height: 3, length: 5 };
  const cells: SourceCell[] = [{ x: 2, y: 0, z: 2, lo: 0, hi: 16 }, { x: 2, y: 1, z: 2, lo: 0, hi: 16 }];
  const jambs: ModelBox[] = [[2.0, 2.2, 0, 2, 2, 3], [2.8, 3.0, 0, 2, 2, 3]];

  it('opens a doorway that is sub-player at 100 % once the size makes it wider than a player (200 %)', () => {
    const carve = planSizeCarve(cells, dims, 200, 0, jambs);
    // The cell lays world x 4..5, y 0..3, z 4..5; every block under the column's top is cut to its jamb. The top
    // block (y 3) is a standing surface - the wall's top - and keeps its whole footprint, so the opening is the
    // three blocks under it, room for the player's 1.8.
    for (let x = 4; x <= 5; x++) for (let y = 0; y <= 2; y++) for (let z = 4; z <= 5; z++) expect(carve.has(`${x},${y},${z}`), `${x},${y},${z}`).toBe(true);
    for (let x = 4; x <= 5; x++) for (let z = 4; z <= 5; z++) {
      const top = carve.get(`${x},3,${z}`);
      expect(top === undefined || (top !== null && top.v === 0), `top ${x},${z} keeps its footprint`).toBe(true);
    }
    // The jambs end at world x 4.4 and start at 5.6; the kit's least forms round each out to half a block, so
    // x 4.5..5.5 is left clear - a gap of a block, wider than the player's 0.6.
    for (const [key, form] of carve) {
      if (!form) continue;
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      if (y === 3) continue;
      for (const b of worldBoxes(x, y, z, form)) expect(b[1]! <= 4.5 + 1e-9 || b[0]! >= 5.5 - 1e-9, `${key} ${b.join(',')}`).toBe(true);
    }
  });

  it('never adds a collider: every carved form lies inside the form the scaled grid lays there', () => {
    for (const pct of [200, 300, 400]) for (const r of QUARTER_TURNS) {
      const carve = planSizeCarve(cells, dims, pct, r, jambs);
      const laid = new Map<string, number[][]>();
      for (const c of cells) {
        const at = new Map<string, number[][]>();
        COLLIDER_KIT.cellPieces(c.x, c.y, c.z, 0, c.lo, c.hi, dims, pct / 100, r, (x, y, z, b) => {
          const k = `${x},${y},${z}`;
          (at.get(k) ?? at.set(k, []).get(k)!).push([x + b[0] / 16, x + b[1] / 16, y + b[2] / 16, y + b[3] / 16, z + b[4] / 16, z + b[5] / 16]);
        });
        for (const [k, v] of at) laid.set(k, [...(laid.get(k) ?? []), ...v]);
      }
      for (const [key, form] of carve) {
        const own = laid.get(key);
        expect(own, `${pct} % / ${r}°: carve only where a block is laid (${key})`).toBeDefined();
        if (!form) continue;
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        for (const b of worldBoxes(x, y, z, form)) {
          const inside = own!.some(o => b[0]! >= o[0]! - 1e-9 && b[1]! <= o[1]! + 1e-9 && b[2]! >= o[2]! - 1e-9 && b[3]! <= o[3]! + 1e-9 && b[4]! >= o[4]! - 1e-9 && b[5]! <= o[5]! + 1e-9);
          expect(inside, `${pct} % / ${r}°: ${key} ${b.join(',')}`).toBe(true);
        }
      }
    }
  });

  it('makes a laid block with no drawn geometry in it air, and leaves one the geometry fills alone', () => {
    // The lower cell is a solid brick; the upper one holds nothing drawn.
    const brick: ModelBox[] = [[2, 3, 0, 1, 2, 3]];
    const carve = planSizeCarve(cells, dims, 200, 0, brick);
    for (let x = 4; x <= 5; x++) for (let z = 4; z <= 5; z++) {
      for (const y of [0, 1]) expect(carve.has(`${x},${y},${z}`), `filled ${x},${y},${z}`).toBe(false);
      for (const y of [2, 3]) expect(carve.get(`${x},${y},${z}`), `empty ${x},${y},${z}`).toBeNull();
    }
  });

  it('keeps a standing surface whole: a floor or roof edge is cut only vertically, so no planner misses an opening in it (21061 at 300 %)', () => {
    // A floor plate 0.25 thick drawn over half of a full 100 % cell: at 200 % its top blocks are standing
    // surfaces, so they keep their whole footprint (a band would leave a gap the grid planners read as floor).
    const floor: SourceCell[] = [{ x: 2, y: 0, z: 2, lo: 0, hi: 16 }];
    const half: ModelBox[] = [[2, 2.5, 0.75, 1, 2, 3]];
    const carve = planSizeCarve(floor, dims, 200, 0, half);
    for (let x = 4; x <= 5; x++) for (let z = 4; z <= 5; z++) {
      const top = carve.get(`${x},1,${z}`);
      if (x === 4) expect(top, `drawn half ${x},${z}`).toEqual({ v: 0, lo: 8, hi: 16 });
      else expect(top, `undrawn half ${x},${z}: nothing drawn, air`).toBeNull();
      expect(carve.get(`${x},0,${z}`), `under the plate ${x},${z}`).toBeNull();
    }
  });

  it('gives a cut band its whole footprint back where its top has headroom once carved: no floor a player falls through (21061 at 300 %)', () => {
    // A wall 0.25 thick at the cell's low-z side, two cells high, with nothing over it: carved, its upper blocks
    // are bands, and the top band's top is a standing surface of the carved grid.
    const wall: SourceCell[] = [{ x: 2, y: 0, z: 2, lo: 0, hi: 16 }, { x: 2, y: 1, z: 2, lo: 0, hi: 16 }, { x: 2, y: 2, z: 2, lo: 0, hi: 16 }];
    const band: ModelBox[] = [[2, 3, 0, 2, 2, 2.25]];
    const carve = planSizeCarve(wall, dims, 200, 0, band);
    expect([...carve.values()].some(form => form && form.v !== 0), 'the wall is cut to bands under its top').toBe(true);
    const g = new ScaledColliderGrid(wall, dims, 2, 0, carve);
    for (const [key, form] of carve) {
      if (!form || form.v === 0) continue;
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      const blk = g.blockAt(x, z, y)!;
      expect(g.surfaces(x, z).includes(y * 16 + blk.hi), `band ${key} is no floor`).toBe(false);
    }
    // The wall's top (world row 5 at z 4) keeps its whole footprint; the undrawn half (z 5) is air.
    for (let x = 4; x <= 5; x++) {
      expect(carve.get(`${x},5,4`)?.v ?? 0, `top ${x}`).toBe(0);
      expect(carve.get(`${x},5,5`), `undrawn ${x}`).toBeNull();
    }
  });

  it('caps a shaft: the highest cut band under a block that does not cover the footprint takes the whole footprint (21061 at 300 %)', () => {
    // A wall cell two high whose top cell is a clearance form (a band at 100 %), over a full cell the carve cuts
    // to a band: without the rule the band under the form is a shaft from the form's open part to the ground.
    const W = COLLIDER_KIT.VARIANTS.findIndex(v => v.kind === 0 && v.shape !== 0);
    const top = COLLIDER_KIT.formBoxes(W, 0, 16);
    const stack: SourceCell[] = [{ x: 2, y: 0, z: 2, lo: 0, hi: 16 }, { x: 2, y: 1, z: 2, lo: 0, hi: 16, v: W }];
    const drawn: ModelBox[] = [[2 + top[0]![0] / 16, 2 + top[0]![1] / 16, 0, 2, 2 + top[0]![4] / 16, 2 + top[0]![5] / 16]];
    const carve = planSizeCarve(stack, dims, 200, 0, drawn);
    const g = new ScaledColliderGrid(stack, dims, 2, 0, carve);
    // Down every column the cell lays: under the form's rows (2, 3), the first carved block is whole or air.
    for (let x = 4; x <= 5; x++) for (let z = 4; z <= 5; z++) {
      const below = [1, 0].map(y => g.blockAt(x, z, y)).filter(Boolean);
      if (!below.length) continue;
      expect(below[0]!.form, `${x},${z}: the block under the form covers the footprint`).toBeUndefined();
    }
  });

  it('leaves a cell invisible on purpose (an access stair, a filled sill: nothing drawn there) exactly as laid', () => {
    // A tread a row up (on the bottom row it would be a ground plate, which no carve touches).
    const stair: SourceCell[] = [{ x: 1, y: 1, z: 1, lo: 0, hi: 8 }, ...cells];
    const carve = planSizeCarve(stair, dims, 200, 0, jambs, new Set(['1,1,1']));
    for (let x = 2; x <= 3; x++) for (let z = 2; z <= 3; z++) expect(carve.has(`${x},2,${z}`), `stair ${x},${z}`).toBe(false);
    // Unprotected, the same stair would be carved away (it holds no drawn geometry).
    expect(planSizeCarve(stair, dims, 200, 0, jambs).get('2,2,2')).toBeNull();
    // The doorway cell is still carved.
    expect(carve.has('4,0,4')).toBe(true);
  });

  it('leaves a ground plate as laid, drawn or not: nothing falls under it, and trimming it re-planned the treads across 21063\'s east plate strip (300 %)', () => {
    // A plate cell (5/16 high) whose drawn plate covers only its first third: at 300 % the laid plate spans three
    // columns, the outer two over nothing drawn.
    const plate: SourceCell[] = [{ x: 0, y: 0, z: 0, lo: 0, hi: 5 }];
    const drawn: ModelBox[] = [[0, 1 / 3, 0, 5 / 16, 0, 1]];
    const carve = planSizeCarve(plate, { width: 1, height: 1, length: 1 }, 300, 0, drawn);
    expect(carve.size).toBe(0);
    // Lifted one 100 % row, the same plate is carved to its drawn third.
    const raised = planSizeCarve([{ x: 0, y: 1, z: 0, lo: 0, hi: 5 }], { width: 1, height: 2, length: 1 }, 300, 0, [[0, 1 / 3, 1, 1 + 5 / 16, 0, 1]]);
    expect(raised.get('2,3,0')).toBeNull();
  });

  it('carves whole sizes only: nothing at 150 % (a re-laid wall can sit half a block off its geometry) or below 100 %', () => {
    expect(carvesAt(150)).toBe(false);
    expect(planSizeCarve(cells, dims, 150, 0, jambs).size).toBe(0);
    expect(planSizeCarve(cells, dims, 50, 0, jambs).size).toBe(0);
    expect(planSizeCarve(cells, dims, 100, 0, jambs).size).toBe(0);
  });

  it('ships a carve at 300 and 400 % but not at 200 %, where it lost every device route of the microscale sets (2026-10-16)', () => {
    expect(carvesAt(200)).toBe(false);
    expect(carvesAt(300)).toBe(true);
    expect(carvesAt(400)).toBe(true);
  });

  it('turns a model box the way the wand turns a cell', () => {
    const d = { width: 4, height: 1, length: 6 };
    for (const r of QUARTER_TURNS) for (let x = 0; x < d.width; x++) for (let z = 0; z < d.length; z++) {
      const t = turnModelBox([x, x + 1, 0, 1, z, z + 1], d, r), c = rotatedCell(x, z, d, r);
      expect([t[0], t[4]], `${r}° cell ${x},${z}`).toEqual([c.x, c.z]);
      expect([t[1] - t[0], t[5] - t[4]]).toEqual([1, 1]);
    }
  });

  it('encodes and decodes a carve losslessly, air included', () => {
    const carve = planSizeCarve(cells, dims, 300, 90, jambs);
    carve.set('0,0,0', null);
    const back = decodeSizeCarve(encodeSizeCarve(carve));
    expect(back.size).toBe(carve.size);
    for (const [k, v] of carve) expect(back.get(k), k).toEqual(v);
  });

  it('ships turn 0 whole and every other turn as its edits against turn 0 turned, and reads back each turn exactly', () => {
    // Not square, and not symmetric: a corner post a fifth of a block square (its least form is a tie between an
    // x band and a z band, which the kit breaks by index, so a turned turn 0 is NOT always the turn's own carve),
    // the doorway's jambs, and a wall along x.
    const d = { width: 6, height: 3, length: 4 };
    const laid: SourceCell[] = [
      { x: 1, y: 0, z: 1, lo: 0, hi: 16 }, { x: 1, y: 1, z: 1, lo: 0, hi: 16 },
      { x: 3, y: 0, z: 2, lo: 0, hi: 16 }, { x: 3, y: 1, z: 2, lo: 0, hi: 16 },
      { x: 4, y: 0, z: 0, lo: 0, hi: 16 }, { x: 5, y: 0, z: 0, lo: 0, hi: 16 },
    ];
    const drawn: ModelBox[] = [[1.0, 1.2, 0, 2, 1.0, 1.2], [3.0, 3.2, 0, 2, 2, 3], [3.8, 4.0, 0, 2, 2, 3], [4, 6, 0, 0.7, 0.1, 0.4]];
    for (const pct of [300, 400]) {
      const planned = new Map(QUARTER_TURNS.map(r => [r, planSizeCarve(laid, d, pct, r, drawn)] as const));
      const base = planned.get(0)!;
      expect(base.size).toBeGreaterThan(0);
      const shipped: ShippedCarves = { plans: { [`${pct}:0`]: encodeSizeCarve(base) }, turned: {}, counts: {} };
      for (const r of [90, 180, 270] as const) shipped.turned![`${pct}:${r}`] = encodeTurnedCarve(base, planned.get(r)!, pct, r, d);
      for (const r of QUARTER_TURNS) {
        const back = sizeCarveAt(shipped, pct, r, d, COLLIDER_KIT.turnForm)!, want = planned.get(r)!;
        expect(back.size, `${pct} % ${r}`).toBe(want.size);
        for (const [k, v] of want) expect(back.get(k), `${pct} % ${r}: ${k}`).toEqual(v);
      }
      const whole = [90, 180, 270].reduce((n, r) => n + encodeSizeCarve(planned.get(r as 90)!).length, 0);
      const edits = [90, 180, 270].reduce((n, r) => n + shipped.turned![`${pct}:${r}`]!.length, 0);
      expect(edits, `${pct} %: the turns ship smaller than whole`).toBeLessThan(whole / 4);
    }
    // A size the pack does not carve reads as none.
    expect(sizeCarveAt({ plans: {}, counts: {} }, 300, 90, d, COLLIDER_KIT.turnForm)).toBeUndefined();
  });

  it('reads a pack built before turned carves (every turn whole) as it shipped', () => {
    const carve = planSizeCarve(cells, dims, 300, 90, jambs);
    const back = sizeCarveAt({ plans: { '300:90': encodeSizeCarve(carve) }, counts: {} }, 300, 90, dims, COLLIDER_KIT.turnForm)!;
    expect(back.size).toBe(carve.size);
    for (const [k, v] of carve) expect(back.get(k), k).toEqual(v);
  });
});
