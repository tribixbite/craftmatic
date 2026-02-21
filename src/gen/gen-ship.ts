/**
 * Ship structure generator.
 * Extracted from gen-structures.ts for modularity.
 */

import { BlockGrid } from '../schem/types.js';
import { type RoomType } from '../types/index.js';
import { getRoomGenerator } from './rooms.js';
import { 
  exteriorWalls,
  windows,
  interiorWall,
  doorway,
 } from './structures.js';
import { type StylePalette } from './styles.js';
import { STORY_H, pick } from './gen-utils.js';

// ─── Ship ───────────────────────────────────────────────────────────────────

export function generateShip(
  floors: number, style: StylePalette, rooms: RoomType[] | undefined,
  _bwOpt: number | undefined, blOpt: number | undefined, rng: () => number
): BlockGrid {
  const shipLen = blOpt ?? 35;
  const shipW = 11;
  const margin = 5;
  const gw = shipW + margin * 2;
  const gl = shipLen + margin * 2;
  const gh = floors * STORY_H + 35;

  const cx = margin + Math.floor(shipW / 2); // center X
  const sz1 = margin; // ship start Z (stern)
  const sz2 = margin + shipLen - 1; // ship end Z (bow)

  const grid = new BlockGrid(gw, gh, gl);

  // Hull shape: deeper V-hull with smooth bow/stern curvature
  const hullDepth = 5; // deeper hull for realistic ship profile
  const hullBase = hullDepth; // Y level of deck
  for (let z = sz1; z <= sz2; z++) {
    const zFrac = (z - sz1) / (sz2 - sz1); // 0=stern, 1=bow
    let halfWidth: number;
    if (zFrac < 0.18) {
      // Stern taper — smooth cosine curve for rounded transom
      const t = zFrac / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else if (zFrac > 0.82) {
      // Bow taper — sharper cosine curve for pointed prow
      const t = (1 - zFrac) / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else {
      halfWidth = Math.floor(shipW / 2);
    }
    halfWidth = Math.max(1, halfWidth);

    // Hull layers from keel to deck with pronounced V-shape
    for (let y = 0; y <= hullBase; y++) {
      // Keel narrows to ~25% of deck width using smoothstep for round hull curvature
      const depthFrac = y / hullBase; // 0=keel, 1=deck
      const curveFrac = depthFrac * depthFrac * (3 - 2 * depthFrac);
      const layerHalf = Math.max(1, Math.round(halfWidth * (0.25 + 0.75 * curveFrac)));

      for (let dx = -layerHalf; dx <= layerHalf; dx++) {
        const x = cx + dx;
        if (!grid.inBounds(x, y, z)) continue;

        if (Math.abs(dx) >= layerHalf - 1) {
          // Hull shell (outer planking)
          grid.set(x, y, z, style.wall);
        } else if (y === 0) {
          // Keel bottom
          grid.set(x, y, z, style.foundation);
        } else if (y < hullBase) {
          // Below-deck hull interior (solid for structure)
          grid.set(x, y, z, style.wall);
        }
      }
    }

    // Deck surface
    for (let dx = -halfWidth + 1; dx < halfWidth; dx++) {
      const x = cx + dx;
      if (grid.inBounds(x, hullBase, z)) {
        grid.set(x, hullBase, z, style.floorGround);
      }
    }
    // Deck edge planks
    if (halfWidth >= 1) {
      if (grid.inBounds(cx - halfWidth, hullBase, z)) {
        grid.set(cx - halfWidth, hullBase, z, style.wall);
      }
      if (grid.inBounds(cx + halfWidth, hullBase, z)) {
        grid.set(cx + halfWidth, hullBase, z, style.wall);
      }
    }

    // Deck railings
    if (halfWidth >= 2) {
      const leftRail = cx - halfWidth;
      const rightRail = cx + halfWidth;
      if (grid.inBounds(leftRail, hullBase + 1, z)) {
        grid.set(leftRail, hullBase + 1, z, style.fence);
      }
      if (grid.inBounds(rightRail, hullBase + 1, z)) {
        grid.set(rightRail, hullBase + 1, z, style.fence);
      }
    }
  }

  // Clear hull interior space for cabins
  for (let y = 1; y < hullBase; y++) {
    const midZStart = sz1 + Math.floor(shipLen * 0.18);
    const midZEnd = sz1 + Math.floor(shipLen * 0.82);
    for (let z = midZStart; z <= midZEnd; z++) {
      for (let dx = -(Math.floor(shipW / 2) - 2); dx <= Math.floor(shipW / 2) - 2; dx++) {
        const x = cx + dx;
        if (grid.inBounds(x, y, z)) {
          grid.set(x, y, z, 'minecraft:air');
        }
      }
    }
  }

  // ── Cargo hold details (below deck, between rooms) ──
  const holdY = 1; // just above keel
  const holdZ1 = sz1 + Math.floor(shipLen * 0.20);
  const holdZ2 = sz1 + Math.floor(shipLen * 0.80);
  const holdHalf = Math.floor(shipW / 2) - 3;
  // Barrel clusters along port/starboard walls
  for (let z = holdZ1 + 2; z < holdZ2 - 2; z += 5) {
    for (const side of [-1, 1]) {
      const bx = cx + side * holdHalf;
      if (grid.inBounds(bx, holdY, z))
        grid.set(bx, holdY, z, 'minecraft:barrel[facing=up]');
      if (grid.inBounds(bx, holdY + 1, z))
        grid.set(bx, holdY + 1, z, 'minecraft:barrel[facing=up]');
      if (grid.inBounds(bx, holdY, z + 1))
        grid.set(bx, holdY, z + 1, 'minecraft:barrel[facing=up]');
    }
  }
  // Chests in hold center
  for (let z = holdZ1 + 4; z < holdZ2 - 4; z += 8) {
    if (grid.inBounds(cx, holdY, z))
      grid.set(cx, holdY, z, 'minecraft:chest[facing=south]');
    if (grid.inBounds(cx + 1, holdY, z))
      grid.set(cx + 1, holdY, z, 'minecraft:hay_block');
  }
  // Hanging lanterns in hold
  for (let z = holdZ1 + 3; z < holdZ2 - 2; z += 6) {
    if (grid.inBounds(cx, hullBase - 1, z))
      grid.set(cx, hullBase - 1, z, style.lantern);
  }
  // Hay bale cargo stacks
  for (let z = holdZ2 - 6; z <= holdZ2 - 3; z++) {
    for (const side of [-1, 1]) {
      const hx = cx + side * (holdHalf - 1);
      if (grid.inBounds(hx, holdY, z))
        grid.set(hx, holdY, z, 'minecraft:hay_block');
      if (grid.inBounds(hx, holdY + 1, z))
        grid.set(hx, holdY + 1, z, 'minecraft:hay_block');
    }
  }

  // Below-deck cabins
  for (let story = 0; story < Math.min(floors, 2); story++) {
    const cabinY = hullBase + 1 + story * STORY_H;
    const cabinZ1 = sz1 + Math.floor(shipLen * 0.2);
    const cabinZ2 = sz1 + Math.floor(shipLen * 0.65);
    const cabinX1 = cx - Math.floor(shipW / 2) + 1;
    const cabinX2 = cx + Math.floor(shipW / 2) - 1;

    // Cabin walls and floor
    grid.fill(cabinX1, cabinY - 1, cabinZ1, cabinX2, cabinY - 1, cabinZ2, style.floorUpper);
    exteriorWalls(grid, cabinX1, cabinY, cabinZ1, cabinX2, cabinY + STORY_H - 2, cabinZ2, style);
    grid.fill(cabinX1, cabinY + STORY_H - 1, cabinZ1, cabinX2, cabinY + STORY_H - 1, cabinZ2, style.ceiling);

    // Windows
    windows(grid, cabinX1, cabinZ1, cabinX2, cabinZ2, cabinY + 1, cabinY + 2, style, 4);

    // Door
    const doorZ = cabinZ1;
    grid.set(cx, cabinY, doorZ, style.doorLowerS);
    grid.set(cx, cabinY + 1, doorZ, style.doorUpperS);

    // Interior rooms
    const cxMid = Math.floor((cabinX1 + cabinX2) / 2);
    interiorWall(grid, 'z', cxMid, cabinZ1 + 1, cabinZ2 - 1, cabinY, cabinY + STORY_H - 2, style);
    doorway(grid, cxMid, cabinY, Math.floor((cabinZ1 + cabinZ2) / 2) - 1,
            cxMid, cabinY + 2, Math.floor((cabinZ1 + cabinZ2) / 2) + 1);

    const shipRooms: RoomType[] = ['bedroom', 'kitchen', 'dining', 'vault', 'armory', 'study'];
    const leftRoom = rooms?.[story * 2] ?? pick(shipRooms, rng);
    const rightRoom = rooms?.[story * 2 + 1] ?? pick(shipRooms, rng);

    getRoomGenerator(leftRoom)(grid, {
      x1: cabinX1 + 1, y: cabinY, z1: cabinZ1 + 1,
      x2: cxMid - 1, z2: cabinZ2 - 1, height: STORY_H - 1,
    }, style);
    getRoomGenerator(rightRoom)(grid, {
      x1: cxMid + 1, y: cabinY, z1: cabinZ1 + 1,
      x2: cabinX2 - 1, z2: cabinZ2 - 1, height: STORY_H - 1,
    }, style);
  }

  // ── Compute sail clearance — sails must start above highest cabin ──
  const cabinStories = Math.min(floors, 2);
  const cabinTopY = hullBase + 1 + cabinStories * STORY_H - 1;
  const sternTopY = hullBase + 1 + 4; // stern cabin ceiling
  const sailStartY = Math.max(cabinTopY, sternTopY) + 1;
  // Minimum sail height = cabin height (ensures visually proportional sails)
  const minSailH = cabinStories * STORY_H;

  // ── Main mast (midship, tallest) ──
  const mastZ = sz1 + Math.floor(shipLen * 0.45);
  // Mast must be tall enough for two sail tiers each at least minSailH, but capped to grid height
  const mastH = Math.min(
    Math.max(20, sailStartY - hullBase + minSailH * 2 + 8),
    gh - hullBase - 1,
  );
  const yardHalf = Math.floor(shipW / 2) + 1;
  for (let y = hullBase; y < hullBase + mastH; y++) {
    if (grid.inBounds(cx, y, mastZ)) grid.set(cx, y, mastZ, style.timber);
  }

  // Crow's nest at top of main mast
  const nestY = hullBase + mastH - 2;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (grid.inBounds(cx + dx, nestY, mastZ + dz))
        grid.set(cx + dx, nestY, mastZ + dz, style.floorUpper);
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    if (grid.inBounds(cx + dx, nestY + 1, mastZ - 1))
      grid.set(cx + dx, nestY + 1, mastZ - 1, style.fence);
    if (grid.inBounds(cx + dx, nestY + 1, mastZ + 1))
      grid.set(cx + dx, nestY + 1, mastZ + 1, style.fence);
  }
  if (grid.inBounds(cx - 1, nestY + 1, mastZ))
    grid.set(cx - 1, nestY + 1, mastZ, style.fence);
  if (grid.inBounds(cx + 1, nestY + 1, mastZ))
    grid.set(cx + 1, nestY + 1, mastZ, style.fence);
  // Restore mast through crow's nest
  if (grid.inBounds(cx, nestY, mastZ)) grid.set(cx, nestY, mastZ, style.timber);
  if (grid.inBounds(cx, nestY + 1, mastZ)) grid.set(cx, nestY + 1, mastZ, style.timber);

  // Yard positions: ensure each sail tier is at least minSailH tall
  const lowerYardY = Math.max(hullBase + Math.floor(mastH * 0.4), sailStartY + minSailH);
  const yardY = Math.max(hullBase + Math.floor(mastH * 0.8), lowerYardY + Math.floor(minSailH * 0.7));

  // Upper yard arm
  for (let dx = -yardHalf; dx <= yardHalf; dx++) {
    if (grid.inBounds(cx + dx, yardY, mastZ))
      grid.set(cx + dx, yardY, mastZ, style.timberX);
  }

  // Lower yard arm
  for (let dx = -yardHalf; dx <= yardHalf; dx++) {
    if (grid.inBounds(cx + dx, lowerYardY, mastZ))
      grid.set(cx + dx, lowerYardY, mastZ, style.timberX);
  }

  // Upper main sail (between upper and lower yard arms, 1 block deep)
  for (let y = lowerYardY + 1; y < yardY; y++) {
    const frac = (y - lowerYardY - 1) / Math.max(1, yardY - lowerYardY - 2);
    const rowHalf = Math.max(1, Math.round(yardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mastZ))
        grid.set(cx + dx, y, mastZ, 'minecraft:white_wool');
    }
  }

  // Lower main sail (lower yard to above cabins, 1 block deep)
  for (let y = sailStartY; y < lowerYardY; y++) {
    const frac = (y - sailStartY) / Math.max(1, lowerYardY - sailStartY - 1);
    const rowHalf = Math.max(1, Math.round(yardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mastZ))
        grid.set(cx + dx, y, mastZ, 'minecraft:white_wool');
    }
  }

  // Restore mast through sails
  for (let y = sailStartY; y < yardY; y++) {
    if (grid.inBounds(cx, y, mastZ)) grid.set(cx, y, mastZ, style.timber);
  }

  // ── Foremast (near bow, shorter) ──
  const foremastZ = sz1 + Math.floor(shipLen * 0.7);
  const foremastH = Math.max(16, sailStartY - hullBase + minSailH + 6);
  for (let y = hullBase; y < hullBase + foremastH; y++) {
    if (grid.inBounds(cx, y, foremastZ)) grid.set(cx, y, foremastZ, style.timber);
  }
  // Yard must be at least minSailH above sailStartY
  const foreYardY = Math.max(hullBase + Math.floor(foremastH * 0.75), sailStartY + minSailH);
  const foreYardHalf = yardHalf - 1;
  for (let dx = -foreYardHalf; dx <= foreYardHalf; dx++) {
    if (grid.inBounds(cx + dx, foreYardY, foremastZ))
      grid.set(cx + dx, foreYardY, foremastZ, style.timberX);
  }
  // Fore sail (1 block deep, starts above cabins)
  for (let y = sailStartY; y < foreYardY; y++) {
    const frac = (y - sailStartY) / Math.max(1, foreYardY - sailStartY - 1);
    const rowHalf = Math.max(1, Math.round(foreYardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, foremastZ))
        grid.set(cx + dx, y, foremastZ, 'minecraft:white_wool');
    }
  }
  for (let y = sailStartY; y < foreYardY; y++) {
    if (grid.inBounds(cx, y, foremastZ)) grid.set(cx, y, foremastZ, style.timber);
  }

  // ── Mizzen mast (near stern, shortest) ──
  const mizzenZ = sz1 + Math.floor(shipLen * 0.18);
  const mizzenH = Math.max(13, sailStartY - hullBase + minSailH + 4);
  for (let y = hullBase; y < hullBase + mizzenH; y++) {
    if (grid.inBounds(cx, y, mizzenZ)) grid.set(cx, y, mizzenZ, style.timber);
  }
  // Yard must be at least minSailH above sailStartY
  const mizYardY = Math.max(hullBase + Math.floor(mizzenH * 0.75), sailStartY + minSailH);
  const mizYardHalf = yardHalf - 2;
  for (let dx = -mizYardHalf; dx <= mizYardHalf; dx++) {
    if (grid.inBounds(cx + dx, mizYardY, mizzenZ))
      grid.set(cx + dx, mizYardY, mizzenZ, style.timberX);
  }
  // Mizzen sail (1 block deep, starts above cabins)
  const mizSailStart = Math.max(sailStartY, sternTopY + 1);
  for (let y = mizSailStart; y < mizYardY; y++) {
    const frac = (y - mizSailStart) / Math.max(1, mizYardY - mizSailStart - 1);
    const rowHalf = Math.max(1, Math.round(mizYardHalf * (0.8 + 0.2 * frac)));
    for (let dx = -rowHalf; dx <= rowHalf; dx++) {
      if (grid.inBounds(cx + dx, y, mizzenZ))
        grid.set(cx + dx, y, mizzenZ, 'minecraft:white_wool');
    }
  }
  for (let y = mizSailStart; y < mizYardY; y++) {
    if (grid.inBounds(cx, y, mizzenZ)) grid.set(cx, y, mizzenZ, style.timber);
  }

  // Bowsprit (extended, angled down toward water)
  const bowZ = sz2 + 1;
  for (let dz = 0; dz < 7; dz++) {
    const by = hullBase + 2 - Math.floor(dz / 3);
    if (grid.inBounds(cx, by, bowZ + dz))
      grid.set(cx, by, bowZ + dz, style.timberZ);
  }

  // Stern cabin (captain's quarters)
  const sternZ1 = sz1 + 1;
  const sternZ2 = sz1 + Math.floor(shipLen * 0.15);
  const sternX1 = cx - 3;
  const sternX2 = cx + 3;
  const sternY = hullBase + 1;
  exteriorWalls(grid, sternX1, sternY, sternZ1, sternX2, sternY + 3, sternZ2, style);
  grid.fill(sternX1, sternY + 4, sternZ1, sternX2, sternY + 4, sternZ2, style.ceiling);
  windows(grid, sternX1, sternZ1, sternX2, sternZ2, sternY + 1, sternY + 2, style, 3);

  // Captain's quarters interior
  getRoomGenerator('study')(grid, {
    x1: sternX1 + 1, y: sternY, z1: sternZ1 + 1,
    x2: sternX2 - 1, z2: sternZ2 - 1, height: 3,
  }, style);

  // ── Deck details ──
  // Ship wheel (between stern cabin and midship)
  const wheelZ = sternZ2 + 2;
  if (grid.inBounds(cx, hullBase + 1, wheelZ)) {
    grid.set(cx, hullBase + 1, wheelZ, style.fence);
    grid.set(cx, hullBase + 2, wheelZ, 'minecraft:dark_oak_trapdoor[facing=south,half=top,open=true]');
  }

  // Deck barrels and crates (scattered around masts)
  const deckY = hullBase + 1;
  const halfDeck = Math.floor(shipW / 2) - 2;
  // Port side barrels near main mast
  if (grid.inBounds(cx - halfDeck, deckY, mastZ + 3))
    grid.set(cx - halfDeck, deckY, mastZ + 3, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx - halfDeck, deckY, mastZ + 4))
    grid.set(cx - halfDeck, deckY, mastZ + 4, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx - halfDeck, deckY + 1, mastZ + 3))
    grid.set(cx - halfDeck, deckY + 1, mastZ + 3, 'minecraft:barrel[facing=up]');
  // Starboard side crates near foremast
  if (grid.inBounds(cx + halfDeck, deckY, foremastZ - 2))
    grid.set(cx + halfDeck, deckY, foremastZ - 2, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx + halfDeck, deckY, foremastZ - 3))
    grid.set(cx + halfDeck, deckY, foremastZ - 3, 'minecraft:barrel[facing=up]');
  // Rope coils (brown wool)
  if (grid.inBounds(cx + 2, deckY, mastZ + 2))
    grid.set(cx + 2, deckY, mastZ + 2, 'minecraft:brown_wool');
  if (grid.inBounds(cx - 2, deckY, foremastZ - 1))
    grid.set(cx - 2, deckY, foremastZ - 1, 'minecraft:brown_wool');

  // Stern lanterns
  if (grid.inBounds(cx - 2, hullBase + 2, sz1))
    grid.set(cx - 2, hullBase + 2, sz1, style.lanternFloor);
  if (grid.inBounds(cx + 2, hullBase + 2, sz1))
    grid.set(cx + 2, hullBase + 2, sz1, style.lanternFloor);

  // Deck lanterns along railings (every 6 blocks)
  for (let z = sz1 + 4; z < sz2 - 4; z += 6) {
    for (const side of [-1, 1]) {
      const lx = cx + side * (Math.floor(shipW / 2) - 1);
      if (grid.inBounds(lx, deckY + 1, z))
        grid.set(lx, deckY + 1, z, style.lanternFloor);
    }
  }
  // Cargo hatch (trapdoor) on deck between masts
  const hatchZ = Math.floor((mastZ + foremastZ) / 2);
  for (let dx = -1; dx <= 1; dx++) {
    if (grid.inBounds(cx + dx, hullBase, hatchZ))
      grid.set(cx + dx, hullBase, hatchZ, 'minecraft:dark_oak_trapdoor[facing=south,half=top,open=false]');
  }

  // Rigging — chains from mast tops down to deck edges
  const riggingPairs: [number, number, number][] = [
    [mastZ, hullBase + mastH - 3, halfDeck],
    [foremastZ, hullBase + foremastH - 3, halfDeck],
  ];
  for (const [rz, topY, rHalf] of riggingPairs) {
    for (const side of [-1, 1]) {
      const steps = topY - deckY;
      for (let i = 0; i < steps; i++) {
        const ry = topY - i;
        const rx = cx + side * Math.round(rHalf * (i / steps));
        if (grid.inBounds(rx, ry, rz) && grid.get(rx, ry, rz) === 'minecraft:air') {
          grid.set(rx, ry, rz, 'minecraft:chain');
        }
      }
    }
  }

  // Additional deck barrels near stern
  if (grid.inBounds(cx - 2, deckY, sternZ2 + 3))
    grid.set(cx - 2, deckY, sternZ2 + 3, 'minecraft:barrel[facing=up]');
  if (grid.inBounds(cx - 2, deckY, sternZ2 + 4))
    grid.set(cx - 2, deckY, sternZ2 + 4, 'minecraft:barrel[facing=up]');

  // Coiled rope (chains) near bow
  if (grid.inBounds(cx + 1, deckY, sz2 - 3))
    grid.set(cx + 1, deckY, sz2 - 3, 'minecraft:chain');
  if (grid.inBounds(cx - 1, deckY, sz2 - 2))
    grid.set(cx - 1, deckY, sz2 - 2, 'minecraft:chain');

  // ── Bow figurehead — multi-block prow decoration ──
  if (grid.inBounds(cx, hullBase + 1, sz2))
    grid.set(cx, hullBase + 1, sz2, 'minecraft:carved_pumpkin[facing=south]');
  // Gold accent trim along bowsprit
  if (grid.inBounds(cx, hullBase + 2, sz2))
    grid.set(cx, hullBase + 2, sz2, 'minecraft:gold_block');
  // Banners trailing from bowsprit
  if (grid.inBounds(cx - 1, hullBase + 2, sz2 + 1))
    grid.set(cx - 1, hullBase + 2, sz2 + 1, style.bannerN);

  // ── Stern gallery windows — adds detail to captain's quarters rear ──
  for (let dx = -2; dx <= 2; dx++) {
    if (grid.inBounds(cx + dx, hullBase + 2, sz1))
      grid.set(cx + dx, hullBase + 2, sz1, style.window);
    if (grid.inBounds(cx + dx, hullBase + 3, sz1))
      grid.set(cx + dx, hullBase + 3, sz1, style.window);
  }
  // Stern name plate (sign-like accent)
  if (grid.inBounds(cx, hullBase + 4, sz1))
    grid.set(cx, hullBase + 4, sz1, style.wallAccent);

  // ── Deck furnishing — ship's bell + compass table ──
  const bellZ = sternZ2 + 1;
  if (grid.inBounds(cx, deckY + 1, bellZ))
    grid.set(cx, deckY + 1, bellZ, 'minecraft:bell[attachment=floor]');
  // Navigation table near wheel
  if (grid.inBounds(cx + 2, deckY, wheelZ))
    grid.set(cx + 2, deckY, wheelZ, style.fence);
  if (grid.inBounds(cx + 2, deckY + 1, wheelZ))
    grid.set(cx + 2, deckY + 1, wheelZ, 'minecraft:cartography_table');

  // ── Hull reinforcement trim — darker accent stripe at waterline ──
  for (let z = sz1; z <= sz2; z++) {
    const zFrac = (z - sz1) / (sz2 - sz1);
    let halfWidth: number;
    if (zFrac < 0.18) {
      const t = zFrac / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else if (zFrac > 0.82) {
      const t = (1 - zFrac) / 0.18;
      halfWidth = Math.round((0.5 - 0.5 * Math.cos(Math.PI * t)) * (shipW / 2));
    } else {
      halfWidth = Math.floor(shipW / 2);
    }
    halfWidth = Math.max(1, halfWidth);
    // Waterline accent at y=2 (hull stripe)
    for (const side of [-1, 1]) {
      const hx = cx + side * halfWidth;
      if (grid.inBounds(hx, 2, z))
        grid.set(hx, 2, z, style.wallAccent);
    }
  }

  // ── Cannon ports (dark openings) along midship hull ──
  const portZStart = sz1 + Math.floor(shipLen * 0.25);
  const portZEnd = sz1 + Math.floor(shipLen * 0.75);
  for (let z = portZStart; z <= portZEnd; z += 5) {
    for (const side of [-1, 1]) {
      const px = cx + side * Math.floor(shipW / 2);
      if (grid.inBounds(px, hullBase - 1, z))
        grid.set(px, hullBase - 1, z, 'minecraft:air'); // cannon port hole
    }
  }

  // ── Stern decoration — ornate name plate and railing ──
  for (let dx = -2; dx <= 2; dx++) {
    if (grid.inBounds(cx + dx, hullBase + 1, sz1))
      grid.set(cx + dx, hullBase + 1, sz1, style.fence); // stern railing
  }
  // Stern lantern cluster
  if (grid.inBounds(cx, hullBase + 3, sz1 - 1))
    grid.set(cx, hullBase + 3, sz1 - 1, style.lanternFloor);

  // ── Dock / pier structure alongside ship — compositional complexity ──
  const dockX1 = 0;
  const dockX2 = cx - Math.floor(shipW / 2) - 2;
  const dockZ1 = sz1 + Math.floor(shipLen * 0.2);
  const dockZ2 = sz1 + Math.floor(shipLen * 0.7);
  if (dockX2 > dockX1) {
    // Dock platform (raised above water)
    for (let x = dockX1; x <= dockX2; x++) {
      for (let z = dockZ1; z <= dockZ2; z++) {
        if (grid.inBounds(x, 2, z))
          grid.set(x, 2, z, style.floorGround);
      }
    }
    // Dock pilings (support posts going down into water)
    for (let x = dockX1 + 1; x <= dockX2; x += 3) {
      for (let z = dockZ1; z <= dockZ2; z += 4) {
        for (let y = 0; y <= 2; y++) {
          if (grid.inBounds(x, y, z))
            grid.set(x, y, z, style.timber);
        }
      }
    }
    // Dock railing on outer edge
    for (let z = dockZ1; z <= dockZ2; z++) {
      if (grid.inBounds(dockX1, 3, z))
        grid.set(dockX1, 3, z, style.fence);
    }
    // Cargo crates on dock
    const crateX = dockX1 + 2;
    for (let dz = 0; dz < 3; dz++) {
      const cz = dockZ1 + 2 + dz * 2;
      if (grid.inBounds(crateX, 3, cz)) {
        grid.set(crateX, 3, cz, 'minecraft:barrel[facing=up]');
        if (dz === 0 && grid.inBounds(crateX, 4, cz))
          grid.set(crateX, 4, cz, 'minecraft:barrel[facing=up]');
      }
    }
    // Dock lanterns
    if (grid.inBounds(dockX1 + 1, 3, dockZ1))
      grid.set(dockX1 + 1, 3, dockZ1, style.lanternFloor);
    if (grid.inBounds(dockX1 + 1, 3, dockZ2))
      grid.set(dockX1 + 1, 3, dockZ2, style.lanternFloor);
    // Gangplank connecting dock to ship
    const gpZ = Math.floor((dockZ1 + dockZ2) / 2);
    for (let x = dockX2 + 1; x <= cx - Math.floor(shipW / 2); x++) {
      if (grid.inBounds(x, 3, gpZ))
        grid.set(x, 3, gpZ, style.slabBottom);
    }
  }

  return grid;
}
