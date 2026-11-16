/**
 * Offline render-fault audit of a BUILT pack: what the device will draw badly,
 * measured from the pack's own geometry instead of found on a phone.
 *
 * Fault classes, each a number that a gate can hold:
 *
 *   coplanar   Two drawn faces with the same outward normal, on the same plane
 *              (within `planeEps` model units), overlapping by a positive area,
 *              in DIFFERENT colours. The depth test cannot order them, so the
 *              winner flips per pixel and per frame: the diagonal hatching and
 *              "strobing" a user reports. Same-colour overlaps draw identically
 *              and are counted apart (`sameColour`), not as faults.
 *   thin       A cube with an extent at or below `thinUnits` on some axis: its
 *              two opposite faces are coplanar with each other and the part
 *              tears at every silhouette.
 *
 * Every measurement is taken in ONE frame for every actor drawn together: the
 * geometry JSON's own coordinates (model units), each actor translated to its
 * placement (model blocks from the placement corner, x16) and turned by its
 * yaw, the bone chain composed about each pivot (`pivotRotation`, the ONE
 * implementation of Bedrock's rotation convention here, shared by the preview
 * and the LOD hull), a cube's own rotation about its own pivot first. Only the NEAR geometry of each controller is drawn (the LOD
 * hull's `<=` controllers draw only past their switch distance, see
 * `AppearanceGroup.far`), which is exactly what the player sees up close.
 *
 * Pure: no DOM, no Three.js; runs in vitest, scripts, the preview and the compiler.
 */
/** A bone as a geometry declares it (model units, degrees). Structurally the preview's `AppearanceBone`. */
export interface GeoBoneLike {
  name: string;
  pivot: [number, number, number];
  rotation?: [number, number, number];
  parent?: string;
}

/** A cube as a geometry declares it. Structurally the preview's `AppearanceCube`. */
export interface GeoCubeLike {
  bone: string;
  origin: [number, number, number];
  size: [number, number, number];
  rotation?: [number, number, number];
  pivot?: [number, number, number];
  faceUv?: { face: BedrockFace; uv: [number, number]; size: [number, number] };
  /** The size the JSON declares when it carries an `inflate` (`origin`/`size` are then the drawn box). */
  uvSize?: [number, number, number];
}

/**
 * The box a geometry JSON cube DRAWS: `inflate` grows the declared box on
 * every side, so the drawn box is `origin - inflate`, `size + 2 * inflate`.
 * The compiler declares every box-UV cube under one unit as size + 2 with
 * inflate -1 (`boxUvSafeCube`, ldraw-entity-compiler.ts) - the same drawn box,
 * but anything reading `origin`/`size` straight from a `.geo.json` would see it
 * one unit larger on every side. Every reader of shipped cubes goes through
 * this. `declared` is the size the device lays the box UV out from.
 */
export function drawnCubeBox(cube: { origin: readonly number[]; size: readonly number[]; inflate?: unknown }): { origin: [number, number, number]; size: [number, number, number]; declared: [number, number, number]; inflated: boolean } {
  const k = typeof cube.inflate === 'number' && Number.isFinite(cube.inflate) ? cube.inflate : 0;
  const o = cube.origin, s = cube.size;
  return {
    origin: [o[0]! - k, o[1]! - k, o[2]! - k],
    size: [s[0]! + 2 * k, s[1]! + 2 * k, s[2]! + 2 * k],
    declared: [s[0]!, s[1]!, s[2]!],
    inflated: k !== 0,
  };
}

/** One colour's cubes (one swatch, or a face atlas). Structurally the preview's `AppearanceGroup`. */
export interface GeoGroupLike {
  ldrawColor: number | null;
  alpha: number;
  cubes: GeoCubeLike[];
  texture?: { path: string };
  far?: boolean;
}

/** Everything one entity draws. Structurally the preview's `AddonAppearanceEntry`. */
export interface GeoEntryLike { groups: GeoGroupLike[]; bones: GeoBoneLike[] }

type AddonAppearanceEntry = GeoEntryLike;
type AppearanceBone = GeoBoneLike;
type AppearanceCube = GeoCubeLike;

export type Vec3 = [number, number, number];
export type BedrockFace = 'west' | 'east' | 'up' | 'down' | 'south' | 'north';
/** Row-major 3x4 affine matrix: [r00 r01 r02 t0, r10 r11 r12 t1, r20 r21 r22 t2]. */
export type Affine = number[];

const DEG = Math.PI / 180;

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** a · b for affines. */
export function mul(a: Affine, b: Affine): Affine {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let s = c === 3 ? a[r * 4 + 3]! : 0;
      for (let k = 0; k < 3; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
      o[r * 4 + c] = s;
    }
  }
  return o;
}

export function apply(m: Affine, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
    m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
    m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
  ];
}

const translate = (x: number, y: number, z: number): Affine => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];

/**
 * A Bedrock bone/cube rotation about `pivot`, as a matrix in the JSON's own
 * coordinates (the frame the cube origins are written in).
 *
 * The compiler works in a right-handed render frame and writes a rotation
 * `M = Rz(c)·Ry(b)·Rx(a)` as JSON `(−a, −b, c)` with every X coordinate
 * mirrored (Blockbench's Bedrock codec; `ldraw-entity-compiler.ts` header).
 * Mirroring X conjugates a rotation: `S·Rx(a)·S = Rx(a)`, `S·Ry(b)·S =
 * Ry(−b)`, `S·Rz(c)·S = Rz(−c)`, so in JSON coordinates the same turn is
 * `Rz(−c)·Ry(−b)·Rx(a)` = **`Rz(−rz)·Ry(ry)·Rx(−rx)`** of the JSON angles.
 * Checked by rendering 76417 (2026-09-25): with it every rotated roof tile and
 * wall panel lies flush; with the preview's former `Rz(−rz)·Ry(−ry)·Rx(rx)`
 * they stood out of the building at their doubled pitch.
 */
export function pivotRotation(rotationDeg: Vec3, pivot: Vec3): Affine {
  const [rxd, ryd, rzd] = rotationDeg;
  if (!rxd && !ryd && !rzd) return IDENTITY;
  const a = -rxd * DEG, b = ryd * DEG, c = -rzd * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  const rx: Affine = [1, 0, 0, 0, 0, ca, -sa, 0, 0, sa, ca, 0];
  const ry: Affine = [cb, 0, sb, 0, 0, 1, 0, 0, -sb, 0, cb, 0];
  const rz: Affine = [cc, -sc, 0, 0, sc, cc, 0, 0, 0, 0, 1, 0];
  const r = mul(rz, mul(ry, rx));
  return mul(translate(pivot[0], pivot[1], pivot[2]), mul(r, translate(-pivot[0], -pivot[1], -pivot[2])));
}

/** A bone's animated pose this frame (structurally the preview's `BonePose`): degrees and model units added, a scale multiplied. */
export interface AnimatedBonePose { rotation: readonly [number, number, number]; position: readonly [number, number, number]; scale: readonly [number, number, number] }

/** Every bone's model-space transform, composed up the parent chain. */
export function boneTransforms(bones: readonly AppearanceBone[], overlay?: ReadonlyMap<string, readonly [number, number, number]>, poses?: ReadonlyMap<string, AnimatedBonePose>): Map<string, Affine> {
  const byName = new Map(bones.map(b => [b.name, b]));
  const done = new Map<string, Affine>();
  const resolve = (name: string, seen: Set<string>): Affine => {
    const hit = done.get(name);
    if (hit) return hit;
    const bone = byName.get(name);
    if (!bone || seen.has(name)) { done.set(name, IDENTITY); return IDENTITY; }
    seen.add(name);
    const parent = bone.parent ? resolve(bone.parent, seen) : IDENTITY;
    const add = overlay?.get(name), pose = poses?.get(name);
    const [brx, bry, brz] = bone.rotation ?? [0, 0, 0];
    const turn: Vec3 = [brx + (add?.[0] ?? 0) + (pose?.rotation[0] ?? 0), bry + (add?.[1] ?? 0) + (pose?.rotation[1] ?? 0), brz + (add?.[2] ?? 0) + (pose?.rotation[2] ?? 0)];
    let local = pivotRotation(turn, bone.pivot);
    // An animated pose (the add-on preview's `poseBones`, measured on the Pixel for the pinball ball, 2026-09-25):
    // T(animated position) · T(pivot) · R(bind + animated) · S(animated) · T(-pivot), the position in the geometry
    // JSON's own frame.
    if (pose) {
      const [sx, sy, sz] = pose.scale;
      if (sx !== 1 || sy !== 1 || sz !== 1) {
        const [px, py, pz] = bone.pivot;
        local = mul(local, mul(translate(px, py, pz), mul([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0], translate(-px, -py, -pz))));
      }
      const [tx, ty, tz] = pose.position;
      if (tx || ty || tz) local = mul(translate(tx, ty, tz), local);
    }
    const world = mul(parent, local);
    done.set(name, world);
    return world;
  };
  for (const b of bones) resolve(b.name, new Set());
  return done;
}

/**
 * Geometry-JSON cube faces as corner indices (bit0 = +x, bit1 = +y,
 * bit2 = +z), ordered outward CCW. Blockbench mirrors numeric X when it
 * exports Bedrock geometry but preserves face keys: JSON `east` is therefore
 * the numeric -X plane and JSON `west` the numeric +X plane. Native device QA
 * confirmed that mapping with 10261's face atlas (2026-10-06).
 */
export const BEDROCK_FACE_CORNERS: Readonly<Record<BedrockFace, readonly [number, number, number, number]>> = {
  west: [1, 3, 7, 5],
  east: [0, 4, 6, 2],
  up: [2, 6, 7, 3],
  down: [0, 1, 5, 4],
  south: [4, 5, 7, 6],
  north: [0, 2, 3, 1],
};

const FACES: ReadonlyArray<{ idx: readonly [number, number, number, number]; name: BedrockFace }> = [
  { idx: BEDROCK_FACE_CORNERS.west, name: 'west' },
  { idx: BEDROCK_FACE_CORNERS.east, name: 'east' },
  { idx: BEDROCK_FACE_CORNERS.up, name: 'up' },
  { idx: BEDROCK_FACE_CORNERS.down, name: 'down' },
  { idx: BEDROCK_FACE_CORNERS.south, name: 'south' },
  { idx: BEDROCK_FACE_CORNERS.north, name: 'north' },
];

/** The eight corners of a cube in the frame `m` maps into, after the cube's own pivot rotation. */
export function cubeCorners(c: AppearanceCube, m: Affine): Vec3[] {
  const [ox, oy, oz] = c.origin, [sx, sy, sz] = c.size;
  const local = c.rotation && c.pivot ? mul(m, pivotRotation(c.rotation, c.pivot)) : m;
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) out.push(apply(local, [ox + (i & 1 ? sx : 0), oy + (i & 2 ? sy : 0), oz + (i & 4 ? sz : 0)]));
  return out;
}

/** A drawn face in the shared frame. */
export interface WorldFace {
  /** Index of the actor (placement order) and of the colour group within it. */
  actor: number;
  group: number;
  /** Index of the cube within its group, and the face's name. */
  cube: number;
  face: string;
  /** Colour key: faces with the same key draw the same texels. */
  colour: string;
  normal: Vec3;
  /** Plane offset: normal · p. */
  d: number;
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** A decal face's texel coordinates per corner (Bedrock per-face UV), for a renderer. */
  uv?: [[number, number], [number, number], [number, number], [number, number]];
}

/**
 * Texel coordinate of a local cube corner on a per-face-UV face. In JSON terms
 * (head-face.ts `orientFace`): north runs u along +X, south along -X, east
 * along -Z, west along +Z, and v runs down (-Y) on all four; up/down run u
 * along +X and v along +Z.
 */
export function bedrockFaceUv(
  f: { face: BedrockFace; uv: readonly [number, number]; size: readonly [number, number] },
  corner: number,
): [number, number] {
  const x = corner & 1 ? 1 : 0, y = corner & 2 ? 1 : 0, z = corner & 4 ? 1 : 0;
  const along = f.face === 'north' ? x : f.face === 'south' ? 1 - x : f.face === 'east' ? 1 - z : f.face === 'west' ? z : x;
  const down = f.face === 'up' || f.face === 'down' ? z : 1 - y;
  return [f.uv[0] + along * f.size[0], f.uv[1] + down * f.size[1]];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** An actor to audit: its appearance, its placement and its pose. */
export interface AuditActor {
  typeId: string;
  kind: string;
  entry: AddonAppearanceEntry;
  /** Placement in the shared frame: model blocks → the audit works in 1/16 block units, so this is ×16 by the caller or here. */
  at: { x: number; y: number; z: number };
  /** The actor's BEDROCK yaw, degrees (0 faces +Z, 90 faces -X): what the placement sets (`actor.yaw + rotation`). */
  yawDeg: number;
  /** Uniform actor size; applies to geometry and bone/cube pivots, not placement. */
  scale?: number;
  overlay?: ReadonlyMap<string, readonly [number, number, number]>;
  /** This frame's animated bone poses (a client's `query.property`-driven bones: a coaster car's pitch, roll and body offset). */
  poses?: ReadonlyMap<string, AnimatedBonePose>;
  /** Bones not drawn (a coaster car's inactive rider variants). */
  hideBone?: (bone: string) => boolean;
}

/** Colour key of a group: the swatch, or the face atlas a decal samples. */
export function groupColourKey(g: AddonAppearanceEntry['groups'][number]): string {
  return g.texture ? `tex:${g.texture.path}` : `c:${g.ldrawColor ?? 'x'}:${g.alpha}`;
}

/**
 * The drawn faces of every actor, in 1/16-block units of the shared frame.
 * A face-UV (decal) cube draws its one face only; a box-UV cube all six.
 * Far-only groups (the LOD hull) are skipped, or ONLY they are drawn with
 * `far` (what the client shows past the switch distance).
 */
export function worldFaces(actors: readonly AuditActor[], options: { far?: boolean } = {}): WorldFace[] {
  const out: WorldFace[] = [];
  actors.forEach((a, actor) => {
    const bones = boneTransforms(a.entry.bones, a.overlay, a.poses);
    // Actor frame: translate to its placement (×16: model units) and turn by its Bedrock yaw about +Y. Bedrock's
    // yaw turns +X toward +Z (yaw 90: the model's +X runs along world +Z, as the wand's `rotatePlacementPoint`
    // turns the colliders), which is three.js `rotation.y` by the NEGATED angle. Until 2026-09-30 the angle was
    // not negated: every actor with a yaw drew turned the other way - a shell placed at 90 degrees put 1.9 % of
    // its collider blocks near drawn geometry, against 99.8 % negated (`output/sim-triage-0930/probes/yaw-check.ts`
    // on 11371). `_pack_render`, `_render_fault_audit` and `_ix_sealed_causes` pass the Bedrock yaw.
    const y = -a.yawDeg * DEG, cy = Math.cos(y), sy = Math.sin(y);
    // Geometry JSON → world: the game's world is the JSON frame with Z
    // mirrored (`Sz`), then the actor's yaw about +Y, then its placement.
    const scale = a.scale ?? 1;
    const place: Affine = [cy * scale, 0, -sy * scale, a.at.x * 16, 0, scale, 0, a.at.y * 16, -sy * scale, 0, -cy * scale, a.at.z * 16];
    a.entry.groups.forEach((g, group) => {
      if (!!g.far !== !!options.far) return;
      const colour = groupColourKey(g);
      g.cubes.forEach((c, cube) => {
        if (a.hideBone?.(c.bone)) return;
        const m = mul(place, bones.get(c.bone) ?? IDENTITY);
        const k = cubeCorners(c, m);
        for (const f of FACES) {
          if (c.faceUv && c.faceUv.face !== f.name) continue;
          const q: [Vec3, Vec3, Vec3, Vec3] = [k[f.idx[0]]!, k[f.idx[1]]!, k[f.idx[2]]!, k[f.idx[3]]!];
          // Outward normal from the corner winding; a degenerate (zero-size) face takes the axis it would have.
          let n = cross(sub(q[1], q[0]), sub(q[3], q[0]));
          if (Math.hypot(n[0], n[1], n[2]) < 1e-9) continue;
          // The Z mirror reverses every winding: turn the normal back outward.
          n = norm(n);
          n = [-n[0], -n[1], -n[2]];
          const face: WorldFace = { actor, group, cube, face: f.name, colour, normal: n, d: dot(n, q[0]), corners: q };
          if (c.faceUv) face.uv = [bedrockFaceUv(c.faceUv, f.idx[0]), bedrockFaceUv(c.faceUv, f.idx[1]), bedrockFaceUv(c.faceUv, f.idx[2]), bedrockFaceUv(c.faceUv, f.idx[3])];
          out.push(face);
        }
      });
    });
  });
  return out;
}

/** A 2D basis for a plane with unit normal n. */
function planeBasis(n: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(n, a));
  return [u, cross(n, u)];
}

type P2 = [number, number];

/** Signed area of a 2D polygon (shoelace). */
function area2(poly: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

/** Sutherland–Hodgman clip of `subject` by the convex CCW polygon `clip`. */
function clipPolygon(subject: readonly P2[], clip: readonly P2[]): P2[] {
  let out: P2[] = subject.slice();
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]!, b = clip[(i + 1) % clip.length]!;
    const inside = (p: P2): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!, q = input[(j + 1) % input.length]!;
      const ip = inside(p), iq = inside(q);
      if (ip >= 0) out.push(p);
      if ((ip >= 0) !== (iq >= 0)) {
        const t = ip / (ip - iq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/** Overlap area of two coplanar quads (model units²). */
export function overlapArea(a: WorldFace, b: WorldFace): number {
  const [u, v] = planeBasis(a.normal);
  const proj = (q: readonly Vec3[]): P2[] => {
    const p = q.map(c => [dot(c, u), dot(c, v)] as P2);
    return area2(p) < 0 ? p.reverse() : p;
  };
  const pa = proj(a.corners), pb = proj(b.corners);
  const clipped = clipPolygon(pa, pb);
  return clipped.length >= 3 ? Math.abs(area2(clipped)) : 0;
}

export interface CoplanarHit {
  a: { actor: number; colour: string; group: number; cube: number; face: string };
  b: { actor: number; colour: string; group: number; cube: number; face: string };
  /** Overlap area, model units² (256 = one block face). */
  area: number;
  /** The least distance between the two planes over the overlap, model units (0 = they touch or cross there). */
  gap: number;
  /**
   * How far face `a` stands IN FRONT of face `b`'s plane over the overlap, at its worst corner (model units, along
   * `b`'s normal; negative = behind). Two planes a fraction of a degree apart (two Euler spellings of one tilt) are
   * not parallel, so a plane-offset difference measured at the frame's origin is not the distance where they overlap.
   */
  lead: number;
  /** The same for face `b` in front of face `a`'s plane. */
  leadBack: number;
  /** A point of the overlap region in the shared frame, blocks. */
  at: Vec3;
  normal: Vec3;
}

export interface CoplanarOptions {
  /** Planes closer than this (model units) fight. Default 0.02 (1/800 block). */
  planeEps?: number;
  /** Ignore overlaps smaller than this (model units²). Default 0.01. */
  minArea?: number;
}

/** The overlap of two (near-)coplanar quads as a polygon on the first face's plane, model units; empty when none. */
function overlapPolygon(a: WorldFace, b: WorldFace): { area: number; points: Vec3[] } {
  const [u, v] = planeBasis(a.normal);
  const proj = (q: readonly Vec3[]): P2[] => {
    const p = q.map(c => [dot(c, u), dot(c, v)] as P2);
    return area2(p) < 0 ? p.reverse() : p;
  };
  const clipped = clipPolygon(proj(a.corners), proj(b.corners));
  if (clipped.length < 3) return { area: 0, points: [] };
  // Back onto the first face's plane: p = s·u + t·v + d·n (u, v, n orthonormal).
  const points = clipped.map(([s, t]): Vec3 => [
    s * u[0] + t * v[0] + a.d * a.normal[0], s * u[1] + t * v[1] + a.d * a.normal[1], s * u[2] + t * v[2] + a.d * a.normal[2],
  ]);
  return { area: Math.abs(area2(clipped)), points };
}

/**
 * Every pair of drawn faces that share a plane and a facing, overlap by a
 * positive area and differ in colour (`hits`), plus the same-colour total.
 *
 * Candidates: faces are grouped by their normal quantised to 1e-3 per component, and a group is measured together
 * with the 26 groups one step away (two Euler spellings of one tilt round their normals either side of a step:
 * 76269's turned floor, A-17). Within that pool the faces are cut into runs that touch along the normal's dominant
 * axis (each face's extent on that axis, widened by `planeEps`), and each run is swept over its 2-D boxes in the
 * plane. The distance between two planes is then measured WHERE THEY OVERLAP (`lead`), never as the difference of
 * their plane offsets: two planes 0.026 degrees apart differ by 0.04 units in offset at the frame's origin and by
 * 0.007 at the model 20 blocks out, so the offset test found 23 of a 76269 chunk's 133 pairs at the origin and all
 * of them at its placement - and the compile, which measures at the origin, left the rest.
 */
export function coplanarFaces(faces: readonly WorldFace[], options: CoplanarOptions = {}): { hits: CoplanarHit[]; sameColourArea: number } {
  const eps = options.planeEps ?? 0.02, minArea = options.minArea ?? 0.01;
  const q = (x: number): number => Math.round(x / 1e-3);
  const nkey = (a: number, b: number, c: number): string => `${a},${b},${c}`;
  const groups = new Map<string, { n: [number, number, number]; list: number[] }>();
  faces.forEach((f, i) => {
    const n: [number, number, number] = [q(f.normal[0]), q(f.normal[1]), q(f.normal[2])];
    const key = nkey(...n);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { n, list: [] });
    g.list.push(i);
  });
  // Each face's box, once.
  const lo = new Float64Array(faces.length * 3), hi = new Float64Array(faces.length * 3);
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      let a = Infinity, b = -Infinity;
      for (const c of f.corners) { if (c[k]! < a) a = c[k]!; if (c[k]! > b) b = c[k]!; }
      lo[i * 3 + k] = a; hi[i * 3 + k] = b;
    }
  });
  const hits: CoplanarHit[] = [];
  let sameColourArea = 0;
  const seenPair = new Set<string>();
  for (const { n: [nx, ny, nz], list } of groups.values()) {
    const pool = [...list];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      if (a === 0 && b === 0 && c === 0) continue;
      const other = groups.get(nkey(nx + a, ny + b, nz + c));
      if (other) pool.push(...other.list);
    }
    const inList = new Set(list);
    const f0 = faces[list[0]!]!;
    const ax = Math.abs(f0.normal[0]), ay = Math.abs(f0.normal[1]), az = Math.abs(f0.normal[2]);
    const k = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    pool.sort((i, j) => lo[i * 3 + k]! - lo[j * 3 + k]!);
    const [u, v] = planeBasis(f0.normal);
    // Runs of faces whose extents on the dominant axis touch (within eps): only they can share a plane.
    for (let start = 0; start < pool.length;) {
      let end = start + 1, reach = hi[pool[start]! * 3 + k]!;
      while (end < pool.length && lo[pool[end]! * 3 + k]! <= reach + eps) { reach = Math.max(reach, hi[pool[end]! * 3 + k]!); end++; }
      const run = pool.slice(start, end);
      start = end;
      if (run.length < 2 || !run.some(i => inList.has(i))) continue;
      const box = run.map(i => {
        const cs = faces[i]!.corners;
        const us = cs.map(p => dot(p, u)), vs = cs.map(p => dot(p, v));
        return { i, u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
      }).sort((a, b) => a.u0 - b.u0);
      for (let x = 0; x < box.length; x++) {
        const A = box[x]!;
        for (let y = x + 1; y < box.length && box[y]!.u0 < A.u1 - 1e-6; y++) {
          const B = box[y]!;
          // A pair with neither face in this group is another group's business.
          if (!inList.has(A.i) && !inList.has(B.i)) continue;
          if (B.v0 >= A.v1 - 1e-6 || A.v0 >= B.v1 - 1e-6) continue;
          // Boxes apart by more than eps on any axis cannot share a plane over an overlap.
          let apart = false;
          for (let t = 0; t < 3 && !apart; t++) apart = lo[B.i * 3 + t]! > hi[A.i * 3 + t]! + eps || lo[A.i * 3 + t]! > hi[B.i * 3 + t]! + eps;
          if (apart) continue;
          const pk = A.i < B.i ? `${A.i}:${B.i}` : `${B.i}:${A.i}`;
          if (seenPair.has(pk)) continue;
          seenPair.add(pk);
          const fa = faces[A.i]!, fb = faces[B.i]!;
          const { area, points } = overlapPolygon(fa, fb);
          if (area < minArea) continue;
          // The first face's plane over the overlap, measured against the second's plane along its normal.
          let smin = Infinity, smax = -Infinity;
          for (const p of points) { const s = dot(fb.normal, p) - fb.d; if (s < smin) smin = s; if (s > smax) smax = s; }
          const gap = smin > 0 ? smin : smax < 0 ? -smax : 0;
          if (gap > eps) continue;
          if (fa.colour === fb.colour) { sameColourArea += area; continue; }
          const cosab = dot(fa.normal, fb.normal);
          const c = points.reduce<Vec3>((s, p) => [s[0] + p[0] / points.length, s[1] + p[1] / points.length, s[2] + p[2] / points.length], [0, 0, 0]);
          hits.push({
            a: { actor: fa.actor, colour: fa.colour, group: fa.group, cube: fa.cube, face: fa.face },
            b: { actor: fb.actor, colour: fb.colour, group: fb.group, cube: fb.cube, face: fb.face },
            area, gap, lead: smin, leadBack: Math.min(-smin * cosab, -smax * cosab), at: [c[0] / 16, c[1] / 16, c[2] / 16], normal: fa.normal,
          });
        }
      }
    }
  }
  return { hits, sameColourArea };
}

/** Cubes thinner than `thinUnits` on an axis (both faces of that axis coincide on screen). */
export function thinCubes(entry: AddonAppearanceEntry, thinUnits = 0.01): number {
  let n = 0;
  for (const g of entry.groups) {
    if (g.far) continue;
    for (const c of g.cubes) if (!c.faceUv && Math.min(Math.abs(c.size[0]), Math.abs(c.size[1]), Math.abs(c.size[2])) <= thinUnits) n++;
  }
  return n;
}

// ─── Separating coplanar faces at export ─────────────────────────────────────

/**
 * How far (model units, 16 = one block) the WINNING face of a coplanar pair is
 * pushed out past the other: 0.15 units = 1/107 block = 0.5 LDU. The two faces
 * then no longer share a depth, so the depth test orders them the same way on
 * every pixel and every frame instead of hatching.
 *
 * Sized against a 24-bit depth buffer: at distance z (blocks) with a near
 * plane n ~ 0.05 the depth step is about z^2 / (n * 2^24) blocks, so 1/107
 * block separates the faces out to ~85 blocks, past which a brick face is a
 * few pixels and the LOD hull takes over (`lodDistance` 96 plus the reach).
 * It is below what the eye can see up close: a stud is 4 LDU tall.
 */
export const COPLANAR_SEPARATION_UNITS = 0.15;

/** Two opposite faces this close (model units) are in contact. */
const CONTACT_EPS = 0.02;

/** Per cube face: which JSON cube side it is. `max` sides grow by adding to size; `min` sides also move the origin. */
const FACE_SIDE: Record<string, { axis: 0 | 1 | 2; max: boolean }> = {
  west: { axis: 0, max: true }, east: { axis: 0, max: false },
  up: { axis: 1, max: true }, down: { axis: 1, max: false },
  south: { axis: 2, max: true }, north: { axis: 2, max: false },
};

/** Area of a face quad (model units squared). */
const faceArea = (q: readonly Vec3[]): number => Math.hypot(...cross(sub(q[1]!, q[0]!), sub(q[3]!, q[0]!)));

/**
 * A test for faces pressed flat against another cube's OPPOSITE face over
 * (almost) their whole area - the top of a stud under a brick, two plates
 * stacked. Such a face is buried: a coplanar fight on it is never seen, so
 * neither the separation nor the audit counts it.
 */
export function buriedFaceTest(faces: readonly WorldFace[]): (f: WorldFace) => boolean {
  // Faces are indexed by normal (quantised to 1e-3) and by the 16-unit cells their boxes cover; a query looks at the
  // 27 normal buckets around its OPPOSITE normal and the cells its own box covers, and measures the contact over the
  // overlap. Until 2026-11-15 the index was the plane offset `d`, which for two nearly parallel faces (two Euler
  // spellings of one tilt) depends on where the model stands: 75397's boat shipped 25 pairs the compile, measuring at
  // the frame's origin, had judged buried (A-17).
  const G = 16;
  const q = (x: number): number => Math.round(x * 1e3);
  const boxOf = (f: WorldFace): number[] => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const c of f.corners) for (let k = 0; k < 3; k++) { if (c[k]! < b[k]!) b[k] = c[k]!; if (c[k]! > b[k + 3]!) b[k + 3] = c[k]!; }
    return b;
  };
  const cellsOf = (b: number[], pad: number, visit: (key: string) => void): void => {
    for (let x = Math.floor((b[0]! - pad) / G); x <= Math.floor((b[3]! + pad) / G); x++)
      for (let y = Math.floor((b[1]! - pad) / G); y <= Math.floor((b[4]! + pad) / G); y++)
        for (let z = Math.floor((b[2]! - pad) / G); z <= Math.floor((b[5]! + pad) / G); z++) visit(`${x},${y},${z}`);
  };
  // Faces by normal now; each normal's cell grid only when a query first needs it (the separation asks about the few
  // faces of its pairs, and building every grid for a 250,000-face entity each pass cost seconds).
  const byNormal = new Map<string, WorldFace[]>();
  for (const f of faces) {
    const nk = `${q(f.normal[0])},${q(f.normal[1])},${q(f.normal[2])}`;
    let l = byNormal.get(nk);
    if (!l) byNormal.set(nk, l = []);
    l.push(f);
  }
  const grids = new Map<string, Map<string, WorldFace[]>>();
  const gridOf = (nk: string): Map<string, WorldFace[]> | undefined => {
    let g = grids.get(nk);
    if (g) return g;
    const list = byNormal.get(nk);
    if (!list) return undefined;
    grids.set(nk, g = new Map());
    for (const f of list) cellsOf(boxOf(f), 0, cell => { let l = g!.get(cell); if (!l) g!.set(cell, l = []); l.push(f); });
    return g;
  };
  return (f: WorldFace): boolean => {
    const area = faceArea(f.corners);
    const n = [q(-f.normal[0]), q(-f.normal[1]), q(-f.normal[2])];
    const seen = new Set<WorldFace>();
    let hit = false;
    cellsOf(boxOf(f), CONTACT_EPS, cell => {
      if (hit) return;
      for (let a = -1; a <= 1 && !hit; a++) for (let b = -1; b <= 1 && !hit; b++) for (let c = -1; c <= 1 && !hit; c++) {
        for (const o of gridOf(`${n[0]! + a},${n[1]! + b},${n[2]! + c}`)?.get(cell) ?? []) {
          if (seen.has(o)) continue;
          seen.add(o);
          const { area: over, points } = overlapPolygon(f, o);
          if (over < area * 0.98) continue;
          // Pressed together over the whole overlap: every point of it within CONTACT_EPS of the other face's plane.
          if (points.every(p => Math.abs(dot(o.normal, p) - o.d) <= CONTACT_EPS)) { hit = true; break; }
        }
      }
    });
    return hit;
  };
}

/** The coplanar hits a player can see: neither face of the pair is buried (`buriedFaceTest`). */
export function visibleCoplanarHits(faces: readonly WorldFace[], options: CoplanarOptions = {}): CoplanarHit[] {
  const { hits } = coplanarFaces(faces, options);
  const buried = buriedFaceTest(faces);
  const byKey = new Map<string, WorldFace>();
  for (const f of faces) byKey.set(`${f.actor}:${f.group}:${f.cube}:${f.face}`, f);
  return hits.filter(h => !buried(byKey.get(`${h.a.actor}:${h.a.group}:${h.a.cube}:${h.a.face}`)!) && !buried(byKey.get(`${h.b.actor}:${h.b.group}:${h.b.cube}:${h.b.face}`)!));
}

export interface CoplanarSeparation {
  /** Visible different-colour coplanar overlaps found on the first pass (a pair pressed against a third face is buried and not counted). */
  pairsFound: number;
  /** Their total area, block faces (256 model units squared each). */
  areaFound: number;
  /** Cube faces pushed out. */
  facesGrown: number;
  /** Overlaps still present after the last pass. */
  pairsLeft: number;
  passes: number;
}

/**
 * How many times the separation re-measures and pushes again. A pushed face can land on the plane of a THIRD face
 * one separation further out (a tile on a plate on a slope, a stack of flush details), so the pushes form chains;
 * each pass settles one more link. Three passes (until 2026-11-15) left 530 pairs in 11374's shell and 8,509 over
 * the 40 favourites (A-17); re-separating those shipped shells settled every one within seven more passes
 * (`output/a17/resep.ts` in the audit-render worktree). The Time Machine body (10300, 250,000 faces) takes 9 pushing
 * passes; 16 leaves margin. Only the first pass and the closing check measure the whole entity (a pass after a push
 * looks near the moved faces, `separateCoplanarAgainst`), so a pass costs a fraction of the first, and an entity with
 * no pair pays for one pass, as before.
 */
export const COPLANAR_SEPARATION_MAX_PASSES = 16;

export interface CoplanarSeparationOptions {
  offset?: number; passes?: number; planeEps?: number;
  /**
   * The entity's own pairs were already separated (the compiler ran `separateCoplanarFaces` on it): a full pass then
   * looks only at its faces near the fixed neighbours, and an entity with no neighbour near it is left as it is.
   * The cross-entity pass sets it; re-measuring a 250,000-face car against nothing cost 5 s a build.
   */
  settledOwn?: boolean;
}

/**
 * Remove every different-colour coplanar overlap from ONE entity's geometry by
 * pushing the winning face of each pair out by `offset` (in place: the cubes'
 * `origin`/`size` are rewritten in their own bone frame, so a rotated bone's
 * cube moves along its own face normal).
 *
 * Which face wins is the one a builder would see: the SMALLER face of the two
 * (a tile, a plate or a print sunk flush into a larger surface is the detail
 * sitting on it; the larger surface is the ground it sits on), then the
 * smaller cube, then an opaque face over a translucent one, then the later
 * colour group so the choice is deterministic. Growing the detail rather than
 * insetting the surface keeps the surface's own edges where they were and can
 * never turn a thin cube inside out.
 *
 * Decal cubes (per-face UV) are never moved: they already stand proud of the
 * head (`DECAL_PROUD_LDU`). Far-only groups (the LOD hull) are left alone.
 * Runs up to `passes` times (`COPLANAR_SEPARATION_MAX_PASSES`), re-measuring,
 * because a pushed face can meet a third face; what is left is returned rather
 * than hidden.
 */
export function separateCoplanarFaces(entry: AddonAppearanceEntry, options: CoplanarSeparationOptions = {}): CoplanarSeparation {
  return separateCoplanarAgainst([{ typeId: 'self', kind: 'self', entry, at: { x: 0, y: 0, z: 0 }, yawDeg: 0 }], [], options);
}

/**
 * `separateCoplanarFaces` for an entity drawn among OTHER entities: `placements` are every placement of one entity
 * (all sharing one `entry`, the geometry that is rewritten) in the shared frame, and `fixed` the drawn faces of what
 * stands around them (`worldFaces` of the neighbours), which this pass may not move. A door leaf flush with its
 * frame, a turntable on its floor, a figure's foot on a plate: a separate entity's face on the shell's plane hatches
 * exactly as a pair inside one entity does (A-17: 13 of the 30.5 block faces left over the 40 favourites were such
 * pairs), but the shell is already shipped and shared by every neighbour, so it is the placed entity's face that is
 * pushed out - the detail in front of the surface it sits on, as the rule above picks inside an entity. A decal face
 * on a neighbour's plane cannot move and is counted as left.
 *
 * Pairs between two placements of the same entity are not separated (one cube draws both, so growing it moves
 * both faces), and pairs among the fixed faces are the neighbours' own business. The fixed faces are clipped to the
 * placements' reach once, so a door in a 500,000-face shell measures only the faces near it.
 */
export function separateCoplanarAgainst(placements: readonly AuditActor[], fixed: readonly WorldFace[], options: CoplanarSeparationOptions = {}): CoplanarSeparation {
  const offset = options.offset ?? COPLANAR_SEPARATION_UNITS;
  const maxPasses = options.passes ?? COPLANAR_SEPARATION_MAX_PASSES;
  const planeEps = Math.max(options.planeEps ?? 0.02, offset * 0.5);
  const entry = placements[0]!.entry;
  if (placements.some(p => p.entry !== entry)) throw new Error('separateCoplanarAgainst: every placement must share one entry (the geometry it rewrites).');
  const own = placements.length;
  const result: CoplanarSeparation = { pairsFound: 0, areaFound: 0, facesGrown: 0, pairsLeft: 0, passes: 0 };
  // The neighbours' faces that can meet this entity, re-indexed after the placements (`own + actor`) so keys never
  // collide: inside the entity's own box and on (or facing) one of its own planes, each widened by every push the
  // passes can make plus the plane tolerance. A face on no plane of the entity can neither pair with one of its faces
  // nor bury one (`buriedFaceTest` reads the opposite face on the same plane), so a door in a 500,000-face shell
  // measures a few hundred neighbours, not the shell.
  let neighbours: WorldFace[] = [];
  if (fixed.length) {
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    const pad = offset * (maxPasses + 1) + planeEps + 0.01;
    const nkey = (n: Vec3): string => `${Math.round(n[0] * 1e3)},${Math.round(n[1] * 1e3)},${Math.round(n[2] * 1e3)}`;
    const planes = new Map<string, number[]>();
    const addPlane = (n: Vec3, d: number): void => { const k = nkey(n); let l = planes.get(k); if (!l) planes.set(k, l = []); l.push(d); };
    for (const f of worldFaces(placements)) {
      for (const c of f.corners) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, c[k]!); hi[k] = Math.max(hi[k]!, c[k]!); }
      addPlane(f.normal, f.d); addPlane([-f.normal[0], -f.normal[1], -f.normal[2]], -f.d);
    }
    for (const l of planes.values()) l.sort((a, b) => a - b);
    const onPlane = (f: WorldFace): boolean => {
      const l = planes.get(nkey(f.normal));
      if (!l) return false;
      let a = 0, b = l.length;
      while (a < b) { const m = (a + b) >> 1; if (l[m]! < f.d - pad) a = m + 1; else b = m; }
      return a < l.length && l[a]! <= f.d + pad;
    };
    const near = (f: WorldFace): boolean => {
      for (let k = 0; k < 3; k++) {
        let a = Infinity, b = -Infinity;
        for (const c of f.corners) { if (c[k]! < a) a = c[k]!; if (c[k]! > b) b = c[k]!; }
        if (b < lo[k]! - pad || a > hi[k]! + pad) return false;
      }
      return true;
    };
    for (const f of fixed) if (near(f) && onPlane(f)) neighbours.push({ ...f, actor: own + f.actor });
  }
  const key = (f: { actor: number; group: number; cube: number; face: string }): string => `${f.actor}:${f.group}:${f.cube}:${f.face}`;
  /**
   * One pass's plan over `faces` (all of them, or those near the faces the last pass moved), with the buried test
   * and face lookup over `all`: the pushes it wants and the visible pairs still closer than `offset`.
   */
  const plan = (faces: WorldFace[], all: WorldFace[]): { grow: Map<string, number>; pending: number; pendingArea: number } => {
    const byKey = new Map<string, WorldFace>();
    for (const f of all) byKey.set(key(f), f);
    const buried = buriedFaceTest(all);
    const { hits } = coplanarFaces(faces, { planeEps });
    // Every pair the pass sees is a constraint `disp(w) >= disp(l) + offset - lead`, the loser's own push included:
    // N faces of N colours on one plane are N - 1 layers, and pushing each winner by its own pair's need alone put the
    // pushed faces on one plane again, one layer settled per pass (42172's body still had 444 pairs after 10 passes).
    // The winner rule is an order (area, volume, alpha, group, cube; a decal or a neighbour never wins), so the
    // constraints are acyclic and relaxing them settles every layer of a plane in one pass.
    const constraints: Array<{ w: string; l: string | null; need: number }> = [];
    let pending = 0, pendingArea = 0;
    for (const h of hits) {
      const aOwn = h.a.actor < own, bOwn = h.b.actor < own;
      if (!aOwn && !bOwn) continue;
      if (aOwn && bOwn && h.a.actor !== h.b.actor) continue;
      const fa = byKey.get(key(h.a))!, fb = byKey.get(key(h.b))!;
      let w: WorldFace, l: WorldFace;
      if (aOwn && bOwn) {
        const ca = entry.groups[fa.group]!.cubes[fa.cube]!, cb = entry.groups[fb.group]!.cubes[fb.cube]!;
        if (ca.faceUv && cb.faceUv) continue;
        const ga = entry.groups[fa.group]!, gb = entry.groups[fb.group]!;
        const vol = (c: typeof ca): number => Math.abs(c.size[0] * c.size[1] * c.size[2]);
        const areaA = faceArea(fa.corners), areaB = faceArea(fb.corners);
        // A decal is never moved; whatever shares its plane (a fringe, a visor,
        // a hood) is in front of the face, so it is the one pushed out.
        const aWins = cb.faceUv ? true : ca.faceUv ? false
          : Math.abs(areaA - areaB) > 1e-6 ? areaA < areaB
          : Math.abs(vol(ca) - vol(cb)) > 1e-6 ? vol(ca) < vol(cb)
            : ga.alpha !== gb.alpha ? ga.alpha > gb.alpha
              : fa.group !== fb.group ? fa.group > fb.group : fa.cube > fb.cube;
        [w, l] = aWins ? [fa, fb] : [fb, fa];
      } else {
        // This entity's face goes in front of the neighbour's.
        [w, l] = aOwn ? [fa, fb] : [fb, fa];
      }
      if (buried(w) || buried(l)) continue;
      // The winner must lead the loser by `offset` over their overlap (`lead`, measured where they overlap: two planes
      // a fraction of a degree apart are not parallel, so their offsets' difference is not the distance).
      const need = offset - (w === fa ? h.lead : h.leadBack);
      if (need > 1e-6) { pending++; pendingArea += h.area; }
      // A decal on a neighbour's plane cannot move: it is left, and counted.
      if (entry.groups[w.group]!.cubes[w.cube]!.faceUv) continue;
      const lOwn = l.actor < own;
      constraints.push({ w: `${w.group}:${w.cube}:${w.face}`, l: lOwn ? `${l.group}:${l.cube}:${l.face}` : null, need });
    }
    const grow = new Map<string, number>();
    for (let round = 0, changed = true; changed && round < 64; round++) {
      changed = false;
      for (const c of constraints) {
        const want = (c.l ? grow.get(c.l) ?? 0 : 0) + c.need;
        if (want > (grow.get(c.w) ?? 0) + 1e-6) { grow.set(c.w, want); changed = true; }
      }
    }
    for (const [k, g] of grow) if (g <= 1e-6) grow.delete(k);
    return { grow, pending, pendingArea };
  };
  /**
   * The faces a pass must look at after the last one moved `moved` (entry-level keys): only a moved face can meet a
   * plane it did not share before, so a pass after the first measures the faces whose boxes come within reach of a
   * moved face's box (a grid of 32-unit cells), not the whole entity again. A pass that finds nothing to push is
   * followed by a FULL pass, which alone may declare the separation settled and count what is left.
   */
  const nearSeeds = (all: WorldFace[], seed: (f: WorldFace) => boolean, reach: number): WorldFace[] => {
    // `reach`: how far the seeds moved. A face a seed USED to press against (buried, so unpaired) is that far from it now.
    const G = 32, pad = planeEps + reach + 0.05;
    const boxOf = (f: WorldFace): [number, number, number, number, number, number] => {
      const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const c of f.corners) for (let k = 0; k < 3; k++) { if (c[k]! < b[k]!) b[k] = c[k]!; if (c[k]! > b[k + 3]!) b[k + 3] = c[k]!; }
      return b;
    };
    const cells = new Map<string, Array<[number, number, number, number, number, number]>>();
    for (const f of all) {
      if (!seed(f)) continue;
      const b = boxOf(f);
      for (let k = 0; k < 3; k++) { b[k] -= pad; b[k + 3] += pad; }
      for (let x = Math.floor(b[0] / G); x <= Math.floor(b[3] / G); x++) for (let y = Math.floor(b[1] / G); y <= Math.floor(b[4] / G); y++) for (let z = Math.floor(b[2] / G); z <= Math.floor(b[5] / G); z++) {
        const k = `${x},${y},${z}`;
        let l = cells.get(k);
        if (!l) cells.set(k, l = []);
        l.push(b);
      }
    }
    return all.filter(f => {
      const b = boxOf(f);
      for (let x = Math.floor(b[0] / G); x <= Math.floor(b[3] / G); x++) for (let y = Math.floor(b[1] / G); y <= Math.floor(b[4] / G); y++) for (let z = Math.floor(b[2] / G); z <= Math.floor(b[5] / G); z++) {
        for (const m of cells.get(`${x},${y},${z}`) ?? []) if (m[0] <= b[3] && b[0] <= m[3] && m[1] <= b[4] && b[1] <= m[4] && m[2] <= b[5] && b[2] <= m[5]) return true;
      }
      return false;
    });
  };
  if (options.settledOwn && !neighbours.length) return result;
  /** A full pass's faces: all of them, or (`settledOwn`) the entity's faces near its neighbours, and the neighbours. */
  const fullScope = (all: WorldFace[]): WorldFace[] => (options.settledOwn ? nearSeeds(all, f => f.actor >= own, offset * (maxPasses + 1)) : all);
  let moved: Set<string> | null = null, movedBy = 0;
  for (let pass = 0; ; pass++) {
    const mine = worldFaces(placements);
    const all = neighbours.length ? mine.concat(neighbours) : mine;
    const full = moved === null;
    const seen = moved;
    const { grow, pending, pendingArea } = plan(seen ? nearSeeds(all, f => f.actor < own && seen.has(`${f.group}:${f.cube}:${f.face}`), movedBy) : fullScope(all), all);
    if (pass === 0) { result.pairsFound = pending; result.areaFound = pendingArea / 256; }
    if (!grow.size) {
      // Settled on a full pass: what is left is counted. Settled near the last pushes: check the whole entity.
      if (full) { result.pairsLeft = pending; return result; }
      moved = null;
      continue;
    }
    // At the cap the pushes are not made; a full measure counts what is left.
    if (result.passes >= maxPasses) { result.pairsLeft = full ? pending : plan(fullScope(all), all).pending; return result; }
    result.passes++;
    for (const [k, g] of grow) {
      const [group, cube, face] = k.split(':') as [string, string, string];
      const c = entry.groups[Number(group)]!.cubes[Number(cube)]!;
      const side = FACE_SIDE[face]!;
      const amount = Math.ceil(g * 100 - 1e-6) / 100; // the compiler writes two decimals: round UP so the lead survives
      c.size[side.axis] = Math.round((c.size[side.axis] + amount) * 100) / 100;
      if (!side.max) c.origin[side.axis] = Math.round((c.origin[side.axis] - amount) * 100) / 100;
      result.facesGrown++;
    }
    moved = new Set(grow.keys());
    movedBy = Math.max(...grow.values()) + 0.01;
  }
}
