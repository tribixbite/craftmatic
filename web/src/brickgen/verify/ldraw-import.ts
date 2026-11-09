/**
 * Read an existing LDraw model (parsed bricks) back onto the stud lattice, so
 * the verifier can be run on real corpus models and on hand-broken copies of
 * them, not only on plans the bricker wrote.
 *
 * It is the inverse of `emit/ldraw-writer.ts`: a brick is placed on the lattice
 * only when it is UPRIGHT (its vertical axis unchanged), turned by a whole
 * quarter turn, and its body sits on whole studs and whole plates. Anything
 * else (sideways, tilted, half-stud offsets, parts the resolver does not know)
 * is reported in `offLattice` instead of being snapped, because a snapped part
 * would invent a connection the model does not have.
 */
import { turnMatrix } from '../emit/ldraw-writer.js';
import type { ParsedBrick } from '../../engine/ldraw-parser.js';
import type { BrickElement, BrickPlan, PlacedElement } from '../types.js';
import { analysePart, flattenPart, readHeader, type BodyFrame, type PartSource } from '../vocab/occupancy.js';
import { frameFor } from '../vocab/index.js';
import { VOCABULARY_LOOKUP, type ElementKind, type PartLookup, type VerifyPart } from './world.js';

/** A part the importer can place: its verifier view and where its body sits against its origin. */
export interface ImportPart extends VerifyPart { frame: BodyFrame }

/** Resolves a part file name for import; undefined = unknown (reported off-lattice). */
export type ImportLookup = (part: string) => ImportPart | undefined;

/** The brick vocabulary as an import resolver. */
export const VOCABULARY_IMPORT: ImportLookup = part => {
  const v = VOCABULARY_LOOKUP(part);
  const frame = frameFor(part);
  return v && frame ? { ...v, frame } : undefined;
};

/**
 * Derive an import resolver for ANY part in an LDraw library from its geometry
 * (the same reader the vocabulary uses). The family is a guess for the
 * cantilever table only: a part with a non-cuboid envelope counts as a slope
 * (supported by its own occupancy), otherwise plate or brick by height.
 * Parts that fail to read (no body geometry, unresolved subfiles) return
 * undefined. NOT a legality check: these parts need not be in the vocabulary.
 */
export function libraryImport(source: PartSource): ImportLookup {
  const cache = new Map<string, ImportPart | undefined>();
  return part => {
    if (cache.has(part)) return cache.get(part);
    let out: ImportPart | undefined;
    try {
      const text = source(part);
      if (text !== undefined) {
        const flat = flattenPart(part, source);
        if (flat.tris.length && !flat.missing.length) {
          const a = analysePart(flat, 'envelope');
          const kind: ElementKind = !a.full ? 'slope' : a.heightPlates <= 1 ? 'plate' : 'brick';
          const element: BrickElement = {
            part, footprint: a.footprint, heightPlates: a.heightPlates,
            ...(a.full ? {} : { occupancy: a.occupancy }),
            connections: { studsTop: a.studsTop, antiStudsBottom: a.antiStudsBottom },
            roles: [], licence: readHeader(text).licence, author: readHeader(text).author,
          };
          out = { element, kind, frame: a.frame };
        }
      }
    } catch { out = undefined; }
    cache.set(part, out);
    return out;
  };
}

export interface ImportResult {
  plan: BrickPlan;
  /** Source indices (into the bricks array) that could not be placed on the lattice, with the reason. */
  offLattice: Array<{ index: number; part: string; reason: string }>;
  /** A `PartLookup` over exactly the parts the plan uses, for `verifyPlan({ lookup })`. */
  lookup: PartLookup;
}

const STUD = 20;
const PLATE = 8;
const EPS = 0.51; // LDU of slack for a written position (the writer rounds to 4 decimals; sources are rougher)

/** Which quarter turn a row-major rotation is, when it is an upright one. */
function turnOf(rot: readonly number[]): 0 | 1 | 2 | 3 | undefined {
  for (const t of [0, 1, 2, 3] as const) {
    const m = turnMatrix(t);
    if (m.every((v, i) => Math.abs(v - (rot[i] ?? (i % 4 === 0 ? 1 : 0))) < 1e-3)) return t;
  }
  return undefined;
}

/** Place parsed bricks on the lattice (origin moved to the model's minimum corner). */
export function importBricks(bricks: readonly ParsedBrick[], resolve: ImportLookup = VOCABULARY_IMPORT): ImportResult {
  const placed: Array<{ index: number; part: ImportPart; turn: 0 | 1 | 2 | 3; at: [number, number, number]; colour: number }> = [];
  const offLattice: ImportResult['offLattice'] = [];
  bricks.forEach((b, index) => {
    const name = b.part.toLowerCase().replaceAll('\\', '/');
    const part = resolve(name);
    if (!part) { offLattice.push({ index, part: b.part, reason: 'unknown part' }); return; }
    const turn = turnOf(b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    if (turn === undefined) { offLattice.push({ index, part: b.part, reason: 'not upright or not a quarter turn' }); return; }
    const m = turnMatrix(turn);
    const [fx, fz] = part.element.footprint;
    const odd = turn % 2 === 1;
    const w = odd ? fz : fx;
    const d = odd ? fx : fz;
    const cx = b.x + m[0] * part.frame.centreX + m[2] * part.frame.centreZ;
    const cz = b.z + m[6] * part.frame.centreX + m[8] * part.frame.centreZ;
    const sx = (cx - (w * STUD) / 2) / STUD;
    const sz = (cz - (d * STUD) / 2) / STUD;
    const plate = (-b.y - part.frame.bottomY) / PLATE;
    const off = (v: number, unit: number): boolean => Math.abs(v * unit - Math.round(v) * unit) > EPS;
    if (off(sx, STUD) || off(sz, STUD) || off(plate, PLATE)) { offLattice.push({ index, part: b.part, reason: 'off the stud/plate grid' }); return; }
    placed.push({ index, part, turn, at: [Math.round(sx), Math.round(plate), Math.round(sz)], colour: b.color });
  });
  const min = [0, 1, 2].map(k => placed.reduce((lo, p) => Math.min(lo, p.at[k]!), Infinity));
  const parts = new Map<string, ImportPart>();
  const elements: PlacedElement[] = placed.map(p => {
    parts.set(p.part.element.part, p.part);
    return { part: p.part.element.part, colour: p.colour, turn: p.turn, group: 'model', at: [p.at[0] - min[0]!, p.at[1] - min[1]!, p.at[2] - min[2]!] };
  });
  return {
    plan: { elements, groups: [{ id: 'model', label: 'Model' }], scale: { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'imported' }, metas: [] },
    offLattice,
    lookup: part => parts.get(part),
  };
}
