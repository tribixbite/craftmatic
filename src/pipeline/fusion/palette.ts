/**
 * Palette extraction — K-means clustering in CIE-Lab space.
 *
 * Used by:
 *   • Stage 4 SV capture to extract per-facade {wall, trim, accent} colours
 *   • Stage 5 satellite roof palette
 *   • Stage 6 fusion to reconcile OSM colour hints with SV/sat evidence
 *
 * Pure: takes raw RGBA pixels, returns Lab cluster centroids. No I/O.
 */

import { rgbToLab } from '../../gen/color-blocks.js';

export type Lab = readonly [L: number, a: number, b: number];

export interface PaletteExtractionResult {
  readonly clusters: readonly {
    readonly lab: Lab;
    /** Fraction of sampled pixels in this cluster (0-1). */
    readonly weight: number;
  }[];
}

export interface PaletteOptions {
  /** Number of clusters (default 3 = wall / trim / accent). */
  readonly k?: number;
  /** Max k-means iterations. Default 20. */
  readonly maxIterations?: number;
  /**
   * Per-pixel mask (same dims as pixels/4). Values: 0=include, non-zero=skip.
   * Typically the sniff mask (veg=2, sky=1) so we skip non-building pixels.
   * Pass null to include all pixels.
   */
  readonly mask?: Uint8Array | null;
  /**
   * Optional bounding-box zone to sample — expressed as ratios {x0,y0,x1,y1}
   * in [0,1]. Null = whole image. Used e.g. to limit wall sampling to the
   * bottom 60% of the facade.
   */
  readonly zone?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | null;
  /** Pixel sampling stride (every Nth pixel). Default 1 = use every pixel. */
  readonly stride?: number;
  /** RNG seed for deterministic tests. Default 0x42. */
  readonly seed?: number;
}

// ─── Deterministic RNG ──────────────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state = (state + Math.imul(state ^ (state >>> 7), 61 | state)) >>> 0;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

// ─── Distance in Lab (CIE76 delta-E, perceptual enough for palette clustering) ──

function deltaESquared(a: Lab, b: Lab): number {
  const dL = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dL * dL + da * da + db * db;
}

// ─── K-means ────────────────────────────────────────────────────────────────

function kmeans(samples: readonly Lab[], k: number, maxIter: number, rng: () => number): PaletteExtractionResult {
  if (samples.length === 0) {
    return { clusters: [] };
  }
  const actualK = Math.min(k, samples.length);

  // Init: pick k distinct random samples as seeds (k-means++ lite — first random,
  // subsequent ones biased toward samples far from existing centroids)
  const centroids: Lab[] = [];
  centroids.push(samples[Math.floor(rng() * samples.length)]);
  while (centroids.length < actualK) {
    const weights = samples.map(s => {
      let minD = Infinity;
      for (const c of centroids) {
        const d = deltaESquared(s, c);
        if (d < minD) minD = d;
      }
      return minD;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let target = rng() * total;
    for (let i = 0; i < weights.length; i++) {
      target -= weights[i];
      if (target <= 0) {
        centroids.push(samples[i]);
        break;
      }
    }
  }

  let assignments = new Int32Array(samples.length);
  for (let iter = 0; iter < maxIter; iter++) {
    // Assign
    let changed = false;
    for (let i = 0; i < samples.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = deltaESquared(samples[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed && iter > 0) break;

    // Update
    const sums: number[][] = centroids.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const cnt = sums[assignments[i]];
      cnt[0] += s[0]; cnt[1] += s[1]; cnt[2] += s[2]; cnt[3]++;
    }
    for (let c = 0; c < centroids.length; c++) {
      const [sumL, sumA, sumB, n] = sums[c];
      if (n > 0) centroids[c] = [sumL / n, sumA / n, sumB / n];
    }
  }

  // Compute weights
  const counts = new Int32Array(centroids.length);
  for (let i = 0; i < samples.length; i++) counts[assignments[i]]++;
  const clusters = centroids.map((lab, c) => ({ lab, weight: counts[c] / samples.length }));
  // Sort by weight desc (wall = largest cluster)
  clusters.sort((a, b) => b.weight - a.weight);

  return { clusters };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function extractPalette(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
  options: PaletteOptions = {},
): PaletteExtractionResult {
  const k = options.k ?? 3;
  const maxIter = options.maxIterations ?? 20;
  const stride = options.stride ?? 1;
  const rng = makeRng(options.seed ?? 0x42);
  const zone = options.zone ?? null;
  const mask = options.mask ?? null;

  const x0 = zone ? Math.floor(zone.x0 * width) : 0;
  const y0 = zone ? Math.floor(zone.y0 * height) : 0;
  const x1 = zone ? Math.ceil(zone.x1 * width) : width;
  const y1 = zone ? Math.ceil(zone.y1 * height) : height;

  const samples: Lab[] = [];
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const p = y * width + x;
      if (mask && mask[p] !== 0) continue; // skip masked pixels
      const i = p * channels;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const lab = rgbToLab(r, g, b);
      samples.push([lab[0], lab[1], lab[2]]);
    }
  }

  if (samples.length === 0) return { clusters: [] };
  return kmeans(samples, k, maxIter, rng);
}

/** Convenience — returns the dominant (largest-weight) Lab cluster. */
export function dominantLab(palette: PaletteExtractionResult): Lab | null {
  if (palette.clusters.length === 0) return null;
  return palette.clusters[0].lab;
}
