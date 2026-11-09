/**
 * Store and gallery media from a built pack, offline (BIZ-62 / X-14; plan D section 6): stills per platform
 * preset and turntables (PNG frames, WebM, MP4, GIF, poster), every file under 2000 px a side and 4 MB.
 *
 * The picture is the game frame (see web/src/release/media-framing.ts: NOT mirrored; test/release-media.test.ts),
 * auto-fitted so the model fills the preset's share of the frame, rendered at --ss (default 2) times the size
 * and Lanczos-downscaled, on a brand backdrop with a ground and contact shadow.
 *
 * Usage: bun scripts/media-turntable.ts <pack.mcaddon> --out=<dir> [--preset=all|id[,id]] [--frames=72]
 *          [--ss=2] [--size=100] [--game-frame] [--kinds=a,b] [--type=<regex>] [--no-video]
 *   --game-frame  accepted and implied: media is always drawn in the game frame (a no-op kept for the plan's wording).
 * Output: <out>/<preset>/... and <out>/media.json (every file, its size, its pixels, the fill measured).
 * Needs ffmpeg on PATH for the video and GIF outputs (stills do not).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { availableParallelism } from 'node:os';
import { buildAddonPreviewModel, readAddonPreviewFiles } from '../web/src/ui/addon-preview-data.ts';
import { placeActors } from '../web/src/release/media-framing.ts';
import { MAX_BYTES_EXCLUSIVE, selectPresets, type StillPreset, type TurntablePreset } from '../web/src/release/media-presets.ts';
import { buildScene, decodeFaceAtlases, encodeStill, fitGif, planCamera, renderPresetFrame, type Scene } from '../web/src/release/media-render.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const file = args.find(a => !a.startsWith('--'));
const outDir = flag('out');
if (!file || !outDir) { console.error('usage: bun scripts/media-turntable.ts <pack.mcaddon> --out=<dir> [--preset=all|id,id] [--frames=72] [--ss=2] [--size=100] [--kinds=..] [--type=..] [--no-video] [--jobs=N]'); process.exit(2); }
const presets = selectPresets(flag('preset') ?? 'all');
const supersample = Number(flag('ss') ?? 2);
const sizePct = Number(flag('size') ?? 100);
const framesOverride = flag('frames') ? Number(flag('frames')) : undefined;
const noVideo = args.includes('--no-video');
/** `--slice=k/n` is internal: a child process rendering every n-th frame starting at k. */
const sliceFlag = flag('slice')?.split('/').map(Number);
const slice = sliceFlag ? { k: sliceFlag[0]!, n: sliceFlag[1]! } : undefined;
/** Render workers for a turntable (the raster is single-threaded JS): a third of the cores by default, shared machine. */
const jobs = Number(flag('jobs') ?? Math.max(1, Math.min(6, Math.floor(availableParallelism() / 3))));
const kinds = flag('kinds')?.split(',');
const typeFilter = flag('type');

interface MediaFile { path: string; bytes: number; width?: number; height?: number; note?: string }
const manifest: MediaFile[] = [];

const bytes = readFileSync(file);
const files = await readAddonPreviewFiles(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
const model = buildAddonPreviewModel(files);
const placed = placeActors(model, files, sizePct, { ...(kinds ? { kinds } : {}), ...(typeFilter ? { typeFilter } : {}) });
if (!placed.length) throw new Error('no actors spawn at this size / filter');
const scene: Scene = buildScene(placed.map(p => p.actor));
const atlases = await decodeFaceAtlases(model.faceTextures);

/** Record a written file and check the 4 MB rule on it. */
function record(path: string, width?: number, height?: number, note?: string): void {
  const size = statSync(path).size;
  if (size >= MAX_BYTES_EXCLUSIVE) throw new Error(`${path} is ${size} bytes, not under 4 MB`);
  manifest.push({ path, bytes: size, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(note ? { note } : {}) });
}

/** Run ffmpeg; throws with its stderr tail on failure. */
function ffmpeg(argv: string[]): void {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...argv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}): ${(r.stderr ?? '').slice(-600)}`);
}

async function stillPreset(p: StillPreset): Promise<void> {
  const dir = join(outDir!, p.id);
  mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  const camera = planCamera(scene, p, 1);
  const frame = await renderPresetFrame(scene, p, camera, 0, 1, supersample, atlases);
  const enc = await encodeStill(frame.rgb, frame.width, frame.height, p.format, p.maxBytes);
  const path = join(dir, `${p.id}.${p.format}`);
  writeFileSync(path, enc.data);
  record(path, frame.width, frame.height, `${p.note}; fill ${(100 * frame.fillWidth).toFixed(0)} percent of width; quality ${enc.quality}`);
  console.log(`${p.id}: ${path} ${frame.width}x${frame.height} ${enc.data.length} bytes, fill ${(100 * frame.fillWidth).toFixed(0)} percent, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

async function turntablePreset(p: TurntablePreset): Promise<void> {
  const dir = join(outDir!, p.id), frameDir = join(dir, 'frames');
  mkdirSync(frameDir, { recursive: true });
  const count = framesOverride ?? p.frames;
  const t0 = performance.now();
  const camera = planCamera(scene, p, Math.min(count, 16));
  const framePath = (i: number): string => join(frameDir, `f${String(i).padStart(3, '0')}.png`);
  /** Render and write frames `indices`; returns the width share the model spans in each. */
  const renderSlice = async (indices: number[]): Promise<number[]> => {
    const shares: number[] = [];
    for (const i of indices) {
      const frame = await renderPresetFrame(scene, p, camera, i, count, supersample, atlases);
      shares.push(frame.fillWidth);
      // Level 3: these frames feed ffmpeg and a size check, not a download; level 9 costs a third of a frame's time.
      writeFileSync(framePath(i), (await sharp(frame.rgb, { raw: { width: frame.width, height: frame.height, channels: 3 } }).png({ compressionLevel: 3 }).toBuffer()));
    }
    return shares;
  };
  const all = Array.from({ length: count }, (_, i) => i);
  if (slice) {
    // Child process: this worker's share of the frames, and the widths for the parent's report.
    const mine = all.filter(i => i % slice.n === slice.k);
    const shares = await renderSlice(mine);
    writeFileSync(join(frameDir, `widths-${slice.k}.json`), JSON.stringify(mine.map((i, j) => [i, shares[j]])));
    return;
  }
  const widths: number[] = new Array<number>(count).fill(0);
  if (jobs > 1) {
    await Promise.all(Array.from({ length: jobs }, (_, k) => new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, [process.argv[1]!, file!, `--out=${outDir}`, `--preset=${p.id}`, `--frames=${count}`, `--ss=${supersample}`, `--size=${sizePct}`, `--slice=${k}/${jobs}`, ...(kinds ? [`--kinds=${kinds.join(',')}`] : []), ...(typeFilter ? [`--type=${typeFilter}`] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', code => (code === 0 ? done() : fail(new Error(`render worker ${k} exited ${code}`))));
    })));
    for (let k = 0; k < jobs; k++) for (const [i, w] of JSON.parse(readFileSync(join(frameDir, `widths-${k}.json`), 'utf8')) as Array<[number, number]>) widths[i] = w;
  } else {
    (await renderSlice(all)).forEach((w, i) => { widths[i] = w; });
  }
  const pngs = all.map(framePath);
  // Poster: the hero still of this preset (fitted to the hero angle alone, so the model fills the share the
  // turntable's one distance cannot give an elongated model at every angle), as PNG and WebP.
  const posterPng = join(dir, 'poster.png'), posterWebp = join(dir, 'poster.webp');
  const hero = await renderPresetFrame(scene, p, planCamera(scene, p, 1), 0, 1, supersample, atlases);
  writeFileSync(posterPng, (await encodeStill(hero.rgb, p.width, p.height, 'png', MAX_BYTES_EXCLUSIVE - 1)).data);
  record(posterPng, p.width, p.height, `poster; fill ${(100 * hero.fillWidth).toFixed(0)} percent of width`);
  writeFileSync(posterWebp, (await encodeStill(hero.rgb, p.width, p.height, 'webp', MAX_BYTES_EXCLUSIVE - 1)).data);
  record(posterWebp, p.width, p.height, 'poster');
  const renderS = (performance.now() - t0) / 1000;
  const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
  const note = `${count} frames; fill of width min ${(100 * Math.min(...widths)).toFixed(0)} / mean ${(100 * mean).toFixed(0)} / max ${(100 * Math.max(...widths)).toFixed(0)} percent`;
  console.log(`${p.id}: ${count} frames rendered in ${renderS.toFixed(1)} s; ${note}`);
  manifest.push({ path: frameDir, bytes: 0, width: p.width, height: p.height, note });
  if (noVideo) return;
  const pattern = join(frameDir, 'f%03d.png');
  // MP4: H.264, yuv420p, faststart. CRF walks up until the clip is under budget.
  const encodeVideo = (outPath: string, codecArgs: (crf: number) => string[]): void => {
    for (const crf of [23, 27, 31, 35, 39]) {
      ffmpeg(['-framerate', String(p.fps), '-i', pattern, ...codecArgs(crf), outPath]);
      if (statSync(outPath).size < MAX_BYTES_EXCLUSIVE) return;
    }
    throw new Error(`${outPath} stays over 4 MB at the highest CRF`);
  };
  const mp4 = join(dir, `${p.id}.mp4`), webm = join(dir, `${p.id}.webm`);
  encodeVideo(mp4, crf => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-movflags', '+faststart']);
  record(mp4, p.width, p.height, 'H.264 yuv420p faststart');
  encodeVideo(webm, crf => ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', String(crf + 4), '-row-mt', '1']);
  record(webm, p.width, p.height, 'VP9');
  // GIF: scaled to gifWidth, 256-colour palette; frames are DROPPED (never the 4 MB rule) until it fits.
  const gifH = Math.round(p.height * p.gifWidth / p.width / 2) * 2;
  const gif = join(dir, `${p.id}.gif`);
  const clipSeconds = count / p.fps;
  const fitted = await fitGif(count, MAX_BYTES_EXCLUSIVE - 1, async (kept, stride) => {
    const listPath = join(dir, `gif-frames-${stride}.txt`);
    // The concat demuxer holds each kept frame for the original duration times the stride, so the clip length stays.
    writeFileSync(listPath, kept.map(i => `file '${resolve(pngs[i]!).replace(/\\/g, '/')}'\nduration ${(stride / p.fps).toFixed(5)}`).join('\n') + '\n');
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-vf', `scale=${p.gifWidth}:${gifH}:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', gif]);
    return readFileSync(gif);
  });
  // Re-write the winning encode (the last attempt on disk is the winner: the ladder stops at the first fit).
  writeFileSync(gif, fitted.data);
  record(gif, p.gifWidth, gifH, `GIF, ${fitted.frames.length} of ${count} frames (stride ${fitted.stride}), ${clipSeconds.toFixed(1)} s`);
  console.log(`${p.id}: mp4 ${statSync(mp4).size}, webm ${statSync(webm).size}, gif ${fitted.data.length} bytes (${fitted.frames.length} frames)`);
}

for (const p of presets) { if (p.kind === 'still') { if (!slice) await stillPreset(p); } else await turntablePreset(p); }
if (slice) process.exit(0);
writeFileSync(join(outDir, 'media.json'), JSON.stringify({ pack: file, sizePct, supersample, files: manifest }, null, 1));
console.log(`${manifest.length} entries in ${join(outDir, 'media.json')}`);
