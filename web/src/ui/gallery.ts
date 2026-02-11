/**
 * Gallery — pre-generated structure showcase with thumbnail previews.
 */

import * as THREE from 'three';
import type { StructureType, StyleName } from '@craft/types/index.js';
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
}

const GALLERY_ENTRIES: GalleryEntry[] = [
  { type: 'house', style: 'fantasy', floors: 2, seed: 42, label: 'Fantasy Cottage' },
  { type: 'house', style: 'medieval', floors: 3, seed: 100, label: 'Medieval Manor' },
  { type: 'tower', style: 'gothic', floors: 4, seed: 77, label: 'Gothic Tower' },
  { type: 'castle', style: 'medieval', floors: 2, seed: 200, label: 'Medieval Castle' },
  { type: 'dungeon', style: 'gothic', floors: 2, seed: 300, label: 'Gothic Dungeon' },
  { type: 'ship', style: 'rustic', floors: 2, seed: 500, label: 'Rustic Ship' },
  { type: 'house', style: 'modern', floors: 2, seed: 600, label: 'Modern House' },
  { type: 'tower', style: 'fantasy', floors: 5, seed: 700, label: 'Wizard Tower' },
  { type: 'castle', style: 'gothic', floors: 3, seed: 800, label: 'Dark Fortress' },
  { type: 'house', style: 'rustic', floors: 2, seed: 900, label: 'Rustic Cabin' },
  { type: 'dungeon', style: 'medieval', floors: 3, seed: 1000, label: 'Stone Dungeon' },
  { type: 'ship', style: 'fantasy', floors: 2, seed: 1100, label: 'Fantasy Galleon' },
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

        // Top face
        ctx.fillStyle = `rgb(${Math.min(255, r + 30)},${Math.min(255, g + 30)},${Math.min(255, b + 30)})`;
        ctx.fillRect(sx - tile, sy, tile * 2, halfT);

        // Left face
        ctx.fillStyle = `rgb(${Math.max(0, r - 15)},${Math.max(0, g - 15)},${Math.max(0, b - 15)})`;
        ctx.fillRect(sx - tile, sy + halfT, tile, tile);

        // Right face
        ctx.fillStyle = `rgb(${Math.max(0, r - 35)},${Math.max(0, g - 35)},${Math.max(0, b - 35)})`;
        ctx.fillRect(sx, sy + halfT, tile, tile);
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
