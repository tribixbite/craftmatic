/**
 * X-14 / BIZ-62: offline media renders of a built pack. The mirror question first: which side of the picture
 * does a part on JSON +X land on, compared with what the game shows?
 *
 * The oracle is NOT worldFaces. It is Bedrock's own entity convention: JSON +X is the entity's LEFT (vanilla
 * player.geo.json: leftarm pivot x +5, rightarm x -5; web/src/sim/core/vec.ts entity frame "x left, z forward"),
 * and an entity at yaw 0 faces world +Z. A viewer standing in front of it therefore sees its left on the
 * viewer's RIGHT; from behind, on the viewer's left. (A first cut that mirrored JSON X, per the plan row,
 * failed this test: the marker came out on the wrong side. The game frame is the plain frame.)
 */
import { describe, expect, it } from 'vitest';
import type { AuditActor, GeoEntryLike, Vec3 } from '../web/src/engine/bedrock-geometry-faces.js';
import { buildScene, encodeStill, fitGif, planCamera, renderPresetFrame, renderView } from '../web/src/release/media-render.js';
import { MAX_BYTES_EXCLUSIVE, MAX_SIDE_EXCLUSIVE, MEDIA_PRESETS, presetById, selectPresets, type MediaPreset } from '../web/src/release/media-presets.js';

/** One grey body cube with a red marker cube at JSON +X (the entity's left). */
const markerEntry = (): GeoEntryLike => ({
  bones: [{ name: 'body', pivot: [0, 0, 0] }],
  groups: [
    { ldrawColor: 71, alpha: 1, cubes: [{ bone: 'body', origin: [-4, 0, -4], size: [8, 16, 8] }] },
    { ldrawColor: 4, alpha: 1, cubes: [{ bone: 'body', origin: [4, 4, -3], size: [8, 8, 6] }] },
  ],
});
const actor = (): AuditActor => ({ typeId: 't:marker', kind: 'shell', entry: markerEntry(), at: { x: 0, y: 0, z: 0 }, yawDeg: 0 });

/** Mean image x (0..1) of the strongly red pixels, or null when there are none. */
function redCentroidX(rgb: Uint8Array, w: number, h: number): number | null {
  let sum = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (rgb[i]! > 150 && rgb[i + 1]! < 80 && rgb[i + 2]! < 80) { sum += x + 0.5; n++; }
  }
  return n ? sum / n / w : null;
}

describe('release-media: game-frame render', () => {
  const W = 160, H = 120;
  const at: Vec3 = [0, 0.5, 0];
  it('a game-frame render of an asymmetric fixture puts the marker on the side the device shows: the entity\'s left is on the viewer\'s right from the front', () => {
    const { rgb } = renderView([actor()], [0, 1, 6], at, { width: W, height: H, fovDeg: 50 });
    const cx = redCentroidX(rgb, W, H);
    expect(cx).not.toBeNull();
    expect(cx!).toBeGreaterThan(0.55);
  });
  it('and on the viewer\'s left from behind', () => {
    const { rgb } = renderView([actor()], [0, 1, -6], at, { width: W, height: H, fovDeg: 50 });
    const cx = redCentroidX(rgb, W, H);
    expect(cx).not.toBeNull();
    expect(cx!).toBeLessThan(0.45);
  });
});

describe('release-media: presets and budgets', () => {
  it('every preset is under 2000 px each side and every byte budget under 4 MB', () => {
    for (const p of MEDIA_PRESETS) {
      expect(p.width, p.id).toBeLessThan(MAX_SIDE_EXCLUSIVE);
      expect(p.height, p.id).toBeLessThan(MAX_SIDE_EXCLUSIVE);
      if (p.kind === 'still') expect(p.maxBytes, p.id).toBeLessThan(MAX_BYTES_EXCLUSIVE);
    }
    expect(presetById('itch-cover')).toMatchObject({ width: 630, height: 500 });
    expect(presetById('yt-thumb')).toMatchObject({ width: 1280, height: 720, maxBytes: expect.any(Number) });
    expect((presetById('yt-thumb') as { maxBytes: number }).maxBytes).toBeLessThan(2_000_000);
    expect(selectPresets('all')).toHaveLength(MEDIA_PRESETS.length);
    expect(() => selectPresets('nope')).toThrow(/valid:/);
  });

  it('every preset output is under 2000 px each side and under 4 MB', async () => {
    const scene = buildScene([actor()]);
    for (const p of MEDIA_PRESETS) {
      const camera = planCamera(scene, p, 1);
      const frame = await renderPresetFrame(scene, p, camera, 0, 1, 1);
      expect(frame.width).toBe(p.width);
      expect(frame.height).toBe(p.height);
      expect(frame.width).toBeLessThan(MAX_SIDE_EXCLUSIVE);
      expect(frame.height).toBeLessThan(MAX_SIDE_EXCLUSIVE);
      const enc = await encodeStill(frame.rgb, frame.width, frame.height, p.kind === 'still' ? p.format : 'png', p.kind === 'still' ? p.maxBytes : MAX_BYTES_EXCLUSIVE - 1);
      expect(enc.data.length, p.id).toBeLessThan(p.kind === 'still' ? p.maxBytes + 1 : MAX_BYTES_EXCLUSIVE);
    }
  }, 60_000);

  it('the model fills 55-75 percent of the frame width at the hero angle', async () => {
    const scene = buildScene([actor()]);
    for (const id of ['screenshot', 'og', 'cf-logo', 'itch-cover']) {
      const p: MediaPreset = presetById(id);
      const frame = await renderPresetFrame(scene, p, planCamera(scene, p, 1), 0, 1, 1);
      // A one-cube-ish fixture is height-limited in wide frames; the share is the target of whichever limit binds.
      const limit = p.framing.fillWidth;
      expect(frame.fillWidth, id).toBeLessThanOrEqual(limit + 0.02);
      expect(frame.fillWidth, id).toBeGreaterThan(0.25);
    }
    const sq = presetById('cf-logo');
    const frame = await renderPresetFrame(scene, sq, planCamera(scene, sq, 1), 0, 1, 1);
    expect(frame.fillWidth).toBeGreaterThanOrEqual(0.55);
    expect(frame.fillWidth).toBeLessThanOrEqual(0.75);
  });

  it('the stage replaces the sky but leaves the model pixels alone', async () => {
    const scene = buildScene([actor()]);
    const p = presetById('avatar');
    const frame = await renderPresetFrame(scene, p, planCamera(scene, p, 1), 0, 1, 1);
    // The raw sky gradient is light blue (blue channel 230); the brand backdrop is dark everywhere in a corner.
    const corner = (x: number, y: number): number[] => [0, 1, 2].map(c => frame.rgb[(y * frame.width + x) * 3 + c]!);
    expect(Math.max(...corner(2, 2))).toBeLessThan(80);
    expect(redCentroidX(frame.rgb, frame.width, frame.height)).not.toBeNull();
  });
});

describe('release-media: gif budget', () => {
  it('the GIF preset drops frames rather than exceed 4 MB', async () => {
    // A fake encoder whose size is proportional to the number of kept frames: 72 frames = 9 MB.
    const encode = async (frames: number[]): Promise<Uint8Array> => new Uint8Array(frames.length * 125_000);
    const fitted = await fitGif(72, MAX_BYTES_EXCLUSIVE - 1, encode);
    expect(fitted.stride).toBeGreaterThan(1);
    expect(fitted.data.length).toBeLessThan(MAX_BYTES_EXCLUSIVE);
    expect(fitted.frames.length).toBeLessThan(72);
    // Every fitting stride below it was over budget: it drops no more than it must.
    const prev = Math.ceil(72 / (fitted.stride === 2 ? 1 : fitted.stride - 1));
    expect(prev * 125_000).toBeGreaterThanOrEqual(MAX_BYTES_EXCLUSIVE - 1);
  });
  it('keeps every frame when they already fit, and throws when nothing fits', async () => {
    expect((await fitGif(72, 4_000_000, async f => new Uint8Array(f.length * 1000))).stride).toBe(1);
    await expect(fitGif(72, 4_000_000, async () => new Uint8Array(5_000_000))).rejects.toThrow(/over budget/);
  });
});

describe('release-media: one framing module', () => {
  it('_pack_render.ts and media-turntable.ts share web/src/release/media-framing.ts instead of copying it', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['scripts/_pack_render.ts', 'scripts/media-turntable.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/release\/media-(framing|render)\.ts/);
      expect(src, f).not.toMatch(/Math\.sin\(fov \/ 2\) \* 1\.1/);
    }
  });
});
