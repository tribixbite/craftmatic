/**
 * Assemble an LXFML whose sub-builds are stored laid out side by side.
 *
 * LEGO's own instruction LXFML for some sets stores each sub-build at the
 * position it is BUILT at, not the position it ends up in, so the model reads
 * as several structures standing apart. 76417 Gringotts is the case that found
 * this: the white bank (2,867 parts) and the dark rock vault (1,511) stand
 * about 115 studs apart at the same height, where the set is one ~90-stud
 * tower. Exporting it produced scattered blobs in game.
 *
 * The placement IS in the file, in `<Explode>`. That element carries a rigid
 * FRAME PAIR — `position`+`rotation` (a quaternion) and
 * `explosionPosition`+`explosionRotation` — and the parts named by its nested
 * `<Parts partRefs="...">` move rigidly between the two frames. Most entries
 * are small per-part instruction lifts, which is why they are easy to dismiss;
 * a few carry whole sub-builds:
 *
 *   refID 1640: 2,946 parts, 96.56 units,
 *               (95.97, 14.20, 1.60) -> (5.56, 48.05, 3.55)
 *
 * Applying that one seats the bank on the rock with a 0.25-unit gap and takes
 * the model from 36.0 to 69.9 units tall — a tower, matching the box art.
 *
 * Nothing here trusts a move because it is large. A candidate is applied only
 * when it SEATS: after the move the carried group's underside must meet the
 * rest of the model within a tolerance, over an overlapping footprint. That is
 * the same test that proved the bank join, and it is what keeps an
 * exploded-view animation — which displaces a group into thin air — from being
 * mistaken for an assembly step.
 *
 * Text in, text out: no DOM, so it runs identically in a test, in the CLI and
 * in the browser, and the corrected LXFML feeds the existing parser unchanged.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** One rigid move the file offers: these parts, from this frame to that one. */
export interface AssemblyMove {
  /** The `<Explode refID>` it came from. */
  refId: string;
  /** LXFML `<Part refID>` values carried by the move. */
  parts: string[];
  fromPos: Vec3;
  toPos: Vec3;
  fromRot: Quat;
  toRot: Quat;
  /** Straight-line distance between the frames, in LXFML units. */
  distance: number;
}

export interface AssemblyOptions {
  /** A move must carry at least this many parts to be a sub-build placement. */
  minParts?: number;
  /** ...and move at least this far, so per-part instruction lifts are ignored. */
  minDistanceUnits?: number;
  /**
   * How close the carried group's underside must come to the rest of the model
   * for the move to count as SEATING it. 76417's true join lands at 0.25.
   */
  seatToleranceUnits?: number;
}

const DEFAULTS: Required<AssemblyOptions> = {
  // Small enough to catch a real sub-module — 76417 has three 11-part groups
  // that seat within 0.34 units — because SEATING, not size, is what decides.
  minParts: 10,
  minDistanceUnits: 15,
  seatToleranceUnits: 2,
};

const num3 = (s: string): Vec3 | null => {
  const v = s.split(',').map(Number);
  return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : null;
};
const num4 = (s: string): Quat | null => {
  const v = s.split(',').map(Number);
  return v.length >= 4 && v.slice(0, 4).every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!, v[3]!] : null;
};

/** Row-major 3x3 from a quaternion (x, y, z, w). */
export function quatToMatrix(q: Quat): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const [x, y, z, w] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

const mulM = (a: readonly number[], b: readonly number[]): number[] => {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  }
  return out;
};
const transposeM = (m: readonly number[]): number[] =>
  [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
const applyM = (m: readonly number[], v: Vec3): Vec3 =>
  [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
   m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
   m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];

/** The rigid transform a move applies: rotate about its own frame, then translate. */
export function moveMatrix(move: AssemblyMove): { rotation: number[]; from: Vec3; to: Vec3 } {
  return {
    rotation: mulM(quatToMatrix(move.toRot), transposeM(quatToMatrix(move.fromRot))),
    from: move.fromPos, to: move.toPos,
  };
}

/** Where a point ends up under a move. */
export function applyMove(move: AssemblyMove, p: Vec3): Vec3 {
  const { rotation, from, to } = moveMatrix(move);
  const local: Vec3 = [p[0] - from[0], p[1] - from[1], p[2] - from[2]];
  const r = applyM(rotation, local);
  return [r[0] + to[0], r[1] + to[1], r[2] + to[2]];
}

/** Every `<Explode>` block, with the parts it carries. */
export function findAssemblyMoves(xml: string, options: AssemblyOptions = {}): AssemblyMove[] {
  const opt = { ...DEFAULTS, ...options };
  const out: AssemblyMove[] = [];
  const seen = new Set<string>();
  for (const block of xml.matchAll(/<Explode\b([^>]*)>([\s\S]*?)<\/Explode>/g)) {
    const head = block[1]!, body = block[2]!;
    const refId = /refID="(\d+)"/.exec(head)?.[1];
    const fromPos = num3(/\bposition="([^"]*)"/.exec(head)?.[1] ?? '');
    const toPos = num3(/\bexplosionPosition="([^"]*)"/.exec(head)?.[1] ?? '');
    const fromRot = num4(/\brotation="([^"]*)"/.exec(head)?.[1] ?? '') ?? [0, 0, 0, 1];
    const toRot = num4(/\bexplosionRotation="([^"]*)"/.exec(head)?.[1] ?? '') ?? [0, 0, 0, 1];
    if (!refId || !fromPos || !toPos) continue;

    const parts = new Set<string>();
    for (const p of body.matchAll(/partRefs="([^"]*)"/g)) {
      for (const ref of p[1]!.split(',')) if (ref) parts.add(ref);
    }
    const distance = Math.hypot(toPos[0] - fromPos[0], toPos[1] - fromPos[1], toPos[2] - fromPos[2]);
    if (parts.size < opt.minParts || distance < opt.minDistanceUnits) continue;
    // The same move is emitted once per step/view; one copy is enough.
    const key = `${[...parts].sort().join(',')}|${fromPos.join(',')}|${toPos.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ refId, parts: [...parts], fromPos, toPos, fromRot, toRot, distance });
  }
  return out.sort((a, b) => b.parts.length - a.parts.length);
}

/** `<Part refID>` → the translation of its first `<Bone>`, which is where it sits. */
export function readPartOrigins(xml: string): Map<string, Vec3> {
  const out = new Map<string, Vec3>();
  for (const part of xml.matchAll(/<Part\b[^>]*\brefID="(\d+)"[^>]*>([\s\S]*?)<\/Part>/g)) {
    const t = /transformation="([^"]*)"/.exec(part[2]!)?.[1];
    if (!t) continue;
    const v = t.split(',').map(Number);
    if (v.length >= 12 && v.slice(9, 12).every(Number.isFinite)) out.set(part[1]!, [v[9]!, v[10]!, v[11]!]);
  }
  return out;
}

/**
 * Does this move SEAT the group it carries on the rest of the model?
 *
 * Measured on part origins: after the move, the carried group's lowest origin
 * must come within tolerance of the highest origin of the parts it lands over,
 * and their footprints must overlap. A move that leaves the group in clear air
 * — an exploded view — fails, which is the whole point.
 */
export function seatingOf(
  move: AssemblyMove, origins: ReadonlyMap<string, Vec3>, options: AssemblyOptions = {},
): { seats: boolean; gapUnits: number; overlaps: boolean; carried: number } {
  const opt = { ...DEFAULTS, ...options };
  const carried = move.parts.filter(ref => origins.has(ref));
  if (!carried.length) return { seats: false, gapUnits: Infinity, overlaps: false, carried: 0 };

  const moved = carried.map(ref => applyMove(move, origins.get(ref)!));
  const inMove = new Set(carried);
  const rest: Vec3[] = [];
  for (const [ref, p] of origins) if (!inMove.has(ref)) rest.push(p);
  if (!rest.length) return { seats: false, gapUnits: Infinity, overlaps: false, carried: carried.length };

  const span = (pts: Vec3[], a: number): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p[a]!); hi = Math.max(hi, p[a]!); }
    return [lo, hi];
  };
  const [mx0, mx1] = span(moved, 0), [mz0, mz1] = span(moved, 2);
  // Only the parts the group actually lands over can hold it up.
  const under = rest.filter(p => p[0] >= mx0 && p[0] <= mx1 && p[2] >= mz0 && p[2] <= mz1);
  const overlaps = under.length > 0;
  if (!overlaps) return { seats: false, gapUnits: Infinity, overlaps, carried: carried.length };

  const movedBottom = span(moved, 1)[0];
  const restTop = span(under, 1)[1];
  const gapUnits = movedBottom - restTop;
  return { seats: Math.abs(gapUnits) <= opt.seatToleranceUnits, gapUnits, overlaps, carried: carried.length };
}

export interface AssemblyResult {
  xml: string;
  applied: AssemblyMove[];
  /** Candidates considered and why each was refused, so a miss is visible. */
  notes: string[];
}

/**
 * Apply every move that seats, largest group first, and rewrite the affected
 * bone transformations so the returned XML parses to the ASSEMBLED model.
 *
 * Seating is re-measured after each application, because a move can only be
 * judged against the model as it stands.
 */
export function assembleLxfml(xml: string, options: AssemblyOptions = {}): AssemblyResult {
  const opt = { ...DEFAULTS, ...options };
  const moves = findAssemblyMoves(xml, opt);
  const origins = readPartOrigins(xml);
  const notes: string[] = [];
  if (!moves.length) return { xml, applied: [], notes: ['no candidate sub-build moves in this file'] };

  const applied: AssemblyMove[] = [];
  const live = new Map(origins);
  const remaining = [...moves];
  for (;;) {
    let best: { move: AssemblyMove; gap: number } | null = null;
    for (const move of remaining) {
      const seat = seatingOf(move, live, opt);
      if (!seat.seats) continue;
      if (!best || move.parts.length > best.move.parts.length) best = { move, gap: seat.gapUnits };
    }
    if (!best) break;
    for (const ref of best.move.parts) {
      const p = live.get(ref);
      if (p) live.set(ref, applyMove(best.move, p));
    }
    applied.push(best.move);
    notes.push(`applied ${best.move.refId}: ${best.move.parts.length} parts, ${best.move.distance.toFixed(2)} units, seated with a ${best.gap.toFixed(2)} unit gap`);
    // A sub-build is placed ONCE. The file offers the same group several times,
    // one entry per step or view, and every frame is expressed against the
    // ORIGINAL stored positions — so applying a second one to parts that have
    // already moved compounds two absolute transforms and throws the group off
    // again. Measured on 76417: taking both of its 2,946-part entries widened
    // the model from 126.8 to 143.8 units instead of narrowing it.
    const placed = new Set(best.move.parts);
    for (let i = remaining.length - 1; i >= 0; i--) {
      const other = remaining[i]!;
      if (other === best.move || other.parts.some(ref => placed.has(ref))) remaining.splice(i, 1);
    }
  }
  for (const move of remaining) {
    const seat = seatingOf(move, live, opt);
    notes.push(`refused ${move.refId}: ${move.parts.length} parts, ${move.distance.toFixed(2)} units — ${
      !seat.overlaps ? 'lands over nothing' : `would leave a ${seat.gapUnits.toFixed(2)} unit gap`}`);
  }
  if (!applied.length) return { xml, applied, notes };

  // Rewrite the bones of every moved part. A part may carry several bones (a
  // flexible element), and all of them move with it.
  const moveOf = new Map<string, AssemblyMove>();
  for (const move of applied) for (const ref of move.parts) if (!moveOf.has(ref)) moveOf.set(ref, move);

  const out = xml.replace(/<Part\b([^>]*)\brefID="(\d+)"([^>]*)>([\s\S]*?)<\/Part>/g,
    (whole, pre: string, ref: string, post: string, body: string) => {
      const chain = applied.filter(m => m.parts.includes(ref));
      if (!chain.length) return whole;
      const moved = body.replace(/transformation="([^"]*)"/g, (attr, value: string) => {
        const v = value.split(',').map(Number);
        if (v.length < 12 || !v.every(Number.isFinite)) return attr;
        // The nine rotation values are stored COLUMN-major (clego's reader:
        // R[i][j] = v[j*3+i]), i.e. as R^T in row-major terms. The part turns
        // with its group, R' = M.R, which is stored as (M.R)^T = R^T.M^T.
        // Multiplying M onto the stored values instead (M.R^T) turned every
        // moved part by the wrong amount about its own axes: 76417's bank,
        // moved with a 44.8 degree turn, came out as scattered planks on the
        // device (2026-09-24), while the unmoved vault was intact.
        let rot = v.slice(0, 9);
        let pos: Vec3 = [v[9]!, v[10]!, v[11]!];
        for (const move of chain) {
          const m = moveMatrix(move);
          rot = mulM(rot, transposeM(m.rotation));
          pos = applyMove(move, pos);
        }
        return `transformation="${[...rot, ...pos].map(n => (Math.abs(n) < 1e-12 ? 0 : n)).join(',')}"`;
      });
      return `<Part${pre}refID="${ref}"${post}>${moved}</Part>`;
    });

  return { xml: out, applied, notes };
}

// ── The root step's own composition ───────────────────────────────────────────
//
// The seating test above decides one move at a time from geometry, and it is
// structurally unable to place a FIGURE: a goblin standing at a counter inside
// the bank has the bank's whole roof above its footprint, so "the top of what
// it lands over" is the roof and every figure reads as a -30-unit gap. On
// 76417 it placed three of the thirteen figures (by the luck of their columns)
// and refused the rest, the dragon and the mine cart, so the set shipped with
// ten figures in a lineup on the grass, the dragon lying beside the rock and
// three plates floating 50 units off the model (device report 2026-09-24).
//
// The file says where they go, and says it in one place. The instruction's
// TOP-LEVEL step (76417: `sm01`, the first child of `<Steps>`) is the finished
// model's page: its DIRECT `<Explode>` children are LEGO's own placement of
// every sub-build and figure into the final scene — the bank onto the rock,
// each figure to its post, the dragon onto the rock face, the cart onto its
// track. Explodes inside nested `<SubBuild>`s are the per-step diagrams (an
// exploded lift of the rock's spine, parts hovering over their studs) and are
// NOT taken; neither are `<ExtraView>`/`<EndOnHighView>` copies.
//
// Nested `<Explode>`s inside a placement are expressed in their PARENT's frame
// (a minifig's arms at (1.03, 1.86, 0) from its hips; the dragon's wings, legs
// and neck from its body), so a part's move composes the chain:
//   M = (F1_to ∘ F2_to ∘ … ∘ Fk_to) ∘ (F1_from ∘ … ∘ Fk_from)^-1
// which carries the group AND takes the display pose the set is shown in. A
// flat reading (the regex in `findAssemblyMoves`) moves children rigidly with
// their parent and keeps their build pose.

/** A rigid frame: row-major rotation and a translation. */
interface Frame { r: number[]; t: Vec3 }

const IDENTITY_FRAME: Frame = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** a ∘ b: first b, then a. */
const composeFrames = (a: Frame, b: Frame): Frame => {
  const bt = applyM(a.r, b.t);
  return { r: mulM(a.r, b.r), t: [bt[0] + a.t[0], bt[1] + a.t[1], bt[2] + a.t[2]] };
};
const invertFrame = (f: Frame): Frame => {
  const rt = transposeM(f.r);
  const t = applyM(rt, f.t);
  return { r: rt, t: [-t[0], -t[1], -t[2]] };
};

/** One placement of the root step: its frame pair, its own parts, its nested placements. */
export interface CompositionNode {
  refId: string;
  fromPos: Vec3; fromRot: Quat; toPos: Vec3; toRot: Quat;
  parts: string[];
  children: CompositionNode[];
}

/**
 * The direct `<Explode>` children of every top-level `<Step>` (a child of
 * `<Steps>`), each with its nested explodes as a tree. Text in, no DOM: the
 * tags are walked with a depth counter, which is exact for LDD's
 * machine-written XML (no CDATA, no comments inside `<BuildingInstruction>`).
 */
export function findRootComposition(xml: string): CompositionNode[] {
  const start = xml.indexOf('<Steps');
  if (start < 0) return [];
  const TAG = /<(\/?)(Steps|Step|SubBuild|ExtraView|EndOnHighView|Explode|Parts)\b([^>]*?)(\/?)>/g;
  TAG.lastIndex = start;
  // Element stack of the structural tags; an explode is "root" when the
  // stack above it is exactly Steps > Step (plus the explode chain itself).
  const stack: string[] = [];
  const explodeStack: CompositionNode[] = [];
  const roots: CompositionNode[] = [];
  let rootExplodeDepth = -1;
  for (let m = TAG.exec(xml); m; m = TAG.exec(xml)) {
    const [, closing, tag, attrs, selfClose] = m;
    if (closing) {
      if (tag === 'Explode' && explodeStack.length) explodeStack.pop();
      if (stack.length && stack[stack.length - 1] === tag) stack.pop();
      if (tag === 'Steps') break;
      if (rootExplodeDepth >= 0 && stack.length < rootExplodeDepth) rootExplodeDepth = -1;
      continue;
    }
    if (tag === 'Parts') {
      const top = explodeStack[explodeStack.length - 1];
      if (top) for (const ref of (/partRefs="([^"]*)"/.exec(attrs!)?.[1] ?? '').split(',')) if (ref) top.parts.push(ref);
      continue;
    }
    if (tag === 'Explode') {
      // Root: directly inside a top-level Step, or nested in a root explode.
      const underRootStep = stack.length === 2 && stack[0] === 'Steps' && stack[1] === 'Step';
      const nested = explodeStack.length > 0 && rootExplodeDepth >= 0;
      if (underRootStep || nested) {
        const fromPos = num3(/\bposition="([^"]*)"/.exec(attrs!)?.[1] ?? '') ?? [0, 0, 0];
        const toPos = num3(/\bexplosionPosition="([^"]*)"/.exec(attrs!)?.[1] ?? '') ?? fromPos;
        const node: CompositionNode = {
          refId: /refID="(\d+)"/.exec(attrs!)?.[1] ?? '?',
          fromPos, toPos,
          fromRot: num4(/\brotation="([^"]*)"/.exec(attrs!)?.[1] ?? '') ?? [0, 0, 0, 1],
          toRot: num4(/\bexplosionRotation="([^"]*)"/.exec(attrs!)?.[1] ?? '') ?? [0, 0, 0, 1],
          parts: [], children: [],
        };
        if (nested) explodeStack[explodeStack.length - 1]!.children.push(node);
        else { roots.push(node); rootExplodeDepth = stack.length + 1; }
        if (!selfClose) { explodeStack.push(node); stack.push('Explode'); }
      } else if (!selfClose) {
        // An explode we do not take still nests; keep the stacks balanced.
        explodeStack.length = 0;
        stack.push('Explode');
      }
      continue;
    }
    if (!selfClose) stack.push(tag!);
  }
  return roots;
}

/** Every part a composition moves, with the rigid move that takes it to the finished scene. */
export function compositionMoves(roots: readonly CompositionNode[]): Map<string, Frame> {
  const out = new Map<string, Frame>();
  const frameOf = (pos: Vec3, rot: Quat): Frame => ({ r: quatToMatrix(rot), t: pos });
  const visit = (node: CompositionNode, from: Frame, to: Frame): void => {
    const f = composeFrames(from, frameOf(node.fromPos, node.fromRot));
    const t = composeFrames(to, frameOf(node.toPos, node.toRot));
    const move = composeFrames(t, invertFrame(f));
    // First placement wins: the file repeats a move per view.
    for (const ref of node.parts) if (!out.has(ref)) out.set(ref, move);
    for (const child of node.children) visit(child, f, t);
  };
  for (const root of roots) visit(root, IDENTITY_FRAME, IDENTITY_FRAME);
  return out;
}

/** Summary of one root placement, for the report. */
export interface CompositionApplied { refId: string; parts: number; distance: number }

/**
 * Apply the top-level step's composition (see the section header): every
 * part it names is moved to where the finished-model page shows it. Parts the
 * composition does not name keep their stored position.
 */
export function composeRootStep(xml: string): { xml: string; applied: CompositionApplied[]; notes: string[] } {
  const roots = findRootComposition(xml);
  if (!roots.length) return { xml, applied: [], notes: ['no top-level step placements in this file'] };
  const moves = compositionMoves(roots);
  const count = (n: CompositionNode): number => n.parts.length + n.children.reduce((s, c) => s + count(c), 0);
  const applied = roots.map(n => ({
    refId: n.refId, parts: count(n),
    distance: Math.hypot(n.toPos[0] - n.fromPos[0], n.toPos[1] - n.fromPos[1], n.toPos[2] - n.fromPos[2]),
  }));
  const out = xml.replace(/<Part\b([^>]*)\brefID="(\d+)"([^>]*)>([\s\S]*?)<\/Part>/g,
    (whole, pre: string, ref: string, post: string, body: string) => {
      const move = moves.get(ref);
      if (!move) return whole;
      const moved = body.replace(/transformation="([^"]*)"/g, (attr, value: string) => {
        const v = value.split(',').map(Number);
        if (v.length < 12 || !v.every(Number.isFinite)) return attr;
        // Stored column-major (R^T in row-major terms): R' = M.R is stored as R^T.M^T.
        const rot = mulM(v.slice(0, 9), transposeM(move.r));
        const p = applyM(move.r, [v[9]!, v[10]!, v[11]!]);
        const pos = [p[0] + move.t[0], p[1] + move.t[1], p[2] + move.t[2]];
        return `transformation="${[...rot, ...pos].map(n => (Math.abs(n) < 1e-12 ? 0 : n)).join(',')}"`;
      });
      return `<Part${pre}refID="${ref}"${post}>${moved}</Part>`;
    });
  const notes = applied.filter(a => a.distance > 1e-9 || a.parts > 0)
    .map(a => `placed ${a.refId}: ${a.parts} parts, ${a.distance.toFixed(2)} units`);
  return { xml: out, applied, notes };
}
