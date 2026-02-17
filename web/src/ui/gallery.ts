/**
 * Gallery — pre-generated structure showcase with thumbnail previews.
 */

import type { StructureType, StyleName, RoofShape, FloorPlanShape } from '@craft/types/index.js';
import { generateStructure } from '@craft/gen/generator.js';
import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { isAir, isSolidBlock, getBlockName } from '@craft/blocks/registry.js';

interface GalleryEntry {
  type: StructureType;
  style: StyleName;
  floors: number;
  seed: number;
  label: string;
  /** Optional roof shape override for the gallery preset */
  roofShape?: RoofShape;
  /** Optional floor plan shape for non-rectangular houses */
  planShape?: FloorPlanShape;
}

const GALLERY_ENTRIES: GalleryEntry[] = [
  // Curated gallery — only buildings scoring 8+ in Gemini 3 Pro QA evaluation
  { type: 'village', style: 'medieval', floors: 1, seed: 42, label: 'Medieval Village' },       // 9.0
  { type: 'dungeon', style: 'gothic', floors: 2, seed: 300, label: 'Gothic Dungeon' },          // 8.7
  { type: 'ship', style: 'fantasy', floors: 2, seed: 1100, label: 'Fantasy Galleon' },          // 8.7
  { type: 'marketplace', style: 'desert', floors: 1, seed: 55, label: 'Desert Bazaar' },        // 8.7
  { type: 'house', style: 'fantasy', floors: 2, seed: 42, label: 'Fantasy Cottage' },           // 8.3
  { type: 'windmill', style: 'rustic', floors: 1, seed: 33, label: 'Rustic Windmill' },         // 8.3
  { type: 'tower', style: 'gothic', floors: 4, seed: 77, label: 'Gothic Tower' },               // 8.0
  { type: 'tower', style: 'elven', floors: 4, seed: 88, label: 'Elven Spire' },                 // 8.0
  { type: 'castle', style: 'underwater', floors: 2, seed: 150, label: 'Undersea Citadel' },     // 8.0
];

/** Render a tiny isometric thumbnail of a BlockGrid onto a canvas */
function renderThumbnail(canvas: HTMLCanvasElement, grid: BlockGrid): void {
  const ctx = canvas.getContext('2d')!;
  const { width, height, length } = grid;
  const tile = Math.max(1, Math.min(4, Math.floor(180 / Math.max(width, length))));
  const halfT = Math.floor(tile / 2);

  // Calculate bounds
  const corners = [
    [0, 0, 0], [width, 0, 0], [0, height, 0], [0, 0, length],
    [width, height, 0], [width, 0, length], [0, height, length], [width, height, length],
  ];
  const sxs = corners.map(([x, _y, z]) => (x - z) * tile);
  const sys = corners.map(([x, y, z]) => -(y * tile) + (x + z) * halfT);

  const pad = tile * 2;
  const minSx = Math.min(...sxs) - pad;
  const maxSx = Math.max(...sxs) + pad;
  const minSy = Math.min(...sys) - pad;
  const maxSy = Math.max(...sys) + pad;

  canvas.width = maxSx - minSx;
  canvas.height = maxSy - minSy;

  // Background
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = -minSx;
  const cy = -minSy;

  // Render blocks in painter's order
  for (let y = 0; y < height; y++) {
    for (let z = length - 1; z >= 0; z--) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        // Simple occlusion: skip if all 6 neighbors are solid
        if (isSolidBlock(grid.get(x+1,y,z)) && isSolidBlock(grid.get(x-1,y,z))
            && isSolidBlock(grid.get(x,y+1,z)) && isSolidBlock(grid.get(x,y-1,z))
            && isSolidBlock(grid.get(x,y,z+1)) && isSolidBlock(grid.get(x,y,z-1))) continue;

        const color = getBlockColor(bs);
        if (!color) continue;

        const [r, g, b] = color;
        const sx = (x - z) * tile + cx;
        const sy = -(y * tile) + (x + z) * halfT + cy;

        // Top face (diamond)
        ctx.fillStyle = `rgb(${Math.min(255, r + 30)},${Math.min(255, g + 30)},${Math.min(255, b + 30)})`;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + tile, sy + halfT);
        ctx.lineTo(sx, sy + tile);
        ctx.lineTo(sx - tile, sy + halfT);
        ctx.closePath();
        ctx.fill();

        // Left face (parallelogram)
        ctx.fillStyle = `rgb(${Math.max(0, r - 15)},${Math.max(0, g - 15)},${Math.max(0, b - 15)})`;
        ctx.beginPath();
        ctx.moveTo(sx - tile, sy + halfT);
        ctx.lineTo(sx, sy + tile);
        ctx.lineTo(sx, sy + tile + tile);
        ctx.lineTo(sx - tile, sy + halfT + tile);
        ctx.closePath();
        ctx.fill();

        // Right face (parallelogram)
        ctx.fillStyle = `rgb(${Math.max(0, r - 35)},${Math.max(0, g - 35)},${Math.max(0, b - 35)})`;
        ctx.beginPath();
        ctx.moveTo(sx + tile, sy + halfT);
        ctx.lineTo(sx, sy + tile);
        ctx.lineTo(sx, sy + tile + tile);
        ctx.lineTo(sx + tile, sy + halfT + tile);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

/** Initialize the gallery grid */
export function initGallery(
  gridEl: HTMLElement,
  onSelect: (grid: BlockGrid, label: string) => void,
): void {
  GALLERY_ENTRIES.forEach((entry, idx) => {
    const card = document.createElement('div');
    card.className = 'gallery-card';
    card.style.animationDelay = `${idx * 50}ms`;

    const preview = document.createElement('div');
    preview.className = 'gallery-preview loading';
    preview.innerHTML = '<canvas></canvas>';

    card.innerHTML = '';
    card.appendChild(preview);

    const meta = document.createElement('div');
    meta.className = 'gallery-meta';
    meta.innerHTML = `
      <div class="gallery-title">${entry.label}</div>
      <div class="gallery-desc">${entry.floors} floors, seed ${entry.seed}</div>
      <div class="gallery-tags">
        <span class="tag tag-type">${entry.type}</span>
        <span class="tag tag-style">${entry.style}</span>
      </div>
    `;
    card.appendChild(meta);

    gridEl.appendChild(card);

    // Generate and render thumbnail lazily via IntersectionObserver
    let generated = false;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !generated) {
        generated = true;
        observer.disconnect();

        // Defer generation to next frame so shimmer is visible
        requestAnimationFrame(() => {
          const grid = generateStructure({
            type: entry.type,
            floors: entry.floors,
            style: entry.style,
            seed: entry.seed,
            ...(entry.roofShape ? { roofShape: entry.roofShape } : {}),
            ...(entry.planShape ? { floorPlanShape: entry.planShape } : {}),
          });
          const canvas = card.querySelector('canvas')!;
          renderThumbnail(canvas, grid);
          preview.classList.remove('loading');

          card.addEventListener('click', () => onSelect(grid, entry.label));
        });
      }
    }, { threshold: 0.1 });
    observer.observe(card);
  });
}
