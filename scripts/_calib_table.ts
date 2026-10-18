#!/usr/bin/env bun
/**
 * Colour-calibration table for a renderer change: did the calibrated ABS
 * colours survive?
 *
 * Compares two `samples.json` bundles produced by
 * scripts/renderer-pass-isolation.mjs at IDENTICAL cameras, so sample i in one
 * run is the same surface as sample i in the other. For each sample it reports
 * the sampled RGB before/after and, against the canonical LDraw hex for that
 * colour id, the HUE error and the CHROMA (saturation) — the two quantities a
 * grey veil destroys and a pure multiply preserves.
 *
 *   bun scripts/_calib_table.ts <beforeDir> <afterDir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LDRAW_COLOR_RGB } from '../web/src/engine/ldraw-colors.js';

interface Sample { px: number; py: number; color: number; part: string; dist: number }
interface Variant { px: number[][] }
interface SetRun { samples: Sample[]; variants: Record<string, Variant> }

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) { console.error('usage: <beforeDir> <afterDir>'); process.exit(1); }

const load = (d: string): Record<string, SetRun> =>
  JSON.parse(readFileSync(join(d, 'samples.json'), 'utf8')) as Record<string, SetRun>;
const A = load(beforeDir), B = load(afterDir);

/** sRGB 0-255 → HSL, hue in degrees. */
function hsl(rgb: number[]): { h: number; s: number; l: number } {
  const [r, g, b] = rgb.map(v => v / 255) as [number, number, number];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s, l };
}
const hexRgb = (hex: string): number[] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
/** Smallest angle between two hues, in degrees. */
const hueDelta = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

console.log('set        colour                       canonical  sampled before   sampled after    Δhue°  chroma before→after');
const rows: { hueErrB: number; hueErrA: number; satB: number; satA: number }[] = [];
let tooDark = 0;
for (const set of Object.keys(B)) {
  if (!A[set]) continue;
  const sa = A[set]!.samples, sb = B[set]!.samples;
  const pa = A[set]!.variants['baseline']!.px, pb = B[set]!.variants['baseline']!.px;
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    // The camera is pinned, so index i is the same surface in both runs; skip
    // any sample whose raycast landed on a different part (a load-order change
    // would invalidate the pairing, and silently comparing two different
    // bricks is exactly the way a calibration check lies).
    if (sa[i]!.part !== sb[i]!.part || sa[i]!.color !== sb[i]!.color) continue;
    const hex = LDRAW_COLOR_RGB[sa[i]!.color];
    if (!hex) continue;
    const canon = hsl(hexRgb(hex));
    const before = hsl(pa[i]!), after = hsl(pb[i]!);
    // Achromatic canonical colours (black/white/greys) have no meaningful hue.
    // Neither does a sample that renders near-black: at L≈0.05 a one-count
    // change in any channel swings the hue tens of degrees, so including those
    // would let numerical noise dominate the statistic. They are counted and
    // reported separately rather than dropped silently.
    const chromatic = canon.s > 0.15;
    const litEnough = before.l > 0.12 && after.l > 0.12;
    const dhB = chromatic ? hueDelta(before.h, canon.h) : NaN;
    const dhA = chromatic ? hueDelta(after.h, canon.h) : NaN;
    if (chromatic) {
      if (litEnough) rows.push({ hueErrB: dhB, hueErrA: dhA, satB: before.s, satA: after.s });
      else tooDark++;
    }
    console.log(
      `${set.padEnd(10)} ${String(sa[i]!.color).padStart(3)} ${hex}  ${sa[i]!.part.slice(0, 12).padEnd(13)} ` +
      `${hex}   ${`(${pa[i]!.join(',')})`.padEnd(16)} ${`(${pb[i]!.join(',')})`.padEnd(16)} ` +
      `${chromatic ? (dhA - dhB >= 0 ? '+' : '') + (dhA - dhB).toFixed(1) : '  n/a'}   ` +
      `${before.s.toFixed(3)} → ${after.s.toFixed(3)}`,
    );
  }
}
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);
console.log(`\nchromatic samples: ${rows.length}`);
console.log(`mean hue error vs canonical LDraw colour : ${mean(rows.map(r => r.hueErrB)).toFixed(2)}° → ${mean(rows.map(r => r.hueErrA)).toFixed(2)}°`);
console.log(`mean saturation                          : ${mean(rows.map(r => r.satB)).toFixed(3)} → ${mean(rows.map(r => r.satA)).toFixed(3)}`);
console.log(`samples whose hue error grew by >3°      : ${rows.filter(r => r.hueErrA - r.hueErrB > 3).length}`);
console.log(`chromatic samples excluded as near-black : ${tooDark} (hue is numerically meaningless below L=0.12)`);

// Saturation is the quantity a grey veil destroys, so it is the headline; hue
// is the quantity a pure multiply must PRESERVE, so it is the guard-rail.
const satGain = mean(rows.map(r => r.satA)) / (mean(rows.map(r => r.satB)) || 1);
console.log(`
verdict: saturation ×${satGain.toFixed(2)}, hue drift ${(mean(rows.map(r => r.hueErrA)) - mean(rows.map(r => r.hueErrB))).toFixed(2)}°`);
