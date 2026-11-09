/** X-12 (BIZ-33): the metrics harness (voxel / silhouette IoU, colour, connectivity, diversity, contact sheet). */
import { describe, it, expect } from 'vitest';
import {
  voxelIoU, voxelIoUAt, silhouetteIoUs, framedCamera, drawnBounds, renderView, silhouetteIoUToMask, medianCellDeltaE, connectivity,
  partDiversity, partFamily, contactSheet, measureLattices, PLATE_RATIO, AXIS_VIEWS,
} from '../web/src/engine/legolize/metrics.js';
import { latticeIndex, type IntentLattice } from '../web/src/engine/legolize/types.js';

/** A lattice with every cell in the boxes [x0,x1) x [p0,p1) x [z0,z1) filled with LDraw colour `colour`. */
function lattice(dims: IntentLattice['dims'], boxes: Array<[number, number, number, number, number, number, number?]>): IntentLattice {
  const cells = new Uint16Array(dims[0] * dims[1] * dims[2]);
  const labels: IntentLattice['labels'] = [];
  for (const [x0, p0, z0, x1, p1, z1, colour = 4] of boxes) {
    let id = labels.findIndex((l) => l.colour === colour) + 1;
    if (id === 0) id = labels.push({ role: 'solid', colour });
    for (let p = p0; p < p1; p++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) cells[latticeIndex(dims, x, p, z)] = id;
  }
  return { dims, cells, labels };
}

describe('legolize-metrics', () => {
  it('IoU of a lattice with itself shifted one cell is 1 after alignment and < 1 before', () => {
    const a = lattice([8, 6, 8], [[1, 1, 1, 5, 4, 3], [1, 1, 3, 2, 3, 6]]);
    // The same model one cell further along x and one plate up: an L shape, so no accidental overlap.
    const b = lattice([8, 6, 8], [[2, 2, 1, 6, 5, 3], [2, 2, 3, 3, 4, 6]]);
    const r = voxelIoU(a, b);
    expect(r.iou).toBe(1);
    expect(r.shift).toEqual([-1, -1, 0]);
    expect(r.iouUnshifted).toBeLessThan(1);
    expect(voxelIoUAt(a, b)).toBe(r.iouUnshifted);
  });

  it('alignment is limited to the shift radius', () => {
    const a = lattice([12, 3, 4], [[0, 0, 0, 2, 2, 2]]);
    const b = lattice([12, 3, 4], [[5, 0, 0, 7, 2, 2]]);
    expect(voxelIoU(a, b, 2).iou).toBe(0);
    expect(voxelIoU(a, b, 5).iou).toBe(1);
  });

  it('silhouette of a known box from the +x camera equals its analytic outline', () => {
    const box = lattice([4, 5, 6], [[0, 0, 0, 4, 5, 6]]);
    const size = 240;
    const cam = framedCamera(drawnBounds([{ lattice: box }]), AXIS_VIEWS[0]!, size);
    const view = renderView(box, cam);
    const covered = view.mask.reduce((n, v) => n + v, 0);
    // Seen from +x the outline is 6 (z) by 5 plates (5 * 0.4 = 2 studs); the camera maps radius * 1.1 to half the image.
    const radius = Math.hypot(4, 5 * PLATE_RATIO, 6) / 2;
    const pxPerUnit = size / 2 / (radius * 1.1);
    expect(covered).toBeGreaterThan(6 * 2 * pxPerUnit * pxPerUnit * 0.97);
    expect(covered).toBeLessThan(6 * 2 * pxPerUnit * pxPerUnit * 1.03);
    // A lattice agrees with itself in every axis view, and a box half as wide differs from the +x side only through depth.
    expect(silhouetteIoUs(box, box).every((s) => s.iou === 1)).toBe(true);
    const narrow = lattice([4, 5, 6], [[0, 0, 0, 2, 5, 6]]);
    const byView = Object.fromEntries(silhouetteIoUs(box, narrow).map((s) => [s.view, s.iou]));
    expect(byView['+x']).toBeCloseTo(1, 2);
    expect(byView['+z']!).toBeCloseTo(0.5, 1);
  });

  it('a reference mask compares to a lattice view through the caller camera', () => {
    const box = lattice([3, 3, 3], [[0, 0, 0, 3, 3, 3]]);
    const cam = framedCamera(drawnBounds([{ lattice: box }]), AXIS_VIEWS[4]!, 64);
    const ref = renderView(box, cam).mask;
    expect(silhouetteIoUToMask(box, ref, cam)).toBe(1);
    expect(silhouetteIoUToMask(lattice([3, 3, 3], [[0, 0, 0, 1, 1, 1]]), ref, cam)).toBeLessThan(0.5);
  });

  it('median CIEDE2000 is 0 for equal colours and large for red against blue', () => {
    const red = lattice([2, 2, 2], [[0, 0, 0, 2, 2, 2, 4]]);
    const blue = lattice([2, 2, 2], [[0, 0, 0, 2, 2, 2, 1]]);
    expect(medianCellDeltaE(red, red)).toEqual({ median: 0, matched: 8 });
    expect(medianCellDeltaE(red, blue).median).toBeGreaterThan(30);
    expect(medianCellDeltaE(red, lattice([2, 2, 2], [[0, 0, 0, 1, 1, 1, 4]]), [5, 0, 0]).matched).toBe(0);
  });

  it('connectivity counts face-connected pieces and specks', () => {
    const l = lattice([6, 2, 2], [[0, 0, 0, 3, 2, 2], [4, 0, 0, 5, 1, 1], [5, 1, 1, 6, 2, 2]]);
    const c = connectivity(l);
    expect(c).toMatchObject({ filled: 14, components: 3, largest: 12, specks: 2 });
    expect(c.largestShare).toBeCloseTo(12 / 14);
    expect(connectivity(lattice([2, 2, 2], []))).toMatchObject({ filled: 0, components: 0, largestShare: 0 });
  });

  it('part diversity reads families through partStem', () => {
    expect(partFamily('3040b.dat')).toBe('slope');
    expect(partFamily('10261 - 3040.dat')).toBe('slope');
    expect(partFamily('3659.dat')).toBe('arch');
    expect(partFamily('4073.dat')).toBe('round');
    expect(partFamily('3001.dat')).toBe('other');
    const d = partDiversity(['3001.dat', '3001.dat', '3040.dat', '3659.dat']);
    expect(d).toMatchObject({ parts: 4, distinct: 3, slopeShare: 0.25, archShare: 0.25, roundShare: 0 });
    expect(partDiversity([])).toMatchObject({ parts: 0, distinct: 0, slopeShare: 0 });
  });

  it('the contact sheet stays under 2000 px however many views it holds', () => {
    const a = lattice([6, 6, 6], [[0, 0, 0, 6, 6, 6]]);
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `v${i}`, dir: [Math.cos(i), 0.3, Math.sin(i)] as [number, number, number] }));
    for (const views of [undefined, many]) {
      const s = contactSheet(a, a, views ? { tile: 400, views } : { tile: 900 });
      expect(Math.max(s.width, s.height)).toBeLessThan(2000);
      expect(s.rgb.length).toBe(s.width * s.height * 3);
    }
  });

  it('measureLattices of a model against itself is perfect', () => {
    const a = lattice([5, 4, 5], [[0, 0, 0, 5, 2, 5], [1, 2, 1, 3, 4, 3, 1]]);
    const r = measureLattices(a, a, { parts: ['3001.dat'] });
    expect(r).toMatchObject({ voxel: { iou: 1, shift: [0, 0, 0] }, silhouetteMean: 1, silhouetteMin: 1, colour: { median: 0 } });
    expect(r.connectivity.generated.components).toBe(1);
  });
});
