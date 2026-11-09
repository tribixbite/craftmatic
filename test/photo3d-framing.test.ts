/**
 * Photo framing for Pixal3D's rig (BIZ-39 / WP B15). Pure pixel maths on synthetic photos: no ComfyUI, no disk.
 */
import { describe, it, expect } from 'vitest';
import { FRAME, PAD, frameViews, maskBox, type RawImage, type RawMask } from '../tools/photo3d/framing';

/** A grey photo of `w x h` with a red figure rectangle (x0,y0,x1,y1); the mask is that rectangle. */
function synthetic(w: number, h: number, box: [number, number, number, number]): { photo: RawImage; mask: RawMask } {
  const rgb = new Uint8Array(w * h * 3).fill(90);
  const mask = new Float32Array(w * h);
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      mask[y * w + x] = 1;
      rgb.set([220, 40, 40], (y * w + x) * 3);
    }
  }
  return { photo: { width: w, height: h, data: rgb }, mask: { width: w, height: h, data: mask } };
}

/** Bounding box of the framed view's boolean mask, via the same helper the framing uses. */
function framedBox(m: Uint8Array): [number, number, number, number] {
  return maskBox({ width: FRAME, height: FRAME, data: Float32Array.from(m, (v) => (v ? 1 : 0)) });
}

describe('photo3d framing', () => {
  const front = synthetic(800, 600, [300, 100, 500, 500]); // 200 wide x 400 tall
  const left = synthetic(1200, 900, [400, 150, 1000, 750]); // 600 wide x 600 tall: the widest extent
  const back = synthetic(640, 640, [200, 40, 420, 600]); // 220 wide x 560 tall

  it('every framed view has the same figure height and the largest extent spans 1024/1.1 px', async () => {
    const framed = await frameViews(
      { front: front.photo, left: left.photo, back: back.photo },
      { front: front.mask, left: left.mask, back: back.mask },
    );
    const heights: number[] = [];
    const extents: number[] = [];
    for (const f of Object.values(framed)) {
      const [x0, y0, x1, y1] = framedBox(f.mask);
      heights.push(y1 - y0);
      extents.push(Math.max(x1 - x0, y1 - y0));
    }
    // Same figure height from every side (within a pixel or two of resampling).
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(2);
    // The widest view's larger extent fills FRAME / PAD.
    expect(Math.max(...extents)).toBeGreaterThanOrEqual(Math.floor(FRAME / PAD) - 2);
    expect(Math.max(...extents)).toBeLessThanOrEqual(Math.ceil(FRAME / PAD) + 2);
  });

  it('centres the mask box in the frame and composites the figure on black', async () => {
    const framed = await frameViews({ front: front.photo }, { front: front.mask });
    const f = framed['front']!;
    const [x0, y0, x1, y1] = framedBox(f.mask);
    expect(Math.abs((x0 + x1) / 2 - FRAME / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs((y0 + y1) / 2 - FRAME / 2)).toBeLessThanOrEqual(2);
    expect(f.rgb.length).toBe(FRAME * FRAME * 3);
    // A corner pixel is background: black. The centre pixel is the figure's red.
    expect([f.rgb[0], f.rgb[1], f.rgb[2]]).toEqual([0, 0, 0]);
    const c = (FRAME / 2 + FRAME * (FRAME / 2)) * 3;
    expect(f.rgb[c]!).toBeGreaterThan(180);
    expect(f.rgb[c + 1]!).toBeLessThan(80);
  });

  it('rejects a photo whose background mask is empty', async () => {
    const empty = synthetic(100, 100, [0, 0, 0, 0]);
    await expect(frameViews({ front: empty.photo }, { front: empty.mask })).rejects.toThrow(/no figure/);
  });
});
