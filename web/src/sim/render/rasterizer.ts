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
 */

/** A 3-vector as an array (the geometry modules' convention). */
export type V3 = [number, number, number];

/** One drawable quad: four corners in 1/16-block units, its outward normal, optional texel UVs. */
export interface RasterQuad {
  corners: readonly [V3, V3, V3, V3];
  normal: V3;
  uv?: readonly [[number, number], [number, number], [number, number], [number, number]];
}

/** A decoded RGBA texture. */
export interface RasterTexture { w: number; h: number; rgba: Uint8Array }

/** How a quad is painted: a colour 0..1 (times the texture when there is one) and an alpha. */
export interface RasterPaint { rgb: V3; alpha: number; tex?: RasterTexture }

export interface RasterCamera { eye: V3; at: V3; fovDeg: number; width: number; height: number }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

type Tri = { p: Array<[number, number, number]>; uv?: Array<[number, number]>; rgb: V3; alpha: number; tex?: RasterTexture; order: number };

/**
 * Render quads to an RGB buffer (`width * height * 3`, 0..255). The sky is a
 * vertical gradient; faces are lit by one fixed direction; opaque faces draw
 * first, translucent ones after, far to near.
 */
export function rasterize(quads: readonly RasterQuad[], paint: (q: RasterQuad, index: number, shade: number) => RasterPaint, cam: RasterCamera): Uint8Array {
  const W = cam.width, H = cam.height, fov = cam.fovDeg * Math.PI / 180;
  const fwd = nrm(sub(cam.at, cam.eye));
  const right = nrm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan(fov / 2), aspect = W / H, near = 0.05;
  const colour = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { const t = Math.floor(i / W) / H; colour[i * 3] = 0.55 + 0.25 * t; colour[i * 3 + 1] = 0.7 + 0.15 * t; colour[i * 3 + 2] = 0.9; }
  const depth = new Float32Array(W * H).fill(Infinity);
  const light = nrm([0.4, 1, 0.25]);
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
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      // Perspective-correct: interpolate 1/z.
      const z = 1 / (w0 / a[2] + w1 / b[2] + w2 / c[2]);
      const k = y * W + x;
      if (z >= depth[k]!) continue;
      let rgb = t.rgb;
      if (t.tex && t.uv) {
        const u = (w0 * t.uv[0]![0] / a[2] + w1 * t.uv[1]![0] / b[2] + w2 * t.uv[2]![0] / c[2]) * z;
        const v = (w0 * t.uv[0]![1] / a[2] + w1 * t.uv[1]![1] / b[2] + w2 * t.uv[2]![1] / c[2]) * z;
        const tx = Math.min(t.tex.w - 1, Math.max(0, Math.floor(u))), ty = Math.min(t.tex.h - 1, Math.max(0, Math.floor(v)));
        const o = (ty * t.tex.w + tx) * 4;
        if (t.tex.rgba[o + 3]! < 128) continue;
        rgb = [t.tex.rgba[o]! / 255 * t.rgb[0], t.tex.rgba[o + 1]! / 255 * t.rgb[1], t.tex.rgba[o + 2]! / 255 * t.rgb[2]];
      }
      if (t.alpha >= 1) { depth[k] = z; colour[k * 3] = rgb[0]; colour[k * 3 + 1] = rgb[1]; colour[k * 3 + 2] = rgb[2]; }
      else for (let c3 = 0; c3 < 3; c3++) colour[k * 3 + c3] = colour[k * 3 + c3]! * (1 - t.alpha) + rgb[c3]! * t.alpha;
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
    const base = { rgb: pt.rgb, alpha: pt.alpha, ...(pt.tex ? { tex: pt.tex } : {}), order };
    tris.push({ p: [P[0]!, P[1]!, P[2]!], ...(q.uv ? { uv: [q.uv[0], q.uv[1], q.uv[2]] } : {}), ...base });
    tris.push({ p: [P[0]!, P[2]!, P[3]!], ...(q.uv ? { uv: [q.uv[0], q.uv[2], q.uv[3]] } : {}), ...base });
  });
  const opaque = tris.filter(t => t.order === 0), clear = tris.filter(t => t.order === 1);
  for (const t of opaque) raster(t);
  clear.sort((a, b) => Math.max(b.p[0]![2], b.p[1]![2], b.p[2]![2]) - Math.max(a.p[0]![2], a.p[1]![2], a.p[2]![2]));
  for (const t of clear) raster(t);
  const rgb8 = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) rgb8[i] = Math.max(0, Math.min(255, Math.round(colour[i]! * 255)));
  return rgb8;
}
