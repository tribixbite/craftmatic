/**
 * Style decorator registry — extracted from generateHouse() to decouple
 * style-specific decorations from core house generation.
 *
 * Each decorator is a function that adds compositional detail (outbuildings,
 * wall treatments, turrets, landscaping) to an already-generated house grid.
 * Decorators are keyed by name and associated with styles via a registry map.
 *
 * This enables:
 * - Mixing decorators across styles (e.g. gothic turret on a fantasy house)
 * - Adding new decorators without touching gen-house.ts
 * - User-selected decorator overrides via generation options
 */

import { BlockGrid } from '../schem/types.js';
import type { RoofShape } from '../types/index.js';
import type { StylePalette } from './styles.js';
import {
  weatherWalls, accentBand, glassCurtainWall,
} from './structures.js';
import { STORY_H, pick, placeOutbuilding } from './gen-utils.js';

// ─── Decorator Context ──────────────────────────────────────────────────────

/** All state a decorator needs to place blocks on the grid */
export interface DecoratorContext {
  grid: BlockGrid;
  style: StylePalette;
  rng: () => number;
  /** Number of stories */
  floors: number;
  /** Active roof shape */
  roofShape: RoofShape;
  /** Effective (clamped) roof height in blocks */
  effectiveRoofH: number;
  /** Building bounding box — min X */
  bx1: number;
  /** Building bounding box — max X */
  bx2: number;
  /** Building bounding box — min Z */
  bz1: number;
  /** Building bounding box — max Z */
  bz2: number;
  /** Building width in blocks */
  bw: number;
  /** Building length in blocks */
  bl: number;
  /** Building X midpoint */
  xMid: number;
  /** Building Z midpoint */
  zMid: number;
  /** Y coordinate where the roof starts */
  roofBase: number;
  /** Porch depth in front of building */
  porchDepth: number;
}

/** Decorator function signature */
export type DecoratorFn = (ctx: DecoratorContext) => void;

// ─── Decorator Implementations ──────────────────────────────────────────────

/** Fantasy cottage: garden shed + fenced flower garden + ivy walls */
function fantasyCottage(ctx: DecoratorContext): void {
  const { grid, style, rng, floors, bx1, bz1, bz2, zMid } = ctx;

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

/** Victorian turret + bay windows — for large fantasy/gothic houses */
function victorianTurret(ctx: DecoratorContext): void {
  const { grid, style, floors, bx2, bz1, bw } = ctx;

  // Only apply for large buildings (3+ floors, bw >= 15)
  if (floors < 3 || bw < 15) return;

  // Corner turret on NE corner — signature Queen Anne element
  const turretR = 3;
  const turretCX = bx2 + 1;
  const turretCZ = bz1 - 1;
  const turretH = floors * STORY_H + 3; // Rises above main roofline
  for (let y = 0; y <= turretH; y++) {
    for (let ddx = -turretR; ddx <= turretR; ddx++) {
      for (let dz = -turretR; dz <= turretR; dz++) {
        const dist = Math.sqrt(ddx * ddx + dz * dz);
        if (dist > turretR + 0.5) continue;
        const tx = turretCX + ddx;
        const tz = turretCZ + dz;
        if (!grid.inBounds(tx, y, tz)) continue;
        if (y === 0) {
          grid.set(tx, y, tz, style.foundation);
        } else if (dist >= turretR - 0.5) {
          // Shell wall — windows every other story at cardinal points
          const isWindowY = (y % STORY_H === 2 || y % STORY_H === 3);
          const isCardinal = (ddx === 0 || dz === 0) && Math.abs(ddx) + Math.abs(dz) === turretR;
          grid.set(tx, y, tz, isWindowY && isCardinal ? style.window : style.wall);
        }
      }
    }
  }
  // Conical turret roof (cone shape)
  for (let layer = 0; layer <= turretR + 2; layer++) {
    const coneY = turretH + 1 + layer;
    const coneR = turretR + 1 - layer * 0.7;
    if (coneR < 0) break;
    for (let ddx = -Math.ceil(coneR); ddx <= Math.ceil(coneR); ddx++) {
      for (let dz = -Math.ceil(coneR); dz <= Math.ceil(coneR); dz++) {
        if (Math.sqrt(ddx * ddx + dz * dz) <= coneR + 0.3) {
          const tx = turretCX + ddx;
          const tz = turretCZ + dz;
          if (grid.inBounds(tx, coneY, tz))
            grid.set(tx, coneY, tz, style.roofCap);
        }
      }
    }
  }
}

/** Bay windows — front facade protrusions, 3 wide x 2 deep */
function bayWindows(ctx: DecoratorContext): void {
  const { grid, style, floors, bx1, bx2, bz2 } = ctx;

  const bayPositions = [bx1 + 3, bx2 - 3].filter(x => x > bx1 + 2 && x < bx2 - 2);
  for (const bayX of bayPositions) {
    for (let story = 0; story < Math.min(floors, 2); story++) {
      const by = story * STORY_H;
      // Bay floor
      for (let ddx = -1; ddx <= 1; ddx++) {
        if (grid.inBounds(bayX + ddx, by, bz2 + 1))
          grid.set(bayX + ddx, by, bz2 + 1, style.floorGround);
        if (grid.inBounds(bayX + ddx, by, bz2 + 2))
          grid.set(bayX + ddx, by, bz2 + 2, style.floorGround);
      }
      // Bay walls + windows
      for (let y = by + 1; y <= by + STORY_H - 1; y++) {
        if (grid.inBounds(bayX - 1, y, bz2 + 1))
          grid.set(bayX - 1, y, bz2 + 1, style.wall);
        if (grid.inBounds(bayX + 1, y, bz2 + 1))
          grid.set(bayX + 1, y, bz2 + 1, style.wall);
        if (grid.inBounds(bayX - 1, y, bz2 + 2))
          grid.set(bayX - 1, y, bz2 + 2, style.wall);
        if (grid.inBounds(bayX + 1, y, bz2 + 2))
          grid.set(bayX + 1, y, bz2 + 2, style.wall);
        // Front window wall
        if (grid.inBounds(bayX, y, bz2 + 2)) {
          const isWin = (y === by + 2 || y === by + 3);
          grid.set(bayX, y, bz2 + 2, isWin ? style.window : style.wall);
        }
      }
      // Bay roof slab
      for (let ddx = -1; ddx <= 1; ddx++) {
        if (grid.inBounds(bayX + ddx, by + STORY_H, bz2 + 1))
          grid.set(bayX + ddx, by + STORY_H, bz2 + 1, style.roofCap);
        if (grid.inBounds(bayX + ddx, by + STORY_H, bz2 + 2))
          grid.set(bayX + ddx, by + STORY_H, bz2 + 2, style.roofCap);
      }
    }
  }
}

/** Modern carport: minimalist flat-roof carport + stepping stone path */
function modernCarport(ctx: DecoratorContext): void {
  const { grid, bx1, bx2, bz1, bz2, porchDepth } = ctx;

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

/** Modern facade: cantilever + glass curtain wall + rooftop terrace */
function modernFacade(ctx: DecoratorContext): void {
  const { grid, style, floors, bx1, bx2, bz1, bz2 } = ctx;

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
  // Upper floor cantilever — extends beyond ground floor on south + east
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

/** Medieval manor: weathering + dormers + heraldic banners + stable + well */
function medievalManor(ctx: DecoratorContext): void {
  const { grid, style, rng, floors, bx1, bx2, bz1, bz2, bw, zMid, roofBase, effectiveRoofH } = ctx;

  // Weathered exterior walls
  const medievalVariants = [
    'minecraft:mossy_stone_bricks', 'minecraft:cracked_stone_bricks',
  ];
  weatherWalls(grid, bx1, 0, bz1, bx2, floors * STORY_H, bz2, style.wall, medievalVariants, rng, 0.15);
  // Dormer windows — break up heavy roofline (south-facing)
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
  const chimX = bx1 + 3;
  for (let y = chimBaseY; y <= chimBaseY + 4; y++) {
    if (grid.inBounds(chimX, y, bz1 + 2))
      grid.set(chimX, y, bz1 + 2, 'minecraft:stone_bricks');
    if (grid.inBounds(chimX + 1, y, bz1 + 2))
      grid.set(chimX + 1, y, bz1 + 2, 'minecraft:stone_bricks');
  }
  // Chimney cap
  if (grid.inBounds(chimX, chimBaseY + 5, bz1 + 2))
    grid.set(chimX, chimBaseY + 5, bz1 + 2, style.slabBottom);
  if (grid.inBounds(chimX + 1, chimBaseY + 5, bz1 + 2))
    grid.set(chimX + 1, chimBaseY + 5, bz1 + 2, style.slabBottom);
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

/** Rustic cabin: log corners + wrap-around porch + campfire + woodshed + fishing dock */
function rusticCabin(ctx: DecoratorContext): void {
  const { grid, style, floors, bx1, bx2, bz1, bz2, xMid, zMid } = ctx;

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
  // Wrap-around porch — extends south and east
  const porchW = 2;
  // Porch floor
  for (let x = bx1 - 1; x <= bx2 + porchW + 1; x++) {
    if (grid.inBounds(x, 0, bz2 + porchW + 1))
      grid.set(x, 0, bz2 + porchW + 1, style.floorGround);
  }
  for (let z = bz1; z <= bz2 + porchW + 1; z++) {
    for (let ddx = 1; ddx <= porchW + 1; ddx++) {
      if (grid.inBounds(bx2 + ddx, 0, z))
        grid.set(bx2 + ddx, 0, z, style.floorGround);
    }
  }
  // Porch posts at corners
  for (const [px, pz] of [
    [bx1 - 1, bz2 + porchW + 1], [bx2 + porchW + 1, bz2 + porchW + 1],
    [bx2 + porchW + 1, bz1], [bx2 + porchW + 1, zMid],
  ] as [number, number][]) {
    for (let y = 1; y <= 3; y++) {
      if (grid.inBounds(px, y, pz))
        grid.set(px, y, pz, style.pillar);
    }
  }
  // Porch railing
  for (let x = bx1; x <= bx2 + porchW; x++) {
    if (grid.inBounds(x, 1, bz2 + porchW + 1))
      grid.set(x, 1, bz2 + porchW + 1, style.fence);
  }
  for (let z = bz1 + 1; z <= bz2 + porchW; z++) {
    if (grid.inBounds(bx2 + porchW + 1, 1, z))
      grid.set(bx2 + porchW + 1, 1, z, style.fence);
  }
  // Log cross-beams at porch corners
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

/** Colonial shutters + brick chimney + pediment + flower boxes + walkway */
function colonialFacade(ctx: DecoratorContext): void {
  const { grid, style, rng, floors, bx1, bx2, bz1, bz2, xMid, roofBase, effectiveRoofH, porchDepth } = ctx;

  // Dark "shutters" flanking every window — spruce trapdoors on both sides
  for (let story = 0; story < floors; story++) {
    const by = story * STORY_H;
    const winY1 = by + 2;
    const winY2 = by + 3;
    // South (front) wall shutters
    for (let x = bx1 + 2; x <= bx2 - 2; x++) {
      if (grid.inBounds(x, winY1, bz2) && grid.get(x, winY1, bz2) === style.window) {
        // Left shutter
        if (grid.inBounds(x - 1, winY1, bz2 + 1))
          grid.set(x - 1, winY1, bz2 + 1, 'minecraft:spruce_trapdoor[facing=east,open=true]');
        if (grid.inBounds(x - 1, winY2, bz2 + 1))
          grid.set(x - 1, winY2, bz2 + 1, 'minecraft:spruce_trapdoor[facing=east,open=true]');
        // Right shutter
        if (grid.inBounds(x + 1, winY1, bz2 + 1))
          grid.set(x + 1, winY1, bz2 + 1, 'minecraft:spruce_trapdoor[facing=west,open=true]');
        if (grid.inBounds(x + 1, winY2, bz2 + 1))
          grid.set(x + 1, winY2, bz2 + 1, 'minecraft:spruce_trapdoor[facing=west,open=true]');
      }
    }
    // North (back) wall shutters
    for (let x = bx1 + 2; x <= bx2 - 2; x++) {
      if (grid.inBounds(x, winY1, bz1) && grid.get(x, winY1, bz1) === style.window) {
        if (grid.inBounds(x - 1, winY1, bz1 - 1))
          grid.set(x - 1, winY1, bz1 - 1, 'minecraft:spruce_trapdoor[facing=east,open=true]');
        if (grid.inBounds(x - 1, winY2, bz1 - 1))
          grid.set(x - 1, winY2, bz1 - 1, 'minecraft:spruce_trapdoor[facing=east,open=true]');
        if (grid.inBounds(x + 1, winY1, bz1 - 1))
          grid.set(x + 1, winY1, bz1 - 1, 'minecraft:spruce_trapdoor[facing=west,open=true]');
        if (grid.inBounds(x + 1, winY2, bz1 - 1))
          grid.set(x + 1, winY2, bz1 - 1, 'minecraft:spruce_trapdoor[facing=west,open=true]');
      }
    }
  }
  // Brick chimney accent — taller chimney with brick cap (colonial staple)
  const colChimX = bx1 + 2;
  const colChimTop = roofBase + effectiveRoofH;
  for (let y = 1; y <= colChimTop + 2; y++) {
    if (grid.inBounds(colChimX, y, bz1 + 1))
      grid.set(colChimX, y, bz1 + 1, 'minecraft:bricks');
  }
  if (grid.inBounds(colChimX, colChimTop + 3, bz1 + 1))
    grid.set(colChimX, colChimTop + 3, bz1 + 1, 'minecraft:stone_brick_slab[type=bottom]');
  // Pediment over front door — triangular decorative header
  if (grid.inBounds(xMid, STORY_H, bz2 + 1)) {
    grid.set(xMid - 1, STORY_H - 1, bz2 + 1, style.roofS);
    grid.set(xMid, STORY_H - 1, bz2 + 1, style.roofCap);
    grid.set(xMid + 1, STORY_H - 1, bz2 + 1, style.roofS);
  }
  // Flower boxes under front windows — colonial curb appeal
  for (let x = bx1 + 3; x <= bx2 - 3; x += 3) {
    if (grid.inBounds(x, 1, bz2 + 1))
      grid.set(x, 1, bz2 + 1, pick(['minecraft:potted_lily_of_the_valley', 'minecraft:potted_blue_orchid', 'minecraft:potted_dandelion'], rng));
  }
  // Brick walkway from front door
  for (let z = bz2 + porchDepth + 1; z <= bz2 + porchDepth + 5; z++) {
    if (grid.inBounds(xMid, 0, z))
      grid.set(xMid, 0, z, 'minecraft:bricks');
  }
}

/** Gothic/Victorian: turret + bay windows + iron fence + weathering */
function gothicVictorian(ctx: DecoratorContext): void {
  const { grid, style, rng, floors, bx1, bx2, bz1, bz2, porchDepth } = ctx;

  // Corner turret — circular tower on NE corner, signature Queen Anne element
  const turretR = 3;
  const turretCX = bx2 + 1;
  const turretCZ = bz1 - 1;
  const turretH = floors * STORY_H + 3; // Rises above main roofline
  for (let y = 0; y <= turretH; y++) {
    for (let ddx = -turretR; ddx <= turretR; ddx++) {
      for (let dz = -turretR; dz <= turretR; dz++) {
        const dist = Math.sqrt(ddx * ddx + dz * dz);
        if (dist > turretR + 0.5) continue;
        const tx = turretCX + ddx;
        const tz = turretCZ + dz;
        if (!grid.inBounds(tx, y, tz)) continue;
        if (y === 0) {
          grid.set(tx, y, tz, style.foundation);
        } else if (dist >= turretR - 0.5) {
          // Shell wall — windows every other story at cardinal points
          const isWindowY = (y % STORY_H === 2 || y % STORY_H === 3);
          const isCardinal = (ddx === 0 || dz === 0) && Math.abs(ddx) + Math.abs(dz) === turretR;
          grid.set(tx, y, tz, isWindowY && isCardinal ? style.window : style.wall);
        }
      }
    }
  }
  // Conical turret roof (cone shape)
  for (let layer = 0; layer <= turretR + 2; layer++) {
    const coneY = turretH + 1 + layer;
    const coneR = turretR + 1 - layer * 0.7;
    if (coneR < 0) break;
    for (let ddx = -Math.ceil(coneR); ddx <= Math.ceil(coneR); ddx++) {
      for (let dz = -Math.ceil(coneR); dz <= Math.ceil(coneR); dz++) {
        if (Math.sqrt(ddx * ddx + dz * dz) <= coneR + 0.3) {
          const tx = turretCX + ddx;
          const tz = turretCZ + dz;
          if (grid.inBounds(tx, coneY, tz))
            grid.set(tx, coneY, tz, style.roofCap);
        }
      }
    }
  }

  // Bay windows — front facade protrusions, 3 wide x 2 deep
  const bayPositions = [bx1 + 3, bx2 - 3].filter(x => x > bx1 + 2 && x < bx2 - 2);
  for (const bayX of bayPositions) {
    for (let story = 0; story < Math.min(floors, 2); story++) {
      const by = story * STORY_H;
      // Bay floor
      for (let ddx = -1; ddx <= 1; ddx++) {
        if (grid.inBounds(bayX + ddx, by, bz2 + 1))
          grid.set(bayX + ddx, by, bz2 + 1, style.floorGround);
        if (grid.inBounds(bayX + ddx, by, bz2 + 2))
          grid.set(bayX + ddx, by, bz2 + 2, style.floorGround);
      }
      // Bay walls + windows
      for (let y = by + 1; y <= by + STORY_H - 1; y++) {
        if (grid.inBounds(bayX - 1, y, bz2 + 1))
          grid.set(bayX - 1, y, bz2 + 1, style.wall);
        if (grid.inBounds(bayX + 1, y, bz2 + 1))
          grid.set(bayX + 1, y, bz2 + 1, style.wall);
        if (grid.inBounds(bayX - 1, y, bz2 + 2))
          grid.set(bayX - 1, y, bz2 + 2, style.wall);
        if (grid.inBounds(bayX + 1, y, bz2 + 2))
          grid.set(bayX + 1, y, bz2 + 2, style.wall);
        // Front window wall
        if (grid.inBounds(bayX, y, bz2 + 2)) {
          const isWin = (y === by + 2 || y === by + 3);
          grid.set(bayX, y, bz2 + 2, isWin ? style.window : style.wall);
        }
      }
      // Bay roof slab
      for (let ddx = -1; ddx <= 1; ddx++) {
        if (grid.inBounds(bayX + ddx, by + STORY_H, bz2 + 1))
          grid.set(bayX + ddx, by + STORY_H, bz2 + 1, style.roofCap);
        if (grid.inBounds(bayX + ddx, by + STORY_H, bz2 + 2))
          grid.set(bayX + ddx, by + STORY_H, bz2 + 2, style.roofCap);
      }
    }
  }

  // Ornamental iron fence around property
  for (let x = Math.max(0, bx1 - 2); x <= bx2 + 2; x++) {
    const fz = bz2 + porchDepth + 2;
    if (grid.inBounds(x, 1, fz))
      grid.set(x, 1, fz, 'minecraft:iron_bars');
  }
  // Weathered wall detail (cracked/mossy variants)
  const gothicVariants = ['minecraft:cracked_deepslate_bricks', 'minecraft:deepslate_tiles'];
  weatherWalls(grid, bx1, 0, bz1, bx2, floors * STORY_H, bz2, style.wall, gothicVariants, rng, 0.1);
}

/** Gabled roof dormers — break up long rooflines for non-medieval styles */
function roofDormers(ctx: DecoratorContext): void {
  const { grid, style, roofShape, bx1, bx2, bz2, bw, roofBase } = ctx;

  // Only for gable/gambrel roofs on wide buildings, excluding medieval (has its own dormers)
  if ((roofShape !== 'gable' && roofShape !== 'gambrel') || bw < 14) return;
  if (style.wall === 'minecraft:stone_bricks') return; // Medieval has its own

  const dormerSpacing = Math.max(6, Math.floor(bw / 3));
  for (let ddx = bx1 + dormerSpacing; ddx <= bx2 - dormerSpacing; ddx += dormerSpacing) {
    const dormerBase = roofBase + 2;
    // Dormer walls (3 wide, 3 tall projecting from south roof slope)
    for (let y = dormerBase; y <= dormerBase + 2; y++) {
      for (let dddx = -1; dddx <= 1; dddx++) {
        if (grid.inBounds(ddx + dddx, y, bz2 + 1))
          grid.set(ddx + dddx, y, bz2 + 1, style.wall);
      }
    }
    // Dormer window
    if (grid.inBounds(ddx, dormerBase + 1, bz2 + 1))
      grid.set(ddx, dormerBase + 1, bz2 + 1, style.window);
    // Dormer mini-gable cap
    if (grid.inBounds(ddx - 1, dormerBase + 3, bz2 + 1))
      grid.set(ddx - 1, dormerBase + 3, bz2 + 1, style.roofS);
    if (grid.inBounds(ddx, dormerBase + 3, bz2 + 1))
      grid.set(ddx, dormerBase + 3, bz2 + 1, style.roofS);
    if (grid.inBounds(ddx + 1, dormerBase + 3, bz2 + 1))
      grid.set(ddx + 1, dormerBase + 3, bz2 + 1, style.roofS);
    if (grid.inBounds(ddx, dormerBase + 4, bz2 + 1))
      grid.set(ddx, dormerBase + 4, bz2 + 1, style.roofCap);
  }
}

/** Steampunk workshop: pipes + gears + smokestacks + boiler tower + crane + rail */
function steampunkWorkshop(ctx: DecoratorContext): void {
  const { grid, floors, bx1, bx2, bz1, bz2, xMid, zMid } = ctx;

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
  // Large external boiler tower — dominant visual element for steampunk
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

// ─── Decorator Registry ─────────────────────────────────────────────────────

/** All available decorators by name */
export const DECORATORS: Record<string, DecoratorFn> = {
  'fantasy-cottage':      fantasyCottage,
  'victorian-turret':     victorianTurret,
  'bay-windows':          bayWindows,
  'modern-carport':       modernCarport,
  'modern-facade':        modernFacade,
  'medieval-manor':       medievalManor,
  'rustic-cabin':         rusticCabin,
  'colonial-facade':      colonialFacade,
  'gothic-victorian':     gothicVictorian,
  'roof-dormers':         roofDormers,
  'steampunk-workshop':   steampunkWorkshop,
};

/** Default decorator names for each style — applied when no explicit list is provided */
export const DEFAULT_STYLE_DECORATORS: Record<string, string[]> = {
  fantasy:    ['fantasy-cottage', 'victorian-turret'],
  modern:     ['modern-carport', 'modern-facade'],
  medieval:   ['medieval-manor'],
  rustic:     ['rustic-cabin'],
  colonial:   ['colonial-facade'],
  gothic:     ['gothic-victorian'],
  steampunk:  ['steampunk-workshop'],
  // Styles without dedicated decorators get universal ones
  elven:      ['roof-dormers'],
  desert:     ['roof-dormers'],
  underwater: [],
};

/**
 * Apply decorators to a house grid.
 *
 * @param decoratorNames - Explicit list of decorator names, or undefined to use style defaults.
 *   Pass an empty array to skip all decorators.
 * @param ctx - The decorator context with grid, style, building geometry
 */
export function applyDecorators(
  decoratorNames: string[] | undefined,
  ctx: DecoratorContext,
): void {
  // Resolve which decorators to apply
  // TODO: Allow user-specified decorator overrides via generation options
  const names = decoratorNames
    ?? DEFAULT_STYLE_DECORATORS[getStyleKey(ctx.style)]
    ?? [];

  // Always apply roof dormers as a universal decorator (unless explicitly excluded)
  const effectiveNames = [...names];
  if (!effectiveNames.includes('roof-dormers')
    && decoratorNames === undefined // Only auto-add for default lists
    && !['modern', 'medieval', 'underwater'].includes(getStyleKey(ctx.style))) {
    effectiveNames.push('roof-dormers');
  }

  for (const name of effectiveNames) {
    const fn = DECORATORS[name];
    if (fn) {
      fn(ctx);
    } else {
      console.warn(`Unknown decorator: "${name}" — skipping`);
    }
  }
}

/**
 * Reverse-lookup style key from a StylePalette instance.
 * Uses the wall material as a discriminator (each style has a unique wall block).
 */
function getStyleKey(style: StylePalette): string {
  // Map wall material → style name for reverse lookup
  const wallMap: Record<string, string> = {
    'minecraft:stone_bricks':       'medieval',
    'minecraft:spruce_planks':      'rustic',
    'minecraft:iron_block':         'steampunk',
    'minecraft:deepslate_bricks':   'gothic',
    'minecraft:sandstone':          'desert',
    'minecraft:moss_block':         'elven',
    'minecraft:prismarine_bricks':  'underwater',
    'minecraft:smooth_quartz':      'colonial',
  };
  const byWall = wallMap[style.wall];
  if (byWall) return byWall;

  // Fantasy and modern both use white_concrete — disambiguate by wallAccent
  if (style.wall === 'minecraft:white_concrete') {
    if (style.wallAccent === 'minecraft:light_gray_concrete') return 'modern';
    return 'fantasy';
  }

  return 'fantasy'; // Fallback
}
