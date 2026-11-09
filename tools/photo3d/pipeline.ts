/**
 * Photos of a real build -> a coloured GLB through a local ComfyUI (BIZ-39 / WP B15). Ported from pokefit
 * `photos_to_glb` / `photo_to_glb`, minus pokefit's photo-colour reprojection and figure-facing steps (a
 * figure-specific refinement; the model's own vertex colours are kept). TODO(photo3d): reproject the photos'
 * colours onto the mesh if the corpus benchmark (B17) shows the model's albedo is too dark.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decodePngNode } from '../../src/pipeline/export/png-decode-node';
import { ComfyClient, ComfyError, firstFile, type ComfyOptions } from './comfy';
import { encodePng, decodePhoto, flipImage, flipMask, frameViews, type Framed, type RawImage, type RawMask } from './framing';
import { generatePrompt, maskPrompt, singlePrompt, VIEWS, type GenOptions, DEFAULT_OPTIONS } from './graphs';
import { meshStats, readGlb, type MeshStats } from './glb';

export interface PipelineOptions {
  comfy?: ComfyOptions;
  gen?: GenOptions;
  /** No right photo: mirror the left one (default true; measured in pokefit: rounder, same GPU time). */
  mirrorRight?: boolean;
  /** Folder for the framed views and masks. Default: next to the output, named after it. */
  workDir?: string;
  log?: (line: string) => void;
  /** Cap on a photo's long edge before upload, px. */
  maxEdge?: number;
}

export interface PipelineReport {
  glb: string;
  views: string[];
  maskSeconds: number;
  generateSeconds: number;
  totalSeconds: number;
  bytes: number;
  mesh: MeshStats & { hasVertexColour: boolean; hasTexture: boolean };
  options: GenOptions;
}

const seconds = (t0: number): number => Math.round((Date.now() - t0) / 100) / 10;

/** A decoded mask PNG (greyscale rendered as RGB) to a 0..1 mask resampled to `w` x `h`. */
async function decodeMask(png: Uint8Array, w: number, h: number): Promise<RawMask> {
  const dec = await decodePngNode(png);
  if (!dec) throw new ComfyError('could not decode the mask PNG ComfyUI returned');
  const src = new Float32Array(dec.width * dec.height);
  for (let i = 0; i < src.length; i++) src[i] = dec.pixels[i * 4]! / 255;
  if (dec.width === w && dec.height === h) return { width: w, height: h, data: src };
  // Nearest-neighbour is enough here: ComfyUI returns the mask at the photo's own size, so this only guards a mismatch.
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(dec.height - 1, Math.floor((y * dec.height) / h));
    for (let x = 0; x < w; x++) out[y * w + x] = src[sy * dec.width + Math.min(dec.width - 1, Math.floor((x * dec.width) / w))]!;
  }
  return { width: w, height: h, data: out };
}

async function finish(
  glbBytes: Uint8Array,
  out: string,
  views: string[],
  gen: GenOptions,
  t: { start: number; mask: number; gen: number },
): Promise<PipelineReport> {
  const mesh = readGlb(glbBytes);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, glbBytes);
  return {
    glb: out,
    views,
    maskSeconds: t.mask,
    generateSeconds: t.gen,
    totalSeconds: seconds(t.start),
    bytes: glbBytes.length,
    mesh: { ...meshStats(mesh), hasVertexColour: mesh.hasVertexColour, hasTexture: mesh.hasTexture },
    options: gen,
  };
}

/** Several views of one build (a `front` is required and is the pose) to a GLB, via Pixal3D multi-view. */
export async function photosToGlb(
  photoFiles: Partial<Record<(typeof VIEWS)[number], string>>,
  out: string,
  options: PipelineOptions = {},
): Promise<PipelineReport> {
  const log = options.log ?? (() => undefined);
  const gen = options.gen ?? DEFAULT_OPTIONS;
  const names: string[] = VIEWS.filter((v) => photoFiles[v]);
  if (names[0] !== 'front') throw new Error('a front photo is required (and is the pose the model gets)');
  const comfy = new ComfyClient(options.comfy);
  if (!(await comfy.alive())) throw new ComfyError(`ComfyUI is not running at ${comfy.url}`);
  const work = options.workDir ?? out.replace(/\.glb$/i, '') + '_work';
  await mkdir(work, { recursive: true });
  const tag = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();

  const images: Record<string, RawImage> = {};
  for (const v of names) images[v] = await decodePhoto(photoFiles[v as (typeof VIEWS)[number]]!, options.maxEdge);
  const uploaded: Record<string, string> = {};
  for (const v of names) uploaded[v] = await comfy.upload(`photo3d_${tag}_${v}.png`, await encodePng(images[v]!.data, images[v]!.width, images[v]!.height));
  log(`masks: BiRefNet on ${names.join(', ')}`);
  const maskOuts = await comfy.run(maskPrompt(uploaded));
  const masks: Record<string, RawMask> = {};
  for (const v of names) {
    masks[v] = await decodeMask(await comfy.fetchFile(firstFile(maskOuts, `save_${v}`)), images[v]!.width, images[v]!.height);
  }
  // No right photo: the left one mirrored (pokefit: with 3 views the far side is invented and comes out boxy).
  if ((options.mirrorRight ?? true) && images['left'] && !images['right']) {
    images['right'] = flipImage(images['left']);
    masks['right'] = flipMask(masks['left']!);
    names.push('right');
  }
  const framed: Record<string, Framed> = await frameViews(images, masks);
  const views: Record<string, string> = {};
  for (const v of names) {
    const png = await encodePng(framed[v]!.rgb, 1024, 1024);
    await writeFile(path.join(work, `view_${v}.png`), png);
    views[v] = await comfy.upload(`photo3d_${tag}_view_${v}.png`, png);
  }
  const maskSeconds = seconds(t0);
  const t1 = Date.now();
  log(`generating with Pixal3D (${names.length} views, a few minutes)`);
  let outs;
  try {
    outs = await comfy.run(generatePrompt(views, gen, `photo3d/${path.basename(out, '.glb')}_${tag}`), (s) =>
      log(`generating: ${Math.round(s)} s`),
    );
  } finally {
    await comfy.free();
  }
  const glb = await comfy.fetchFile(firstFile(outs, 'save'));
  return finish(glb, out, names, gen, { start: t0, mask: maskSeconds, gen: seconds(t1) });
}

/** One photo from any angle to a GLB (single-view Pixal3D, or TRELLIS.2 with `gen.model === 'trellis2'`). */
export async function photoToGlb(photo: string, out: string, options: PipelineOptions = {}): Promise<PipelineReport> {
  const log = options.log ?? (() => undefined);
  const gen = options.gen ?? DEFAULT_OPTIONS;
  const comfy = new ComfyClient(options.comfy);
  if (!(await comfy.alive())) throw new ComfyError(`ComfyUI is not running at ${comfy.url}`);
  const tag = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  const img = await decodePhoto(photo, options.maxEdge);
  const name = await comfy.upload(`photo3d_${tag}_photo.png`, await encodePng(img.data, img.width, img.height));
  log(`generating with ${gen.model === 'trellis2' ? 'TRELLIS.2' : 'Pixal3D'} (one photo, a few minutes)`);
  let outs;
  try {
    outs = await comfy.run(singlePrompt(name, gen, `photo3d/${path.basename(out, '.glb')}_${tag}`), (s) =>
      log(`generating: ${Math.round(s)} s`),
    );
  } finally {
    await comfy.free();
  }
  const glb = await comfy.fetchFile(firstFile(outs, 'save'));
  return finish(glb, out, ['photo'], gen, { start: t0, mask: 0, gen: seconds(t0) });
}

/** Write a JSON report next to the GLB. */
export async function writeReport(report: PipelineReport): Promise<string> {
  const p = report.glb.replace(/\.glb$/i, '') + '.report.json';
  await writeFile(p, JSON.stringify(report, null, 2));
  return p;
}
