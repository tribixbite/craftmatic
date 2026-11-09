/**
 * `BrickPlan` -> LDraw MPD text.
 *
 * Deterministic by construction: the same plan and identity always write the
 * same bytes (LF endings, groups and elements in a fixed order, numbers in one
 * canonical form), so a design can be regenerated and diffed, and polish ops
 * that name groups and lattice boxes survive regeneration.
 *
 * Layout of the MPD:
 *  - `0 FILE <slug>.ldr`: the model. Header, the authoring metas, then one
 *    reference per group (identity transform, colour 16).
 *  - one `0 FILE <slug>-<group>.ldr` per group, elements sorted by
 *    (plate, z, x, part, colour) - i.e. layer by layer, bottom up.
 *
 * Frames: lattice x/z are LDraw x/z; plate layer `p` spans LDraw
 * `y in [-(p + 1) * 8, -p * 8]` (y is down). A vocabulary part is placed by its
 * BODY, not its origin: `at` is the minimum-x/z cell of the footprint AFTER the
 * turn, and the part's measured body frame (`vocab/occupancy.ts` `BodyFrame`)
 * puts the body's bottom on the plate's floor and its centre on the footprint
 * centre. So parts whose origin is not at the top centre (curved slopes, door
 * frames) land correctly.
 */
import type { AuthoringMeta, BrickPlan, PlacedElement } from '../types.js';
import { elementFor, frameFor, type BodyFrame } from '../vocab/index.js';
import type { BrickElement } from '../types.js';

/** Who the written file says wrote it, and under which licence. */
export interface WriterIdentity {
  /** File stem of the model, lower-case `[a-z0-9_-]`. */
  slug: string;
  /** Model title (line 1 of every section). */
  title: string;
  /** Written as `0 Author:`. */
  author: string;
  /** Written as `0 !LICENSE`. */
  licence: string;
}

/**
 * Stand-in identity until the studio name and licence are chosen (decision U1).
 * TODO(U1): replace the author and licence with the real studio and licence text.
 */
export const PLACEHOLDER_IDENTITY: WriterIdentity = {
  slug: 'design',
  title: 'Untitled design',
  author: 'brickgen (placeholder studio)',
  licence: 'TODO(U1) licence to be chosen before release',
};

/** What the writer needs to know about vocabulary parts; injectable for tests. */
export interface WriterVocab {
  elementFor(part: string): BrickElement | undefined;
  frameFor(part: string): BodyFrame | undefined;
}

const DEFAULT_VOCAB: WriterVocab = { elementFor, frameFor };

/** LDU per stud and per plate. */
const STUD = 20;
const PLATE = 8;

/**
 * The exact rotation matrix (row-major, as written to LDraw type-1 lines) for a
 * quarter turn about the vertical axis. Turn `t` rotates by `t * 90` degrees
 * about LDraw +y: `x' = cos * x + sin * z`, `z' = -sin * x + cos * z`, so turn 1
 * sends local +x to world -z and local +z to world +x. All entries are exactly
 * -1, 0 or 1.
 */
export function turnMatrix(turn: 0 | 1 | 2 | 3): readonly [number, number, number, number, number, number, number, number, number] {
  switch (turn) {
    case 0: return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    case 1: return [0, 0, 1, 0, 1, 0, -1, 0, 0];
    case 2: return [-1, 0, 0, 0, 1, 0, 0, 0, -1];
    case 3: return [0, 0, -1, 0, 1, 0, 1, 0, 0];
  }
}

/** Canonical number text: at most 4 decimals, no trailing zeros, never `-0`. */
export function formatNumber(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  if (r === 0) return '0';
  return String(r);
}

/** One authoring meta as a `0 !CRAFTMATIC` line (the inverse of `parseAuthoringMeta`). */
export function formatAuthoringMeta(m: AuthoringMeta): string {
  const f = formatNumber;
  switch (m.kind) {
    case 'FIGURE': return `0 !CRAFTMATIC FIGURE ${m.system} ${f(m.at[0])} ${f(m.at[1])} ${f(m.at[2])} ${f(m.facingDeg)}${m.seat ? ` ${m.seat}` : ''}`;
    case 'SEAT': return `0 !CRAFTMATIC SEAT ${m.id} ${f(m.at[0])} ${f(m.at[1])} ${f(m.at[2])} ${f(m.facingDeg)}`;
    case 'DOOR': return `0 !CRAFTMATIC DOOR ${m.group} ${f(m.hinge[0])} ${f(m.hinge[1])} ${f(m.hinge[2])} ${m.axis} ${f(m.openDeg)}`;
    case 'SPAWN': return `0 !CRAFTMATIC SPAWN ${f(m.at[0])} ${f(m.at[1])} ${f(m.at[2])}`;
    case 'DESIGN': return `0 !CRAFTMATIC DESIGN ${m.slug} ${m.version} ${m.provenance}`;
  }
}

/** A name that is safe in an MPD `0 FILE` line and a type-1 reference. */
function fileSafe(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

/** The type-1 line placing one element. Throws for a part outside the vocabulary. */
function elementLine(e: PlacedElement, vocab: WriterVocab): string {
  const el = vocab.elementFor(e.part);
  const frame = vocab.frameFor(e.part);
  if (!el || !frame) throw new Error(`brickgen writer: ${e.part} is not in the vocabulary`);
  const m = turnMatrix(e.turn);
  const [fx, fz] = el.footprint;
  const odd = e.turn % 2 === 1;
  const w = odd ? fz : fx; // footprint extent in x after the turn
  const d = odd ? fx : fz; // ... and in z
  const cx = e.at[0] * STUD + (w * STUD) / 2;
  const cz = e.at[2] * STUD + (d * STUD) / 2;
  // Origin = footprint centre minus the turned body-centre offset.
  const ox = cx - (m[0] * frame.centreX + m[2] * frame.centreZ);
  const oz = cz - (m[6] * frame.centreX + m[8] * frame.centreZ);
  const oy = -e.at[1] * PLATE - frame.bottomY;
  const nums = [e.colour, ox, oy, oz, ...m].map(formatNumber).join(' ');
  return `1 ${nums} ${e.part}`;
}

/** Order of elements inside a group file: layer by layer, then z, x, part, colour. */
function compareElements(a: PlacedElement, b: PlacedElement): number {
  return a.at[1] - b.at[1] || a.at[2] - b.at[2] || a.at[0] - b.at[0] || (a.part < b.part ? -1 : a.part > b.part ? 1 : 0) || a.colour - b.colour;
}

/**
 * Write a plan as MPD text. Throws when an element names a part outside the
 * vocabulary or a group the plan does not declare, or when two group ids
 * collapse to one file name.
 */
export function writeLdraw(plan: BrickPlan, identity: WriterIdentity = PLACEHOLDER_IDENTITY, vocab: WriterVocab = DEFAULT_VOCAB): string {
  const slug = fileSafe(identity.slug);
  const groups = [...plan.groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fileOf = new Map<string, string>();
  const used = new Set<string>();
  for (const g of groups) {
    const name = `${slug}-${fileSafe(g.id)}.ldr`;
    if (used.has(name)) throw new Error(`brickgen writer: group ids collapse to the same file name: ${name}`);
    used.add(name);
    fileOf.set(g.id, name);
  }
  const byGroup = new Map<string, PlacedElement[]>(groups.map(g => [g.id, []]));
  for (const e of plan.elements) {
    const list = byGroup.get(e.group);
    if (!list) throw new Error(`brickgen writer: element ${e.part} is in undeclared group "${e.group}"`);
    list.push(e);
  }

  const header = (name: string, title: string): string[] => [
    `0 FILE ${name}`,
    `0 ${title}`,
    `0 Name: ${name}`,
    `0 Author: ${identity.author}`,
    `0 !LICENSE ${identity.licence}`,
  ];

  const IDENTITY = '1 0 0 0 1 0 0 0 1';
  const lines: string[] = [
    ...header(`${slug}.ldr`, identity.title),
    ...plan.metas.map(formatAuthoringMeta),
    ...groups.map(g => `1 16 0 0 0 ${IDENTITY} ${fileOf.get(g.id)!}`),
  ];
  for (const g of groups) {
    lines.push('', ...header(fileOf.get(g.id)!, g.label));
    for (const e of [...byGroup.get(g.id)!].sort(compareElements)) lines.push(elementLine(e, vocab));
  }
  return `${lines.join('\n')}\n`;
}
