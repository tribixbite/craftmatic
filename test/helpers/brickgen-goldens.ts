/**
 * Hand-built reference plans for the lattice verifier (X-09) and, later, the
 * bricker (X-10): small buildings made the way a builder would, with running
 * bond, so a verifier run on them SHOULD come back clean.
 *
 * Also the offline part source (the vendored official parts under
 * `test/fixtures/ldraw-vocab`) and the real compile used to measure the budget.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrickPlan, PlacedElement } from '../../web/src/brickgen/types.js';
import type { PartSource } from '../../web/src/brickgen/vocab/occupancy.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/ldraw-vocab');

/** Vendored official parts: `parts/` then `p/` (subfiles are `s/..`, `48/..`), like the LDraw library. */
export const fixtureSource: PartSource = name => {
  for (const dir of ['parts', 'p']) {
    const f = path.join(FIXTURES, dir, name);
    if (existsSync(f)) return readFileSync(f, 'utf8');
  }
  return undefined;
};

const SCALE = { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'golden' };
type At = [number, number, number];

const el = (part: string, at: At, turn: 0 | 1 | 2 | 3 = 0, colour = 4, group = 'walls'): PlacedElement => ({ part, colour, at, turn, group });

/** Brick lengths available as 1xN bricks, longest first. */
const BRICK_BY_LENGTH: ReadonlyArray<readonly [number, string]> = [[4, '3010.dat'], [3, '3622.dat'], [2, '3004.dat'], [1, '3005.dat']];

/**
 * Tile a set of wall cells (one layer) with 1xN bricks along x or z. `phase`
 * shifts where the first brick of every run ends, so consecutive layers get
 * different seams (running bond).
 */
function layerBricks(cells: ReadonlySet<string>, plate: number, phase: number, colour: number, group: string): PlacedElement[] {
  const out: PlacedElement[] = [];
  const has = (x: number, z: number): boolean => cells.has(`${x},${z}`);
  const taken = new Set<string>();
  const key = (x: number, z: number): string => `${x},${z}`;
  const coords = [...cells].map(k => k.split(',').map(Number) as [number, number]);
  // Runs along x first; a cell with no x-neighbour runs along z.
  const lay = (x: number, z: number, dx: number, dz: number): void => {
    let len = 0;
    while (has(x + dx * len, z + dz * len) && !taken.has(key(x + dx * len, z + dz * len))) len++;
    let used = 0;
    // The first brick of the run is shortened by `phase` studs on odd layers.
    let first = phase > 0 && len > 2 ? Math.min(phase, len - 1) : 0;
    while (used < len) {
      const room = len - used;
      const want = first > 0 ? first : room;
      first = 0;
      const [n, part] = BRICK_BY_LENGTH.find(([k]) => k <= Math.min(want, room))!;
      const cx = x + dx * used, cz = z + dz * used;
      for (let i = 0; i < n; i++) taken.add(key(cx + dx * i, cz + dz * i));
      out.push(el(part, [cx, plate, cz], dx === 1 ? 0 : 1, colour, group));
      used += n;
    }
  };
  const sorted = coords.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [x, z] of sorted) {
    if (taken.has(key(x, z))) continue;
    const alongX = has(x + 1, z) || !has(x, z + 1);
    lay(x, z, alongX ? 1 : 0, alongX ? 0 : 1);
  }
  return out;
}

/** Cells of a rectangular wall ring `w x d` with its minimum corner at (x0, z0). */
function ring(x0: number, z0: number, w: number, d: number): Set<string> {
  const s = new Set<string>();
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) if (x === 0 || z === 0 || x === w - 1 || z === d - 1) s.add(`${x0 + x},${z0 + z}`);
  return s;
}

const plan = (elements: PlacedElement[], groups = ['base', 'walls', 'roof']): BrickPlan => ({
  elements, groups: groups.map(id => ({ id, label: id })), scale: SCALE, metas: [],
});

/** Plate layers of the two-plate floor; the walls start on top of it. */
const FLOOR = 2;

/**
 * A two-plate floor over a set of cells: layer 0 is 2x2 plates on even
 * coordinates, layer 1 is 2x2 plates shifted by one stud (1x1 plates where a
 * 2x2 does not fit), so every layer-0 plate is bridged to its neighbours and the
 * floor is one connected piece. `cells` must be a union of even-aligned 2x2 blocks.
 */
function floor(cells: ReadonlySet<string>): PlacedElement[] {
  const out: PlacedElement[] = [];
  for (const [plate, shift] of [[0, 0], [1, 1]] as const) {
    const taken = new Set<string>();
    const xs = [...cells].map(k => Number(k.split(',')[0])), zs = [...cells].map(k => Number(k.split(',')[1]));
    for (let z = Math.min(...zs) + shift; z <= Math.max(...zs); z += 2) for (let x = Math.min(...xs) + shift; x <= Math.max(...xs); x += 2) {
      const block = [[x, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]] as const;
      if (block.every(([bx, bz]) => cells.has(`${bx},${bz}`) && !taken.has(`${bx},${bz}`))) {
        out.push(el('3022.dat', [x, plate, z], 0, 0, 'base'));
        block.forEach(([bx, bz]) => taken.add(`${bx},${bz}`));
      }
    }
    // Cells a 2x2 could not take (the border of the shifted layer).
    for (const k of cells) if (!taken.has(k) && shift) { const [x, z] = k.split(',').map(Number) as [number, number]; out.push(el('3024.dat', [x, plate, z], 0, 0, 'base')); }
  }
  return out;
}

const rect = (x0: number, z0: number, w: number, d: number): Set<string> => {
  const s = new Set<string>();
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) s.add(`${x0 + x},${z0 + z}`);
  return s;
};

/** Golden 1: an 8 x 8 box house, six brick layers on a two-plate floor, and a flat plate roof. */
export function boxHouse(): BrickPlan {
  const walls: PlacedElement[] = [];
  for (let layer = 0; layer < 6; layer++) walls.push(...layerBricks(ring(0, 0, 8, 8), FLOOR + layer * 3, layer % 2 ? 2 : 0, 14, 'walls'));
  // Roof: 3034 8x2 plates in four rows over the wall tops.
  const roof: PlacedElement[] = [];
  for (let z = 0; z < 8; z += 2) roof.push(el('3034.dat', [0, FLOOR + 18, z], 0, 4, 'roof'));
  return plan([...floor(rect(0, 0, 8, 8)), ...walls, ...roof]);
}

/** Golden 2: an L-shaped hall, four brick layers, closed with 45-degree slopes along its long arm. */
export function lHall(): BrickPlan {
  const cells = new Set<string>();
  for (const k of ring(0, 0, 12, 6)) cells.add(k);
  for (const k of ring(0, 4, 6, 8)) cells.add(k);
  const walls: PlacedElement[] = [];
  for (let layer = 0; layer < 4; layer++) walls.push(...layerBricks(cells, FLOOR + layer * 3, layer % 2 ? 2 : 0, 15, 'walls'));
  const roof: PlacedElement[] = [];
  // Slopes (3040b is 1x2) cap the long arm's north and south walls.
  for (let x = 0; x < 12; x += 2) {
    roof.push(el('3040b.dat', [x, FLOOR + 12, 0], 3, 1, 'roof'));
    roof.push(el('3040b.dat', [x, FLOOR + 12, 5], 1, 1, 'roof'));
  }
  const floorCells = rect(0, 0, 12, 6);
  for (const k of rect(0, 6, 6, 6)) floorCells.add(k);
  return plan([...floor(floorCells), ...walls, ...roof]);
}

/** Golden 3: a courtyard wall with two arches in its south side and a tile coping. */
export function archedCourt(): BrickPlan {
  const walls: PlacedElement[] = [];
  // Layer 0, then the arch course: the ring minus the south cells the two 1x4 arches cover.
  walls.push(...layerBricks(ring(0, 0, 10, 10), FLOOR, 0, 6, 'walls'));
  const archCourse = ring(0, 0, 10, 10);
  for (let x = 1; x <= 8; x++) archCourse.delete(`${x},9`);
  walls.push(...layerBricks(archCourse, FLOOR + 3, 2, 6, 'walls'));
  for (const x of [1, 5]) walls.push(el('3659.dat', [x, FLOOR + 3, 9], 0, 6, 'walls'));
  for (let layer = 2; layer < 4; layer++) walls.push(...layerBricks(ring(0, 0, 10, 10), FLOOR + layer * 3, layer % 2 ? 2 : 0, 6, 'walls'));
  // Tile coping on the north wall.
  const top = FLOOR + 12;
  const roof: PlacedElement[] = [el('2431.dat', [0, top, 0], 0, 0, 'roof'), el('2431.dat', [4, top, 0], 0, 0, 'roof'), el('3069b.dat', [8, top, 0], 0, 0, 'roof')];
  return plan([...floor(rect(0, 0, 10, 10)), ...walls, ...roof]);
}

export const GOLDENS: ReadonlyArray<readonly [string, () => BrickPlan]> = [['box house', boxHouse], ['L hall', lHall], ['arched court', archedCourt]];
