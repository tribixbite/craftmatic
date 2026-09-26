/**
 * Which end of a vehicle is its nose — inferred from the parts, not assumed.
 *
 * The previous compiler never inferred the SIGN: it took the long axis for a
 * car, always +Z for a plane, and always the positive end, so every golden
 * model that faces the LDraw convention (front toward −Z, the direction a
 * minifig faces) drove tail-first, and a plane built along X flew sideways.
 * Measured 2026-09-15 on the six-view silhouettes: 10300 rear at the nose,
 * 75892 rear wing at the nose, 76240 four-wheel end at the nose, 76286 beam-on.
 *
 * Each signal below is a horizontal vote vector in the LEVELLED LDraw frame
 * (after detached objects are dropped): its direction is "toward the nose",
 * its length is the confidence. The axis is the dominant component of the
 * weighted sum when the sum is decisive, else the longer footprint axis, else
 * Z; the sign is the sum's sign on that axis, else negative (the LDraw
 * convention). The decision and every vote are reported so a wrong guess is
 * inspectable in `craftmatic-diagnostics.json`.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { PlayableKind } from './playable-components.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import { partStem } from './part-id.js';

export type NoseDirection = '+x' | '-x' | '+z' | '-z';

export interface FacingVote {
  signal: string;
  /** Vote vector (LDraw horizontal plane) pointing toward the nose. */
  x: number;
  z: number;
  weight: number;
  detail?: string;
}

export interface FacingDecision {
  nose: NoseDirection;
  axis: 'x' | 'z';
  sign: -1 | 1;
  /** `explicit` = caller supplied; `inferred` = votes decided; `convention` = no usable evidence. */
  source: 'explicit' | 'inferred' | 'convention';
  /** Fraction of the total vote weight that agreed with the chosen direction (1 = unanimous). */
  agreement: number;
  votes: FacingVote[];
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const stem = (part: string): string => partStem(part);
const apply = (m: readonly number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];

/**
 * Parts whose LOCAL −Z is the direction their user faces. Minifig torsos,
 * heads and legs face −Z by LDraw convention; a seat's backrest is on its +Z
 * side (4079: backrest vertices at z ≈ +22, seat lip at −0.5); the car
 * steering stand's wheel is pitched so its top edge leans to −Z, away from the
 * driver behind it at +Z (3829c01 / 73081: top z −4.5, bottom z −1.8).
 * Measured from the parts' own geometry, 2026-09-15.
 */
const DRIVER_PARTS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /^(973|3814|76382)(?![0-9])/, weight: 3, label: 'minifig torso' },
  { re: /^3626(?![0-9])/, weight: 2, label: 'minifig head' },
  { re: /^(970|3815|3816|41879|16968)(?![0-9])/, weight: 2, label: 'minifig legs' },
  { re: /^(4079|4079b|33176|58888|14520)$/, weight: 3, label: 'seat' },
  { re: /^(3829|3829c01|73081)$/, weight: 3, label: 'steering wheel' },
];

/** Trans-Red: tail lights. Only ever at the rear of a road vehicle. */
const TAIL_LIGHT_COLOURS = new Set([36]);
/** Trans-Clear: headlights, when they are lamps (round) at one end. */
const HEAD_LIGHT_COLOURS = new Set([47]);
const isTranslucentColour = (c: number): boolean => (c >= 33 && c <= 47) || c === 52 || c === 54 || c === 111 || c === 32 || c === 57;

/**
 * Horizontal lean of a part's geometry: the mean of its lowest quarter of
 * vertices minus the mean of its highest quarter (LDraw Y is down). A
 * windscreen's bottom edge is forward of its top edge, so the lean points
 * toward the nose. Symmetric parts (a plain window pane) lean ~0.
 */
export function partLean(mesh: LdrawPartMesh | null | undefined): Vec3 | null {
  if (!mesh || !mesh.triangles.length) return null;
  let minY = Infinity, maxY = -Infinity;
  for (const t of mesh.triangles) for (const p of [t.a, t.b, t.c]) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const h = maxY - minY;
  if (h < 4) return null;
  let tx = 0, tz = 0, tn = 0, bx = 0, bz = 0, bn = 0;
  for (const t of mesh.triangles) for (const p of [t.a, t.b, t.c]) {
    if (p[1] < minY + h * 0.25) { tx += p[0]; tz += p[2]; tn++; }
    else if (p[1] > maxY - h * 0.25) { bx += p[0]; bz += p[2]; bn++; }
  }
  if (!tn || !bn) return null;
  return [bx / bn - tx / tn, 0, bz / bn - tz / tn];
}

/** A dish, round brick/plate/tile or cone: the moulds engine glows are built from (by description, else by id family). */
export function isRoundGlowPart(part: string, description?: string): boolean {
  const d = (description ?? '').replace(/^[~=_]+\s*/, '');
  if (d) return /^(Dish|Cone|Cylinder)\b/i.test(d) || /\bRound\b/i.test(d);
  return /^(3941|3942|3943|4073|6141|4740|3960|43898|11833|2654|4589|3062|6222|18674|98138|6143|4032|3567|6233|30153)(?![0-9])/.test(stem(part));
}

/** A windscreen / canopy / window glass, or any translucent part at least 30 LDU on two axes (a pane, not a lamp). */
export function isGlassPart(part: string, mesh?: LdrawPartMesh | null): boolean {
  const d = (mesh?.description ?? '').replace(/^[~=_]+\s*/, '');
  if (/^(Windscreen|Canopy|Cockpit|Windshield|Glass for|Window)\b/i.test(d)) return true;
  if (d) return false;
  // No description (unresolved part, or a caller without meshes): anything translucent that is not a known glow mould.
  if (!mesh || !mesh.triangles.length) return !isRoundGlowPart(part);
  const size = [0, 1, 2].map(i => mesh.bounds.max[i]! - mesh.bounds.min[i]!).sort((a, b) => b - a);
  return size[1]! >= 30;
}

export interface InferNoseOptions {
  /** Explicit nose from the caller (UI facing selector or verified component metadata). */
  explicit?: NoseDirection;
  /** Resolved part meshes, for windscreen lean and wheel size. */
  meshes?: Map<string, LdrawPartMesh | null>;
  /** Wheel part names recognised by the compiler (positions and radii vote for cars). */
  isWheel?: (brick: ParsedBrick) => boolean;
}

/** Infer the nose direction of a LEVELLED, detached-object-free placement set. */
export function inferVehicleNose(bricks: ParsedBrick[], kind: PlayableKind, options: InferNoseOptions = {}): FacingDecision {
  const votes: FacingVote[] = [];
  const n = bricks.length;
  const xs = bricks.map(b => b.x), zs = bricks.map(b => b.z);
  const minX = n ? Math.min(...xs) : 0, maxX = n ? Math.max(...xs) : 0, minZ = n ? Math.min(...zs) : 0, maxZ = n ? Math.max(...zs) : 0;
  const spanX = maxX - minX, spanZ = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const longAxis: 'x' | 'z' = spanX > spanZ * 1.1 ? 'x' : 'z';
  const span = longAxis === 'x' ? spanX : spanZ;
  const along = (b: { x: number; z: number }): number => longAxis === 'x' ? b.x - cx : b.z - cz;
  const axisVec = (s: number): { x: number; z: number } => longAxis === 'x' ? { x: s, z: 0 } : { x: 0, z: s };
  /**
   * A vote from where a group of parts sits relative to the footprint centre,
   * in BOTH horizontal axes: `toward` +1 votes toward the group (a cockpit),
   * −1 away from it (exhausts, tail lights). Measured 2026-09-15 on 76286:
   * the Milano's wingspan (1,504 LDU) is longer than its hull (785), so any
   * signal read "along the long axis" looked across the ship and its four
   * engine dishes, symmetric in X, cancelled to nothing.
   */
  //
  // The reference point is the MASS centre (mean placement), not the box
  // centre: the Milano's wings sweep back past its engines, so against the box
  // centre its exhausts read as barely aft; and the threshold is a fraction of
  // the span along the offset's own axis, so a wide ship's wingspan does not
  // set the bar for a signal along its hull.
  const mx = n ? xs.reduce((a, b) => a + b, 0) / n : 0, mz = n ? zs.reduce((a, b) => a + b, 0) / n : 0;
  const centroidVote = (sel: ParsedBrick[], signal: string, weight: number, toward: 1 | -1, minFraction: number, detail: string, partWeight: (b: ParsedBrick) => number = () => 1): void => {
    if (!sel.length) return;
    const total = sel.reduce((a, b) => a + partWeight(b), 0) || 1;
    const ox = sel.reduce((a, b) => a + b.x * partWeight(b), 0) / total - mx, oz = sel.reduce((a, b) => a + b.z * partWeight(b), 0) / total - mz;
    const mag = Math.hypot(ox, oz);
    const spanAlong = Math.abs(ox) >= Math.abs(oz) ? spanX : spanZ;
    if (mag < spanAlong * minFraction) return;
    votes.push({ signal, x: ox / mag * weight * toward, z: oz / mag * weight * toward, weight, detail: `${detail} at ${Math.round(ox)}, ${Math.round(oz)} LDU from the mass centre` });
  };

  if (options.explicit) {
    const axis = options.explicit.endsWith('x') ? 'x' : 'z';
    return { nose: options.explicit, axis, sign: options.explicit.startsWith('-') ? -1 : 1, source: 'explicit', agreement: 1, votes };
  }
  if (n < 2 || (spanX < 1 && spanZ < 1)) {
    return { nose: '-z', axis: 'z', sign: -1, source: 'convention', agreement: 0, votes };
  }

  // 1. Driver-facing parts: local −Z through the placement rotation. Only a
  //    part facing squarely along an axis counts (a display figure posed at an
  //    angle beside the vehicle does not), and only inside the vehicle's own
  //    footprint (shrunk 10 % per side).
  const insideX0 = minX + spanX * 0.1, insideX1 = maxX - spanX * 0.1, insideZ0 = minZ + spanZ * 0.1, insideZ1 = maxZ - spanZ * 0.1;
  const driverTotals = new Map<string, { x: number; z: number; count: number; weight: number }>();
  for (const b of bricks) {
    const id = stem(b.part);
    const cls = DRIVER_PARTS.find(d => d.re.test(id));
    if (!cls) continue;
    if (b.x < insideX0 || b.x > insideX1 || b.z < insideZ0 || b.z > insideZ1) continue;
    const f = apply(b.rot ?? IDENTITY, [0, 0, -1]);
    const h = Math.hypot(f[0], f[2]);
    if (h < 0.85) continue;
    const fx = f[0] / h, fz = f[2] / h;
    if (Math.max(Math.abs(fx), Math.abs(fz)) < 0.85) continue;
    const t = driverTotals.get(cls.label) ?? { x: 0, z: 0, count: 0, weight: cls.weight };
    t.x += fx; t.z += fz; t.count++;
    driverTotals.set(cls.label, t);
  }
  for (const [label, t] of driverTotals) {
    const h = Math.hypot(t.x, t.z);
    if (h < 0.5) continue; // the group disagrees with itself (figures facing each other)
    // A class votes once with its weight (capped ×2 for several agreeing placements), not once per placement.
    const w = t.weight * Math.min(2, 1 + (t.count - 1) * 0.25) * (h / t.count);
    votes.push({ signal: `driver:${label}`, x: t.x / h * w, z: t.z / h * w, weight: w, detail: `${t.count} placement${t.count === 1 ? '' : 's'}` });
  }

  // 2. Windscreen lean: translucent parts whose bottom edge sits forward of
  //    their top edge. Rear windows lean the other way but are smaller and
  //    fewer; the vote is the net lean, capped so one part cannot outvote a seat.
  if (options.meshes) {
    let lx = 0, lz = 0, count = 0;
    for (const b of bricks) {
      if (!isTranslucentColour(b.color)) continue;
      const lean = partLean(options.meshes.get(b.part));
      if (!lean) continue;
      const w = apply(b.rot ?? IDENTITY, lean);
      const h = Math.hypot(w[0], w[2]);
      if (h < 5) continue;
      lx += w[0]; lz += w[2]; count++;
    }
    // A plane's canopy leans along its flight axis; a lean across a decisively
    // long fuselage is a side window, so only the longitudinal part counts.
    if (kind === 'plane' && Math.max(spanX, spanZ) >= Math.min(spanX, spanZ) * 1.3) { if (longAxis === 'x') lz = 0; else lx = 0; }
    const h = Math.hypot(lx, lz);
    if (count && h >= 10) {
      const w = Math.min(2.5, 0.5 + count * 0.5);
      votes.push({ signal: 'windscreen lean', x: lx / h * w, z: lz / h * w, weight: w, detail: `${count} sloped translucent placement${count === 1 ? '' : 's'}, net lean ${Math.round(h)} LDU` });
    }
  }

  if (kind === 'car' || kind === 'boat') {
    // 3. Tail lights: trans-red sits at the rear. Vote away from their centroid.
    const tails = bricks.filter(b => TAIL_LIGHT_COLOURS.has(b.color));
    if (tails.length >= 2) centroidVote(tails, 'tail lights', 2, -1, 0.1, `${tails.length} trans-red placements`);
    // 3b. Headlights: clear lamps (a round tile, plate or dish in trans-clear)
    //     at one END of the vehicle - its outer quarter along the long axis.
    //     42128's tow truck had no seat, steering wheel or glass to read and
    //     voted to a tie (tail lights against its wheel count); its four clear
    //     round tiles sit 622 LDU forward of centre, over the cab.
    if (span > 0) {
      // A clear lens stacked on a coloured one (42128's Mecabricks source puts clear, red and orange
      // round tiles at one spot of its tail lamps) is part of that lamp, not a headlight.
      const coloured = bricks.filter(b => isTranslucentColour(b.color) && !HEAD_LIGHT_COLOURS.has(b.color));
      const lamps = bricks.filter(b => HEAD_LIGHT_COLOURS.has(b.color) && isRoundGlowPart(b.part, options.meshes?.get(b.part)?.description) && Math.abs(along(b)) >= span * 0.25
        && !coloured.some(c => Math.hypot(c.x - b.x, c.z - b.z) < 2 && Math.abs(c.y - b.y) <= 24));
      const neg = lamps.filter(b => along(b) < 0).length, pos = lamps.length - neg;
      // Lamps at both ends are indicators or a light bar, not a heading.
      if (lamps.length >= 2 && Math.min(neg, pos) * 3 <= Math.max(neg, pos)) {
        const sign = pos > neg ? 1 : -1;
        const w = 2.5;
        votes.push({ signal: 'headlights', ...axisVec(sign * w), weight: w, detail: `${Math.max(neg, pos)} clear lamp placement${Math.max(neg, pos) === 1 ? '' : 's'} at the ${sign > 0 ? '+' : '-'}${longAxis} end (${Math.min(neg, pos)} at the other)` });
      }
    }
    // 4. Wheels: the end with more, or larger, wheels is the rear (a dragster's
    //    slicks, the Tumbler's four rear tyres). Symmetric wheelbases abstain.
    if (options.isWheel && span > 0) {
      const wheels = bricks.filter(options.isWheel);
      const radius = (b: ParsedBrick): number => {
        const m = options.meshes?.get(b.part);
        return m ? Math.max(m.bounds.max[0] - m.bounds.min[0], m.bounds.max[1] - m.bounds.min[1], m.bounds.max[2] - m.bounds.min[2]) / 2 : 0;
      };
      const neg = wheels.filter(b => along(b) < 0), pos = wheels.filter(b => along(b) > 0);
      if (neg.length >= 1 && pos.length >= 1) {
        const rNeg = neg.reduce((a, b) => a + radius(b), 0) / neg.length, rPos = pos.reduce((a, b) => a + radius(b), 0) / pos.length;
        let rearSign = 0, why = '';
        if (Math.abs(neg.length - pos.length) >= 2) { rearSign = neg.length > pos.length ? -1 : 1; why = `${neg.length} vs ${pos.length} wheels`; }
        else if (rNeg > 0 && rPos > 0 && Math.max(rNeg, rPos) / Math.min(rNeg, rPos) > 1.2) { rearSign = rNeg > rPos ? -1 : 1; why = `wheel radius ${Math.round(rNeg)} vs ${Math.round(rPos)} LDU`; }
        if (rearSign) {
          const w = 2;
          votes.push({ signal: 'wheel asymmetry', ...axisVec(-rearSign * w), weight: w, detail: why });
        }
      }
    }
  }

  if (kind === 'plane') {
    // 5a. Engine glow: translucent ROUND parts (dishes, round bricks/plates,
    //     cones) in a glow colour are exhausts, and exhausts sit at the tail.
    //     Strongest plane signal: the Milano's cockpit sits AFT of centre
    //     (its prongs reach forward), so canopy position alone read it 90°
    //     wrong; its four trans-light-blue engine dishes settle it.
    const glow = bricks.filter(b => isTranslucentColour(b.color) && isRoundGlowPart(b.part, options.meshes?.get(b.part)?.description));
    //     Weighted by footprint area: an engine is a 4×4 dish, a nav light a
    //     1×1 round plate, and the Milano has nine of the latter spread about.
    const footprint = (b: ParsedBrick): number => { const m = options.meshes?.get(b.part); return m ? Math.max(1, (m.bounds.max[0] - m.bounds.min[0]) * (m.bounds.max[2] - m.bounds.min[2])) : 400; };
    if (glow.length >= 2) centroidVote(glow, 'engine glow', 3, -1, 0.1, `${glow.length} translucent round placements`, footprint);
    // 5b. Canopy position: the cockpit sits toward the nose (a helicopter's
    //     cabin, a fighter's canopy). Glass only - lamps and glows are not a
    //     cockpit, and they are exactly what sits at the tail.
    //     Weaker than the exhausts: the Milano's cockpit sits AFT of centre.
    const canopy = bricks.filter(b => isTranslucentColour(b.color) && isGlassPart(b.part, options.meshes?.get(b.part)));
    if (canopy.length >= 1) centroidVote(canopy, 'canopy position', 1.5, 1, 0.08, `${canopy.length} glass placements`);
    // 6. Narrow end: the nose is slimmer than the tail (fins, wings, engines).
    //    Tested on BOTH axes - a wide-winged ship's hull is its short axis.
    //    An axis shorter than half the other cannot be the hull (a helicopter's
    //    tail boom is asymmetric across the short axis and would vote there).
    if (n >= 8) {
      for (const axis of ['x', 'z'] as const) {
        const aSpan = axis === 'x' ? spanX : spanZ;
        if (aSpan <= 0 || aSpan < (axis === 'x' ? spanZ : spanX) * 0.5) continue;
        const pos = (b: ParsedBrick): number => axis === 'x' ? b.x - cx : b.z - cz;
        const outer = (sign: number): number => {
          const sel = bricks.filter(b => sign * pos(b) > aSpan * 0.3);
          if (!sel.length) return 0;
          const t = sel.map(b => axis === 'x' ? b.z : b.x);
          return Math.max(...t) - Math.min(...t);
        };
        const wNeg = outer(-1), wPos = outer(1);
        if (wNeg > 0 && wPos > 0 && Math.max(wNeg, wPos) / Math.min(wNeg, wPos) >= 1.3) {
          const w = 1, s = wNeg < wPos ? -w : w;
          votes.push({ signal: `narrow end ${axis}`, x: axis === 'x' ? s : 0, z: axis === 'z' ? s : 0, weight: w, detail: `outer width ${Math.round(wNeg)} vs ${Math.round(wPos)} LDU across ${axis}` });
        }
      }
    }
  }

  const sumX = votes.reduce((a, v) => a + v.x, 0), sumZ = votes.reduce((a, v) => a + v.z, 0);
  const total = votes.reduce((a, v) => a + v.weight, 0);
  const mag = Math.hypot(sumX, sumZ);
  if (!votes.length || mag < 0.5) {
    return { nose: (longAxis === 'x' ? '-x' : '-z'), axis: longAxis, sign: -1, source: 'convention', agreement: 0, votes };
  }
  // The axis: the vote sum's dominant component when it is decisive (≥ 1.5×
  // the other), otherwise the footprint's long axis.
  let axis: 'x' | 'z';
  // A car or a boat moves along its LENGTH: with a decisively long footprint
  // the axis is the long one and the votes only pick the end. 60221's diving
  // yacht (10.7 x 5.2 blocks) sailed sideways because its standing skipper and
  // his legs faced across the deck and outvoted the steering wheel (audit
  // 2026-09-25). Aircraft are exempt: a wingspan can be the long side.
  if ((kind === 'car' || kind === 'boat') && Math.max(spanX, spanZ) >= Math.min(spanX, spanZ) * 1.3) axis = spanX > spanZ ? 'x' : 'z';
  else if (Math.abs(sumX) >= Math.abs(sumZ) * 1.5) axis = 'x';
  else if (Math.abs(sumZ) >= Math.abs(sumX) * 1.5) axis = 'z';
  else axis = longAxis;
  const component = axis === 'x' ? sumX : sumZ;
  if (Math.abs(component) < 0.5) {
    return { nose: (longAxis === 'x' ? '-x' : '-z'), axis: longAxis, sign: -1, source: 'convention', agreement: 0, votes };
  }
  const sign: -1 | 1 = component < 0 ? -1 : 1;
  const agreeing = votes.reduce((a, v) => a + Math.max(0, (axis === 'x' ? v.x : v.z) * sign), 0);
  return { nose: `${sign < 0 ? '-' : '+'}${axis}` as NoseDirection, axis, sign, source: 'inferred', agreement: total ? Math.round(agreeing / total * 1000) / 1000 : 0, votes };
}
