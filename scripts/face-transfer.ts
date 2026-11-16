/**
 * Carry a head's PRINT identity from one source of a set to another (audit 2026-11-15 A-10 / FIG-04,
 * TODO(face-source-transfer)).
 *
 * The index's first pick for a set is often the source that places the model best but names no head prints
 * (Mecabricks writes its printed heads as the plain `3626`, an `.io` can lose its decorations), while another
 * conversion of the SAME set (DBIX, IOModel2V2) writes a `0 !CRAFTMATIC HEAD_PRINT` id or a printed part name for
 * the same figure. The frames of two conversions differ, but a figure is recognisable by what it is made of: the
 * colours of its torso, arms, hands and legs, and the shape and colour of its hair or hat. So every figure of both
 * sources gets a SIGNATURE (role:colour per part, the headwear's mould family too), and a head takes the donor's
 * print only when the match is unambiguous:
 *   - the best donor figure scores at least `MIN_SCORE` (a weighted overlap of the two signatures),
 *   - it beats the second best by `MIN_MARGIN`,
 *   - the pairing is MUTUAL (the donor figure's best target is this figure), and
 *   - every donor figure that ties on the signature names the SAME print (two identical clones carry one face).
 * Anything else is a refusal with its reason, never a guess.
 */
import { classifyFigurePart, figureSystemOfTorso, mouldFamilyId, type FigureSystem } from '../web/src/engine/minifig-rig.ts';
import { groupFigures, isHeadPart } from '../web/src/engine/ldraw-entity-compiler.ts';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import type { LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import { namedHeadPrint } from './face-census.ts';

/** A signature score at or above this is a candidate match (1 = the same parts in the same colours). */
export const MIN_SCORE = 0.75;
/** The best candidate must beat the runner-up (with a DIFFERENT print) by this much. */
export const MIN_MARGIN = 0.15;

/** The roles a figure part is compared by: the rig's slots folded so a one-piece and a split mould agree. */
type Role = 'torso' | 'head' | 'headwear' | 'arm' | 'hand' | 'lower' | 'back';
/** How much each role weighs in the score: the torso and headwear say most about who a figure is. */
const ROLE_WEIGHT: Record<Role, number> = { torso: 3, headwear: 3, head: 1, arm: 1, hand: 0.5, lower: 2, back: 1 };

export interface FigureSig {
  /** Index of the head brick in the source's brick list. */
  head: number;
  /** The print the head names (`3626pb2588`), or null for a plain head. */
  print: string | null;
  /**
   * The head's part stem when the PART NAME is a library print (`3626cp0e`), else null: such a print is carried
   * as a rename to that part (the library draws it), never as a meta.
   */
  printedPart: string | null;
  /** Weighted multiset of `role:colour` (and `headwear:<family>:colour`) keys. */
  keys: Map<string, number>;
}

const roleOf = (slot: string | null): Role | null => {
  if (!slot) return null;
  if (slot === 'torso' || slot === 'head' || slot === 'headwear' || slot === 'back') return slot;
  if (slot.startsWith('arm')) return 'arm';
  if (slot.startsWith('hand')) return 'hand';
  if (slot === 'hips' || slot === 'hips_legs' || slot.startsWith('leg')) return 'lower';
  // Mini-doll slots (`doll_torso`, `doll_head`, `doll_hair`, `doll_leg`, `doll_arm_*`).
  if (/torso/.test(slot)) return 'torso';
  if (/head/.test(slot)) return 'head';
  if (/hair|hat/.test(slot)) return 'headwear';
  if (/arm/.test(slot)) return 'arm';
  if (/hand/.test(slot)) return 'hand';
  if (/leg|hip|skirt/.test(slot)) return 'lower';
  return null;
};

/** A mould family with any print suffix removed (`973p1a` -> `973`, `62810pr0001` -> `62810`). */
const baseMould = (part: string, description: string): string =>
  mouldFamilyId(part, description).replace(/(?:p[a-z]{0,2}\d+[a-z]?\d*|pr\d+|pat\d+)$/i, '');

/**
 * One signature per figure group (`groupFigures`, the export's own grouping) that has a head. `colourKey` maps a
 * brick's colour into the space both sources are compared in.
 */
export function figureSignatures(
  bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, colourKey: (colour: number) => string,
): FigureSig[] {
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const out: FigureSig[] = [];
  for (const g of groupFigures(bricks, meshes)) {
    const torso = bricks[g.torso]!;
    const system: FigureSystem = figureSystemOfTorso(torso.part, desc(torso)) ?? 'minifig';
    const keys = new Map<string, number>();
    let head = -1;
    for (const i of g.parts) {
      const b = bricks[i]!;
      const d = desc(b);
      const isHead = isHeadPart(b.part, d);
      const role: Role | null = isHead ? 'head' : roleOf(classifyFigurePart(system, b.part, d));
      if (!role) continue;
      if (isHead && head < 0) head = i;
      const colour = colourKey(b.color);
      const add = (k: string, w: number): void => { keys.set(k, (keys.get(k) ?? 0) + w); };
      add(`${role}:${colour}`, ROLE_WEIGHT[role]);
      if (role === 'headwear') add(`headwear:${baseMould(b.part, d)}:${colour}`, ROLE_WEIGHT.headwear);
    }
    if (head < 0) continue;
    const h = bricks[head]!;
    out.push({ head, print: namedHeadPrint(h.part, h.headPrint), printedPart: !h.headPrint && namedHeadPrint(h.part) ? partStem(h.part) : null, keys });
  }
  return out;
}

/** Weighted Jaccard overlap of two signatures. */
export function signatureScore(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0, union = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? 0, y = b.get(k) ?? 0;
    inter += Math.min(x, y);
    union += Math.max(x, y);
  }
  return union > 0 ? inter / union : 0;
}

export interface TransferDecision {
  /** Target head brick index. */
  head: number;
  /** The print carried across, when accepted. */
  print?: string;
  /** Set when the donor names the print as a library part: the target head is renamed to it. */
  part?: string;
  score?: number;
  /** Why a head got nothing (`no candidate`, `ambiguous`, `not mutual`, `donor names no print`). */
  refused?: string;
}

/**
 * For every target figure whose head names NO print, decide whether a donor figure's print can be carried across.
 * Heads that already name a print are left out of the result.
 */
export function decideTransfers(
  target: readonly FigureSig[], donor: readonly FigureSig[], fits: (head: number, print: string) => boolean = () => true,
): TransferDecision[] {
  const scores = target.map(t => donor.map(d => signatureScore(t.keys, d.keys)));
  const out: TransferDecision[] = [];
  target.forEach((t, ti) => {
    if (t.print) return;
    const row = scores[ti]!;
    const order = row.map((s, k) => [s, k] as const).sort((a, b) => b[0] - a[0]);
    const [best, bk] = order[0] ?? [0, -1];
    if (bk < 0 || best < MIN_SCORE) { out.push({ head: t.head, refused: `no candidate (best ${best.toFixed(2)})`, score: best }); return; }
    const print = donor[bk]!.print;
    if (!print) { out.push({ head: t.head, refused: 'donor names no print', score: best }); return; }
    if (!fits(t.head, print)) { out.push({ head: t.head, refused: `print ${print} is not this head's mould`, score: best }); return; }
    // The runner-up that would give a DIFFERENT face decides ambiguity; clones carrying the same print do not.
    const rival = order.slice(1).find(([, k]) => donor[k]!.print !== print);
    if (rival && best - rival[0] < MIN_MARGIN) {
      out.push({ head: t.head, refused: `ambiguous (${best.toFixed(2)} vs ${rival[0].toFixed(2)} for ${donor[rival[1]]!.print ?? 'no print'})`, score: best });
      return;
    }
    // Mutual: among the target figures, this one is (one of) the donor's best, by more than the margin against
    // any target figure that is NOT a clone of it.
    const col = scores.map(r => r[bk]!);
    const mine = col[ti]!;
    const better = col.some((s, k) => k !== ti && s > mine + 1e-9 && signatureScore(target[k]!.keys, t.keys) < 1 - 1e-9);
    if (better) { out.push({ head: t.head, refused: 'not mutual', score: best }); return; }
    out.push({ head: t.head, print, score: best, ...(donor[bk]!.printedPart ? { part: donor[bk]!.printedPart! } : {}) });
  });
  // Capacity: a print cannot go to more target heads than the donor has heads wearing it (one donor figure is
  // never copied onto two different target figures).
  const have = new Map<string, number>();
  for (const d of donor) if (d.print) have.set(d.print, (have.get(d.print) ?? 0) + 1);
  const given = new Map<string, number>();
  for (const d of out) if (d.print) given.set(d.print, (given.get(d.print) ?? 0) + 1);
  for (const d of out) {
    if (d.print && given.get(d.print)! > have.get(d.print)!) {
      d.refused = `${given.get(d.print)} heads match ${d.print}, the donor has ${have.get(d.print)}`;
      delete d.print;
    }
  }
  return out;
}

/**
 * Whether a print id belongs on a head mould: a minifig print (`3626p…`, `28621p…`) on a minifig head, a doll print
 * (`92198p…`, `92240p…`) on a doll head.
 */
export function printFitsHead(headPart: string, print: string): boolean {
  const stem = partStem(headPart).toLowerCase();
  const doll = /^(92198|92240|28649)/.test(stem);
  return doll ? /^(92198|92240|28649)p/i.test(print) : /^(3626|28621)p/i.test(print);
}
