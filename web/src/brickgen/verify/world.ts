/**
 * Placed elements read onto the stud lattice: the one geometry every verifier
 * stage shares (connectivity, stability, overlap, budget), so none of them
 * re-derives how a quarter turn moves a footprint.
 *
 * Frame (`types.ts`): x east, z south, `plate` up. An element placed at
 * `at = [sx, plate, sz]` with turn `t` covers `w x d` studs from `at` (the
 * footprint AFTER the turn) and `heightPlates` plate layers from `plate`.
 * Its studs stand in the layer ABOVE its body (`plate + heightPlates`); its
 * anti-studs are in its bottom layer (`plate`). Two elements connect when one's
 * stud cell is the other's anti-stud cell (`connect.ts`).
 */
import { turnMatrix } from '../emit/ldraw-writer.js';
import type { BrickElement, PlacedElement } from '../types.js';
import { ELEMENT_SPECS, type ElementSpec } from '../vocab/elements.js';
import { elementFor, occupancyIndex } from '../vocab/index.js';

/** The element families the verifier tells apart (cantilever limits are per family). */
export type ElementKind = ElementSpec['kind'];

/** What the verifier needs to know about a part: its element and its family. */
export interface VerifyPart {
  element: BrickElement;
  kind: ElementKind;
}

/** Resolves a part file name; undefined = not a legal vocabulary part. Injectable for tests and corpus models. */
export type PartLookup = (part: string) => VerifyPart | undefined;

const KIND_BY_PART = new Map<string, ElementKind>(ELEMENT_SPECS.map(s => [s.part, s.kind]));

/** The production lookup: the brick vocabulary and its curated families. */
export const VOCABULARY_LOOKUP: PartLookup = part => {
  const element = elementFor(part);
  const kind = KIND_BY_PART.get(part);
  return element && kind ? { element, kind } : undefined;
};

/** A lattice cell `[sx, plate, sz]`. */
export type Cell = readonly [sx: number, plate: number, sz: number];

/** One placed element resolved onto the lattice. */
export interface WorldElement {
  /** Index into the plan's `elements`. */
  index: number;
  placed: PlacedElement;
  part: VerifyPart;
  /** Footprint extent in studs AFTER the turn. */
  w: number;
  d: number;
  /** Lowest plate layer of the body, and its height in plates. */
  y0: number;
  h: number;
  /** Cells of the body (studs excluded), honouring a non-cuboid occupancy mask. */
  body: Cell[];
  /** Stud cells: x, z of the stud and the plate layer ABOVE the body. */
  studs: Cell[];
  /** Anti-stud cells in the bottom layer. */
  antis: Cell[];
}

/** Integer key of a lattice cell: coordinates within +-32,768 give a key below 2^48, exact in a double. */
export function cellKey(x: number, y: number, z: number): number {
  return ((x + 32768) * 65536 + (y + 32768)) * 65536 + (z + 32768);
}

/**
 * The lattice offset `[dx, dz]` from `at` of a part-local footprint cell after
 * the element's quarter turn (`turnMatrix`, the same matrix the writer applies).
 */
export function turnedCell(turn: 0 | 1 | 2 | 3, fx: number, fz: number, lx: number, lz: number): [number, number] {
  const m = turnMatrix(turn);
  const a = lx + 0.5 - fx / 2; // cell centre against the footprint centre, in studs
  const b = lz + 0.5 - fz / 2;
  const odd = turn % 2 === 1;
  const w = odd ? fz : fx;
  const d = odd ? fx : fz;
  return [Math.floor(m[0] * a + m[2] * b + w / 2), Math.floor(m[6] * a + m[8] * b + d / 2)];
}

/** Resolve one placement; undefined when its part is not known to `lookup`. */
export function placeElement(index: number, placed: PlacedElement, lookup: PartLookup): WorldElement | undefined {
  const part = lookup(placed.part);
  if (!part) return undefined;
  const { element } = part;
  const [fx, fz] = element.footprint;
  const odd = placed.turn % 2 === 1;
  const [sx, y0, sz] = placed.at;
  const h = element.heightPlates;
  const at = (lx: number, lz: number, layer: number): Cell => {
    const [dx, dz] = turnedCell(placed.turn, fx, fz, lx, lz);
    return [sx + dx, y0 + layer, sz + dz];
  };
  const body: Cell[] = [];
  for (let layer = 0; layer < h; layer++) {
    for (let lz = 0; lz < fz; lz++) {
      for (let lx = 0; lx < fx; lx++) {
        if (element.occupancy && element.occupancy[occupancyIndex(fx, fz, lx, lz, layer)] === 0) continue;
        body.push(at(lx, lz, layer));
      }
    }
  }
  return {
    index, placed, part,
    w: odd ? fz : fx, d: odd ? fx : fz, y0, h,
    body,
    studs: element.connections.studsTop.map(([x, z]) => at(x, z, h)),
    antis: element.connections.antiStudsBottom.map(([x, z]) => at(x, z, 0)),
  };
}

/** Resolve a whole plan. Unknown parts are returned separately (they are illegal, and have no geometry to verify). */
export function placeAll(elements: readonly PlacedElement[], lookup: PartLookup): { world: WorldElement[]; unknown: PlacedElement[] } {
  const world: WorldElement[] = [];
  const unknown: PlacedElement[] = [];
  elements.forEach((e, i) => {
    const w = placeElement(i, e, lookup);
    if (w) world.push(w);
    else unknown.push(e);
  });
  return { world, unknown };
}
