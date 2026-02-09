/**
 * Three.js scene builder — creates a 3D scene from schematic data.
 * Generates block meshes with color-coded materials.
 * Supports embedding real texture PNGs for the HTML viewer.
 */

import * as THREE from 'three';
import { BlockGrid } from '../schem/types.js';
import { getBlockColor } from '../blocks/colors.js';
import { isAir, isSolidBlock, getBlockName } from '../blocks/registry.js';
import type { RGB } from '../types/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build a Three.js scene from a BlockGrid */
export function buildScene(grid: BlockGrid): THREE.Group {
  const group = new THREE.Group();
  const { width, height, length } = grid;

  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const instanceMap = new Map<string, THREE.Matrix4[]>();

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        if (isFullyOccluded(grid, x, y, z)) continue;

        const color = getBlockColor(bs);
        if (!color) continue;

        const key = colorKey(color);
        if (!instanceMap.has(key)) {
          instanceMap.set(key, []);
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255),
            roughness: 0.8,
            metalness: 0.1,
          });
          materialCache.set(key, mat);
        }

        const matrix = new THREE.Matrix4();
        matrix.setPosition(x - width / 2, y, z - length / 2);
        instanceMap.get(key)!.push(matrix);
      }
    }
  }

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  for (const [key, matrices] of instanceMap) {
    const material = materialCache.get(key)!;
    const instanced = new THREE.InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) {
      instanced.setMatrixAt(i, matrices[i]);
    }
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  }

  return group;
}

/** Check if a block is completely surrounded by solid blocks */
function isFullyOccluded(grid: BlockGrid, x: number, y: number, z: number): boolean {
  return (
    isSolidBlock(grid.get(x + 1, y, z)) &&
    isSolidBlock(grid.get(x - 1, y, z)) &&
    isSolidBlock(grid.get(x, y + 1, z)) &&
    isSolidBlock(grid.get(x, y - 1, z)) &&
    isSolidBlock(grid.get(x, y, z + 1)) &&
    isSolidBlock(grid.get(x, y, z - 1))
  );
}

function colorKey(c: RGB): string {
  return `${c[0]},${c[1]},${c[2]}`;
}

// ─── Texture-aware viewer data ─────────────────────────────────────────────

/** Find bundled textures directory */
function findTextureDir(): string | null {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(__dirname, '../../textures/blocks'),
      join(process.cwd(), 'textures/blocks'),
    ];
    for (const dir of candidates) {
      if (existsSync(dir)) return dir;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Get candidate texture filenames for a block name.
 * Handles stairs→planks, slabs→base, carpet→wool, etc.
 */
function resolveTextureCandidates(blockState: string): string[] {
  const name = getBlockName(blockState);
  const candidates = [name];

  // Stairs → planks or base material
  if (name.endsWith('_stairs')) {
    const base = name.replace('_stairs', '');
    candidates.push(base + '_planks', base);
  }
  // Slabs → planks or base
  if (name.endsWith('_slab')) {
    const base = name.replace('_slab', '');
    candidates.push(base + '_planks', base);
  }
  // Fences → planks
  if (name.endsWith('_fence') || name.endsWith('_fence_gate')) {
    const base = name.replace(/_fence(_gate)?$/, '');
    candidates.push(base + '_planks', base);
  }
  // Walls → base material
  if (name.endsWith('_wall') && name !== 'cobblestone_wall') {
    const base = name.replace('_wall', '');
    candidates.push(base);
  }
  if (name === 'cobblestone_wall') candidates.push('cobblestone');
  // Carpet → wool
  if (name.endsWith('_carpet')) {
    const color = name.replace('_carpet', '');
    candidates.push(color + '_wool');
  }
  // Stripped logs → regular log texture
  if (name.startsWith('stripped_') && name.endsWith('_log')) {
    const base = name.replace('stripped_', '');
    candidates.push(base);
  }
  // Concrete → closest wool
  if (name.endsWith('_concrete')) {
    const color = name.replace('_concrete', '');
    candidates.push(color + '_wool', color + '_terracotta');
  }
  // Stained glass pane → stained glass
  if (name.endsWith('_stained_glass_pane')) {
    const color = name.replace('_stained_glass_pane', '');
    candidates.push(color + '_stained_glass');
  }
  // Stone brick variants
  if (name === 'stone_bricks' || name === 'stone_brick_stairs' || name === 'stone_brick_slab') {
    candidates.push('stone');
  }
  // Mossy stone bricks
  if (name.startsWith('mossy_stone_brick')) {
    candidates.push('mossy_cobblestone');
  }
  // Deepslate variants → nether_bricks as dark alternative
  if (name.includes('deepslate')) {
    candidates.push('nether_bricks', 'obsidian');
  }
  // Polished blackstone → obsidian
  if (name.includes('blackstone')) {
    candidates.push('obsidian', 'nether_bricks');
  }
  // Smooth quartz → quartz_block
  if (name.includes('smooth_quartz')) {
    candidates.push('smooth_quartz', 'quartz_block');
  }
  // Tinted glass → glass
  if (name === 'tinted_glass') candidates.push('glass');

  return candidates;
}

/** Load a texture PNG as base64 data URI */
function loadTextureBase64(blockState: string, textureDir: string | null): string | null {
  if (!textureDir) return null;
  const candidates = resolveTextureCandidates(blockState);
  for (const candidate of candidates) {
    const filePath = join(textureDir, candidate + '.png');
    if (existsSync(filePath)) {
      const data = readFileSync(filePath);
      return `data:image/png;base64,${data.toString('base64')}`;
    }
  }
  return null;
}

/** Viewer palette entry with optional embedded texture */
interface ViewerPaletteEntry {
  name: string;
  color: RGB;
  texture: string | null; // base64 data URI or null
}

/**
 * Serialize a BlockGrid to JSON with embedded texture data for the viewer.
 * Each unique block state gets its own palette entry with a real texture
 * (if available) or null for procedural fallback.
 */
export async function serializeForViewerTextured(grid: BlockGrid): Promise<object> {
  const { width, height, length } = grid;
  const textureDir = findTextureDir();

  // Build palette of unique block states
  const paletteMap = new Map<string, number>();
  const palette: ViewerPaletteEntry[] = [];
  const blocks: { x: number; y: number; z: number; p: number }[] = [];

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        if (isFullyOccluded(grid, x, y, z)) continue;

        const color = getBlockColor(bs);
        if (!color) continue;

        let p = paletteMap.get(bs);
        if (p === undefined) {
          p = palette.length;
          paletteMap.set(bs, p);
          palette.push({ name: bs, color, texture: null });
        }
        blocks.push({ x, y, z, p });
      }
    }
  }

  // Load real textures for each palette entry
  for (const entry of palette) {
    entry.texture = loadTextureBase64(entry.name, textureDir);
  }

  return {
    width, height, length,
    blockCount: blocks.length,
    palette,
    blocks,
  };
}

/**
 * Legacy serializer — flat color, no textures.
 */
export function serializeForViewer(grid: BlockGrid): object {
  const { width, height, length } = grid;
  const blocks: { x: number; y: number; z: number; color: RGB }[] = [];

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        if (isAir(bs)) continue;
        if (isFullyOccluded(grid, x, y, z)) continue;

        const color = getBlockColor(bs);
        if (!color) continue;
        blocks.push({ x, y, z, color });
      }
    }
  }

  return {
    width, height, length,
    blockCount: blocks.length,
    blocks,
  };
}
