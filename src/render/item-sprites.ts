/**
 * 16x16 RGBA pixel sprites for top-down item rendering in floor plans.
 * Each sprite is hand-crafted pixel art representing the block as viewed
 * from directly above.
 */

/** Sprite pixel data: 16x16 RGBA (1024 bytes) */
type SpriteData = Uint8Array;

const SPRITE_SIZE = 16;
const cache = new Map<string, SpriteData | null>();

/** Fill a rectangular region in sprite data */
function sFill(d: Uint8Array, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a = 255): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx, py = y + dy;
      if (px < 0 || px >= SPRITE_SIZE || py < 0 || py >= SPRITE_SIZE) continue;
      const idx = (py * SPRITE_SIZE + px) * 4;
      d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = a;
    }
  }
}

/** Set a single pixel in sprite data */
function sPx(d: Uint8Array, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || x >= SPRITE_SIZE || y < 0 || y >= SPRITE_SIZE) return;
  const idx = (y * SPRITE_SIZE + x) * 4;
  d[idx] = r; d[idx + 1] = g; d[idx + 2] = b; d[idx + 3] = a;
}

/** Fill a circle in sprite data */
function sCircle(d: Uint8Array, cx: number, cy: number, radius: number, r: number, g: number, b: number): void {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        sPx(d, cx + dx, cy + dy, r, g, b);
      }
    }
  }
}

function makeFlowerPot(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Brown pot base (trapezoid from above — circle)
  sCircle(d, 7, 10, 3, 130, 75, 40);
  sCircle(d, 7, 10, 2, 150, 88, 48);
  // Pot rim
  sCircle(d, 7, 9, 3, 140, 82, 44);
  // Green plant above
  sCircle(d, 7, 5, 3, 55, 140, 40);
  sCircle(d, 7, 4, 2, 70, 160, 50);
  // Stem
  sFill(d, 7, 7, 1, 3, 45, 100, 30);
  return d;
}

function makeBed(color: [number, number, number]): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  const [cr, cg, cb] = color;
  // Bed frame (dark wood border)
  sFill(d, 2, 1, 12, 14, 90, 60, 30);
  // Blanket body (colored)
  sFill(d, 3, 4, 10, 10, cr, cg, cb);
  // Pillow (lighter, at top)
  sFill(d, 4, 2, 8, 3, 230, 230, 225);
  sFill(d, 5, 2, 6, 2, 240, 240, 235);
  // Blanket fold line
  sFill(d, 3, 8, 10, 1, Math.max(0, cr - 30), Math.max(0, cg - 30), Math.max(0, cb - 30));
  return d;
}

function makeChair(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Seat (viewed from above — square)
  sFill(d, 3, 5, 10, 8, 140, 100, 55);
  sFill(d, 4, 6, 8, 6, 160, 115, 65);
  // Back rest (visible at top)
  sFill(d, 3, 2, 10, 4, 120, 85, 45);
  sFill(d, 4, 3, 8, 2, 130, 92, 50);
  return d;
}

function makeTable(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Round table top
  sCircle(d, 7, 7, 6, 155, 120, 70);
  sCircle(d, 7, 7, 5, 170, 135, 80);
  // Center post visible
  sCircle(d, 7, 7, 1, 130, 95, 55);
  return d;
}

function makeLantern(warm: boolean): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  if (warm) {
    // Warm glow aura
    sCircle(d, 7, 7, 6, 60, 40, 10);
    sCircle(d, 7, 7, 4, 100, 70, 15);
    // Lantern body
    sCircle(d, 7, 7, 2, 255, 200, 70);
    sCircle(d, 7, 7, 1, 255, 230, 120);
    // Chain pixel
    sPx(d, 7, 3, 120, 120, 130);
  } else {
    // Cool soul glow
    sCircle(d, 7, 7, 6, 15, 40, 50);
    sCircle(d, 7, 7, 4, 25, 70, 85);
    sCircle(d, 7, 7, 2, 80, 200, 220);
    sCircle(d, 7, 7, 1, 120, 225, 240);
    sPx(d, 7, 3, 120, 120, 130);
  }
  return d;
}

function makeChest(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Wood body
  sFill(d, 2, 3, 12, 10, 140, 105, 42);
  sFill(d, 3, 4, 10, 8, 155, 118, 48);
  // Gold band
  sFill(d, 2, 7, 12, 2, 200, 170, 50);
  // Clasp
  sFill(d, 6, 6, 4, 2, 220, 190, 55);
  sPx(d, 7, 5, 240, 210, 65);
  sPx(d, 8, 5, 240, 210, 65);
  return d;
}

function makeCauldron(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Outer rim (circle)
  sCircle(d, 7, 7, 6, 62, 62, 62);
  // Inner circle (water)
  sCircle(d, 7, 7, 4, 50, 85, 190);
  sCircle(d, 7, 7, 3, 55, 95, 210);
  return d;
}

function makeArmorStand(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Cross/T shape from above (gray)
  sFill(d, 3, 6, 10, 2, 160, 130, 95);  // horizontal bar
  sFill(d, 7, 3, 2, 10, 160, 130, 95);  // vertical bar
  // Base platform
  sFill(d, 5, 12, 6, 2, 136, 136, 132);
  return d;
}

function makeBookshelf(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Wood frame
  sFill(d, 1, 1, 14, 14, 162, 130, 78);
  // Book spines (colored vertical stripes)
  const bookColors: [number, number, number][] = [
    [170, 42, 36], [53, 57, 168], [84, 109, 28], [130, 48, 180],
    [114, 72, 40], [170, 42, 36], [24, 142, 150],
  ];
  for (let i = 0; i < 7; i++) {
    const [br, bg, bb] = bookColors[i];
    sFill(d, 2 + i * 2, 2, 1, 12, br, bg, bb);
    sFill(d, 3 + i * 2, 2, 1, 12, Math.max(0, br - 20), Math.max(0, bg - 20), Math.max(0, bb - 20));
  }
  return d;
}

function makeBrewingStand(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Base (3 bottles in triangle from above)
  sCircle(d, 4, 10, 2, 125, 115, 92);
  sCircle(d, 10, 10, 2, 125, 115, 92);
  sCircle(d, 7, 5, 2, 125, 115, 92);
  // Center rod
  sPx(d, 7, 7, 180, 160, 110);
  sPx(d, 7, 8, 180, 160, 110);
  return d;
}

function makeEnchantingTable(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Diamond shape (obsidian base)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = Math.abs(x - 7), dy = Math.abs(y - 7);
      if (dx + dy <= 6) {
        sPx(d, x, y, 45, 20, 55);
      }
    }
  }
  // Book on top (open)
  sFill(d, 4, 5, 8, 5, 140, 90, 55);
  sFill(d, 5, 6, 6, 3, 200, 190, 160);
  // Sparkle
  sPx(d, 3, 3, 180, 120, 255);
  sPx(d, 11, 4, 160, 100, 240);
  sPx(d, 10, 11, 170, 110, 250);
  return d;
}

function makeBell(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Bell dome from above (gold circle)
  sCircle(d, 7, 7, 5, 210, 190, 55);
  sCircle(d, 7, 7, 4, 220, 200, 60);
  sCircle(d, 7, 7, 2, 240, 215, 70);
  // Clapper (dark center)
  sPx(d, 7, 7, 80, 70, 30);
  return d;
}

function makeCampfire(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Logs (cross pattern)
  sFill(d, 2, 6, 12, 3, 100, 70, 35);
  sFill(d, 6, 2, 3, 12, 90, 60, 30);
  // Fire center
  sCircle(d, 7, 7, 3, 220, 110, 30);
  sCircle(d, 7, 7, 2, 255, 160, 40);
  sCircle(d, 7, 6, 1, 255, 230, 80);
  return d;
}

function makeBarrel(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Circle (barrel top)
  sCircle(d, 7, 7, 6, 135, 105, 58);
  sCircle(d, 7, 7, 5, 145, 112, 62);
  // Metal bands (darker rings)
  for (let a = 0; a < 360; a += 3) {
    const rad = a * Math.PI / 180;
    const r4x = Math.round(7 + 4 * Math.cos(rad));
    const r4y = Math.round(7 + 4 * Math.sin(rad));
    sPx(d, r4x, r4y, 100, 75, 40);
  }
  return d;
}

function makeAnvil(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // T-shape from above (dark gray)
  sFill(d, 2, 3, 12, 4, 72, 72, 72);   // wide top
  sFill(d, 5, 7, 6, 6, 80, 80, 80);    // narrow base
  // Highlight
  sFill(d, 3, 4, 10, 2, 90, 90, 90);
  return d;
}

function makeCraftingTable(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Wood surface
  sFill(d, 1, 1, 14, 14, 150, 110, 60);
  // Grid lines (3x3)
  for (let i = 0; i < 4; i++) {
    const gp = Math.min(14, Math.round(1 + i * 4.3));
    sFill(d, gp, 1, 1, 14, 110, 78, 40);
    sFill(d, 1, gp, 14, 1, 110, 78, 40);
  }
  return d;
}

function makeCartographyTable(): SpriteData {
  const d = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  // Green surface with border
  sFill(d, 1, 1, 14, 14, 90, 120, 60);
  sFill(d, 2, 2, 12, 12, 100, 135, 70);
  // Compass rose
  sPx(d, 7, 4, 50, 70, 35);  // N
  sPx(d, 7, 11, 50, 70, 35); // S
  sPx(d, 4, 7, 50, 70, 35);  // W
  sPx(d, 11, 7, 50, 70, 35); // E
  // Center cross
  sFill(d, 7, 6, 2, 4, 60, 80, 40);
  sFill(d, 6, 7, 4, 2, 60, 80, 40);
  return d;
}

/** Build or retrieve a cached sprite for the given block base ID */
function buildSprite(baseId: string): SpriteData | null {
  // Flower pots (any variant)
  if (baseId.startsWith('minecraft:potted_') || baseId === 'minecraft:flower_pot') {
    return makeFlowerPot();
  }
  // Beds
  if (baseId === 'minecraft:red_bed') return makeBed([170, 42, 36]);
  if (baseId === 'minecraft:blue_bed') return makeBed([53, 57, 168]);
  if (baseId === 'minecraft:cyan_bed') return makeBed([24, 142, 150]);
  if (baseId.endsWith('_bed')) return makeBed([170, 42, 36]);

  switch (baseId) {
    // Lighting
    case 'minecraft:lantern': return makeLantern(true);
    case 'minecraft:soul_lantern': return makeLantern(false);
    // Storage
    case 'minecraft:chest':
    case 'minecraft:trapped_chest':
    case 'minecraft:ender_chest':
      return makeChest();
    case 'minecraft:barrel': return makeBarrel();
    // Furniture
    case 'minecraft:cauldron':
    case 'minecraft:water_cauldron':
      return makeCauldron();
    case 'minecraft:armor_stand': return makeArmorStand();
    case 'minecraft:bookshelf': return makeBookshelf();
    case 'minecraft:brewing_stand': return makeBrewingStand();
    case 'minecraft:enchanting_table': return makeEnchantingTable();
    case 'minecraft:bell': return makeBell();
    case 'minecraft:campfire':
    case 'minecraft:soul_campfire':
      return makeCampfire();
    case 'minecraft:anvil': return makeAnvil();
    case 'minecraft:crafting_table': return makeCraftingTable();
    case 'minecraft:cartography_table': return makeCartographyTable();
    default: return null;
  }
}

// Chair/stairs are detected by block name suffix
function isChairBlock(baseId: string): boolean {
  return baseId.endsWith('_stairs') && !baseId.includes('quartz') && !baseId.includes('stone')
    && !baseId.includes('brick') && !baseId.includes('copper') && !baseId.includes('purpur')
    && !baseId.includes('sandstone') && !baseId.includes('prismarine')
    && !baseId.includes('deepslate') && !baseId.includes('cobblestone');
}

function isTableBlock(baseId: string): boolean {
  return baseId.endsWith('_fence') && !baseId.includes('nether');
}

/**
 * Get a 16x16 RGBA sprite for a block's top-down appearance.
 * Returns null if no custom sprite exists (fall back to texture/color).
 */
export function getItemSprite(baseId: string): SpriteData | null {
  if (cache.has(baseId)) return cache.get(baseId) ?? null;

  let sprite: SpriteData | null = null;

  // Check for chair (wood stairs used as furniture)
  if (isChairBlock(baseId)) sprite = makeChair();
  // Check for table (fence post)
  else if (isTableBlock(baseId)) sprite = makeTable();
  // Potted plants
  else if (baseId.startsWith('minecraft:potted_')) sprite = makeFlowerPot();
  // Other items
  else sprite = buildSprite(baseId);

  cache.set(baseId, sprite);
  return sprite;
}

/** Sprite resolution — always 16x16 */
export const ITEM_SPRITE_SIZE = SPRITE_SIZE;
