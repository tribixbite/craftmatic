/**
 * Semantic part → Minecraft element mapping (docs/schem-shapes-proposal.md
 * pass A, slice 5).
 *
 * Same contract as the slab/stair passes and for the same reason: it NEVER
 * removes a cell and NEVER moves a footprint. It asks a cell that is already
 * solid whether the LEGO part that owns it has a Minecraft element that is a
 * better answer than a cube — a window's glass is a `glass_pane`, a fence's
 * spindles are a `fence`, a lattice is `iron_bars`, a ladder is a `ladder`.
 * Every cell of the part gets the same treatment, so the silhouette is
 * unchanged and the worst case is the previous all-cubes output.
 *
 * WHAT IS AND IS NOT IN THE TABLE, measured (scripts/_element_survey.ts, 613
 * corpus files / 530,695 placements sampled from OMR + IOModel2V2 + DbixConvV3):
 *
 *   IN   pane    836   "Glass for Window/Train Window/Door" — 20 parts, led by
 *                      60601 (301), 60602 (121), 57895 (74).
 *   IN   fence   588   "Fence Spindled/Ornamented/Picket/Lattice" — 3633 (281),
 *                      3185 (104), 19121 (79), 15332 (65), 30055 (35).
 *   IN   bars    208   window "Pane Lattice Diamond" — 38320 (157), 30046 (51).
 *   IN   ladder  206   4175 "Plate 1 x 2 with Ladder".
 *
 *   OUT  door    514   REFUSED, and this is the proposal's headline element.
 *                      Every LEGO door in the corpus is 3-4 studs wide and 5-7
 *                      bricks tall (60596 Door 1x4x6 Frame, 187; 3821/3822 Door
 *                      1x3x1, 109; 60623, 37). A Minecraft door is ONE block
 *                      wide and two tall. At the coarsest export resolution a
 *                      1x4x6 door is still ~5x8 cells, so any mapping either
 *                      deletes ~95% of the part — exactly what this pass exists
 *                      not to do — or leaves a lone door floating inside a wall
 *                      of blocks. Nothing about the door's semantics survives
 *                      that, so the frame and leaf stay blocks.
 *   OUT  grille  6,523 "Tile 1x2 Grille" (3,453) and "Brick 1x2 with Grille"
 *                      (3,070) are SOLID parts with a moulded ridge pattern, not
 *                      openwork. `iron_bars` would put a hole through a wall.
 *   OUT  flora   1,533 "Plant Leaves/Flower/Stem". Minecraft's flora is fixed
 *                      greens and a full-block leaf; the swap would be a
 *                      RECOLOUR (which this pass has no business doing), not a
 *                      shape refinement.
 *   OUT  rod     280   Antenna 3957a/b, whip 2569 → `end_rod` is white and
 *                      emissive; a black LEGO antenna would come out as a lamp.
 *   OUT  window  1,142 Window FRAMES are solid plastic and stay solid. Only the
 *                      glass that sits IN them becomes a pane, which is what the
 *                      "Glass for …" gate already does.
 *
 * Membership comes from the LDraw library's OWN description line, never a
 * hand-written part-id list — the same decision, for the same reason, as the
 * slope pass (`isSlopeDescription` in block-shapes.ts): ids get re-tooled and a
 * list is stale the day it is written.
 */

import type { BlockGrid } from '@craft/schem/types.js';
import type { ShapeHints } from './block-shapes.js';

// ─── Kinds ───────────────────────────────────────────────────────────────────

export const ELEMENT_NONE = 0;
export const ELEMENT_PANE = 1;
export const ELEMENT_FENCE = 2;
export const ELEMENT_BARS = 3;
export const ELEMENT_LADDER = 4;
/** Two different mapped parts claimed the cell — neither wins. */
export const ELEMENT_CONFLICT = 255;

export type ElementKind = 0 | 1 | 2 | 3 | 4;

/**
 * Which element family a part belongs to, from its `.dat` description line.
 * Order matters: "Fence Lattice 1x4x2" is a fence, not a lattice pane.
 */
export function elementKindForDescription(header: string): ElementKind {
  const d = header.replace(/^0\s+/, '').trim();
  // Glass inserts: "Glass for Window …", "=Glass for Window …" (a ~Moved-to
  // alias still carries the description), "Glass for Train Door".
  if (/^[~=]*Glass for\b/i.test(d)) return ELEMENT_PANE;
  if (/^[~=]*Fence\b/i.test(d)) return ELEMENT_FENCE;
  // "~" prefixes an obsolete/moved stub, whose geometry is not the real part.
  if (/^[~=]*[^~]*\bLadder\b/i.test(d) && !d.startsWith('~')) return ELEMENT_LADDER;
  // Openwork only. "Grille" is deliberately NOT here — see the header.
  if (/\b(Lattice|Grating)\b/i.test(d)) return ELEMENT_BARS;
  return ELEMENT_NONE;
}

/**
 * Largest voxel footprint a part may have and still be swapped for an element.
 *
 * The proposal's rule is that the swap must be a refinement, never a deletion,
 * and that is a question of SIZE: a Minecraft pane, fence, bar and ladder each
 * occupy one cell, so the swap only reads as the same object when the LEGO part
 * is a handful of cells too. Measured against the real parts, 64 cells means
 * elements fire at 1 and 2.5 blocks per stud — where a 1x4x6 window glass is
 * ~5x8 cells and a spindled fence ~5x3 — and switch themselves off at 5 blocks
 * per stud, where that same window is ~150 cells and a wall of panes would be a
 * lattice of nonsense. Nothing else in the pipeline is resolution-aware by
 * accident; this one is by construction.
 */
export const MAX_ELEMENT_CELLS = 64;

// ─── Material variant tables ─────────────────────────────────────────────────

/**
 * Glass block → its pane. Vanilla has a pane for plain glass and all 16 dyed
 * glasses, and for nothing else — `tinted_glass` has none, which is why the
 * pass declines rather than substituting a near colour.
 */
export function paneIdFor(block: string): string | null {
  if (block === 'minecraft:glass') return 'minecraft:glass_pane';
  return block.endsWith('_stained_glass') ? `${block}_pane` : null;
}

/**
 * Material block → the fence or wall in its own family.
 *
 * Two vanilla families, and the asymmetry is real: wood has fences and no
 * walls, stone has walls and no fences (except `nether_brick_fence`, the one
 * non-wood fence in the game). A material in neither table declines — a LEGO
 * fence rendered in a colour that maps to quartz or concrete keeps its cubes
 * rather than changing material.
 */
export const FENCE_VARIANTS: Readonly<Record<string, string>> = {
  'minecraft:oak_planks': 'minecraft:oak_fence',
  'minecraft:spruce_planks': 'minecraft:spruce_fence',
  'minecraft:birch_planks': 'minecraft:birch_fence',
  'minecraft:jungle_planks': 'minecraft:jungle_fence',
  'minecraft:acacia_planks': 'minecraft:acacia_fence',
  'minecraft:dark_oak_planks': 'minecraft:dark_oak_fence',
  'minecraft:mangrove_planks': 'minecraft:mangrove_fence',
  'minecraft:cherry_planks': 'minecraft:cherry_fence',
  'minecraft:bamboo_planks': 'minecraft:bamboo_fence',
  'minecraft:crimson_planks': 'minecraft:crimson_fence',
  'minecraft:warped_planks': 'minecraft:warped_fence',
  'minecraft:nether_bricks': 'minecraft:nether_brick_fence',
};

/**
 * Material block → its wall. Vanilla is selective here and the omissions are
 * NOT oversights: there is no `stone_wall`, no `smooth_stone_wall`, no
 * `polished_andesite_wall`, no quartz, purpur or plank wall.
 */
export const WALL_VARIANTS: Readonly<Record<string, string>> = {
  'minecraft:cobblestone': 'minecraft:cobblestone_wall',
  'minecraft:mossy_cobblestone': 'minecraft:mossy_cobblestone_wall',
  'minecraft:stone_bricks': 'minecraft:stone_brick_wall',
  'minecraft:mossy_stone_bricks': 'minecraft:mossy_stone_brick_wall',
  'minecraft:andesite': 'minecraft:andesite_wall',
  'minecraft:diorite': 'minecraft:diorite_wall',
  'minecraft:granite': 'minecraft:granite_wall',
  'minecraft:cobbled_deepslate': 'minecraft:cobbled_deepslate_wall',
  'minecraft:polished_deepslate': 'minecraft:polished_deepslate_wall',
  'minecraft:deepslate_bricks': 'minecraft:deepslate_brick_wall',
  'minecraft:deepslate_tiles': 'minecraft:deepslate_tile_wall',
  'minecraft:blackstone': 'minecraft:blackstone_wall',
  'minecraft:polished_blackstone': 'minecraft:polished_blackstone_wall',
  'minecraft:polished_blackstone_bricks': 'minecraft:polished_blackstone_brick_wall',
  'minecraft:sandstone': 'minecraft:sandstone_wall',
  'minecraft:red_sandstone': 'minecraft:red_sandstone_wall',
  'minecraft:bricks': 'minecraft:brick_wall',
  'minecraft:mud_bricks': 'minecraft:mud_brick_wall',
  'minecraft:nether_bricks': 'minecraft:nether_brick_wall',
  'minecraft:red_nether_bricks': 'minecraft:red_nether_brick_wall',
  'minecraft:prismarine': 'minecraft:prismarine_wall',
  'minecraft:end_stone_bricks': 'minecraft:end_stone_brick_wall',
};

/**
 * Blocks a lattice may become `iron_bars` in.
 *
 * `iron_bars` is a fixed dark gray, so substituting it anywhere else would be a
 * RECOLOUR — the one thing this pass must not do. Restricted to the neutral
 * grays and metals a LEGO lattice is actually moulded in.
 */
export const BARS_MATERIALS: ReadonlySet<string> = new Set([
  'minecraft:gray_concrete', 'minecraft:light_gray_concrete', 'minecraft:black_concrete',
  'minecraft:iron_block', 'minecraft:stone', 'minecraft:smooth_stone', 'minecraft:andesite',
  'minecraft:polished_andesite', 'minecraft:stone_bricks', 'minecraft:cobblestone',
  'minecraft:cobbled_deepslate', 'minecraft:polished_deepslate', 'minecraft:deepslate_bricks',
  'minecraft:deepslate_tiles', 'minecraft:blackstone', 'minecraft:polished_blackstone',
  'minecraft:polished_blackstone_bricks',
]);

// ─── State strings ───────────────────────────────────────────────────────────

/**
 * Connection sides, in ALPHABETICAL property order.
 *
 * Alphabetical is mandatory, not tidy: the litematic reader re-sorts properties,
 * so writing them any other way breaks id equality on re-import (the same rule
 * `stairsIdFor` follows).
 */
const SIDES = [
  ['east', 1, 0], ['north', 0, -1], ['south', 0, 1], ['west', -1, 0],
] as const;

/** `<id>[east=..,north=..,south=..,waterlogged=false,west=..]` for a pane/bars/fence. */
function connectedId(id: string, connect: readonly boolean[]): string {
  return `${id}[east=${connect[0]},north=${connect[1]},south=${connect[2]},waterlogged=false,west=${connect[3]}]`;
}

/**
 * `<id>[east=..,north=..,south=..,up=true,waterlogged=false,west=..]` for a wall.
 * Wall sides are an enum, not a boolean, and `up` keeps the centre post so a
 * lone wall block is not invisible.
 */
function wallId(id: string, connect: readonly boolean[]): string {
  const s = (b: boolean): string => (b ? 'low' : 'none');
  return `${id}[east=${s(connect[0]!)},north=${s(connect[1]!)},south=${s(connect[2]!)},up=true,waterlogged=false,west=${s(connect[3]!)}]`;
}

// ─── The pass ────────────────────────────────────────────────────────────────

export interface ElementStats {
  /** Cells a mapped part claimed (before the material and support checks). */
  candidates: number;
  panes: number;
  fences: number;
  walls: number;
  bars: number;
  ladders: number;
  /** Claimed cells left as cubes because the material has no such element. */
  noVariant: number;
  /** Ladder cells with no wall to hang on. */
  unsupported: number;
  /** `noVariant` by block id — what a palette change would unlock. */
  noVariantByBlock: Record<string, number>;
}

const AIR = 'minecraft:air';

/**
 * Rewrite the cells of mapped parts into their Minecraft elements.
 *
 * Runs BEFORE `applyBlockShapes` and zeroes `hints.element` for every cell it
 * declines, so a non-zero code afterwards means "an element was placed here"
 * and the slab/stair pass can skip exactly those cells. A cell it declines
 * stays eligible for a slab, which is the right fallback.
 *
 * Neighbour queries are only ever "is this cell air", and this pass never
 * writes air — so the answers cannot change while it runs and a single pass is
 * enough to compute connections and ladder support correctly.
 */
export function applyPartElements(grid: BlockGrid, hints: ShapeHints): ElementStats {
  const stats: ElementStats = {
    candidates: 0, panes: 0, fences: 0, walls: 0, bars: 0, ladders: 0,
    noVariant: 0, unsupported: 0, noVariantByBlock: {},
  };
  const el = hints.element;
  const { width, height, length } = grid;
  if (!el || hints.width !== width || hints.height !== height || hints.length !== length) return stats;

  const airIdx = grid.paletteIndexOf(AIR);
  const solid = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < width && y < height && z < length
    && grid.getIndex(x, y, z) !== airIdx;

  const idxCache = new Map<string, number>();
  const intern = (id: string): number => {
    let p = idxCache.get(id);
    if (p === undefined) { p = grid.paletteIndexOf(id); idxCache.set(id, p); }
    return p;
  };

  const decline = (i: number, block?: string): void => {
    el[i] = ELEMENT_NONE;
    if (block !== undefined) {
      stats.noVariant++;
      stats.noVariantByBlock[block] = (stats.noVariantByBlock[block] ?? 0) + 1;
    }
  };

  const connect: boolean[] = [false, false, false, false];

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = (y * length + z) * width + x;
        const code = el[i]!;
        if (code === ELEMENT_NONE) continue;
        if (code === ELEMENT_CONFLICT) { el[i] = ELEMENT_NONE; continue; }
        const idx = grid.getIndex(x, y, z);
        if (idx === airIdx) { el[i] = ELEMENT_NONE; continue; }
        stats.candidates++;
        const block = grid.blockStateFromIndex(idx);

        if (code === ELEMENT_LADDER) {
          // Facing is NOT taken from the part's own convention — a ladder is
          // defined by what it hangs on, and the LDraw origin of a
          // "Plate 1 x 2 with Ladder" tells us nothing reliable about which
          // face the rungs are on. Instead: the wall must be BEHIND the ladder
          // (Minecraft's ladder model sits on the face opposite `facing`) and
          // the climbing side must be open. No such pair → keep the cube.
          let placed = false;
          for (const [name, dx, dz] of SIDES) {
            if (!solid(x - dx, y, z - dz) || solid(x + dx, y, z + dz)) continue;
            grid.setIndex(x, y, z, intern(`minecraft:ladder[facing=${name},waterlogged=false]`));
            stats.ladders++;
            placed = true;
            break;
          }
          if (!placed) { stats.unsupported++; el[i] = ELEMENT_NONE; }
          continue;
        }

        // Everything else is a connecting element: work out its target id first,
        // and only then pay for the neighbour scan.
        let target: string | null = null;
        let kind: 'pane' | 'fence' | 'wall' | 'bars' | null = null;
        if (code === ELEMENT_PANE) {
          target = paneIdFor(block);
          kind = 'pane';
        } else if (code === ELEMENT_FENCE) {
          const fence = FENCE_VARIANTS[block];
          if (fence) { target = fence; kind = 'fence'; }
          else { const wall = WALL_VARIANTS[block]; if (wall) { target = wall; kind = 'wall'; } }
        } else if (code === ELEMENT_BARS) {
          if (BARS_MATERIALS.has(block)) { target = 'minecraft:iron_bars'; kind = 'bars'; }
        }
        if (!target || !kind) { decline(i, block); continue; }

        for (let s = 0; s < 4; s++) {
          const [, dx, dz] = SIDES[s]!;
          connect[s] = solid(x + dx, y, z + dz);
        }
        grid.setIndex(x, y, z, intern(kind === 'wall' ? wallId(target, connect) : connectedId(target, connect)));
        if (kind === 'pane') stats.panes++;
        else if (kind === 'fence') stats.fences++;
        else if (kind === 'wall') stats.walls++;
        else stats.bars++;
      }
    }
  }
  return stats;
}
