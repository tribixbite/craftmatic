import { describe, it, expect } from 'vitest';
import { lookupProfile } from './profile.js';

describe('lookupProfile', () => {
  it('base row for small + suburban (identity modifier)', () => {
    const p = lookupProfile({ size: 'small', svDifficulty: 'suburban' });
    expect(p.tiles.radiusM).toBe(40);
    expect(p.streetview.dirCount).toBe(4);
    expect(p.streetview.offsetM).toBe(30);
    expect(p.satellite.scale).toBe(1);
  });

  it('dense-urban modifier halves SV offset + concats angleVariants', () => {
    const p = lookupProfile({ size: 'tiny', svDifficulty: 'dense-urban' });
    expect(p.streetview.offsetM).toBe(15 / 2);
    expect(p.streetview.angleVariants).toContain(-45);
    expect(p.streetview.angleVariants).toContain(45);
  });

  it('rural-occluded sets minBuildingPixelRatio + maskTrees, extends angles to ±60', () => {
    const p = lookupProfile({ size: 'skyscraper', svDifficulty: 'rural-occluded' });
    expect(p.streetview.angleVariants).toContain(-60);
    expect(p.streetview.angleVariants).toContain(60);
    expect(p.streetview.minBuildingPixelRatio).toBe(0.15);
    expect(p.satellite.maskTrees).toBe(true);
  });

  it('no-coverage skips SV capture via dirCount=0', () => {
    const p = lookupProfile({ size: 'medium', svDifficulty: 'no-coverage' });
    expect(p.streetview.dirCount).toBe(0);
    // other fields untouched
    expect(p.streetview.offsetM).toBe(60);
  });

  it('dedup avoids duplicate angle values when modifier adds existing entries', () => {
    const p = lookupProfile({ size: 'medium', svDifficulty: 'dense-urban' });
    // base has [-30,-15,0,15,30]; dense-urban adds [-45,45]
    const vs = p.streetview.angleVariants;
    expect(new Set(vs).size).toBe(vs.length);
    expect(vs).toEqual(expect.arrayContaining([-45, -30, -15, 0, 15, 30, 45]));
  });

  it('returns a fresh object on each call (no shared mutation)', () => {
    const a = lookupProfile({ size: 'small', svDifficulty: 'suburban' });
    const b = lookupProfile({ size: 'small', svDifficulty: 'suburban' });
    expect(a).not.toBe(b);
    expect(a.streetview.angleVariants).not.toBe(b.streetview.angleVariants);
  });
});
