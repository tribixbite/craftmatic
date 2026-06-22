/**
 * LSynth flexible-part synthesis (hoses / pneumatic & ribbed tubes / cables).
 *
 * Most LDraw models we load already ship their flexible parts SYNTHESIZED
 * (OMR `0 SYNTH SYNTHESIZED BEGIN … END` blocks of placed segment sub-parts;
 * Studio `.io` bakes them into CustomParts meshes) — those render with no help.
 * The gap this fills is an UNSYNTHESIZED block: a hand-authored / editor-exported
 * file that carries only `0 SYNTH BEGIN <type> <colour>` + oriented constraint
 * type-1 lines + `0 SYNTH END`, with no geometry between. Without synthesis the
 * constraints render as stray marker parts (or 404), never as a hose.
 *
 * This is a pure TEXT→TEXT pass: each unsynthesized block is replaced by a
 * reference to a generated inline `0 FILE` whose body is a swept tube (circular
 * cross-section parallel-transported along a centripetal Catmull-Rom spline
 * through the constraint positions). The downstream parser/renderer then handle
 * it like any other inline part — zero renderer changes. Already-synthesized
 * blocks and unknown types are left untouched, so it can't break working files.
 *
 * Curve fidelity: the spline passes through every constraint with smooth,
 * twist-free framing — visually faithful for hoses. (Constraint-orientation
 * tangents and band/chain tangent-arc routing are out of scope; documented.)
 */

type Vec3 = [number, number, number];

/** Tube outer radius (LDU) by SYNTH type keyword. Defaults to standard hose. */
function radiusForType(type: string): number {
  const t = type.toUpperCase();
  if (t.includes('PNEUMATIC')) return 3;
  if (t.includes('RIBBED')) return 5;
  if (t.includes('ELECTRIC') || t.includes('FIBER') || t.includes('FIBRE')) return 2;
  if (t.includes('FLEXIBLE_AXLE') || t.includes('FLEX_AXLE') || t.includes('FLEX-AXLE')) return 5;
  if (t.includes('HOSE') || t.includes('TUBE')) return 4;
  return 4;
}

/** Is this SYNTH type one we know how to sweep as a round tube? */
function isTubeType(type: string): boolean {
  const t = type.toUpperCase();
  // Bands (rubber band / chain / tread) need tangent-arc / discrete-link
  // routing, not a swept tube — leave those blocks untouched.
  if (t.includes('BAND') || t.includes('CHAIN') || t.includes('TREAD') || t.includes('TRACK')) return false;
  return /HOSE|TUBE|PNEUMATIC|RIBBED|CABLE|ELECTRIC|FLEX|FIBER|FIBRE|STRING/.test(t);
}

// ─── vector helpers ───────────────────────────────────────────────────────────
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm(a: Vec3): Vec3 {
  const l = len(a);
  return l < 1e-9 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Sample a centripetal Catmull-Rom spline through `pts` at ~`spacing` LDU.
 * Centripetal (alpha=0.5) avoids the cusps/overshoot uniform Catmull-Rom gets
 * on unevenly-spaced control points — important for hoses with tight bends.
 * Returns path points (always includes the exact endpoints).
 */
export function sampleSpline(pts: Vec3[], spacing: number): Vec3[] {
  if (pts.length < 2) return pts.slice();
  if (pts.length === 2) {
    const out: Vec3[] = [];
    const d = len(sub(pts[1], pts[0]));
    const n = Math.max(1, Math.round(d / spacing));
    for (let i = 0; i <= n; i++) out.push(add(pts[0], scale(sub(pts[1], pts[0]), i / n)));
    return out;
  }
  // Pad ends by reflection so the curve reaches the true endpoints.
  const P = [add(pts[0], sub(pts[0], pts[1])), ...pts, add(pts[pts.length - 1], sub(pts[pts.length - 1], pts[pts.length - 2]))];
  const out: Vec3[] = [pts[0]];
  const tj = (ti: number, a: Vec3, b: Vec3) => ti + Math.pow(Math.max(1e-6, len(sub(b, a))), 0.5);
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    const segLen = len(sub(p2, p1));
    const steps = Math.max(1, Math.round(segLen / spacing));
    for (let s = 1; s <= steps; s++) {
      const t = t1 + (t2 - t1) * (s / steps);
      const A1 = add(scale(p0, (t1 - t) / (t1 - t0)), scale(p1, (t - t0) / (t1 - t0)));
      const A2 = add(scale(p1, (t2 - t) / (t2 - t1)), scale(p2, (t - t1) / (t2 - t1)));
      const A3 = add(scale(p2, (t3 - t) / (t3 - t2)), scale(p3, (t - t2) / (t3 - t2)));
      const B1 = add(scale(A1, (t2 - t) / (t2 - t0)), scale(A2, (t - t0) / (t2 - t0)));
      const B2 = add(scale(A2, (t3 - t) / (t3 - t1)), scale(A3, (t - t1) / (t3 - t1)));
      const C = add(scale(B1, (t2 - t) / (t2 - t1)), scale(B2, (t - t1) / (t2 - t1)));
      out.push(C);
    }
  }
  return out;
}

/**
 * Sweep a circular cross-section of `radius` along `path`, returning LDraw
 * type-3 triangle lines (colour 16 = inherit). Uses a rotation-minimizing
 * (parallel-transport) frame so the tube doesn't twist, plus end caps.
 */
export function sweepTube(path: Vec3[], radius: number, sides = 8): string[] {
  if (path.length < 2) return [];
  // Tangents (central differences).
  const tang: Vec3[] = path.map((_, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    return norm(sub(b, a));
  });
  // Initial frame: any vector not parallel to the first tangent.
  let ref: Vec3 = Math.abs(tang[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let normal = norm(sub(ref, scale(tang[0], dot(ref, tang[0]))));
  const rings: Vec3[][] = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      // Parallel-transport the normal across the tangent change.
      const axis = cross(tang[i - 1], tang[i]);
      const sinT = len(axis);
      if (sinT > 1e-6) {
        const a = norm(axis);
        const cosT = Math.max(-1, Math.min(1, dot(tang[i - 1], tang[i])));
        const ang = Math.atan2(sinT, cosT);
        normal = rotateAround(normal, a, ang);
      }
      normal = norm(sub(normal, scale(tang[i], dot(normal, tang[i]))));
    }
    const binormal = norm(cross(tang[i], normal));
    const ring: Vec3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const off = add(scale(normal, Math.cos(a) * radius), scale(binormal, Math.sin(a) * radius));
      ring.push(add(path[i], off));
    }
    rings.push(ring);
  }
  const lines: string[] = [];
  const tri = (p: Vec3, q: Vec3, r: Vec3) =>
    `3 16 ${fmt(p)} ${fmt(q)} ${fmt(r)}`;
  // Side quads → 2 tris each.
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a = rings[i][s], b = rings[i][s2], c = rings[i + 1][s2], d = rings[i + 1][s];
      lines.push(tri(a, b, c), tri(a, c, d));
    }
  }
  // End caps (fan to ring centroid = path endpoint).
  for (const [end, ring] of [[path[0], rings[0]], [path[path.length - 1], rings[rings.length - 1]]] as [Vec3, Vec3[]][]) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      lines.push(tri(end, ring[s2], ring[s]));
    }
  }
  return lines;
}

function rotateAround(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  // Rodrigues
  return add(
    add(scale(v, c), scale(cross(axis, v), s)),
    scale(axis, dot(axis, v) * (1 - c)),
  );
}

const fmt = (p: Vec3): string => `${trim(p[0])} ${trim(p[1])} ${trim(p[2])}`;
const trim = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

interface Constraint { pos: Vec3; }

/** Parse the oriented constraint points inside one SYNTH block body. */
function parseConstraints(bodyLines: string[]): Constraint[] {
  const out: Constraint[] = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    // Constraints are type-1 refs. MLCAD-hidden ones (`0 MLCAD HIDE 1 …`) also
    // count — strip the prefix so a pre-hidden constraint list still synthesizes.
    const m = /^(?:0\s+MLCAD\s+HIDE\s+)?1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:\S+\s+){9}(\S+)\s*$/i.exec(line);
    if (!m) continue;
    const x = +m[2], y = +m[3], z = +m[4];
    if (!Number.isFinite(x + y + z)) continue;
    out.push({ pos: [x, y, z] });
  }
  return out;
}

let synthCounter = 0;

/**
 * Rewrite unsynthesized `0 SYNTH BEGIN … END` tube blocks in an MPD/LDR string
 * into a reference + generated inline tube part. Returns the new text and how
 * many blocks were synthesized (0 → input returned unchanged).
 *
 * Safe by construction: blocks containing `SYNTH SYNTHESIZED` (already done),
 * non-tube types (bands/chains), or fewer than 2 constraints are left intact.
 */
export function synthesizeLSynth(text: string): { text: string; count: number } {
  if (!/^\s*0\s+SYNTH\s+BEGIN/im.test(text)) return { text, count: 0 };
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const generated: string[] = [];
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const begin = /^\s*0\s+SYNTH\s+BEGIN\s+(\S+)\s+(-?\d+)/i.exec(lines[i]);
    if (!begin) { out.push(lines[i]); continue; }
    // Collect block body up to SYNTH END.
    const type = begin[1], color = begin[2];
    const body: string[] = [];
    let j = i + 1;
    let synthesized = false;
    for (; j < lines.length; j++) {
      if (/^\s*0\s+SYNTH\s+SYNTHESIZED/i.test(lines[j])) synthesized = true;
      if (/^\s*0\s+SYNTH\s+END/i.test(lines[j])) break;
      body.push(lines[j]);
    }
    // Already synthesized, unknown type, or unterminated → emit block verbatim.
    if (synthesized || !isTubeType(type) || j >= lines.length) {
      out.push(lines[i]);
      for (const b of body) out.push(b);
      if (j < lines.length) out.push(lines[j]);
      i = j;
      continue;
    }
    const constraints = parseConstraints(body);
    if (constraints.length < 2) { // nothing to route — keep verbatim
      out.push(lines[i]); for (const b of body) out.push(b);
      out.push(lines[j]); i = j; continue;
    }
    const radius = radiusForType(type);
    const path = sampleSpline(constraints.map(c => c.pos), Math.max(2, radius));
    const tris = sweepTube(path, radius);
    if (tris.length === 0) { out.push(lines[i]); for (const b of body) out.push(b); out.push(lines[j]); i = j; continue; }
    const name = `lsynth-${synthCounter++}.dat`;
    // Tag as Unofficial_Part so the parser treats the reference as a TERMINAL
    // brick (emitting one ParsedBrick) instead of recursing into it as an
    // assembly — the geometry-only body has no type-1 lines, so recursion would
    // drop it. This mirrors how pre-synthesized OMR LSxx segment parts are tagged.
    generated.push(`0 FILE ${name}`, `0 Synthesized LSynth ${type}`, '0 !LDRAW_ORG Unofficial_Part', '0 BFC CERTIFY CCW', ...tris, '');
    // Replace the whole block with one reference to the generated tube (world
    // coords already baked into the triangles → identity placement).
    out.push(`1 ${color} 0 0 0 1 0 0 0 1 0 0 0 1 ${name}`);
    count++;
    i = j;
  }
  if (count === 0) return { text, count: 0 };
  // Append generated inline parts so MPD inline-resolution finds them.
  return { text: out.join('\n') + '\n' + generated.join('\n'), count };
}
