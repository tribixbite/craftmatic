/**
 * The bricker's candidate shapes: every vocabulary element in each of its
 * distinct quarter turns, as a list of lattice offsets, plus the rule that says
 * which lattice labels an element may serve.
 *
 * Geometry is read through the verifier's own placement (`placeElement`), so a
 * variant covers exactly the cells X-09 will later read for the same placement
 * and the writer's turn convention is never re-derived here.
 *
 * Slope direction convention (the contract for grammar authors, A07): a
 * `roof-slope` label's `slope.dir` is the direction the roof surface DESCENDS
 * towards, i.e. the way the slope faces: 0 = +x, 1 = -x, 2 = +z, 3 = -z. `rise`
 * is the steepness class of the part: 3 = the 45 degree family, 2 = the 33
 * degree family, 1 = the shallow curved slopes (table `RISE_CLASS`).
 */
import type { BrickElement, BrickVocabulary, IntentLabel, IntentRole } from '../types.js';
import { ELEMENT_SPECS, type ElementSpec } from '../vocab/elements.js';
import { occupancyIndex } from '../vocab/index.js';
import { placeElement, turnedCell, VOCABULARY_LOOKUP, type ElementKind } from '../verify/world.js';

/** How an element is chosen. */
export type Use = 'generic' | 'slope' | 'arch' | 'window' | 'round' | 'cone' | 'dome' | 'fence';

/** One element in one quarter turn. Offsets are relative to `at` (the footprint's minimum corner, lowest layer). */
export interface Variant {
  part: string;
  kind: ElementKind;
  use: Use;
  turn: 0 | 1 | 2 | 3;
  /** Footprint after the turn, and height in plates. */
  w: number;
  d: number;
  h: number;
  /** Occupied cells, flat `[dx, dy, dz, ...]`, in scan order (layer, then z, then x). */
  body: Int16Array;
  /** Envelope cells the part leaves empty (arches, windows), flat; they must be empty or opening-labelled. */
  voids: Int16Array;
  /** Number of occupied cells. */
  cells: number;
  /** Slope variants: the descent direction at this turn, and the steepness class. */
  slopeDir?: 0 | 1 | 2 | 3;
  rise?: 1 | 2 | 3;
}

/** Steepness class per slope part (LDraw names: Slope 45 = 3, Slope 33 = 2, curved = 1). */
const RISE_CLASS: Readonly<Record<string, 1 | 2 | 3>> = {
  '3040b.dat': 3, '3039.dat': 3, '3038.dat': 3, '3037.dat': 3,
  '3298.dat': 2, '3297.dat': 2, '4286.dat': 2,
  '11477.dat': 1, '85984.dat': 1, '15068.dat': 1,
};

/** Double convex / concave corner slopes: their descent has no single direction. TODO(X-10): corner roof grammar. */
const CORNER_SLOPES: ReadonlySet<string> = new Set(['3045.dat', '3046.dat']);

/**
 * Inverted slopes and brackets are not placed by the bricker yet. TODO(X-10): inverted slopes under overhangs (the
 * vocabulary's occupancy for them reads like the upright part's) and SNOT brackets (X-09 reads no side joins).
 */
const NOT_PLACED_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['slope-inverted', 'bracket']);

const SPEC_BY_PART = new Map<string, ElementSpec>(ELEMENT_SPECS.map(s => [s.part, s]));

function useOf(kind: ElementKind): Use | undefined {
  switch (kind) {
    case 'brick': case 'plate': case 'tile': return 'generic';
    case 'slope': case 'slope-curved': return 'slope';
    case 'arch': return 'arch';
    case 'window': case 'door-frame': return 'window';
    case 'round': return 'round';
    case 'cone': return 'cone';
    case 'dome': return 'dome';
    case 'fence': return 'fence';
    default: return undefined;
  }
}

/** Plate height of each column of a part in one turn, as a map from `dx,dz` and the footprint after the turn. */
function columnHeights(element: BrickElement, turn: 0 | 1 | 2 | 3): { w: number; d: number; heights: number[] } {
  const [fx, fz] = element.footprint;
  const odd = turn % 2 === 1;
  const w = odd ? fz : fx, d = odd ? fx : fz;
  const heights = new Array<number>(w * d).fill(0);
  for (let layer = 0; layer < element.heightPlates; layer++) {
    for (let lz = 0; lz < fz; lz++) {
      for (let lx = 0; lx < fx; lx++) {
        if (element.occupancy && element.occupancy[occupancyIndex(fx, fz, lx, lz, layer)] === 0) continue;
        const [dx, dz] = turnedCell(turn, fx, fz, lx, lz);
        heights[dx + w * dz]!++;
      }
    }
  }
  return { w, d, heights };
}

/**
 * The direction a slope part descends towards at a turn (see the module comment), from the height-weighted centroid of
 * its columns: the high side is where the mass is. Undefined for a part that is level or symmetric (a corner slope).
 */
export function slopeDirOf(element: BrickElement, turn: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 | undefined {
  const { w, d, heights } = columnHeights(element, turn);
  let sx = 0, sz = 0;
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const h = heights[x + w * z]!;
    sx += h * (x - (w - 1) / 2);
    sz += h * (z - (d - 1) / 2);
  }
  if (Math.abs(sx) < 1e-9 && Math.abs(sz) < 1e-9) return undefined;
  if (Math.abs(sx) >= Math.abs(sz)) return sx > 0 ? 1 : 0;
  return sz > 0 ? 3 : 2;
}

/** Length caps of the packer: 1xN up to `maxLength1`, 2xN up to `maxLength2` (README X-10). */
export interface LengthCaps { maxLength1: number; maxLength2: number }

/** Build every candidate variant of the vocabulary. Deterministic order (vocabulary order, then turn). */
export function buildVariants(vocabulary: BrickVocabulary, caps: LengthCaps): Variant[] {
  const out: Variant[] = [];
  for (const element of vocabulary.elements) {
    const spec = SPEC_BY_PART.get(element.part);
    if (!spec || NOT_PLACED_KINDS.has(spec.kind) || CORNER_SLOPES.has(element.part)) continue;
    const use = useOf(spec.kind);
    if (!use) continue;
    const [fx, fz] = element.footprint;
    if (use === 'generic') {
      const short = Math.min(fx, fz), long = Math.max(fx, fz);
      if (short === 1 && long > caps.maxLength1) continue;
      if (short === 2 && long > caps.maxLength2) continue;
    }
    const seen = new Set<string>();
    for (const turn of [0, 1, 2, 3] as const) {
      const placed = placeElement(0, { part: element.part, colour: 0, at: [0, 0, 0], turn, group: '' }, VOCABULARY_LOOKUP);
      if (!placed) continue;
      const cells = placed.body.map(([x, y, z]) => [x, y, z] as const)
        .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
      const key = cells.map(c => c.join(',')).join(';');
      if (seen.has(key)) continue; // a quarter turn that lands on the same cells (a symmetric part) adds nothing
      seen.add(key);
      // Envelope cells the part leaves empty.
      const voids: number[] = [];
      if (element.occupancy) {
        const own = new Set(cells.map(c => c.join(',')));
        for (let layer = 0; layer < element.heightPlates; layer++) for (let lz = 0; lz < fz; lz++) for (let lx = 0; lx < fx; lx++) {
          const [dx, dz] = turnedCell(turn, fx, fz, lx, lz);
          if (!own.has(`${dx},${layer},${dz}`)) voids.push(dx, layer, dz);
        }
      }
      const v: Variant = {
        part: element.part, kind: spec.kind, use, turn, w: placed.w, d: placed.d, h: placed.h,
        body: Int16Array.from(cells.flat()), voids: Int16Array.from(voids), cells: cells.length,
      };
      if (use === 'slope') {
        const dir = slopeDirOf(element, turn);
        if (dir === undefined) continue;
        v.slopeDir = dir;
        v.rise = RISE_CLASS[element.part] ?? 1;
      }
      out.push(v);
    }
  }
  return out;
}

/** What a label may be built from, per generic family: higher tier wins. Missing family = not allowed for the role. */
const GENERIC_TIER: Readonly<Record<IntentRole, Partial<Record<'brick' | 'plate' | 'tile', number>>>> = {
  wall: { brick: 3, plate: 1 },
  column: { brick: 3, plate: 1 },
  support: { brick: 3, plate: 1 },
  solid: { brick: 3, plate: 1 },
  terrain: { brick: 3, plate: 1 },
  floor: { plate: 3 },
  'roof-flat': { plate: 3 },
  // Exposed tops get tiles (`topExposedOnly`); anywhere else the plate carries what stands on it.
  trim: { tile: 3, plate: 2 },
  detail: { tile: 3, plate: 2 },
  // A roof stair-step no slope fits: bricks in the thick part, plates at the edge.
  'roof-slope': { brick: 3, plate: 2 },
  arch: { brick: 3, plate: 1 },
  // A window cell no frame fits stays an open hole: nothing here.
  window: {},
};

/** A variant with the tier it earns for one label (0 = not eligible). */
export interface Ranked { variant: Variant; tier: number; /** Tiles carry nothing: only legal under an empty cell. */ topExposedOnly: boolean }

/** Special-element tiers sit above every generic tier so a matching mask always wins over bricks. */
const SPECIAL_TIER = 6;

/** The eligible variants for a label, best first (tier, then covered cells, then input order). */
export function rankVariants(variants: readonly Variant[], label: IntentLabel): Ranked[] {
  const out: Ranked[] = [];
  const feature = label.feature ?? '';
  variants.forEach(v => {
    let tier = 0;
    switch (v.use) {
      case 'generic': {
        const family = v.kind === 'brick' ? 'brick' : v.kind === 'tile' ? 'tile' : 'plate';
        tier = GENERIC_TIER[label.role]?.[family] ?? 0;
        break;
      }
      case 'slope':
        if (label.role === 'roof-slope' && label.slope && label.slope.dir === v.slopeDir && (feature === '' || feature === 'slope')) {
          tier = label.slope.rise === v.rise ? SPECIAL_TIER : SPECIAL_TIER - 0.5;
        }
        break;
      case 'arch': if (label.role === 'arch') tier = SPECIAL_TIER; break;
      case 'window': if (label.role === 'window') tier = SPECIAL_TIER; break;
      case 'round':
        if (feature === 'round' && (label.role === 'column' || label.role === 'detail')) tier = v.h >= 3 ? SPECIAL_TIER - 1 : SPECIAL_TIER - 2;
        break;
      case 'cone': if (feature === 'cone' && label.role === 'roof-slope') tier = SPECIAL_TIER; break;
      case 'dome': if (feature === 'dome' && label.role === 'roof-slope') tier = SPECIAL_TIER; break;
      case 'fence': if ((feature === 'fence' || feature === 'lattice') && (label.role === 'detail' || label.role === 'trim')) tier = SPECIAL_TIER - 1; break;
    }
    if (tier > 0) out.push({ variant: v, tier, topExposedOnly: v.kind === 'tile' });
  });
  return out.sort((a, b) => b.tier - a.tier || b.variant.cells - a.variant.cells);
}
