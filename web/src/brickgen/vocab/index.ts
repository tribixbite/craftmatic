/**
 * The brick vocabulary: ~80 OFFICIAL LDraw elements with footprint, height,
 * occupancy and connections read from their geometry (`occupancy.ts`).
 *
 * The runtime copy is `vocabulary.generated.ts`, written by
 * `bun scripts/_vendor_ldraw_vocab.ts` from the vendored parts under
 * `test/fixtures/ldraw-vocab/`; `buildVocabulary` is the same derivation and a
 * test asserts the committed data equals a fresh rebuild, so a part revision or
 * a reader change cannot drift silently.
 */
import { PRODUCTION_PALETTE } from '../colour.js';
import type { BrickElement, BrickVocabulary } from '../types.js';
import { ELEMENT_SPECS, MOVED_PARTS, type ElementSpec } from './elements.js';
import { analysePart, flattenPart, readHeader, type BodyFrame, type PartSource } from './occupancy.js';
import { VOCAB_RECORDS, type VocabRecord } from './vocabulary.generated.js';

export { ELEMENT_SPECS, MOVED_PARTS } from './elements.js';
export type { ElementSpec } from './elements.js';
export type { BodyFrame, PartSource } from './occupancy.js';
export { occupancyIndex } from './occupancy.js';

/** Bumped when the derivation or the element list changes. */
export const VOCAB_VERSION = '1';

/** One element together with where its body sits against the part origin. */
export interface VocabBuild { element: BrickElement; frame: BodyFrame; spec: ElementSpec }

/** Derive every element from part geometry. `source` resolves library file names. Throws on an unreadable part. */
export function buildVocabulary(source: PartSource): VocabBuild[] {
  return ELEMENT_SPECS.map(spec => {
    const text = source(spec.part);
    if (text === undefined) throw new Error(`vocabulary part ${spec.part} is not in the source`);
    const header = readHeader(text);
    const flat = flattenPart(spec.part, source);
    if (flat.missing.length) throw new Error(`${spec.part}: unresolved ${flat.missing.join(', ')}`);
    if (flat.logoFiles.length) throw new Error(`${spec.part}: reaches a logo stud (${flat.logoFiles.join(', ')})`);
    const a = analysePart(flat, spec.mode);
    const element: BrickElement = {
      part: spec.part,
      footprint: a.footprint,
      heightPlates: a.heightPlates,
      ...(a.full ? {} : { occupancy: a.occupancy }),
      connections: { studsTop: a.studsTop, antiStudsBottom: a.antiStudsBottom, ...(spec.side ? { side: spec.side } : {}) },
      roles: [...spec.roles],
      licence: header.licence,
      author: header.author,
    };
    return { element, frame: a.frame, spec };
  });
}

function recordToElement(r: VocabRecord, spec: ElementSpec): BrickElement {
  return {
    part: r.part,
    footprint: [r.footprint[0], r.footprint[1]],
    heightPlates: r.heightPlates,
    ...(r.occupancy === null ? {} : { occupancy: Uint8Array.from(r.occupancy, c => (c === '1' ? 1 : 0)) }),
    connections: {
      studsTop: r.studsTop.map(([x, z]) => [x, z] as [number, number]),
      antiStudsBottom: r.antiStudsBottom.map(([x, z]) => [x, z] as [number, number]),
      ...(spec.side ? { side: spec.side } : {}),
    },
    roles: [...spec.roles],
    licence: r.licence,
    author: r.author,
  };
}

const SPEC_BY_PART = new Map(ELEMENT_SPECS.map(s => [s.part, s]));

export const BRICK_VOCABULARY: BrickVocabulary = {
  // A record without a spec is a stale generated file (the script that rewrites it must be able to import this
  // module first); `buildVocabulary` + the drift test and `--check` report it.
  elements: VOCAB_RECORDS.filter(r => SPEC_BY_PART.has(r.part)).map(r => recordToElement(r, SPEC_BY_PART.get(r.part)!)),
  palette: [...PRODUCTION_PALETTE],
  version: VOCAB_VERSION,
};

const ELEMENT_BY_PART = new Map(BRICK_VOCABULARY.elements.map(e => [e.part, e]));
const FRAME_BY_PART = new Map<string, BodyFrame>(VOCAB_RECORDS.map(r => [r.part, r.frame]));

/** A part file name with an official "~Moved to" alias (`3023.dat`) read as the part it points at (`3023b.dat`). */
export function canonicalPart(part: string): string {
  return MOVED_PARTS[part] ?? part;
}

/** The vocabulary element for a part file name (`3001.dat`, or a moved name like `3023.dat`), or undefined when it is not in the vocabulary. */
export function elementFor(part: string): BrickElement | undefined {
  return ELEMENT_BY_PART.get(canonicalPart(part));
}

/** Where the body of a vocabulary part sits against its origin (LDU, LDraw axes), or undefined. */
export function frameFor(part: string): BodyFrame | undefined {
  return FRAME_BY_PART.get(canonicalPart(part));
}
