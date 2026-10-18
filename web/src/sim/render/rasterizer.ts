/**
 * A z-buffered software rasteriser for quads: the offline renderer of built
 * packs (`scripts/_pack_render.ts`) and the simulator's first-person
 * snapshots draw through it. Pure: faces and a camera in, an RGB buffer out;
 * the caller decides each face's colour or texture and writes the image.
 *
 * Frame: world blocks, Y up; faces arrive in 1/16-block units (the geometry
 * convention of `bedrock-geometry-faces.ts`). Near-plane clipping is skipped:
 * a face crossing the camera plane is dropped (the camera sits outside what it
 * looks at).
 *
 * Two device rules the phones apply are measured here, never guessed
 * (`rasterizeDetailed`): a face the device DROPS (a box-UV face whose declared
 * height floors to 0, quirk `box-uv-sub-unit-faces`) is left out of the picture
 * but counted where it would have been the nearest face (`dropped`), and two
 * faces of different colour on one plane that both reach a pixel are flagged as
 * a HATCH (quirk `coplanar-hatching`: the device z-fights them; which colour
 * wins is unknowable, so the flag says WHERE, the picture shows the nearer
 * face only because something must).
 */

/** A 3-vector as an array (the geometry modules' convention). */
export type V3 = [number, number, number];

/** One drawable quad: four corners in 1/16-block units, its outward normal, optional texel UVs. */
export interface RasterQuad {
  corners: readonly [V3, V3, V3, V3];
  normal: V3;
  uv?: readonly [[number, number], [number, number], [number, number], [number, number]];
  /** Colour key: two quads with the same key draw the same texels (a hatch needs different keys). */
  key?: string;
  /** The actor the quad belongs to: a hatch within one actor is the pack's own, across two the placement's. */
  owner?: number;
}

/** A decoded RGBA texture. */
export interface RasterTexture { w: number; h: number; rgba: Uint8Array }

/** How a quad is painted: a colour 0..1 (times the texture when there is one) and an alpha. */
export interface RasterPaint { rgb: V3; alpha: number; tex?: RasterTexture }

/** The camera: eye, a point looked at, an optional up vector (a rolled view; default world up), field and image size. */
export interface RasterCamera { eye: V3; at: V3; up?: V3; fovDeg: number; width: number; height: number }

/** The device rules `rasterizeDetailed` applies. */
export interface RasterOptions {
  /** A quad the device does not draw: left out of the picture, counted in `dropped` where it was the nearest. */
  dropped?: (index: number) => boolean;
  /** Planes closer than this (blocks) with different colour keys fight (default 0.02 model units = 1/800 block, the audit's). */
  conflictEps?: number;
}

/** What a detailed raster returns beside the picture. */
export interface RasterResult {
  rgb: Uint8Array;
  width: number; height: number;
  /** View depth (blocks along the forward axis) of the nearest OPAQUE face drawn per pixel; Infinity for sky. */
  depth: Float32Array;
  /** Per pixel: 0 no hatch, 1 two coplanar faces of one actor fight here, 2 of two actors. */
  hatch: Uint8Array;
  /** Per pixel: 1 where the nearest face (dropped faces included) is one the device drops. */
  dropped: Uint8Array;
  /** Per pixel: 1 where a translucent face was blended over whatever was behind it. */
  translucent: Uint8Array;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The audit's plane epsilon, in blocks: 0.02 model units. */
export const CONFLICT_EPS_BLOCKS = 0.02 / 16;

type Tri = { p: Array<[number, number, number]>; uv?: Array<[number, number]>; rgb: V3; alpha: number; tex?: RasterTexture; order: number; quad: number };

/**
 * Render quads to an RGB buffer (`width * height * 3`, 0..255). The sky is a
 * vertical gradient; faces are lit by one fixed direction; opaque faces draw
 * first, translucent ones after, far to near.
 */
export function rasterize(quads: readonly RasterQuad[], paint: (q: RasterQuad, index: number, shade: number) => RasterPaint, cam: RasterCamera): Uint8Array {
  return rasterizeDetailed(quads, paint, cam).rgb;
}

/** `rasterize` with the device rules and the per-pixel findings (the snapshots and `_pack_render.ts --hatch` read these). */
export function rasterizeDetailed(quads: readonly RasterQuad[], paint: (q: RasterQuad, index: number, shade: number) => RasterPaint, cam: RasterCamera, options: RasterOptions = {}): RasterResult {
  const W = cam.width, H = cam.height, fov = cam.fovDeg * Math.PI / 180;
  const fwd = nrm(sub(cam.at, cam.eye));
  // A rolled view takes its up from the camera; a world-up camera looking straight up or down has no right axis, so fall back to the x axis.
  let right = nrm(cross(fwd, cam.up ?? [0, 1, 0]));
  if (!Number.isFinite(right[0]) || Math.hypot(...cross(fwd, cam.up ?? [0, 1, 0])) < 1e-9) right = nrm(cross(fwd, [1, 0, 0]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan(fov / 2), aspect = W / H, near = 0.05;
  const eps = options.conflictEps ?? CONFLICT_EPS_BLOCKS;
  const colour = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { const t = Math.floor(i / W) / H; colour[i * 3] = 0.55 + 0.25 * t; colour[i * 3 + 1] = 0.7 + 0.15 * t; colour[i * 3 + 2] = 0.9; }
  const depth = new Float32Array(W * H).fill(Infinity);
  const owner = new Int32Array(W * H).fill(-1);
  const hatch = new Uint8Array(W * H);
  const translucent = new Uint8Array(W * H);
  // The nearest face of ALL faces, dropped ones included, for `dropped`.
  const depthAll = new Float32Array(W * H).fill(Infinity);
  const dropped = new Uint8Array(W * H);
  const light = nrm([0.4, 1, 0.25]);
  // Each quad's plane in blocks (normal · p = d), for the coplanar test, and whether the device drops it.
  const planeD = new Float64Array(quads.length);
  const isDropped = new Uint8Array(quads.length);
  quads.forEach((q, i) => { planeD[i] = dot(q.normal, [q.corners[0][0] / 16, q.corners[0][1] / 16, q.corners[0][2] / 16]); isDropped[i] = options.dropped?.(i) ? 1 : 0; });
  const coplanar = (a: number, b: number): boolean => {
    const qa = quads[a]!, qb = quads[b]!;
    return dot(qa.normal, qb.normal) > 0.999 && Math.abs(planeD[a]! - planeD[b]!) <= eps && (qa.key ?? '') !== (qb.key ?? '');
  };
  const project = (v: V3): [number, number, number] | null => {
    const r = sub(v, cam.eye), z = dot(r, fwd);
    if (z < near) return null;
    return [W / 2 + (dot(r, right) * f / aspect / z) * W / 2, H / 2 - (dot(r, up) * f / z) * H / 2, z];
  };
  const raster = (t: Tri): void => {
    const [a, b, c] = t.p as [[number, number, number], [number, number, number], [number, number, number]];
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-9) return;
    const drop = isDropped[t.quad] === 1;
    // A gap along the view ray between two faces `eps` apart along their normal is at least `eps`; a face nearer by more than
    // a few eps is simply nearer (it clears a hatch it covers), one within that is tested for the plane.
    const zTol = 4 * eps;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      // Perspective-correct: interpolate 1/z.
      const z = 1 / (w0 / a[2] + w1 / b[2] + w2 / c[2]);
      const k = y * W + x;
      if (t.alpha >= 1 && z < depthAll[k]!) { depthAll[k] = z; dropped[k] = drop ? 1 : 0; }
      if (drop) continue;
      if (t.alpha >= 1) {
        if (z >= depth[k]! + zTol) continue;
        // A pixel centre exactly on a shared edge belongs to both neighbours (axis-aligned geometry lands on half-pixels
        // often): two faces that only ABUT never fight, so the flag needs the pixel strictly inside this triangle.
        const inside = w0 > 1e-6 && w1 > 1e-6 && w2 > 1e-6;
        if (inside && z > depth[k]! - zTol && owner[k]! >= 0 && owner[k] !== t.quad && coplanar(t.quad, owner[k]!)) {
          hatch[k] = (quads[t.quad]!.owner ?? -1) === (quads[owner[k]!]!.owner ?? -1) ? 1 : 2;
        } else if (z < depth[k]! - zTol) hatch[k] = 0;
        if (z >= depth[k]!) continue;
      } else if (z >= depth[k]!) continue;
      let rgb = t.rgb;
      if (t.tex && t.uv) {
        const u = (w0 * t.uv[0]![0] / a[2] + w1 * t.uv[1]![0] / b[2] + w2 * t.uv[2]![0] / c[2]) * z;
        const v = (w0 * t.uv[0]![1] / a[2] + w1 * t.uv[1]![1] / b[2] + w2 * t.uv[2]![1] / c[2]) * z;
        const tx = Math.min(t.tex.w - 1, Math.max(0, Math.floor(u))), ty = Math.min(t.tex.h - 1, Math.max(0, Math.floor(v)));
        const o = (ty * t.tex.w + tx) * 4;
        if (t.tex.rgba[o + 3]! < 128) continue;
        rgb = [t.tex.rgba[o]! / 255 * t.rgb[0], t.tex.rgba[o + 1]! / 255 * t.rgb[1], t.tex.rgba[o + 2]! / 255 * t.rgb[2]];
      }
      if (t.alpha >= 1) { depth[k] = z; owner[k] = t.quad; colour[k * 3] = rgb[0]; colour[k * 3 + 1] = rgb[1]; colour[k * 3 + 2] = rgb[2]; }
      else { translucent[k] = 1; for (let c3 = 0; c3 < 3; c3++) colour[k * 3 + c3] = colour[k * 3 + c3]! * (1 - t.alpha) + rgb[c3]! * t.alpha; }
    }
  };
  const tris: Tri[] = [];
  quads.forEach((q, i) => {
    const toEye = sub(cam.eye, [q.corners[0][0] / 16, q.corners[0][1] / 16, q.corners[0][2] / 16]);
    if (dot(q.normal, toEye) <= 0) return; // back face
    const ps = q.corners.map(c => project([c[0] / 16, c[1] / 16, c[2] / 16]));
    if (ps.some(p => !p)) return;
    const shade = 0.6 + 0.4 * Math.max(0, dot(q.normal, light)) + 0.1 * q.normal[0];
    const pt = paint(q, i, shade);
    const P = ps as Array<[number, number, number]>, order = pt.alpha < 1 ? 1 : 0;
    const base = { rgb: pt.rgb, alpha: pt.alpha, ...(pt.tex ? { tex: pt.tex } : {}), order, quad: i };
    tris.push({ p: [P[0]!, P[1]!, P[2]!], ...(q.uv ? { uv: [q.uv[0], q.uv[1], q.uv[2]] } : {}), ...base });
    tris.push({ p: [P[0]!, P[2]!, P[3]!], ...(q.uv ? { uv: [q.uv[0], q.uv[2], q.uv[3]] } : {}), ...base });
  });
  const opaque = tris.filter(t => t.order === 0), clear = tris.filter(t => t.order === 1);
  for (const t of opaque) raster(t);
  clear.sort((a, b) => Math.max(b.p[0]![2], b.p[1]![2], b.p[2]![2]) - Math.max(a.p[0]![2], a.p[1]![2], a.p[2]![2]));
  for (const t of clear) raster(t);
  const rgb8 = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) rgb8[i] = Math.max(0, Math.min(255, Math.round(colour[i]! * 255)));
  return { rgb: rgb8, width: W, height: H, depth, hatch, dropped, translucent };
}

/** Paint every hatched pixel in a loud magenta/black check (what `_pack_render.ts --hatch` and the frames show). */
export function paintHatch(result: RasterResult): Uint8Array {
  const out = new Uint8Array(result.rgb);
  for (let k = 0; k < result.width * result.height; k++) {
    if (!result.hatch[k]) continue;
    const x = k % result.width, y = (k - x) / result.width;
    const dark = ((x >> 1) + (y >> 1)) % 2 === 0;
    out[k * 3] = dark ? 0 : 255; out[k * 3 + 1] = 0; out[k * 3 + 2] = dark ? 0 : 255;
  }
  return out;
}
