/**
 * Offline media renderer core (BIZ-62 / X-14): pictures of a built pack's actors in the GAME frame, composed
 * on a brand backdrop with a ground and contact shadow, supersampled, and encoded within a byte budget.
 *
 * The geometry and the camera are the simulator's (`worldFaces`, `renderActorsDetailed`); nothing here mirrors
 * them. An earlier reading of the plan said "mirror JSON X"; `test/release-media.test.ts` shows that draws the
 * entity's left on the viewer's left from the front, which is wrong, so the game frame is the plain frame.
 *
 * Node/Bun only (sharp).
 */
import sharp from 'sharp';
import { lodFaces, renderActorsDetailed } from '../sim/adapters/craftmatic/snapshot.js';
import type { AuditActor, Vec3 } from '../engine/bedrock-geometry-faces.js';
import type { RasterTexture } from '../sim/render/rasterizer.js';
import type { UvFloorModel } from '../engine/figure-holes.js';
import { boundsOfPoints, cameraBasis, centreOf, drawnPoints, fitView, orbitEye, type Bounds } from './media-framing.js';
import { MAX_BYTES_EXCLUSIVE, MAX_SIDE_EXCLUSIVE, type MediaPreset, type StillFormat } from './media-presets.js';

/** Decode a pack's face atlases (PNG bytes by path) to RGBA once, for the rasteriser. */
export async function decodeFaceAtlases(faceTextures: ReadonlyMap<string, Uint8Array> | undefined): Promise<Map<string, RasterTexture>> {
  const atlases = new Map<string, RasterTexture>();
  for (const [path, png] of faceTextures ?? []) {
    const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    atlases.set(path, { w: info.width, h: info.height, rgba: new Uint8Array(data) });
  }
  return atlases;
}

/** What a picture needs: size, field of view and the device rules. */
export interface ViewOptions {
  width: number;
  height: number;
  fovDeg: number;
  atlases?: ReadonlyMap<string, RasterTexture>;
  /** Device box-UV rule; media default `none` draws every face (marketing images show the geometry, not the phone's loss). */
  uvFloor?: UvFloorModel;
}

/** The raster of `actors` from `eye` looking at `at`: colour plus the per-pixel depth the backdrop composite reads. */
export function renderView(actors: readonly AuditActor[], eye: Vec3, at: Vec3, o: ViewOptions): { rgb: Uint8Array; depth: Float32Array } {
  const { actors: drawn, faces } = lodFaces(actors as AuditActor[], []);
  const res = renderActorsDetailed(drawn, faces, { eye, at, fovDeg: o.fovDeg, width: o.width, height: o.height }, { uvFloor: o.uvFloor ?? 'none', hatch: false }, o.atlases);
  return { rgb: res.rgb, depth: res.depth };
}

/** Backdrop colours (0..255): a dark brand gradient, a lit stage floor and the shadow strength. */
export interface StagePalette { top: Vec3; bottom: Vec3; floor: Vec3; shadow: number }
export const BRAND_STAGE: StagePalette = { top: [9, 12, 24], bottom: [27, 36, 60], floor: [44, 58, 92], shadow: 0.6 };

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/**
 * Replace the sky pixels (no opaque face; depth Infinity) with the backdrop: a vertical gradient with a
 * vignette, and, where the ray meets the ground plane under the model, a soft stage floor with a contact
 * shadow in the model's footprint. Mutates and returns `rgb`.
 */
export function compositeStage(rgb: Uint8Array, depth: Float32Array, width: number, height: number, eye: Vec3, at: Vec3, fovDeg: number, ground: Bounds, palette: StagePalette = BRAND_STAGE): Uint8Array {
  const { fwd, right, up } = cameraBasis(eye, at);
  const f = 1 / Math.tan(fovDeg * Math.PI / 360), aspect = width / height;
  const cx = (ground.lo[0] + ground.hi[0]) / 2, cz = (ground.lo[2] + ground.hi[2]) / 2, gy = ground.lo[1];
  const hx = Math.max(0.5, (ground.hi[0] - ground.lo[0]) / 2), hz = Math.max(0.5, (ground.hi[2] - ground.lo[2]) / 2);
  for (let y = 0; y < height; y++) {
    const sy = 1 - (y + 0.5) / height * 2;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (depth[i]! !== Infinity) continue;
      const sx = (x + 0.5) / width * 2 - 1;
      const vig = 1 - 0.22 * (sx * sx + sy * sy) / 2;
      const t = (sy + 1) / 2;
      let r = lerp(palette.bottom[0], palette.top[0], t), g = lerp(palette.bottom[1], palette.top[1], t), b = lerp(palette.bottom[2], palette.top[2], t);
      const kx = sx * aspect / f, ky = sy / f;
      const dx = fwd[0] + right[0] * kx + up[0] * ky, dy = fwd[1] + right[1] * kx + up[1] * ky, dz = fwd[2] + right[2] * kx + up[2] * ky;
      if (dy < -1e-4) {
        const s = (gy - eye[1]) / dy;
        if (s > 0) {
          // Footprint-normalised distance: 1 is the edge of the model's bounds on the ground.
          const rho = Math.hypot((eye[0] + dx * s - cx) / hx, (eye[2] + dz * s - cz) / hz);
          const floor = smooth((2.6 - rho) / 1.6) * 0.85;
          r = lerp(r, palette.floor[0], floor); g = lerp(g, palette.floor[1], floor); b = lerp(b, palette.floor[2], floor);
          const shade = 1 - palette.shadow * Math.exp(-((rho / 0.95) ** 2));
          r *= shade; g *= shade; b *= shade;
        }
      }
      rgb[i * 3] = Math.round(r * vig); rgb[i * 3 + 1] = Math.round(g * vig); rgb[i * 3 + 2] = Math.round(b * vig);
    }
  }
  return rgb;
}

/** Lanczos-downscale an RGB buffer to the final size (the supersampling resolve). */
export async function downscaleRgb(rgb: Uint8Array, width: number, height: number, outW: number, outH: number): Promise<Buffer> {
  if (width === outW && height === outH) return Buffer.from(rgb);
  return sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } }).resize(outW, outH, { kernel: 'lanczos3' }).raw().toBuffer();
}

/** An encoded still and the setting that met the budget. */
export interface EncodedStill { data: Buffer; format: StillFormat; quality: number | 'lossless' | 'palette' }

/**
 * Encode an RGB picture under `maxBytes`: JPEG/WebP walk quality down; PNG tries full colour, then a 256-colour
 * palette. Throws, naming the size, when nothing fits; it never ships an over-budget file.
 */
export async function encodeStill(rgb: Uint8Array, width: number, height: number, format: StillFormat, maxBytes: number): Promise<EncodedStill> {
  if (width >= MAX_SIDE_EXCLUSIVE || height >= MAX_SIDE_EXCLUSIVE) throw new Error(`image ${width}x${height} has a side of ${MAX_SIDE_EXCLUSIVE} px or more`);
  const limit = Math.min(maxBytes, MAX_BYTES_EXCLUSIVE - 1);
  const img = (): sharp.Sharp => sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } });
  if (format === 'png') {
    let data = await img().png({ compressionLevel: 9 }).toBuffer();
    if (data.length <= limit) return { data, format, quality: 'lossless' };
    data = await img().png({ compressionLevel: 9, palette: true, quality: 90, dither: 0.6 }).toBuffer();
    if (data.length <= limit) return { data, format, quality: 'palette' };
    throw new Error(`png ${width}x${height} is ${data.length} bytes, over the ${limit} budget`);
  }
  for (const quality of [92, 86, 80, 72, 64, 56, 48, 40, 30]) {
    const data = await (format === 'jpg' ? img().jpeg({ quality, mozjpeg: true }) : img().webp({ quality })).toBuffer();
    if (data.length <= limit) return { data, format, quality };
  }
  throw new Error(`${format} ${width}x${height} does not fit ${limit} bytes even at quality 30`);
}

/** The frame-drop ladder: keep every n-th frame, n growing. */
export const GIF_STRIDES: readonly number[] = [1, 2, 3, 4, 6, 8, 12];

/** The result of fitting a GIF to its budget. */
export interface FittedGif { data: Uint8Array; stride: number; frames: number[] }

/**
 * Encode a GIF under the byte budget by DROPPING FRAMES (every 2nd, 3rd, ... frame, the encoder keeping the
 * clip's duration) rather than exceeding it. `encode` receives the kept frame indices and the stride and returns
 * the GIF bytes. Throws when even the sparsest ladder step is over the budget.
 */
export async function fitGif(total: number, budget: number, encode: (frames: number[], stride: number) => Promise<Uint8Array>): Promise<FittedGif> {
  const limit = Math.min(budget, MAX_BYTES_EXCLUSIVE - 1);
  let last = 0;
  for (const stride of GIF_STRIDES) {
    if (stride > 1 && Math.ceil(total / stride) < 8) break;
    const frames = Array.from({ length: Math.ceil(total / stride) }, (_, k) => k * stride);
    const data = await encode(frames, stride);
    last = data.length;
    if (data.length <= limit) return { data, stride, frames };
  }
  throw new Error(`gif over budget at every frame-drop step (last ${last} bytes, limit ${limit})`);
}

/** A model prepared for framing: its actors, drawn corner cloud, bounds and aim point. */
export interface Scene { actors: AuditActor[]; points: Vec3[]; bounds: Bounds; at: Vec3 }

/** Prepare `actors` once: the corner cloud is the costly part and every frame and preset reuses it. */
export function buildScene(actors: readonly AuditActor[]): Scene {
  const points = drawnPoints(actors);
  if (!points.length) throw new Error('nothing drawn: the actors have no faces');
  const bounds = boundsOfPoints(points);
  return { actors: [...actors], points, bounds, at: centreOf(bounds) };
}

/** A fixed camera for one preset: where it aims, the look direction and the one distance every frame uses. */
export interface PresetCamera { at: Vec3; dir: Vec3; distance: number; fovDeg: number }

/** Fit the camera so the model fills the preset's width/height shares from every azimuth (one distance, no pulsing). */
export function planCamera(scene: Scene, preset: MediaPreset, azimuths: number): PresetCamera {
  const { framing, width, height } = preset;
  const dir: Vec3 = [...framing.dir];
  const { at, distance } = fitView(scene.points, scene.at, dir, azimuths, framing.fovDeg, width / height, { fillWidth: framing.fillWidth, fillHeight: framing.fillHeight });
  return { at, dir, distance, fovDeg: framing.fovDeg };
}

/** One finished frame at the preset size, and how much of the frame width the model spans. */
export interface RenderedFrame { rgb: Buffer; width: number; height: number; fillWidth: number }

/**
 * Render frame `index` of `count` of a turntable (or the hero still: index 0, count 1) for a preset: raster at
 * `supersample` times the size, the stage composited, then a Lanczos resolve to the preset size.
 */
export async function renderPresetFrame(scene: Scene, preset: MediaPreset, camera: PresetCamera, index: number, count: number, supersample: number, atlases?: ReadonlyMap<string, RasterTexture>): Promise<RenderedFrame> {
  const W = Math.round(preset.width * supersample), H = Math.round(preset.height * supersample);
  const eye = orbitEye(camera.at, camera.dir, index, count, camera.distance);
  const { rgb, depth } = renderView(scene.actors, eye, camera.at, { width: W, height: H, fovDeg: camera.fovDeg, ...(atlases ? { atlases } : {}) });
  // Width the model spans: the first and last columns holding an opaque pixel.
  let x0 = W, x1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (depth[y * W + x]! !== Infinity) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  compositeStage(rgb, depth, W, H, eye, camera.at, camera.fovDeg, scene.bounds);
  const out = await downscaleRgb(rgb, W, H, preset.width, preset.height);
  return { rgb: out, width: preset.width, height: preset.height, fillWidth: x1 >= x0 ? (x1 - x0 + 1) / W : 0 };
}
