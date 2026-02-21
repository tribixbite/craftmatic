/**
 * House generator — produces residential structures with multiple architectural styles.
 * Extracted from generator.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import type { RoomType, RoomBounds, RoofShape, FeatureFlags, FloorPlanShape } from '../types/index.js';
import { getRoomGenerator } from './rooms.js';
import {
  foundation, floor, exteriorWalls, timberColumns, timberBeams,
  windows, interiorWall, doorway, frontDoor, staircase,
  gabledRoof, hipRoof, flatRoof, gambrelRoof, mansardRoof,
  chimney, wallTorches, porch,
  placeTree, placeGarden, placePool,
  addBackyard, addDriveway, addPropertyFence,
  weatherWalls, accentBand, glassCurtainWall,
  windowSills, baseTrim, eaveTrim,
} from './structures.js';
import type { StylePalette } from './styles.js';
import { STORY_H, resolveRooms, pick, placeOutbuilding } from './gen-utils.js';

// ─── House ──────────────────────────────────────────────────────────────────

export function generateHouse(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  bwOpt: number | undefined, blOpt: number | undefined, rng: () => number,
  roofShapeOpt?: RoofShape, features?: FeatureFlags,
  planShape?: FloorPlanShape
): BlockGrid {
  // Use style's preferred roof shape when no explicit override
  const roofShape: RoofShape = roofShapeOpt ?? style.defaultRoofShape;
  // Use style's preferred plan shape when no explicit override
  const effectivePlanShape: FloorPlanShape = planShape ?? style.defaultPlanShape;
  // Use style's preferred roof height (overrides global ROOF_H constant)
  const effectiveRoofH = style.roofHeight;
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

  // Foundation
  foundation(grid, bx1, bz1, bx2, bz2, style);

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

    windows(grid, bx1, bz1, bx2, bz2, by + 2, by + 3, style);
    // Window sills — top-slab below each window for depth
    windowSills(grid, bx1, bz1, bx2, bz2, by + 1, style);

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
  switch (roofShape) {
    case 'hip':     hipRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'flat':    flatRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'gambrel': gambrelRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'mansard': mansardRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
    case 'gable':
    default:        gabledRoof(grid, bx1, bz1, bx2, bz2, roofBase, effectiveRoofH, style); break;
  }

  // ── L/T/U-shaped wing ──────────────────────────────────────────────
  if (effectivePlanShape !== 'rect' && wingW > 0 && wingL > 0) {
    // Wing extends off the east side of the main building
    const wx1 = bx2 + 1;
    const wx2 = wx1 + wingW - 1;
    // L-shape: wing on back half; T-shape: wing centered; U-shape: two wings
    const wz1 = effectivePlanShape === 'T' ? zMid - Math.floor(wingL / 2) : bz1;
    const wz2 = wz1 + wingL - 1;

    // Wing shell (ground floor only for simplicity)
    foundation(grid, wx1, wz1, wx2, wz2, style);
    floor(grid, wx1 + 1, 0, wz1 + 1, wx2 - 1, wz2 - 1, style, true);
    exteriorWalls(grid, wx1, 1, wz1, wx2, STORY_H - 1, wz2, style);
    windows(grid, wx1, wz1, wx2, wz2, 3, 4, style);
    grid.fill(wx1, STORY_H, wz1, wx2, STORY_H, wz2, style.ceiling);
    wallTorches(grid, wx1, wz1, wx2, wz2, 3, style);

    // Roof over wing — uses style's preferred shape
    const wingRoofBase = STORY_H;
    const wingRoofH = effectiveRoofH;
    switch (roofShape) {
      case 'hip':     hipRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'flat':    flatRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'gambrel': gambrelRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'mansard': mansardRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
      case 'gable':
      default:        gabledRoof(grid, wx1, wz1, wx2, wz2, wingRoofBase, wingRoofH, style); break;
    }

    // Connecting doorway between main body and wing
    const connectZ = Math.max(bz1 + 1, Math.min(wz1 + Math.floor(wingL / 2), bz2 - 1));
    doorway(grid, bx2, 1, connectZ - 1, bx2, 3, connectZ + 1);

    // Wing rooms (use remaining rooms from assignment or defaults)
    const wingBounds: RoomBounds = {
      x1: wx1 + 1, y: 1, z1: wz1 + 1, x2: wx2 - 1, z2: wz2 - 1, height: STORY_H - 1,
    };
    // Pick a sensible room for the wing
    const wingRoom = rooms?.find(r => r === 'garage' || r === 'sunroom' || r === 'study') ?? 'study';
    const wingGen = getRoomGenerator(wingRoom);
    wingGen(grid, wingBounds, style);

    // U-shape: second wing on the west side
    if (effectivePlanShape === 'U') {
      const wx1b = Math.max(0, bx1 - wingW);
      const wx2b = bx1 - 1;
      if (wx2b > wx1b) {
        foundation(grid, wx1b, wz1, wx2b, wz2, style);
        floor(grid, wx1b + 1, 0, wz1 + 1, wx2b - 1, wz2 - 1, style, true);
        exteriorWalls(grid, wx1b, 1, wz1, wx2b, STORY_H - 1, wz2, style);
        windows(grid, wx1b, wz1, wx2b, wz2, 3, 4, style);
        grid.fill(wx1b, STORY_H, wz1, wx2b, STORY_H, wz2, style.ceiling);
        // U-shape west wing roof — same shape as main
        switch (roofShape) {
          case 'hip':     hipRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'flat':    flatRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'gambrel': gambrelRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'mansard': mansardRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
          case 'gable':
          default:        gabledRoof(grid, wx1b, wz1, wx2b, wz2, STORY_H, wingRoofH, style); break;
        }
        doorway(grid, bx1, 1, connectZ - 1, bx1, 3, connectZ + 1);
        const wing2Bounds: RoomBounds = {
          x1: wx1b + 1, y: 1, z1: wz1 + 1, x2: wx2b - 1, z2: wz2 - 1, height: STORY_H - 1,
        };
        const wing2Room = rooms?.find(r => r === 'library' || r === 'laundry') ?? 'living';
        getRoomGenerator(wing2Room)(grid, wing2Bounds, style);
      }
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

  // Exterior features, each gated by its flag
  if (f.backyard) addBackyard(grid, bx1, bx2, bz1, style, rng);
  if (f.driveway) addDriveway(grid, xMid, bz2, porchDepth);
  if (f.fence)    addPropertyFence(grid, bx1, bz1, bx2, bz2, xMid, style);

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

  // Additional trees in front/side yard
  if (f.trees) {
    const treeX = Math.max(0, bx1 - 1);
    const treeZ = bz2 + porchDepth + 4;
    if (grid.inBounds(treeX, 1, treeZ)) placeTree(grid, treeX, 1, treeZ, 'oak', 5);
    const treeX2 = Math.min(grid.width - 1, bx2 + 1);
    if (grid.inBounds(treeX2, 1, treeZ)) placeTree(grid, treeX2, 1, treeZ, 'birch', 4);
  }

  // Side garden
  if (f.garden) {
    const gardenX1 = Math.max(0, bx1 - 1);
    const gardenZ1 = bz1 + 2;
    const gardenZ2 = Math.min(gardenZ1 + 3, bz2 - 2);
    if (gardenZ2 > gardenZ1 && grid.inBounds(gardenX1, 0, gardenZ2))
      placeGarden(grid, gardenX1 - 1, gardenZ1, gardenX1, gardenZ2, 0, rng);
  }

  // ── Compositional outbuildings — break "single box" silhouette for all house styles ──
  // Fantasy Cottage: garden shed + flower garden with fence + ivy walls
  if (style.wallAccent === 'minecraft:chiseled_stone_bricks') {
    // Garden shed to the west
    const shedX = Math.max(0, bx1 - 8);
    const shedZ = zMid - 2;
    placeOutbuilding(grid, shedX, shedZ, 5, 5, 3, style, 'gable');
    // Gravel path connecting shed to house front
    for (let x = shedX + 5; x <= bx1; x++) {
      if (grid.inBounds(x, 0, shedZ + 2))
        grid.set(x, 0, shedZ + 2, 'minecraft:gravel');
    }
    // Fenced flower garden south of shed
    const fgX1 = shedX;
    const fgZ1 = bz2 + 2;
    const fgX2 = fgX1 + 6;
    if (grid.inBounds(fgX2 + 1, 1, fgZ1 + 5)) {
      for (let x = fgX1; x <= fgX2; x++) {
        for (let z = fgZ1; z <= fgZ1 + 4; z++) {
          if (grid.inBounds(x, 0, z)) grid.set(x, 0, z, 'minecraft:grass_block');
        }
      }
      const fFlowers = ['minecraft:rose_bush', 'minecraft:lilac', 'minecraft:peony', 'minecraft:sunflower'];
      for (let i = 0; i < 8; i++) {
        const fx = fgX1 + Math.floor(rng() * 7);
        const fz = fgZ1 + Math.floor(rng() * 5);
        if (grid.inBounds(fx, 1, fz))
          grid.set(fx, 1, fz, pick(fFlowers, rng));
      }
      for (let x = fgX1 - 1; x <= fgX2 + 1; x++) {
        if (grid.inBounds(x, 1, fgZ1 - 1)) grid.set(x, 1, fgZ1 - 1, style.fence);
        if (grid.inBounds(x, 1, fgZ1 + 5)) grid.set(x, 1, fgZ1 + 5, style.fence);
      }
      for (let z = fgZ1 - 1; z <= fgZ1 + 5; z++) {
        if (grid.inBounds(fgX1 - 1, 1, z)) grid.set(fgX1 - 1, 1, z, style.fence);
        if (grid.inBounds(fgX2 + 1, 1, z)) grid.set(fgX2 + 1, 1, z, style.fence);
      }
    }
    // Ivy/azalea climbing west wall
    for (let y = 1; y <= Math.min(floors * STORY_H - 1, 6); y++) {
      for (let z = bz1 + 2; z <= bz2 - 2; z += 2) {
        if (grid.inBounds(bx1 - 1, y, z) && rng() < 0.5)
          grid.set(bx1 - 1, y, z, 'minecraft:azalea_leaves[persistent=true]');
      }
    }
  }

  // Modern House: detached carport + landscaped yard
  if (style.wallAccent === 'minecraft:light_gray_concrete') {
    // Minimalist carport to the west
    const cpX = Math.max(0, bx1 - 9);
    const cpZ = bz1;
    if (grid.inBounds(cpX, 0, cpZ)) {
      // Flat roof carport (open sides)
      grid.fill(cpX, 0, cpZ, cpX + 6, 0, cpZ + 5, 'minecraft:polished_andesite');
      // Corner pillars only
      for (const [px, pz] of [[cpX, cpZ], [cpX + 6, cpZ], [cpX, cpZ + 5], [cpX + 6, cpZ + 5]] as [number, number][]) {
        for (let y = 1; y <= 3; y++) {
          if (grid.inBounds(px, y, pz)) grid.set(px, y, pz, 'minecraft:quartz_pillar');
        }
      }
      // Flat slab roof
      grid.fill(cpX, 4, cpZ, cpX + 6, 4, cpZ + 5, 'minecraft:smooth_quartz_slab[type=bottom]');
    }
    // Stepping stone path from carport to house
    for (let x = cpX + 7; x <= bx1; x += 2) {
      if (grid.inBounds(x, 0, cpZ + 2))
        grid.set(x, 0, cpZ + 2, 'minecraft:smooth_stone_slab[type=bottom]');
    }
    // Decorative ground cover (different materials for modern landscape)
    for (let x = Math.max(0, bx1 - 2); x <= bx2 + 2; x++) {
      for (let z = bz2 + porchDepth + 1; z <= bz2 + porchDepth + 3; z++) {
        if (grid.inBounds(x, 0, z) && grid.get(x, 0, z) === 'minecraft:air')
          grid.set(x, 0, z, x % 3 === 0 ? 'minecraft:smooth_stone' : 'minecraft:light_gray_concrete');
      }
    }
  }

  // ── Modern facade enhancements: cantilever + glass curtain wall + rooftop ──
  if (style.wall === 'minecraft:white_concrete') {
    // Horizontal accent bands between floors for visual depth
    for (let story = 1; story < floors; story++) {
      accentBand(grid, bx1, story * STORY_H, bz1, bx2, bz2, style.wallAccent);
    }
    // Ground floor: full glass curtain wall on front AND east side
    glassCurtainWall(grid, bx1 + 2, 2, STORY_H - 2, bz2, bx2 - 2, style.window);
    // East side glass wall (ground floor)
    for (let z = bz1 + 2; z <= bz2 - 2; z++) {
      for (let y = 2; y <= STORY_H - 2; y++) {
        if (grid.inBounds(bx2, y, z))
          grid.set(bx2, y, z, style.window);
      }
    }
    // Upper floor cantilever — extends 2 blocks beyond ground floor on south + east
    if (floors >= 2) {
      // South cantilever overhang (3 blocks deep)
      for (let x = bx1; x <= bx2 + 2; x++) {
        for (let dz = 1; dz <= 3; dz++) {
          if (grid.inBounds(x, STORY_H, bz2 + dz))
            grid.set(x, STORY_H, bz2 + dz, 'minecraft:white_concrete');
        }
      }
      // East cantilever overhang (2 blocks deep)
      for (let z = bz1; z <= bz2; z++) {
        for (let ddx = 1; ddx <= 2; ddx++) {
          if (grid.inBounds(bx2 + ddx, STORY_H, z))
            grid.set(bx2 + ddx, STORY_H, z, 'minecraft:white_concrete');
        }
      }
      // Cantilever underside — dark accent slab to emphasize shadow
      for (let x = bx1; x <= bx2 + 2; x++) {
        if (grid.inBounds(x, STORY_H - 1, bz2 + 2))
          grid.set(x, STORY_H - 1, bz2 + 2, 'minecraft:gray_concrete');
      }
      // Upper floor walls on cantilever extension
      for (let y = STORY_H + 1; y <= 2 * STORY_H - 1; y++) {
        for (let x = bx1; x <= bx2 + 2; x++) {
          if (grid.inBounds(x, y, bz2 + 3))
            grid.set(x, y, bz2 + 3, style.wall);
        }
        // East extended wall
        if (grid.inBounds(bx2 + 2, y, bz2 + 2))
          grid.set(bx2 + 2, y, bz2 + 2, style.wall);
      }
      // Upper floor glass on cantilever front
      for (let x = bx1 + 2; x <= bx2; x++) {
        for (let y = STORY_H + 2; y <= 2 * STORY_H - 2; y++) {
          if (grid.inBounds(x, y, bz2 + 3))
            grid.set(x, y, bz2 + 3, style.window);
        }
      }
    }
    // Rooftop terrace — flat roof with glass railing and planter boxes
    const roofTop = floors * STORY_H;
    // Glass railing around rooftop
    for (let x = bx1; x <= bx2; x++) {
      if (grid.inBounds(x, roofTop + 1, bz1))
        grid.set(x, roofTop + 1, bz1, 'minecraft:glass_pane');
      if (grid.inBounds(x, roofTop + 1, bz2))
        grid.set(x, roofTop + 1, bz2, 'minecraft:glass_pane');
    }
    for (let z = bz1; z <= bz2; z++) {
      if (grid.inBounds(bx1, roofTop + 1, z))
        grid.set(bx1, roofTop + 1, z, 'minecraft:glass_pane');
      if (grid.inBounds(bx2, roofTop + 1, z))
        grid.set(bx2, roofTop + 1, z, 'minecraft:glass_pane');
    }
    // Planter boxes on rooftop corners
    for (const [px, pz] of [[bx1 + 1, bz1 + 1], [bx2 - 1, bz1 + 1],
                              [bx1 + 1, bz2 - 1], [bx2 - 1, bz2 - 1]] as [number, number][]) {
      if (grid.inBounds(px, roofTop + 1, pz))
        grid.set(px, roofTop + 1, pz, 'minecraft:potted_fern');
    }
    // Exterior accent: dark concrete base trim
    for (let x = bx1; x <= bx2; x++) {
      for (const z of [bz1, bz2]) {
        if (grid.inBounds(x, 0, z)) grid.set(x, 0, z, 'minecraft:gray_concrete');
      }
    }
  }

  // ── Medieval manor enhancements: dormers + weathering + heraldic detail ──
  if (style.wall === 'minecraft:stone_bricks') {
    // Weathered exterior walls
    const medievalVariants = [
      'minecraft:mossy_stone_bricks', 'minecraft:cracked_stone_bricks',
    ];
    weatherWalls(grid, bx1, 0, bz1, bx2, floors * STORY_H, bz2, style.wall, medievalVariants, rng, 0.15);
    // ── Dormer windows — break up heavy roofline (south-facing) ──
    const dormerSpacing = Math.max(6, Math.floor(bw / 3));
    for (let ddx = bx1 + dormerSpacing; ddx <= bx2 - dormerSpacing; ddx += dormerSpacing) {
      const dormerBase = roofBase + 2;
      // Dormer walls (3 wide, 3 tall box projecting from roof)
      for (let y = dormerBase; y <= dormerBase + 2; y++) {
        for (let dddx = -1; dddx <= 1; dddx++) {
          if (grid.inBounds(ddx + dddx, y, bz2 + 1))
            grid.set(ddx + dddx, y, bz2 + 1, style.wall);
        }
      }
      // Dormer window
      if (grid.inBounds(ddx, dormerBase + 1, bz2 + 1))
        grid.set(ddx, dormerBase + 1, bz2 + 1, style.window);
      // Dormer roof (mini gable — 3 blocks)
      if (grid.inBounds(ddx - 1, dormerBase + 3, bz2 + 1))
        grid.set(ddx - 1, dormerBase + 3, bz2 + 1, style.roofS);
      if (grid.inBounds(ddx, dormerBase + 3, bz2 + 1))
        grid.set(ddx, dormerBase + 3, bz2 + 1, style.roofS);
      if (grid.inBounds(ddx + 1, dormerBase + 3, bz2 + 1))
        grid.set(ddx + 1, dormerBase + 3, bz2 + 1, style.roofS);
      if (grid.inBounds(ddx, dormerBase + 4, bz2 + 1))
        grid.set(ddx, dormerBase + 4, bz2 + 1, style.roofCap);
    }
    // Flower boxes under front-facing windows
    for (let x = bx1 + 4; x <= bx2 - 4; x += 4) {
      if (grid.inBounds(x, 1, bz2 + 1))
        grid.set(x, 1, bz2 + 1, 'minecraft:potted_red_tulip');
    }
    // Banners on side walls — heraldic identity
    for (let story = 0; story < floors; story++) {
      const banY = story * STORY_H + 3;
      if (grid.inBounds(bx1 - 1, banY, zMid))
        grid.set(bx1 - 1, banY, zMid, 'minecraft:red_wall_banner[facing=west]');
      if (grid.inBounds(bx2 + 1, banY, zMid))
        grid.set(bx2 + 1, banY, zMid, 'minecraft:red_wall_banner[facing=east]');
    }
    // Prominent chimney — taller, with stone brick cap
    const chimBaseY = roofBase + effectiveRoofH - 3;
    const chimX2 = bx1 + 3;
    for (let y = chimBaseY; y <= chimBaseY + 4; y++) {
      if (grid.inBounds(chimX2, y, bz1 + 2))
        grid.set(chimX2, y, bz1 + 2, 'minecraft:stone_bricks');
      if (grid.inBounds(chimX2 + 1, y, bz1 + 2))
        grid.set(chimX2 + 1, y, bz1 + 2, 'minecraft:stone_bricks');
    }
    // Chimney cap
    if (grid.inBounds(chimX2, chimBaseY + 5, bz1 + 2))
      grid.set(chimX2, chimBaseY + 5, bz1 + 2, style.slabBottom);
    if (grid.inBounds(chimX2 + 1, chimBaseY + 5, bz1 + 2))
      grid.set(chimX2 + 1, chimBaseY + 5, bz1 + 2, style.slabBottom);
    // Courtyard well for manor estate feel
    const wellMX = bx1 - 3;
    const wellMZ = zMid;
    if (grid.inBounds(wellMX, 0, wellMZ)) {
      grid.set(wellMX, 0, wellMZ, 'minecraft:cobblestone');
      grid.set(wellMX, 1, wellMZ, 'minecraft:water_cauldron[level=3]');
      for (const [fx, fz] of [[wellMX - 1, wellMZ - 1], [wellMX + 1, wellMZ - 1],
                                [wellMX - 1, wellMZ + 1], [wellMX + 1, wellMZ + 1]] as [number, number][]) {
        if (grid.inBounds(fx, 1, fz)) grid.set(fx, 1, fz, style.fence);
      }
    }
    // Detached stable building — adds compositional complexity
    const stbX = Math.max(0, bx1 - 10);
    const stbZ = bz1 + 2;
    placeOutbuilding(grid, stbX, stbZ, 7, 6, 3, style, 'lean-to');
    // Hay bales inside stable
    if (grid.inBounds(stbX + 1, 1, stbZ + 1))
      grid.set(stbX + 1, 1, stbZ + 1, 'minecraft:hay_block');
    if (grid.inBounds(stbX + 1, 2, stbZ + 1))
      grid.set(stbX + 1, 2, stbZ + 1, 'minecraft:hay_block');
    // Cobblestone courtyard path from stable to manor
    for (let x = stbX + 7; x <= bx1; x++) {
      if (grid.inBounds(x, 0, stbZ + 3))
        grid.set(x, 0, stbZ + 3, 'minecraft:cobblestone');
    }
    // Estate perimeter stone wall (partial — north and west sides)
    const wallXStart = Math.max(0, stbX - 2);
    for (let x = wallXStart; x <= bx2 + 2; x++) {
      if (grid.inBounds(x, 1, Math.max(0, bz1 - 2)))
        grid.set(x, 1, Math.max(0, bz1 - 2), 'minecraft:cobblestone_wall');
    }
    for (let z = Math.max(0, bz1 - 2); z <= bz2 + 2; z++) {
      if (grid.inBounds(wallXStart, 1, z))
        grid.set(wallXStart, 1, z, 'minecraft:cobblestone_wall');
    }
  }

  // ── Rustic cabin enhancements: log construction + wrap-around porch + woodsman vibe ──
  if (style.wall === 'minecraft:spruce_planks') {
    // Full log corner construction — EVERY corner column is stripped log
    for (let y = 1; y <= floors * STORY_H; y++) {
      for (const [lx, lz] of [[bx1, bz1], [bx2, bz1], [bx1, bz2], [bx2, bz2]] as [number, number][]) {
        if (grid.inBounds(lx, y, lz))
          grid.set(lx, y, lz, 'minecraft:stripped_spruce_log');
      }
    }
    // Alternating log layer accents on walls — cabin log construction look
    for (let y = 1; y <= floors * STORY_H; y += 2) {
      for (let x = bx1; x <= bx2; x++) {
        if (grid.inBounds(x, y, bz1) && grid.get(x, y, bz1) === style.wall)
          grid.set(x, y, bz1, 'minecraft:spruce_log[axis=x]');
        if (grid.inBounds(x, y, bz2) && grid.get(x, y, bz2) === style.wall)
          grid.set(x, y, bz2, 'minecraft:spruce_log[axis=x]');
      }
      for (let z = bz1; z <= bz2; z++) {
        if (grid.inBounds(bx1, y, z) && grid.get(bx1, y, z) === style.wall)
          grid.set(bx1, y, z, 'minecraft:spruce_log[axis=z]');
        if (grid.inBounds(bx2, y, z) && grid.get(bx2, y, z) === style.wall)
          grid.set(bx2, y, z, 'minecraft:spruce_log[axis=z]');
      }
    }
    // Wrap-around covered porch on south + east sides
    const porchW = 2;
    // South porch extension
    for (let x = bx1 - 1; x <= bx2 + porchW + 1; x++) {
      if (grid.inBounds(x, 0, bz2 + porchW + 1))
        grid.set(x, 0, bz2 + porchW + 1, style.floorGround);
    }
    // East porch extension
    for (let z = bz1; z <= bz2 + porchW + 1; z++) {
      for (let ddx = 1; ddx <= porchW + 1; ddx++) {
        if (grid.inBounds(bx2 + ddx, 0, z))
          grid.set(bx2 + ddx, 0, z, style.floorGround);
      }
    }
    // Porch support posts (fence + log columns)
    const porchPosts: [number, number][] = [
      [bx1 - 1, bz2 + porchW + 1], [bx2 + porchW + 1, bz2 + porchW + 1],
      [bx2 + porchW + 1, bz1], [bx2 + porchW + 1, zMid],
    ];
    for (const [px, pz] of porchPosts) {
      for (let y = 1; y <= STORY_H - 1; y++) {
        if (grid.inBounds(px, y, pz))
          grid.set(px, y, pz, 'minecraft:stripped_spruce_log');
      }
    }
    // Porch railing (fence between posts)
    for (let x = bx1; x <= bx2 + porchW; x++) {
      if (grid.inBounds(x, 1, bz2 + porchW + 1))
        grid.set(x, 1, bz2 + porchW + 1, style.fence);
    }
    for (let z = bz1 + 1; z <= bz2 + porchW; z++) {
      if (grid.inBounds(bx2 + porchW + 1, 1, z))
        grid.set(bx2 + porchW + 1, 1, z, style.fence);
    }
    // Large woodpile against north wall (2 wide, 3 tall)
    for (let y = 1; y <= 3; y++) {
      for (let dz = 0; dz < 3; dz++) {
        if (grid.inBounds(bx2 + 1, y, bz1 + dz))
          grid.set(bx2 + 1, y, bz1 + dz, 'minecraft:spruce_log[axis=x]');
      }
    }
    // Campfire with seating
    if (grid.inBounds(xMid - 4, 0, bz2 + 4))
      grid.set(xMid - 4, 0, bz2 + 4, 'minecraft:cobblestone');
    if (grid.inBounds(xMid - 4, 1, bz2 + 4))
      grid.set(xMid - 4, 1, bz2 + 4, 'minecraft:campfire[lit=true]');
    // Log benches around campfire
    for (const [sx, sz] of [[xMid - 6, bz2 + 4], [xMid - 4, bz2 + 6]] as [number, number][]) {
      if (grid.inBounds(sx, 1, sz))
        grid.set(sx, 1, sz, 'minecraft:spruce_log[axis=x]');
    }
    // Stone cobble path from porch to campfire
    for (let dz = 1; dz <= 3; dz++) {
      if (grid.inBounds(xMid - 2, 0, bz2 + dz))
        grid.set(xMid - 2, 0, bz2 + dz, 'minecraft:cobblestone');
    }
    // Woodshed / outhouse — separate small structure for compositional variety
    const outX = Math.max(0, bx1 - 7);
    const outZ = bz1;
    placeOutbuilding(grid, outX, outZ, 4, 4, 3, style, 'lean-to');
    // Logs stacked outside woodshed
    for (let y = 1; y <= 2; y++) {
      if (grid.inBounds(outX + 4, y, outZ + 1))
        grid.set(outX + 4, y, outZ + 1, 'minecraft:spruce_log[axis=z]');
      if (grid.inBounds(outX + 4, y, outZ + 2))
        grid.set(outX + 4, y, outZ + 2, 'minecraft:spruce_log[axis=z]');
    }
    // Dirt path from woodshed to cabin
    for (let x = outX + 4; x <= bx1; x++) {
      if (grid.inBounds(x, 0, outZ + 2))
        grid.set(x, 0, outZ + 2, 'minecraft:dirt_path');
    }
    // Fishing dock extending south (waterfront cabin feel)
    const dockZ = bz2 + porchW + 3;
    const dockX = bx2 + 3;
    for (let z = dockZ; z <= dockZ + 6; z++) {
      if (grid.inBounds(dockX, 0, z))
        grid.set(dockX, 0, z, style.floorGround);
      if (grid.inBounds(dockX + 1, 0, z))
        grid.set(dockX + 1, 0, z, style.floorGround);
    }
    // Dock posts
    for (const dz of [dockZ, dockZ + 6]) {
      if (grid.inBounds(dockX, 1, dz))
        grid.set(dockX, 1, dz, style.fence);
      if (grid.inBounds(dockX + 1, 1, dz))
        grid.set(dockX + 1, 1, dz, style.fence);
    }
  }

  // ── Steampunk workshop enhancements: heavy industrial aesthetic ──
  if (style.wall === 'minecraft:iron_block') {
    // Vertical pipe runs on ALL exterior walls — copper + lightning rod stacks
    for (let z = bz1 + 2; z <= bz2 - 2; z += 3) {
      for (let y = 1; y <= floors * STORY_H; y++) {
        if (grid.inBounds(bx1 - 1, y, z))
          grid.set(bx1 - 1, y, z, y % 2 === 0 ? 'minecraft:lightning_rod' : 'minecraft:chain');
        if (grid.inBounds(bx2 + 1, y, z))
          grid.set(bx2 + 1, y, z, y % 2 === 0 ? 'minecraft:lightning_rod' : 'minecraft:chain');
      }
    }
    // Horizontal pipe runs connecting verticals (cross bracing)
    for (let y = 2; y <= floors * STORY_H; y += STORY_H) {
      for (let x = bx1; x <= bx2; x += 2) {
        if (grid.inBounds(x, y, bz1 - 1))
          grid.set(x, y, bz1 - 1, 'minecraft:exposed_copper');
        if (grid.inBounds(x, y, bz2 + 1))
          grid.set(x, y, bz2 + 1, 'minecraft:exposed_copper');
      }
    }
    // Copper accent base band — oxidized copper for aged industrial look
    for (let x = bx1; x <= bx2; x++) {
      if (grid.inBounds(x, 1, bz1)) grid.set(x, 1, bz1, 'minecraft:exposed_copper');
      if (grid.inBounds(x, 1, bz2)) grid.set(x, 1, bz2, 'minecraft:exposed_copper');
    }
    for (let z = bz1; z <= bz2; z++) {
      if (grid.inBounds(bx1, 1, z)) grid.set(bx1, 1, z, 'minecraft:exposed_copper');
      if (grid.inBounds(bx2, 1, z)) grid.set(bx2, 1, z, 'minecraft:exposed_copper');
    }
    // Piston "gear" array on front facade — 3-wide mechanical feature
    for (let ddx = -1; ddx <= 1; ddx++) {
      if (grid.inBounds(bx1 + 3 + ddx, 3, bz2))
        grid.set(bx1 + 3 + ddx, 3, bz2, 'minecraft:piston[facing=south]');
      if (grid.inBounds(bx2 - 3 + ddx, 3, bz2))
        grid.set(bx2 - 3 + ddx, 3, bz2, 'minecraft:sticky_piston[facing=south]');
    }
    // Observer blocks as "gauges" on north wall
    for (let x = bx1 + 3; x <= bx2 - 3; x += 5) {
      if (grid.inBounds(x, 3, bz1))
        grid.set(x, 3, bz1, 'minecraft:observer[facing=north]');
    }
    // Redstone lamps flanking door + above
    if (grid.inBounds(xMid - 2, STORY_H - 1, bz2 + 1))
      grid.set(xMid - 2, STORY_H - 1, bz2 + 1, 'minecraft:redstone_lamp');
    if (grid.inBounds(xMid + 2, STORY_H - 1, bz2 + 1))
      grid.set(xMid + 2, STORY_H - 1, bz2 + 1, 'minecraft:redstone_lamp');
    // DUAL smokestacks — taller, with copper banding
    for (const stackX of [bx1 + 2, bx2 - 2]) {
      const stackBase = floors * STORY_H + 1;
      for (let y = stackBase; y <= stackBase + 5; y++) {
        if (grid.inBounds(stackX, y, bz1 + 2)) {
          const block = y % 3 === 0 ? 'minecraft:exposed_copper' : 'minecraft:iron_block';
          grid.set(stackX, y, bz1 + 2, block);
        }
      }
      if (grid.inBounds(stackX, stackBase + 6, bz1 + 2))
        grid.set(stackX, stackBase + 6, bz1 + 2, 'minecraft:campfire[lit=true]');
    }
    // Copper roof trim — replace roof edge blocks with oxidized copper
    const roofY = floors * STORY_H;
    for (let x = bx1; x <= bx2; x++) {
      if (grid.inBounds(x, roofY + 1, bz1)) grid.set(x, roofY + 1, bz1, 'minecraft:oxidized_copper');
      if (grid.inBounds(x, roofY + 1, bz2)) grid.set(x, roofY + 1, bz2, 'minecraft:oxidized_copper');
    }
    // Exterior workbench + anvil — workshop identity
    if (grid.inBounds(bx2 + 2, 1, zMid))
      grid.set(bx2 + 2, 1, zMid, 'minecraft:smithing_table');
    if (grid.inBounds(bx2 + 2, 1, zMid + 1))
      grid.set(bx2 + 2, 1, zMid + 1, 'minecraft:anvil[facing=north]');
    if (grid.inBounds(bx2 + 2, 1, zMid - 1))
      grid.set(bx2 + 2, 1, zMid - 1, 'minecraft:blast_furnace[facing=west]');
    // ── LARGE external boiler tower — the dominant visual element for steampunk ──
    // Separate cylindrical structure west of workshop, connected by pipe bridge
    const btX = Math.max(2, bx1 - 9);
    const btZ = zMid;
    const btR = 3;
    const btH = floors * STORY_H + 8; // Taller than main workshop
    // Cylindrical tower
    for (let y = 0; y <= btH; y++) {
      for (let ddx = -btR; ddx <= btR; ddx++) {
        for (let dz = -btR; dz <= btR; dz++) {
          if (Math.sqrt(ddx * ddx + dz * dz) <= btR + 0.5) {
            const tx = btX + ddx;
            const tz = btZ + dz;
            if (!grid.inBounds(tx, y, tz)) continue;
            if (y === 0) {
              grid.set(tx, y, tz, 'minecraft:iron_block');
            } else if (Math.sqrt(ddx * ddx + dz * dz) >= btR - 0.5) {
              // Alternating copper + iron bands
              grid.set(tx, y, tz, y % 4 === 0 ? 'minecraft:exposed_copper' : 'minecraft:iron_block');
            }
          }
        }
      }
    }
    // Massive smokestack on top of boiler tower
    for (let y = btH + 1; y <= btH + 5; y++) {
      if (grid.inBounds(btX, y, btZ))
        grid.set(btX, y, btZ, 'minecraft:iron_block');
      if (grid.inBounds(btX + 1, y, btZ))
        grid.set(btX + 1, y, btZ, 'minecraft:iron_block');
    }
    if (grid.inBounds(btX, btH + 6, btZ))
      grid.set(btX, btH + 6, btZ, 'minecraft:campfire[lit=true]');
    // Pipe bridge connecting boiler tower to workshop
    const bridgeY = Math.floor(floors * STORY_H * 0.6);
    for (let x = btX + btR + 1; x <= bx1; x++) {
      if (grid.inBounds(x, bridgeY, btZ))
        grid.set(x, bridgeY, btZ, 'minecraft:exposed_copper');
      if (grid.inBounds(x, bridgeY + 1, btZ))
        grid.set(x, bridgeY + 1, btZ, 'minecraft:chain');
    }
    // Crane arm extending from workshop roof
    const craneBase = floors * STORY_H + 2;
    const craneX = bx2;
    for (let y = craneBase; y <= craneBase + 4; y++) {
      if (grid.inBounds(craneX, y, bz2))
        grid.set(craneX, y, bz2, 'minecraft:iron_block');
    }
    // Horizontal crane arm
    for (let z = bz2; z <= bz2 + 5; z++) {
      if (grid.inBounds(craneX, craneBase + 4, z))
        grid.set(craneX, craneBase + 4, z, 'minecraft:iron_block');
    }
    // Crane cable + hook
    for (let y = craneBase; y <= craneBase + 3; y++) {
      if (grid.inBounds(craneX, y, bz2 + 5))
        grid.set(craneX, y, bz2 + 5, 'minecraft:chain');
    }
    // Rail track/conveyor alongside workshop (east side)
    for (let z = bz1; z <= bz2 + 3; z++) {
      if (grid.inBounds(bx2 + 3, 0, z))
        grid.set(bx2 + 3, 0, z, 'minecraft:rail');
    }
  }

  return grid;
}
