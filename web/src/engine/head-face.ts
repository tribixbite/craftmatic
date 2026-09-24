/**
 * Head faces as a TEXTURE on the front of the head.
 *
 * A face print is ink ~1 LDU across (an eye, an eyebrow, a line of a mouth).
 * The entity compiler builds a head from cuboids at a 2 LDU grain, so a
 * printed LDraw head's coloured triangles survive only as 2 LDU blocks: the
 * print reads as a smudge of the right colours (10261's sunglasses head,
 * `output/faces-0924/shots/route3-10261-fig2-face.png`). Here the print is
 * rasterised instead, face-on, at `FACE_PX_PER_LDU`, and drawn on ONE thin
 * decal cube proud of the head's front, textured through an alpha-tested
 * atlas: the head's own cuboids stay plain, and the ink is as sharp as the
 * LDraw artwork.
 *
 * Two sources fill the same slot:
 *   - a printed LDraw head (`rasterizeHeadFace`): exact artwork, offline, CC BY;
 *   - face ART seeded by the caller (`seedFaceArt`), keyed by the head's
 *     BrickLink print id (`3626pb3484`), which a converted source carries as
 *     `0 !CRAFTMATIC HEAD_PRINT <id>` before the plain head
 *     (`ParsedBrick.headPrint`). Nothing seeds it in the browser; an offline
 *     build can (`scripts/_playable_ref.ts --faces=<dir>`), which is how a head
 *     no library draws still gets its own face. See docs/bedrock-addon-guide.md.
 *
 * Image convention: an RGBA image of the head seen FACE-ON from its front
 * (LDraw −Z): column → LDraw +X, row → LDraw +Y (down), alpha 0 = no ink (the
 * head shows through). `rect` is the head-local LDU rectangle it spans.
 */
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import { resolveLdrawEntityMaterial } from './ldraw-entity-materials.js';

/** Texels per LDU of face. A minifig head is 26 LDU wide: 104 texels. */
export const FACE_PX_PER_LDU = 4;
/** Supersampling per axis when rasterising a printed head (2 = four samples per texel). */
const SUPERSAMPLE = 2;

export interface FaceImage {
  width: number;
  height: number;
  /** Row-major RGBA, row 0 at the top (LDraw −Y). */
  rgba: Uint8Array;
  /** Head-local LDU rectangle on the front plane: x0 → column 0, y0 → row 0. */
  rect: { x0: number; x1: number; y0: number; y1: number };
}

/** Face art as supplied (a photo-derived decal): covers the head's BODY, top of stud-neck to chin. */
export interface FaceArt {
  width: number;
  height: number;
  rgba: Uint8Array;
}

// ─── Rasterising a printed head ──────────────────────────────────────────────

interface Raster {
  w: number; h: number;
  /** Nearest depth per sample (LDraw z; smaller = nearer the viewer at −Z). */
  depth: Float32Array;
  /** Colour id of the nearest triangle per sample; -1 = empty. */
  color: Int32Array;
}

/**
 * Z-buffer the mesh as seen face-on from −Z, over `rect` at `pxPerLdu`.
 * Only what the viewer would SEE wins a sample, so a dual-sided head's back
 * print never bleeds through to the front.
 */
function rasterize(mesh: LdrawPartMesh, rect: FaceImage['rect'], pxPerLdu: number): Raster {
  const w = Math.max(1, Math.round((rect.x1 - rect.x0) * pxPerLdu));
  const h = Math.max(1, Math.round((rect.y1 - rect.y0) * pxPerLdu));
  const depth = new Float32Array(w * h).fill(Infinity);
  const color = new Int32Array(w * h).fill(-1);
  const toPx = (x: number): number => (x - rect.x0) * pxPerLdu;
  const toPy = (y: number): number => (y - rect.y0) * pxPerLdu;
  for (const t of mesh.triangles) {
    const ax = toPx(t.a[0]), ay = toPy(t.a[1]);
    const bx = toPx(t.b[0]), by = toPy(t.b[1]);
    const cx = toPx(t.c[0]), cy = toPy(t.c[1]);
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue; // edge-on to the viewer: covers nothing
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5, sy = py + 0.5;
        const w0 = ((bx - sx) * (cy - sy) - (by - sy) * (cx - sx)) / area;
        const w1 = ((cx - sx) * (ay - sy) - (cy - sy) * (ax - sx)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * t.a[2] + w1 * t.b[2] + w2 * t.c[2];
        const i = py * w + px;
        // Coplanar print and surface triangles never overlap in a printed LDraw
        // part, so a strict nearer-wins test is enough; a hair of tolerance keeps
        // the FIRST writer on exact ties.
        if (z < depth[i]! - 1e-4) { depth[i] = z; color[i] = t.color; }
      }
    }
  }
  return { w, h, depth, color };
}

/**
 * The head's BODY rectangle, face-on: the rows at least 80 % as wide as the
 * widest (which drops the stud on top and the neck below) and their X span.
 * The same rule crops a photo's head to its body, so the two line up.
 */
export function headBodyRect(mesh: LdrawPartMesh): FaceImage['rect'] {
  const b = mesh.bounds;
  const full = { x0: b.min[0], x1: b.max[0], y0: b.min[1], y1: b.max[1] };
  const r = rasterize(mesh, full, 2);
  const widths: Array<{ lo: number; hi: number } | null> = [];
  for (let y = 0; y < r.h; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < r.w; x++) if (r.color[y * r.w + x]! !== -1) { if (lo < 0) lo = x; hi = x; }
    widths.push(lo < 0 ? null : { lo, hi });
  }
  const widest = Math.max(0, ...widths.map(s => (s ? s.hi - s.lo + 1 : 0)));
  const rows = widths.map((s, y) => (s && s.hi - s.lo + 1 >= 0.8 * widest ? y : -1)).filter(y => y >= 0);
  if (!rows.length) return full;
  const lo = Math.min(...rows.map(y => widths[y]!.lo)), hi = Math.max(...rows.map(y => widths[y]!.hi));
  return {
    x0: full.x0 + lo / 2, x1: full.x0 + (hi + 1) / 2,
    y0: full.y0 + rows[0]! / 2, y1: full.y0 + (rows[rows.length - 1]! + 1) / 2,
  };
}

/**
 * The print of a printed head as seen face-on: every sample whose nearest
 * triangle carries an explicit colour is ink, colour 16 (the head's own
 * colour) is transparent. Null when nothing on the front is printed.
 */
export function rasterizeHeadFace(mesh: LdrawPartMesh): FaceImage | null {
  if (!mesh.triangles.some(t => t.color !== 16)) return null;
  const b = mesh.bounds;
  const rect = { x0: b.min[0], x1: b.max[0], y0: b.min[1], y1: b.max[1] };
  const r = rasterize(mesh, rect, FACE_PX_PER_LDU * SUPERSAMPLE);
  const width = Math.max(1, Math.floor(r.w / SUPERSAMPLE)), height = Math.max(1, Math.floor(r.h / SUPERSAMPLE));
  const rgba = new Uint8Array(width * height * 4);
  let ink = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0, sr = 0, sg = 0, sb = 0;
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          const c = r.color[(y * SUPERSAMPLE + dy) * r.w + x * SUPERSAMPLE + dx]!;
          if (c === -1 || c === 16 || c === 24) continue;
          const [cr, cg, cb] = resolveLdrawEntityMaterial(c).rgb;
          sr += cr; sg += cg; sb += cb; n++;
        }
      }
      // A texel is ink when at least half its samples are; its colour is the
      // mean of those samples (alpha-TESTED, so there is no partial alpha).
      if (n * 2 < SUPERSAMPLE * SUPERSAMPLE) continue;
      const o = (y * width + x) * 4;
      rgba[o] = Math.round(sr / n); rgba[o + 1] = Math.round(sg / n); rgba[o + 2] = Math.round(sb / n); rgba[o + 3] = 255;
      ink++;
    }
  }
  return ink ? { width, height, rgba, rect } : null;
}

// ─── Face art supplied by the caller ─────────────────────────────────────────

const faceArt = new Map<string, FaceArt>();

/** Register face art by print id (`3626pb3484`; `3626cpb3484`, `.dat` and case are the same key). */
export function seedFaceArt(entries: Iterable<[string, FaceArt]>): number {
  let n = 0;
  for (const [part, art] of entries) {
    if (art.rgba.length !== art.width * art.height * 4) throw new Error(`face art ${part}: ${art.rgba.length} bytes for ${art.width}x${art.height}`);
    faceArt.set(faceKey(part), art);
    n++;
  }
  return n;
}

/** Drop every seeded face (tests). */
export function clearFaceArt(): void { faceArt.clear(); }

/**
 * One key per print: BrickLink numbers a head print once across moulds, so
 * `3626pb3484`, `3626cpb3484(.dat)` and `3626bpb3484` are the same face.
 */
export const faceKey = (part: string): string => {
  const stem = part.toLowerCase().replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.dat$/, '');
  const m = /^(?:3626[bc]?|28621)(pb?)([0-9a-z]+)$/.exec(stem);
  return m ? `3626${m[1]}${m[2]}` : stem;
};

/**
 * Face art for this head, by its print id (`headPrint`) and else by its part
 * name (the 2026-09-24 identity names, `3626cpb3484.dat`), resampled onto the
 * head's body rectangle at `FACE_PX_PER_LDU`; null when none was seeded.
 */
export function faceArtImage(part: string, mesh: LdrawPartMesh, headPrint?: string): FaceImage | null {
  const art = (headPrint ? faceArt.get(faceKey(headPrint)) : undefined) ?? faceArt.get(faceKey(part));
  if (!art) return null;
  const rect = headBodyRect(mesh);
  const width = Math.max(1, Math.round((rect.x1 - rect.x0) * FACE_PX_PER_LDU));
  const height = Math.max(1, Math.round((rect.y1 - rect.y0) * FACE_PX_PER_LDU));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(art.height - 1, Math.floor(((y + 0.5) / height) * art.height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(art.width - 1, Math.floor(((x + 0.5) / width) * art.width));
      const s = (sy * art.width + sx) * 4, o = (y * width + x) * 4;
      // Alpha-tested: the art's own alpha decides ink, at the half-way mark.
      if (art.rgba[s + 3]! < 128) continue;
      rgba[o] = art.rgba[s]!; rgba[o + 1] = art.rgba[s + 1]!; rgba[o + 2] = art.rgba[s + 2]!; rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba, rect };
}

// ─── Orienting a face onto a Bedrock cube face ───────────────────────────────

/** The cube face a decal is drawn on, by its name in the geometry JSON. */
export type BedrockFaceName = 'north' | 'south' | 'east' | 'west';

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const snapAxis = (v: Vec3): Vec3 | null => {
  const i = [0, 1, 2].reduce((best, k) => (Math.abs(v[k]!) > Math.abs(v[best]!) ? k : best), 0);
  if (Math.abs(v[i]!) < 0.99) return null;
  const out: Vec3 = [0, 0, 0];
  out[i] = Math.sign(v[i]!);
  return out;
};

/**
 * Re-lay a face image for the cube face its print looks out of.
 *
 * Directions are in the compiler's RENDER frame (right-handed, Y up), where
 * the game is a proper rotation away (`world = (−x, y, −z)` at yaw 0, proven
 * on the Pixel): a texture must therefore read UNMIRRORED from outside in
 * this frame, with the image's right along `(−n) × up` and its down along
 * −Y. Bedrock's JSON mirrors X, so a render normal of +X is the JSON `west`
 * face and −X is `east`. A player skin's face on its head's `north` face
 * agrees: in JSON terms north runs u → +X, south u → −X, east u → +Z,
 * west u → −Z, and v → −Y on all four.
 *
 * `normal`, `right` and `down` are where the image's outward normal, +column
 * and +row point in the render frame. Null when the face does not look along
 * a horizontal axis (a figure lying down keeps its printed cuboids instead).
 */
export function orientFace(img: FaceImage, normal: Vec3, right: Vec3, down: Vec3): { face: BedrockFaceName; width: number; height: number; rgba: Uint8Array } | null {
  const n = snapAxis(normal), r = snapAxis(right), d = snapAxis(down);
  if (!n || !r || !d || n[1] !== 0) return null;
  const up: Vec3 = [0, 1, 0];
  const m: Vec3 = [-n[0], -n[1], -n[2]];
  const rc: Vec3 = [m[1] * up[2] - m[2] * up[1], m[2] * up[0] - m[0] * up[2], m[0] * up[1] - m[1] * up[0]];
  const dc: Vec3 = [0, -1, 0];
  const face: BedrockFaceName = n[2] === -1 ? 'north' : n[2] === 1 ? 'south' : n[0] === 1 ? 'west' : 'east';
  // Output column runs along rc, output row along dc; find each in the source.
  const colFromCol = dot(rc, r), colFromRow = dot(rc, d);
  const rowFromCol = dot(dc, r), rowFromRow = dot(dc, d);
  const transposed = colFromCol === 0;
  const W = transposed ? img.height : img.width, H = transposed ? img.width : img.height;
  const rgba = new Uint8Array(W * H * 4);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      // Source (column, row) of output (u, v): each output axis is ± one source axis.
      let sc: number, sr: number;
      if (!transposed) {
        sc = colFromCol > 0 ? u : img.width - 1 - u;
        sr = rowFromRow > 0 ? v : img.height - 1 - v;
      } else {
        sr = colFromRow > 0 ? u : img.height - 1 - u;
        sc = rowFromCol > 0 ? v : img.width - 1 - v;
      }
      const s = (sr * img.width + sc) * 4, o = (v * W + u) * 4;
      rgba[o] = img.rgba[s]!; rgba[o + 1] = img.rgba[s + 1]!; rgba[o + 2] = img.rgba[s + 2]!; rgba[o + 3] = img.rgba[s + 3]!;
    }
  }
  return { face, width: W, height: H, rgba };
}

// ─── One atlas per entity ────────────────────────────────────────────────────

export interface FaceAtlas {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Top-left texel of each input image, in input order. */
  at: Array<[number, number]>;
}

/**
 * Shelf-pack face images into one texture, with a transparent texel gutter so
 * a neighbour never bleeds into a face under nearest sampling. Width is a
 * multiple of 16; the height follows.
 */
export function packFaceAtlas(images: ReadonlyArray<{ width: number; height: number; rgba: Uint8Array }>): FaceAtlas {
  const GUTTER = 1;
  const area = images.reduce((s, im) => s + (im.width + GUTTER) * (im.height + GUTTER), 0);
  const widest = Math.max(16, ...images.map(im => im.width + GUTTER));
  const width = Math.ceil(Math.max(widest, Math.sqrt(area)) / 16) * 16;
  const at: Array<[number, number]> = [];
  let x = 0, y = 0, shelf = 0;
  for (const im of images) {
    if (x + im.width + GUTTER > width) { x = 0; y += shelf; shelf = 0; }
    at.push([x, y]);
    x += im.width + GUTTER;
    shelf = Math.max(shelf, im.height + GUTTER);
  }
  const height = Math.max(16, Math.ceil((y + shelf) / 16) * 16);
  const rgba = new Uint8Array(width * height * 4);
  images.forEach((im, k) => {
    const [ox, oy] = at[k]!;
    for (let row = 0; row < im.height; row++) rgba.set(im.rgba.subarray(row * im.width * 4, (row + 1) * im.width * 4), ((oy + row) * width + ox) * 4);
  });
  return { width, height, rgba, at };
}
