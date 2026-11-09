/**
 * Style profile (A09): wall, trim and roof colours as LDraw codes.
 *
 * Sources, in order: the sidecar's `style` (hex colours a reviewer read off the licensed photos), then the most
 * common `building:colour` / `building:facade:colour` and `roof:colour` OSM tags, then the defaults below.
 * `TODO(palette-extraction)`: a Lab k-means palette over the licensed photos (`extractPalette`,
 * `src/pipeline/fusion/palette.ts`) needs the image pixels, which this stage never reads.
 */
import { hexToRgb, nearestLdrawColour } from '../colour.js';
import type { StyleProfile } from '../types.js';
import type { AnnotationSidecar } from './types.js';
import type { TagPart } from './tags.js';

/** LDraw: 19 tan (limestone), 71 light bluish grey (trim), 72 dark bluish grey (roof). */
export const DEFAULT_STYLE: Readonly<StyleProfile> = { wallColour: 19, trimColour: 71, roofColour: 72, accentColours: [] };

/** CSS names OSM colour tags commonly use; anything else must be a `#rrggbb` hex. */
const NAMED: Readonly<Record<string, string>> = {
  white: '#ffffff', black: '#000000', grey: '#808080', gray: '#808080', red: '#b22222', brown: '#8b4513',
  beige: '#f5f5dc', yellow: '#e8c547', green: '#2e7d32', blue: '#1e5aa8', orange: '#e87722', tan: '#d2b48c',
};

/** An OSM/sidecar colour string to an LDraw code, or `undefined` when it is not a colour we can read. */
export function ldrawFromColourString(c: string | undefined): number | undefined {
  if (!c) return undefined;
  const s = c.trim().toLowerCase();
  const hex = /^#[0-9a-f]{6}$/.test(s) ? s : NAMED[s];
  return hex ? nearestLdrawColour(hexToRgb(hex)) : undefined;
}

function mostCommon(values: Array<number | undefined>): number | undefined {
  const n = new Map<number, number>();
  for (const v of values) if (v !== undefined) n.set(v, (n.get(v) ?? 0) + 1);
  // Ties go to the lowest code so the result is deterministic.
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

/** Style from sidecars first, tags second, defaults last. */
export function buildStyle(sidecars: ReadonlyArray<AnnotationSidecar>, tagParts: ReadonlyArray<TagPart>): StyleProfile {
  const fromSidecar = <K extends 'wall' | 'trim' | 'roof'>(k: K): number | undefined =>
    sidecars.map(s => ldrawFromColourString(s.style?.[k])).find(c => c !== undefined);
  const wall = fromSidecar('wall') ?? mostCommon(tagParts.map(p => ldrawFromColourString(p.tags['building:colour'] ?? p.tags['building:facade:colour'])));
  const roof = fromSidecar('roof') ?? mostCommon(tagParts.map(p => ldrawFromColourString(p.tags['roof:colour'])));
  const accents = sidecars.flatMap(s => s.style?.accents ?? []).map(ldrawFromColourString).filter((c): c is number => c !== undefined);
  const era = sidecars.map(s => s.style?.era).find(e => e !== undefined);
  return {
    wallColour: wall ?? DEFAULT_STYLE.wallColour,
    trimColour: fromSidecar('trim') ?? DEFAULT_STYLE.trimColour,
    roofColour: roof ?? DEFAULT_STYLE.roofColour,
    accentColours: [...new Set(accents)],
    ...(era !== undefined ? { era } : {}),
  };
}
