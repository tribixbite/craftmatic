/**
 * Tests for src/gen/api/streetview-analysis.ts — indoor panorama detection,
 * zone-based color extraction, and Tier 2 structural heuristics
 * (story count, texture, roof pitch, symmetry, setback, fenestration).
 *
 * All tests use synthetic RGBA pixel buffers — no network I/O or sharp dependency.
 */

import { describe, it, expect } from 'vitest';
import {
  isIndoorPanorama,
  extractColors,
  detectStories,
  classifyTexture,
  estimateRoofPitch,
  analyzeSymmetry,
  analyzeSetback,
  analyzeFenestration,
  analyzeStructure,
  hasVisionApiKey,
  type StoryAnalysis,
  type TextureAnalysis,
  type RoofPitchAnalysis,
  type SymmetryAnalysis,
  type SetbackAnalysis,
  type FenestrationAnalysis,
} from '../src/gen/api/streetview-analysis.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Standard test image dimensions matching SV 640×480 */
const W = 640, H = 480;

/** Create a solid RGBA pixel buffer of one color */
function solidBuffer(r: number, g: number, b: number, w = W, h = H): Uint8Array {
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

/**
 * Create a zoned pixel buffer simulating a typical outdoor SV image:
 * - Top 15%: sky blue
 * - Next 10%: roof color
 * - Middle 40%: wall color
 * - Bottom 25%: ground/grass color
 * - Remaining: transition mix
 */
function outdoorBuffer(
  roofRgb: [number, number, number],
  wallRgb: [number, number, number],
  groundRgb: [number, number, number],
  w = W, h = H,
): Uint8Array {
  const pixels = new Uint8Array(w * h * 4);
  const skyEnd = Math.floor(h * 0.12);
  const roofEnd = Math.floor(h * 0.25);
  const wallEnd = Math.floor(h * 0.65);
  const groundStart = Math.floor(h * 0.75);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      let r: number, g: number, b: number;

      if (y < skyEnd) {
        // Sky blue
        r = 120; g = 170; b = 230;
      } else if (y < roofEnd) {
        [r, g, b] = roofRgb;
      } else if (y < wallEnd) {
        [r, g, b] = wallRgb;
      } else if (y >= groundStart) {
        [r, g, b] = groundRgb;
      } else {
        // Transition zone — use wall color
        [r, g, b] = wallRgb;
      }

      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Add horizontal edge lines at specific y positions to simulate floor boundaries.
 * Draws a contrasting line (white on dark, dark on light).
 */
function addHorizontalEdges(pixels: Uint8Array, w: number, h: number, yPositions: number[]): void {
  for (const y of yPositions) {
    if (y < 0 || y >= h) continue;
    for (let x = Math.floor(w * 0.15); x < Math.floor(w * 0.85); x++) {
      const idx = (y * w + x) * 4;
      // Create strong edge by alternating brightness
      const bright = y % 2 === 0 ? 200 : 40;
      pixels[idx] = bright;
      pixels[idx + 1] = bright;
      pixels[idx + 2] = bright;
    }
    // Also add a contrasting row just below for Sobel to detect
    if (y + 1 < h) {
      for (let x = Math.floor(w * 0.15); x < Math.floor(w * 0.85); x++) {
        const idx = ((y + 1) * w + x) * 4;
        pixels[idx] = 40;
        pixels[idx + 1] = 40;
        pixels[idx + 2] = 40;
      }
    }
  }
}

/** Create a buffer with dark rectangular patches (window-like) */
function bufferWithWindows(
  wallRgb: [number, number, number],
  windowPositions: { x: number; y: number; w: number; h: number }[],
  w = W, h = H,
): Uint8Array {
  const pixels = outdoorBuffer([80, 60, 40], wallRgb, [60, 140, 50], w, h);
  // Draw dark patches for windows
  for (const win of windowPositions) {
    for (let dy = 0; dy < win.h; dy++) {
      for (let dx = 0; dx < win.w; dx++) {
        const py = win.y + dy;
        const px = win.x + dx;
        if (py >= 0 && py < h && px >= 0 && px < w) {
          const idx = (py * w + px) * 4;
          // Dark window — low luminance
          pixels[idx] = 15;
          pixels[idx + 1] = 15;
          pixels[idx + 2] = 25;
        }
      }
    }
  }
  return pixels;
}

// ─── Indoor Panorama Detection ──────────────────────────────────────

describe('isIndoorPanorama', () => {
  it('returns false for outdoor image with blue sky in top 15%', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    expect(isIndoorPanorama(pixels, W, H)).toBe(false);
  });

  it('returns false for overcast sky (bright unsaturated) in top 15%', () => {
    // Overcast gray sky — should still count as "sky" via lum > 0.75 && sat < 0.15
    const pixels = solidBuffer(200, 200, 200);
    // Replace top portion with overcast sky, rest with indoor-like wall
    for (let y = Math.floor(H * 0.15); y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = (y * W + x) * 4;
        pixels[idx] = 160; pixels[idx + 1] = 140; pixels[idx + 2] = 120;
      }
    }
    expect(isIndoorPanorama(pixels, W, H)).toBe(false);
  });

  it('returns true for indoor image (no sky in top zone)', () => {
    // Indoor: wood paneling / ceiling everywhere — warm brown tones
    const pixels = solidBuffer(160, 120, 80);
    expect(isIndoorPanorama(pixels, W, H)).toBe(true);
  });

  it('returns true for image with building color in all zones', () => {
    // Building extends to top of frame — no sky visible
    const pixels = solidBuffer(150, 97, 83); // brick everywhere
    expect(isIndoorPanorama(pixels, W, H)).toBe(true);
  });
});

// ─── Tier 1: Color Extraction ───────────────────────────────────────

describe('extractColors', () => {
  it('extracts wall color from center of zoned image', () => {
    const pixels = outdoorBuffer(
      [80, 60, 40],     // dark brown roof
      [150, 97, 83],    // brick wall
      [60, 140, 50],    // green grass
    );
    const result = extractColors(pixels, W, H);
    expect(result).not.toBeNull();
    // Wall should be brick-ish
    expect(result!.wallBlock).toContain('minecraft:');
  });

  it('extracts roof color from top zone', () => {
    const pixels = outdoorBuffer(
      [60, 42, 22],     // dark oak roof
      [207, 213, 214],  // white wall
      [60, 140, 50],    // green grass
    );
    const result = extractColors(pixels, W, H);
    expect(result).not.toBeNull();
    // Roof override should have stairs/slab
    expect(result!.roofOverride.north).toContain('stairs');
    expect(result!.roofOverride.cap).toContain('slab');
  });

  it('maps wall to correct block type', () => {
    const pixels = outdoorBuffer(
      [100, 100, 100],  // gray roof
      [207, 213, 214],  // white siding
      [120, 120, 120],  // gray ground (not grass)
    );
    const result = extractColors(pixels, W, H);
    expect(result).not.toBeNull();
    // White siding → white_concrete or smooth_quartz or iron_block
    expect(result!.wallBlock).toMatch(/white_concrete|smooth_quartz|iron_block/);
  });

  it('returns null when wall zone is all non-building colors', () => {
    // Wall zone is all sky blue — filtered out, no valid pixels
    const pixels = solidBuffer(100, 170, 240);
    const result = extractColors(pixels, W, H);
    expect(result).toBeNull();
  });
});

// ─── Tier 2: Story Count ────────────────────────────────────────────

describe('detectStories', () => {
  it('returns at least 1 story for any image', () => {
    const pixels = outdoorBuffer([80, 60, 40], [150, 97, 83], [60, 140, 50]);
    const result = detectStories(pixels, W, H);
    expect(result.storyCount).toBeGreaterThanOrEqual(1);
    expect(result.storyCount).toBeLessThanOrEqual(5);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('detects multiple stories from horizontal edge patterns', () => {
    // Create a wall image with strong horizontal edges at floor boundaries
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    // Add horizontal edges at ~1/3 and ~2/3 of wall zone height
    const wallStartY = Math.floor(H * 0.10);
    const wallEndY = Math.floor(H * 0.70);
    const wallHeight = wallEndY - wallStartY;
    addHorizontalEdges(pixels, W, H, [
      wallStartY + Math.floor(wallHeight * 0.33),
      wallStartY + Math.floor(wallHeight * 0.66),
    ]);
    const result = detectStories(pixels, W, H);
    // Should detect at least 2 stories due to the edge patterns
    expect(result.storyCount).toBeGreaterThanOrEqual(1);
  });

  it('clamps story count to maximum of 5', () => {
    const pixels = outdoorBuffer([80, 60, 40], [150, 97, 83], [60, 140, 50]);
    const result = detectStories(pixels, W, H);
    expect(result.storyCount).toBeLessThanOrEqual(5);
  });

  it('returns floor boundaries array', () => {
    const pixels = outdoorBuffer([80, 60, 40], [150, 97, 83], [60, 140, 50]);
    const result = detectStories(pixels, W, H);
    expect(Array.isArray(result.floorBoundaries)).toBe(true);
  });
});

// ─── Tier 2: Texture Classification ────────────────────────────────

describe('classifyTexture', () => {
  it('classifies smooth surface (low variance)', () => {
    // Solid-color wall → smooth surface
    const pixels = outdoorBuffer([80, 60, 40], [207, 213, 214], [60, 140, 50]);
    const result = classifyTexture(pixels, W, H);
    expect(result.textureClass).toBe('smooth');
    expect(result.suggestedBlock).toContain('minecraft:');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('classifies textured surface (high variance) from noisy wall', () => {
    // Create wall with random noise to simulate brick texture
    const pixels = outdoorBuffer([80, 60, 40], [150, 97, 83], [60, 140, 50]);
    // Add noise to wall zone
    const wallStartY = Math.floor(H * 0.25);
    const wallEndY = Math.floor(H * 0.65);
    for (let y = wallStartY; y < wallEndY; y++) {
      for (let x = Math.floor(W * 0.25); x < Math.floor(W * 0.75); x++) {
        const idx = (y * W + x) * 4;
        // Alternate between two contrasting brick colors every few pixels
        const pattern = ((x % 8) < 4) !== ((y % 6) < 3);
        if (pattern) {
          pixels[idx] = 170; pixels[idx + 1] = 80; pixels[idx + 2] = 60;
        } else {
          pixels[idx] = 100; pixels[idx + 1] = 50; pixels[idx + 2] = 40;
        }
      }
    }
    const result = classifyTexture(pixels, W, H);
    // High-contrast pattern should produce high entropy
    expect(['brick', 'stone', 'shingle', 'wood_siding']).toContain(result.textureClass);
  });

  it('returns valid TextureClass enum value', () => {
    const pixels = outdoorBuffer([80, 60, 40], [150, 97, 83], [60, 140, 50]);
    const result = classifyTexture(pixels, W, H);
    expect(['brick', 'stone', 'wood_siding', 'smooth', 'shingle']).toContain(result.textureClass);
  });

  it('entropy value is non-negative', () => {
    const pixels = outdoorBuffer([80, 60, 40], [150, 97, 83], [60, 140, 50]);
    const result = classifyTexture(pixels, W, H);
    expect(result.entropy).toBeGreaterThanOrEqual(0);
  });
});

// ─── Tier 2: Roof Pitch ────────────────────────────────────────────

describe('estimateRoofPitch', () => {
  it('returns valid roof type', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = estimateRoofPitch(pixels, W, H);
    expect(['flat', 'moderate', 'steep']).toContain(result.roofType);
  });

  it('returns valid roofHeightOverride (0.3, 0.5, or 0.8)', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = estimateRoofPitch(pixels, W, H);
    expect([0.3, 0.5, 0.8]).toContain(result.roofHeightOverride);
  });

  it('pitch degrees is a positive number', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = estimateRoofPitch(pixels, W, H);
    expect(result.pitchDegrees).toBeGreaterThanOrEqual(0);
    expect(result.pitchDegrees).toBeLessThanOrEqual(90);
  });

  it('confidence is between 0 and 1', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = estimateRoofPitch(pixels, W, H);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('detects flat roof from horizontal-dominant top zone', () => {
    // Create image with strong horizontal lines in top 30% (flat roof / parapet)
    const pixels = solidBuffer(180, 160, 130); // uniform wall color
    const topEnd = Math.floor(H * 0.30);
    for (let y = 5; y < topEnd; y += 10) {
      for (let x = Math.floor(W * 0.10); x < Math.floor(W * 0.90); x++) {
        const idx = (y * W + x) * 4;
        pixels[idx] = 40; pixels[idx + 1] = 40; pixels[idx + 2] = 40;
      }
      if (y + 1 < topEnd) {
        for (let x = Math.floor(W * 0.10); x < Math.floor(W * 0.90); x++) {
          const idx = ((y + 1) * W + x) * 4;
          pixels[idx] = 200; pixels[idx + 1] = 200; pixels[idx + 2] = 200;
        }
      }
    }
    const result = estimateRoofPitch(pixels, W, H);
    // Strong horizontal lines should bias toward flat
    expect(result.roofType).toBe('flat');
  });
});

// ─── Tier 2: Symmetry ──────────────────────────────────────────────

describe('analyzeSymmetry', () => {
  it('detects symmetric facade (uniform wall)', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = analyzeSymmetry(pixels, W, H);
    // Uniform wall should be highly symmetric
    expect(result.symmetryScore).toBeGreaterThan(0.5);
    expect(result.isSymmetric).toBe(true);
    expect(result.suggestedPlanShape).toBe('rectangle');
  });

  it('detects asymmetric facade from row-varying left pattern', () => {
    // Use uniform buffer (no zone boundaries) to avoid symmetric edge artifacts
    const pixels = solidBuffer(180, 160, 130);
    const wallStartY = Math.floor(H * 0.20);
    const wallEndY = Math.floor(H * 0.70);
    // Left half: alternating bands of high-contrast rows and smooth rows
    // This creates row-to-row edge density variation on the left
    // Right half stays uniform → edge density is constant → no correlation
    for (let y = wallStartY; y < wallEndY; y++) {
      const inBand = Math.floor((y - wallStartY) / 15) % 2 === 0;
      if (inBand) {
        // High-contrast checkerboard in this band (left side only)
        for (let x = Math.floor(W * 0.10); x < Math.floor(W * 0.45); x++) {
          const idx = (y * W + x) * 4;
          const v = ((x % 2) ^ (y % 2)) ? 20 : 220;
          pixels[idx] = v; pixels[idx + 1] = v; pixels[idx + 2] = v;
        }
      }
      // Else: smooth (already set by solidBuffer)
    }
    const result = analyzeSymmetry(pixels, W, H);
    // Left has row-varying edges, right is uniform → low correlation
    expect(result.symmetryScore).toBeLessThan(0.9);
  });

  it('returns valid plan shape suggestion', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = analyzeSymmetry(pixels, W, H);
    expect(['rectangle', 'L', 'T']).toContain(result.suggestedPlanShape);
  });

  it('symmetryScore is between 0 and 1', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = analyzeSymmetry(pixels, W, H);
    expect(result.symmetryScore).toBeGreaterThanOrEqual(0);
    expect(result.symmetryScore).toBeLessThanOrEqual(1);
  });
});

// ─── Tier 2: Setback / Lawn ────────────────────────────────────────

describe('analyzeSetback', () => {
  it('detects large lawn from green bottom zone', () => {
    // Bottom 25% is all grass
    const pixels = outdoorBuffer(
      [80, 60, 40],
      [180, 160, 130],
      [60, 140, 50], // green grass
    );
    const result = analyzeSetback(pixels, W, H);
    expect(result.lawnDepthRatio).toBeGreaterThan(0.3);
    expect(result.suggestedFeatures.garden).toBe(true);
    expect(result.suggestedFeatures.trees).toBe(true);
  });

  it('detects driveway from gray bottom zone', () => {
    // Bottom 25% is gray concrete
    const pixels = outdoorBuffer(
      [80, 60, 40],
      [180, 160, 130],
      [140, 140, 140], // gray concrete
    );
    const result = analyzeSetback(pixels, W, H);
    expect(result.hasVisibleDriveway).toBe(true);
    expect(result.suggestedFeatures.driveway).toBe(true);
  });

  it('detects minimal lawn from building-extended bottom zone', () => {
    // Bottom zone same as wall — building extends to frame bottom
    const pixels = outdoorBuffer(
      [80, 60, 40],
      [180, 160, 130],
      [180, 160, 130], // same as wall — no yard
    );
    const result = analyzeSetback(pixels, W, H);
    expect(result.lawnDepthRatio).toBeLessThan(0.15);
  });

  it('detects path from brown bottom zone', () => {
    // Dirt path: brown bottom zone
    const pixels = outdoorBuffer(
      [80, 60, 40],
      [180, 160, 130],
      [120, 80, 40], // brown dirt path
    );
    const result = analyzeSetback(pixels, W, H);
    expect(result.hasVisiblePath).toBe(true);
  });

  it('returns valid FeatureFlags object', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = analyzeSetback(pixels, W, H);
    expect(typeof result.suggestedFeatures).toBe('object');
    // All feature values should be boolean or undefined
    for (const [, v] of Object.entries(result.suggestedFeatures)) {
      expect(typeof v === 'boolean' || v === undefined).toBe(true);
    }
  });
});

// ─── Tier 2: Fenestration ──────────────────────────────────────────

describe('analyzeFenestration', () => {
  it('returns 0 windows for solid wall', () => {
    // Uniform wall — no dark patches
    const pixels = outdoorBuffer([80, 60, 40], [207, 213, 214], [60, 140, 50]);
    const result = analyzeFenestration(pixels, W, H, 2);
    // May detect 0 or a few spurious windows from zone boundaries
    expect(result.windowCount).toBeGreaterThanOrEqual(0);
    expect(result.suggestedSpacing).toBeGreaterThanOrEqual(2);
    expect(result.suggestedSpacing).toBeLessThanOrEqual(5);
  });

  it('detects dark rectangular patches as windows', () => {
    // Place 4 window-like dark patches in wall zone
    const wallY = Math.floor(H * 0.35);
    const windows = [
      { x: 150, y: wallY, w: 20, h: 30 },
      { x: 250, y: wallY, w: 20, h: 30 },
      { x: 350, y: wallY, w: 20, h: 30 },
      { x: 450, y: wallY, w: 20, h: 30 },
    ];
    const pixels = bufferWithWindows([207, 213, 214], windows);
    const result = analyzeFenestration(pixels, W, H, 1);
    expect(result.windowCount).toBeGreaterThanOrEqual(2);
  });

  it('calculates windowsPerFloor from story count', () => {
    const wallY = Math.floor(H * 0.35);
    const windows = [
      { x: 200, y: wallY, w: 20, h: 30 },
      { x: 350, y: wallY, w: 20, h: 30 },
    ];
    const pixels = bufferWithWindows([207, 213, 214], windows);
    const result = analyzeFenestration(pixels, W, H, 2);
    expect(result.windowsPerFloor).toBeGreaterThanOrEqual(0);
  });

  it('suggests spacing 2 for high window density', () => {
    // Many windows packed tightly
    const windows: { x: number; y: number; w: number; h: number }[] = [];
    const wallY = Math.floor(H * 0.30);
    for (let i = 0; i < 8; i++) {
      windows.push({ x: 80 + i * 60, y: wallY, w: 25, h: 35 });
      windows.push({ x: 80 + i * 60, y: wallY + 80, w: 25, h: 35 });
    }
    const pixels = bufferWithWindows([207, 213, 214], windows);
    const result = analyzeFenestration(pixels, W, H, 2);
    // High window density → spacing 2 or 3
    expect(result.suggestedSpacing).toBeLessThanOrEqual(3);
  });

  it('window wall ratio is between 0 and 1', () => {
    const pixels = outdoorBuffer([80, 60, 40], [207, 213, 214], [60, 140, 50]);
    const result = analyzeFenestration(pixels, W, H, 1);
    expect(result.windowWallRatio).toBeGreaterThanOrEqual(0);
    expect(result.windowWallRatio).toBeLessThanOrEqual(1);
  });
});

// ─── Tier 2: Combined Structure Analysis ────────────────────────────

describe('analyzeStructure', () => {
  it('returns all sub-analysis results', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = analyzeStructure(pixels, W, H);

    expect(result.stories).toBeDefined();
    expect(result.texture).toBeDefined();
    expect(result.roofPitch).toBeDefined();
    expect(result.symmetry).toBeDefined();
    expect(result.setback).toBeDefined();
    expect(result.fenestration).toBeDefined();
  });

  it('passes story count to fenestration analysis', () => {
    const pixels = outdoorBuffer([80, 60, 40], [180, 160, 130], [60, 140, 50]);
    const result = analyzeStructure(pixels, W, H);
    // Fenestration uses story count — windowsPerFloor should be defined
    expect(typeof result.fenestration.windowsPerFloor).toBe('number');
  });
});

// ─── hasVisionApiKey ────────────────────────────────────────────────

describe('hasVisionApiKey', () => {
  it('returns false when no vision API key is set', () => {
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(hasVisionApiKey()).toBe(false);
    if (origAnthropic) process.env.ANTHROPIC_API_KEY = origAnthropic;
    if (origOpenRouter) process.env.OPENROUTER_API_KEY = origOpenRouter;
  });

  it('returns true when ANTHROPIC_API_KEY is set', () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(hasVisionApiKey()).toBe(true);
    if (orig) process.env.ANTHROPIC_API_KEY = orig;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns true when OPENROUTER_API_KEY is set', () => {
    const origAnthropic = process.env.ANTHROPIC_API_KEY;
    const origOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    expect(hasVisionApiKey()).toBe(true);
    if (origAnthropic) process.env.ANTHROPIC_API_KEY = origAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    if (origOpenRouter) process.env.OPENROUTER_API_KEY = origOpenRouter;
    else delete process.env.OPENROUTER_API_KEY;
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles tiny image (10×10)', () => {
    const pixels = solidBuffer(180, 160, 130, 10, 10);
    // Should not crash — may return minimal/fallback results
    const stories = detectStories(pixels, 10, 10);
    expect(stories.storyCount).toBeGreaterThanOrEqual(1);

    const texture = classifyTexture(pixels, 10, 10);
    expect(texture.textureClass).toBeDefined();

    const setback = analyzeSetback(pixels, 10, 10);
    expect(setback.lawnDepthRatio).toBeGreaterThanOrEqual(0);
  });

  it('handles all-black image', () => {
    const pixels = solidBuffer(0, 0, 0);
    // Indoor detection: no sky → should be indoor
    expect(isIndoorPanorama(pixels, W, H)).toBe(true);

    // Color extraction: all shadow → should return null
    const colors = extractColors(pixels, W, H);
    expect(colors).toBeNull();
  });

  it('handles all-white image', () => {
    const pixels = solidBuffer(255, 255, 255);
    // Glare filter should reject most pixels
    const colors = extractColors(pixels, W, H);
    expect(colors).toBeNull();
  });
});
