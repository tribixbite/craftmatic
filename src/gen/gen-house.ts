/**
 * House generator — produces residential structures with multiple architectural styles.
 * Extracted from generator.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import type { RoomType, RoomBounds, RoofShape, FeatureFlags, FloorPlanShape, BuildingSection, LandscapeData } from '../types/index.js';
import type { CoordinateBitmap } from './coordinate-bitmap.js';
import type { TreeType } from './structures.js';
import { getRoomGenerator } from './rooms.js';
import {
  foundation,
  floor, exteriorWalls, timberColumns, timberBeams,
  windows, interiorWall, doorway, frontDoor, staircase,
  gabledRoof, hipRoof, flatRoof, gambrelRoof, mansardRoof,
  chimney, wallTorches, porch, placeDeck,
  placeTree, placeGarden, placePool,
  addBackyard, addDriveway, addPropertyFence,
  windowSills, baseTrim, eaveTrim,
} from './structures.js';
import type { StylePalette } from './styles.js';
import { STORY_H, resolveRooms } from './gen-utils.js';
import { applyDecorators } from './gen-decorators.js';

// ─── Section Helpers ────────────────────────────────────────────────────────

/** Place a roof of the given shape — single dispatch for all roof variants */
function placeRoof(
  grid: BlockGrid, x1: number, z1: number, x2: number, z2: number,
  baseY: number, height: number, style: StylePalette, shape: RoofShape,
): void {
  switch (shape) {
    case 'hip':     hipRoof(grid, x1, z1, x2, z2, baseY, height, style); break;
    case 'flat':    flatRoof(grid, x1, z1, x2, z2, baseY, height, style); break;
    case 'gambrel': gambrelRoof(grid, x1, z1, x2, z2, baseY, height, style); break;
    case 'mansard': mansardRoof(grid, x1, z1, x2, z2, baseY, height, style); break;
    case 'gable':
    default:        gabledRoof(grid, x1, z1, x2, z2, baseY, height, style); break;
  }
}

/** Generate a wing section: foundation, shell, windows, roof, single room */
function generateWingSection(
  grid: BlockGrid, section: BuildingSection, style: StylePalette,
  roofShape: RoofShape, roofHeight: number, windowSpacing?: number,
): void {
  const { x1, z1, width, length, floors } = section;
  const x2 = x1 + width - 1;
  const z2 = z1 + length - 1;

  foundation(grid, x1, z1, x2, z2, style);

  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;
    floor(grid, x1 + 1, by, z1 + 1, x2 - 1, z2 - 1, style, story === 0);
    exteriorWalls(grid, x1, by + 1, z1, x2, cy - 1, z2, style);
    windows(grid, x1, z1, x2, z2, by + 3, by + 4, style, windowSpacing);
    if (story === floors - 1) {
      grid.fill(x1, cy, z1, x2, cy, z2, style.ceiling);
    }
    wallTorches(grid, x1, z1, x2, z2, by + 3, style);
  }

  placeRoof(grid, x1, z1, x2, z2, floors * STORY_H, roofHeight, style, roofShape);

  if (section.roomType) {
    const bounds: RoomBounds = {
      x1: x1 + 1, y: 1, z1: z1 + 1, x2: x2 - 1, z2: z2 - 1, height: STORY_H - 1,
    };
    getRoomGenerator(section.roomType)(grid, bounds, style);
  }
}

/**
 * Convert FloorPlanShape + dimensions into wing BuildingSection[].
 * Returns empty array for 'rect'. For L/T: one east wing. For U: east + west wings.
 * Callers can also construct BuildingSection[] directly for arbitrary layouts.
 */
export function planShapeToSections(
  planShape: FloorPlanShape, bx1: number, bx2: number,
  bz1: number, zMid: number,
  wingW: number, wingL: number, rooms?: RoomType[],
): BuildingSection[] {
  if (planShape === 'rect' || wingW <= 0 || wingL <= 0) return [];

  const sections: BuildingSection[] = [];
  // L-shape: wing at back (bz1); T-shape: wing centered vertically
  const wz1 = planShape === 'T' ? zMid - Math.floor(wingL / 2) : bz1;

  // East wing (L/T/U)
  sections.push({
    x1: bx2 + 1, z1: wz1, width: wingW, length: wingL,
    floors: 1,
    roomType: rooms?.find(r => r === 'garage' || r === 'sunroom' || r === 'study') ?? 'study',
  });

  // West wing (U only)
  if (planShape === 'U') {
    const wx1 = Math.max(0, bx1 - wingW);
    const wx2 = bx1 - 1;
    if (wx2 > wx1) {
      sections.push({
        x1: wx1, z1: wz1, width: wx2 - wx1 + 1, length: wingL,
        floors: 1,
        roomType: rooms?.find(r => r === 'library' || r === 'laundry') ?? 'living',
      });
    }
  }

  return sections;
}

// ─── Tree Positioning ────────────────────────────────────────────────────────

/** Distribute N trees around the building perimeter with minimum spacing.
 * Returns [x, z] positions in grid coordinates, deterministic via rng. */
function computeTreePositions(
  grid: BlockGrid, bx1: number, bx2: number, bz1: number, bz2: number,
  porchDepth: number, count: number, rng: () => number,
): [number, number][] {
  const candidates: [number, number][] = [];
  const minSpacing = 3;

  // Front yard: 2 candidates (left and right of entrance)
  const frontZ = bz2 + porchDepth + 4;
  candidates.push([Math.max(0, bx1 - 1), frontZ]);
  candidates.push([Math.min(grid.width - 1, bx2 + 1), frontZ]);
  // Extra front yard candidate (center-ish offset)
  candidates.push([Math.floor((bx1 + bx2) / 2) - 4, frontZ + 2]);

  // Side yards: left and right of building
  for (const sz of [bz1 + 2, Math.floor((bz1 + bz2) / 2)]) {
    candidates.push([Math.max(0, bx1 - 3), sz]);
    candidates.push([Math.min(grid.width - 1, bx2 + 3), sz]);
  }

  // Back yard: behind the house
  candidates.push([bx1 + 2, Math.max(0, bz1 - 4)]);
  candidates.push([bx2 - 2, Math.max(0, bz1 - 5)]);

  // Filter to in-bounds candidates, then shuffle deterministically
  const valid = candidates.filter(([x, z]) => grid.inBounds(x, 1, z));
  for (let i = valid.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }

  // Pick up to `count` positions with minimum spacing between them
  const placed: [number, number][] = [];
  for (const pos of valid) {
    if (placed.length >= count) break;
    const tooClose = placed.some(([px, pz]) =>
      Math.abs(pos[0] - px) < minSpacing && Math.abs(pos[1] - pz) < minSpacing
    );
    if (!tooClose) placed.push(pos);
  }
  return placed;
}

// ─── Ground Cover Patches ────────────────────────────────────────────────────

/** Block materials for each ground cover type — scattered as patches, not full fill */
const GROUND_COVER_BLOCKS: Record<string, string[]> = {
  forest: ['minecraft:podzol', 'minecraft:moss_block'],
  crop: ['minecraft:farmland', 'minecraft:coarse_dirt'],
  built: ['minecraft:stone', 'minecraft:gray_concrete'],
  bare: ['minecraft:sand', 'minecraft:red_sand'],
  water: ['minecraft:clay'],
};

/** Scatter ground cover patches in yard areas based on land cover class */
function applyGroundCover(
  grid: BlockGrid, bx1: number, bx2: number, bz1: number, bz2: number,
  porchDepth: number, groundCover: string, rng: () => number,
): void {
  const blocks = GROUND_COVER_BLOCKS[groundCover];
  if (!blocks) return; // 'grass' and 'default' leave the existing grass_block ground

  // Patch areas: front yard, side yards, and back yard
  const zones: [number, number, number, number][] = [
    // Back yard
    [Math.max(0, bx1 - 2), Math.max(0, bz1 - 7), bx2 + 2, bz1 - 1],
    // Front yard
    [bx1, bz2 + porchDepth + 2, bx2, bz2 + porchDepth + 5],
    // Left side
    [Math.max(0, bx1 - 3), bz1, bx1 - 1, bz2],
    // Right side
    [bx2 + 1, bz1, Math.min(grid.width - 1, bx2 + 3), bz2],
  ];

  for (const [zx1, zz1, zx2, zz2] of zones) {
    for (let x = zx1; x <= zx2; x++) {
      for (let z = zz1; z <= zz2; z++) {
        if (!grid.inBounds(x, 0, z)) continue;
        // ~25% coverage — scattered patches, not solid fill
        if (rng() < 0.25) {
          const block = blocks[Math.floor(rng() * blocks.length)];
          grid.set(x, 0, z, block);
        }
      }
    }
  }
}

// ─── House ──────────────────────────────────────────────────────────────────

export function generateHouse(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, rng: () => number,
  roofShapeOpt?: RoofShape, features?: FeatureFlags,
  planShape?: FloorPlanShape, roofHeightOverride?: number,
  windowSpacing?: number, footprintBitmap?: CoordinateBitmap,
  sections?: BuildingSection[], landscape?: LandscapeData,
): BlockGrid {
  // Use style's preferred roof shape when no explicit override
  const roofShape: RoofShape = roofShapeOpt ?? style.defaultRoofShape;
  // Use style's preferred plan shape when no explicit override
  const effectivePlanShape: FloorPlanShape = planShape ?? style.defaultPlanShape;
  // Roof height: Solar API pitch override > style default
  // Clamp roof height proportionally to wall height — prevents roof-dominated buildings.
  // Wall:roof ratio stays ≥ 1:1 (roof never taller than walls).
  // For 1-floor (5 blocks): max 6. For 2-floor (10 blocks): max 8. For 3+ floor: unclamped.
  const wallH = floors * STORY_H;
  const maxRoofH = floors >= 3 ? 14 : wallH + Math.max(1, Math.floor(wallH * 0.2));
  const rawRoofH = roofHeightOverride ?? style.roofHeight;
  const effectiveRoofH = Math.min(rawRoofH, maxRoofH);
  const bw = bwOpt ?? 29;
  const bl = blOpt ?? 23;
  const margin = 3;
  const porchDepth = 4;
  // For L/T/U plans, allocate extra width for the wing(s)
  const wingW = (effectivePlanShape !== 'rect') ? Math.max(8, Math.floor(bw * 0.45)) : 0;
  const wingL = (effectivePlanShape !== 'rect') ? Math.max(6, Math.floor(bl * 0.4)) : 0;
  // U-shape needs extra space on both sides; L/T only on one side
  const extraEast = (effectivePlanShape !== 'rect') ? wingW : 0;
  const extraWest = (effectivePlanShape === 'U') ? wingW : 0;
  const gw = bw + 2 * margin + extraEast + extraWest;
  const gl = bl + 2 * margin + porchDepth;
  const gh = floors * STORY_H + effectiveRoofH;

  // Shift main building right for U-shape to make room for west wing
  const bx1 = margin + extraWest;
  const bx2 = margin + extraWest + bw - 1;
  const bz1 = margin;
  const bz2 = margin + bl - 1;
  const xMid = margin + Math.floor(bw / 2);
  const zMid = margin + Math.floor(bl / 2);

  const grid = new BlockGrid(gw, gh, gl);
  const foundType = features?.foundationType ?? 'slab';

  // Foundation — type determines visual treatment at ground level (y=0)
  foundation(grid, bx1, bz1, bx2, bz2, style);
  if (foundType === 'crawlspace') {
    // Crawlspace: replace solid perimeter at y=0 with lattice fencing
    // Interior stays solid (floor), but the visible edge is open
    const csBlk = landscape?.fenceBlock ?? 'minecraft:oak_fence';
    for (let x = bx1; x <= bx2; x++) {
      grid.set(x, 0, bz1, csBlk);
      grid.set(x, 0, bz2, csBlk);
    }
    for (let z = bz1 + 1; z < bz2; z++) {
      grid.set(bx1, 0, z, csBlk);
      grid.set(bx2, 0, z, csBlk);
    }
  } else if (foundType === 'pier') {
    // Pier: only corner and midpoint pillars visible at y=0
    const pillars: [number, number][] = [
      [bx1, bz1], [bx1, bz2], [bx2, bz1], [bx2, bz2],
      [xMid, bz1], [xMid, bz2], [bx1, zMid], [bx2, zMid],
    ];
    // Clear foundation edges, re-place only pillar positions
    for (let x = bx1; x <= bx2; x++) {
      grid.set(x, 0, bz1, 'minecraft:air');
      grid.set(x, 0, bz2, 'minecraft:air');
    }
    for (let z = bz1 + 1; z < bz2; z++) {
      grid.set(bx1, 0, z, 'minecraft:air');
      grid.set(bx2, 0, z, 'minecraft:air');
    }
    for (const [px, pz] of pillars) {
      if (grid.inBounds(px, 0, pz)) grid.set(px, 0, pz, style.pillar);
    }
  }

  // Per-story shell
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const cy = by + STORY_H;

    floor(grid, bx1 + 1, by, bz1 + 1, bx2 - 1, bz2 - 1, style, story === 0);
    exteriorWalls(grid, bx1, by + 1, bz1, bx2, cy - 1, bz2, style);

    const colXs = [bx1, bx1 + Math.floor(bw / 4), xMid, bx2 - Math.floor(bw / 4), bx2];
    const colPositions: [number, number][] = [];
    for (const cx of colXs) {
      colPositions.push([cx, bz1], [cx, bz2]);
    }
    const sideZs = [bz1, bz1 + 5, zMid, bz2 - 5, bz2].filter(z => z >= bz1 && z <= bz2);
    for (const sz of sideZs) {
      colPositions.push([bx1, sz], [bx2, sz]);
    }
    timberColumns(grid, colPositions, by, cy, style);
    timberBeams(grid, bx1, by, bz1, bx2, bz2, style);
    timberBeams(grid, bx1, cy, bz1, bx2, bz2, style);

    windows(grid, bx1, bz1, bx2, bz2, by + 2, by + 3, style, windowSpacing ?? 3);
    // Window sills — top-slab below each window for depth
    windowSills(grid, bx1, bz1, bx2, bz2, by + 1, style, windowSpacing ?? 3);

    interiorWall(grid, 'z', xMid, bz1 + 1, bz2 - 1, by + 1, cy - 1, style);
    doorway(grid, xMid, by + 1, zMid - 1, xMid, by + 3, zMid + 1);

    interiorWall(grid, 'x', zMid, bx1 + 1, xMid - 1, by + 1, cy - 1, style);
    interiorWall(grid, 'x', zMid, xMid + 1, bx2 - 1, by + 1, cy - 1, style);
    doorway(grid, bx1 + 4, by + 1, zMid, bx1 + 6, by + 3, zMid);
    doorway(grid, bx2 - 6, by + 1, zMid, bx2 - 4, by + 3, zMid);

    // Foundation base trim on ground story
    if (story === 0) {
      baseTrim(grid, bx1, bz1, bx2, bz2, by + 1, style);
    }

    if (story === floors - 1) {
      grid.fill(bx1, cy, bz1, bx2, cy, bz2, style.ceiling);
      // Eave overhang at roofline
      eaveTrim(grid, bx1, bz1, bx2, bz2, cy, style);
    }

    wallTorches(grid, bx1, bz1, bx2, bz2, by + 3, style);
  }

  const dx = xMid;
  // Porch is gated by features flag (default: true)
  if (features?.porch !== false) {
    porch(grid, dx, bz2, 9, STORY_H, style, 'south');
    // Exterior lanterns flanking the front door
    if (grid.inBounds(dx - 2, 1, bz2 + 1))
      grid.set(dx - 2, 1, bz2 + 1, style.lanternFloor);
    if (grid.inBounds(dx + 2, 1, bz2 + 1))
      grid.set(dx + 2, 1, bz2 + 1, style.lanternFloor);
  }
  frontDoor(grid, dx, 1, bz2, style, 'north');

  const stairX = xMid + 3;
  const stairX2 = xMid + 4;
  for (let story = 0; story < floors - 1; story++) {
    const by = story * STORY_H;
    const nextY = (story + 1) * STORY_H;
    staircase(grid, stairX, stairX2, bz1 + 2, by, nextY, gh);
  }

  const roomAssignment = resolveRooms(floors, rooms, rng, 'house');
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const fy = by + 1;
    const storyRooms = roomAssignment[story];

    const quadrants: RoomBounds[] = [
      { x1: bx1 + 1, y: fy, z1: bz1 + 1, x2: xMid - 1, z2: zMid - 1, height: STORY_H - 1 },
      { x1: bx1 + 1, y: fy, z1: zMid + 1, x2: xMid - 1, z2: bz2 - 1, height: STORY_H - 1 },
      { x1: xMid + 1, y: fy, z1: zMid + 1, x2: bx2 - 1, z2: bz2 - 1, height: STORY_H - 1 },
      { x1: xMid + 1, y: fy, z1: bz1 + 1, x2: bx2 - 1, z2: zMid - 1, height: STORY_H - 1 },
    ];

    for (let q = 0; q < Math.min(storyRooms.length, quadrants.length); q++) {
      const roomType = storyRooms[q];
      const generator = getRoomGenerator(roomType);
      generator(grid, quadrants[q], style);
    }
  }

  // ── Roof ───────────────────────────────────────────────────────────
  const roofBase = floors * STORY_H;
  placeRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style, roofShape);

  // ── Wing sections (L/T/U plans or explicit BuildingSection[]) ─────
  const wings = sections
    ?? planShapeToSections(effectivePlanShape, bx1, bx2, bz1, zMid, wingW, wingL, rooms);
  for (const wing of wings) {
    generateWingSection(grid, wing, style, roofShape, effectiveRoofH, windowSpacing);
    // Connecting doorway between main body and wing
    const connectZ = Math.max(bz1 + 1, Math.min(wing.z1 + Math.floor(wing.length / 2), bz2 - 1));
    if (wing.x1 > bx2) {
      doorway(grid, bx2, 1, connectZ - 1, bx2, 3, connectZ + 1);
    } else {
      doorway(grid, bx1, 1, connectZ - 1, bx1, 3, connectZ + 1);
    }
  }

  // ── Feature flags (default: all enabled for houses) ───────────────
  // Note: porch is handled earlier (before staircases) for grid layout ordering
  const f = {
    chimney:  features?.chimney  ?? true,
    backyard: features?.backyard ?? true,
    driveway: features?.driveway ?? true,
    fence:    features?.fence    ?? true,
    trees:    features?.trees    ?? true,
    garden:   features?.garden   ?? true,
    pool:     features?.pool     ?? false,
  };

  // Chimney (skip for flat roofs — no peak to rise through)
  if (f.chimney && roofShape !== 'flat') {
    const chimX = Math.floor((bx1 + 1 + xMid - 1) / 2);
    const chimTop = roofBase + effectiveRoofH - 2;
    chimney(grid, chimX, bz1, STORY_H, chimTop);
  }

  // Deck on the back of the house (before other features to avoid overlap)
  if (features?.deck) {
    placeDeck(grid, bx1, bx2, bz1, 0, landscape?.fenceBlock);
  }

  // Exterior features, each gated by its flag
  // Backyard tree species from landscape palette
  const backyardTree: TreeType = landscape?.treePalette
    ? landscape.treePalette[Math.floor(rng() * landscape.treePalette.length)]
    : 'birch';
  if (f.backyard) addBackyard(grid, bx1, bx2, bz1, style, rng, backyardTree);
  if (f.driveway) addDriveway(grid, xMid, bz2, porchDepth, landscape?.pathBlock);
  if (f.fence)    addPropertyFence(grid, bx1, bz1, bx2, bz2, xMid, style, landscape?.fenceBlock);

  // Swimming pool in backyard area — check full extent including border + diving board
  if (f.pool) {
    const poolW = 5, poolL = 8;
    const poolX = Math.floor((bx1 + bx2) / 2);
    const poolZ = Math.max(Math.floor(poolL / 2) + 2, bz1 - 6);
    const px1 = poolX - Math.floor(poolW / 2) - 1; // border
    const px2 = poolX + Math.floor(poolW / 2) + 1;
    const pz1 = poolZ - Math.floor(poolL / 2) - 1;
    const pz2 = poolZ + Math.floor(poolL / 2) + 2; // diving board extends +1
    if (grid.inBounds(px1, 0, pz1) && grid.inBounds(px2, 0, pz2))
      placePool(grid, poolX, poolZ, poolW, poolL);
  }

  // Additional trees around property — species, count, and height from landscape data
  if (f.trees) {
    const palette: TreeType[] = landscape?.treePalette ?? ['oak', 'birch'];
    const count = landscape?.treeCount ?? 2;
    const height = landscape?.treeHeight ?? 5;
    const positions = computeTreePositions(grid, bx1, bx2, bz1, bz2, porchDepth, count, rng);
    for (const [tx, tz] of positions) {
      const species = palette[Math.floor(rng() * palette.length)];
      placeTree(grid, tx, 1, tz, species, height);
    }
  }

  // Side garden
  if (f.garden) {
    const gardenX1 = Math.max(0, bx1 - 1);
    const gardenZ1 = bz1 + 2;
    const gardenZ2 = Math.min(gardenZ1 + 3, bz2 - 2);
    if (gardenZ2 > gardenZ1 && grid.inBounds(gardenX1, 0, gardenZ2))
      placeGarden(grid, gardenX1 - 1, gardenZ1, gardenX1, gardenZ2, 0, rng);
  }

  // ── Ground cover patches from land cover class ──────────────────
  if (landscape?.groundCover && landscape.groundCover !== 'grass' && landscape.groundCover !== 'default') {
    applyGroundCover(grid, bx1, bx2, bz1, bz2, porchDepth, landscape.groundCover, rng);
  }

  // ── Style decorators — compositional details extracted to gen-decorators.ts ──
  applyDecorators(undefined, {
    grid, style, rng, floors, roofShape, effectiveRoofH,
    bx1, bx2, bz1, bz2, bw, bl, xMid, zMid,
    roofBase, porchDepth, landscape,
  });

  // ── Bitmap footprint mask ────────────────────────────────────────
  // When an OSM-derived footprint bitmap is available, carve away any blocks
  // in the main building volume that fall outside the actual polygon footprint.
  // This gives pixel-perfect L/T/U shapes without rewriting wall generation.
  if (footprintBitmap) {
    const bmBounds = footprintBitmap.bounds();
    if (bmBounds) {
      const bmW = bmBounds.maxX - bmBounds.minX + 1;
      const bmH = bmBounds.maxZ - bmBounds.minZ + 1;
      const gridW = bx2 - bx1 + 1;
      const gridH = bz2 - bz1 + 1;
      // Scale factors: map grid building area to bitmap area
      const scaleX = bmW / gridW;
      const scaleZ = bmH / gridH;

      // Helper: check if a grid column maps to a kept (inside polygon) bitmap cell
      const isKept = (gx: number, gz: number): boolean => {
        const bX = Math.round(bmBounds.minX + (gx - bx1) * scaleX);
        const bZ = Math.round(bmBounds.minZ + (gz - bz1) * scaleZ);
        return footprintBitmap!.contains(bX, bZ);
      };

      // Pass 1: carve away columns outside the polygon footprint
      for (let gx = bx1; gx <= bx2; gx++) {
        for (let gz = bz1; gz <= bz2; gz++) {
          if (!isKept(gx, gz)) {
            for (let y = 0; y < gh; y++) {
              if (grid.get(gx, y, gz) !== 'minecraft:air') {
                grid.set(gx, y, gz, 'minecraft:air');
              }
            }
          }
        }
      }

      // Pass 2: seal exposed interior edges at the cut boundary.
      // Kept columns that border carved columns have newly-visible faces.
      // Fill interior air blocks with wall material to prevent seeing into rooms.
      const dirs: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (let gx = bx1; gx <= bx2; gx++) {
        for (let gz = bz1; gz <= bz2; gz++) {
          if (!isKept(gx, gz)) continue;
          // Check if this kept column borders any carved column
          let bordersCut = false;
          for (const [dx, dz] of dirs) {
            const nx = gx + dx, nz = gz + dz;
            if (nx < bx1 || nx > bx2 || nz < bz1 || nz > bz2) continue;
            if (!isKept(nx, nz)) { bordersCut = true; break; }
          }
          if (!bordersCut) continue;
          // Seal: replace interior air with wall blocks (floors 1 through roof base)
          for (let y = 1; y <= floors * STORY_H; y++) {
            if (grid.get(gx, y, gz) === 'minecraft:air') {
              grid.set(gx, y, gz, style.wall);
            }
          }
        }
      }
    }
  }

  return grid;
}
