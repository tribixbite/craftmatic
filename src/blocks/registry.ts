/**
 * Block state registry — parse block state strings, extract properties,
 * and provide block metadata for rendering and generation.
 */

import type { BlockStateProperties } from '../types/index.js';

/**
 * Parse a full block state string into its components.
 * e.g. "minecraft:dark_oak_stairs[facing=north,half=bottom]" =>
 *   { name: "dark_oak_stairs", id: "minecraft:dark_oak_stairs", properties: { facing: "north", half: "bottom" } }
 */
export function parseBlockState(blockState: string): BlockStateProperties {
  const bracketIdx = blockState.indexOf('[');
  const id = bracketIdx >= 0 ? blockState.slice(0, bracketIdx) : blockState;

  // Extract name without namespace
  const colonIdx = id.indexOf(':');
  const name = colonIdx >= 0 ? id.slice(colonIdx + 1) : id;

  // Parse properties from bracket notation
  const properties: Record<string, string> = {};
  if (bracketIdx >= 0) {
    const closeBracket = blockState.indexOf(']', bracketIdx);
    if (closeBracket > bracketIdx) {
      const propStr = blockState.slice(bracketIdx + 1, closeBracket);
      for (const pair of propStr.split(',')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          properties[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
        }
      }
    }
  }

  return { name, id, properties };
}

/**
 * Get the base block ID (without properties).
 * e.g. "minecraft:oak_stairs[facing=north]" => "minecraft:oak_stairs"
 */
export function getBaseId(blockState: string): string {
  const bracketIdx = blockState.indexOf('[');
  return bracketIdx >= 0 ? blockState.slice(0, bracketIdx) : blockState;
}

/**
 * Get the block name without namespace.
 * e.g. "minecraft:oak_stairs[facing=north]" => "oak_stairs"
 */
export function getBlockName(blockState: string): string {
  const base = getBaseId(blockState);
  const colonIdx = base.indexOf(':');
  return colonIdx >= 0 ? base.slice(colonIdx + 1) : base;
}

/**
 * Check if a block state is air.
 */
export function isAir(blockState: string): boolean {
  const base = getBaseId(blockState);
  return base === 'minecraft:air' || base === 'air' || base === 'minecraft:cave_air' || base === 'minecraft:void_air';
}

/**
 * Check if a block is transparent (for rendering visibility).
 */
export function isTransparent(blockState: string): boolean {
  if (isAir(blockState)) return true;
  const name = getBlockName(blockState);

  // Common transparent blocks
  const transparentBlocks = new Set([
    'glass', 'glass_pane', 'iron_bars', 'torch', 'wall_torch',
    'soul_torch', 'soul_wall_torch', 'lantern', 'soul_lantern',
    'chain', 'end_rod', 'flower_pot', 'candle', 'white_candle',
    'carpet', 'red_carpet', 'blue_carpet', 'white_carpet', 'purple_carpet',
    'black_carpet', 'yellow_carpet', 'cyan_carpet', 'magenta_carpet',
    'fence', 'dark_oak_fence', 'oak_fence', 'spruce_fence',
  ]);

  if (transparentBlocks.has(name)) return true;
  if (name.includes('glass')) return true;
  if (name.includes('carpet')) return true;
  if (name.includes('fence') && !name.includes('gate')) return true;
  if (name.includes('torch')) return true;
  if (name.includes('candle')) return true;

  return false;
}

/**
 * Check if a block is a solid full cube (for greedy meshing).
 */
export function isSolidBlock(blockState: string): boolean {
  if (isAir(blockState)) return false;
  const name = getBlockName(blockState);

  // Non-solid blocks
  if (name.includes('slab')) return false;
  if (name.includes('stairs')) return false;
  if (name.includes('fence')) return false;
  if (name.includes('wall') && !name.includes('wall_banner')) return false;
  if (name.includes('door')) return false;
  if (name.includes('trapdoor')) return false;
  if (name.includes('torch')) return false;
  if (name.includes('carpet')) return false;
  if (name.includes('glass_pane')) return false;
  if (name.includes('bars')) return false;
  if (name.includes('candle')) return false;
  if (name.includes('chain')) return false;
  if (name.includes('rod')) return false;
  if (name.includes('banner')) return false;
  if (name.includes('skull')) return false;
  if (name.includes('head')) return false;
  if (name.includes('bed')) return false;
  if (name.includes('pot')) return false;
  if (name.includes('campfire')) return false;
  if (name.includes('bell')) return false;
  if (name.includes('cluster')) return false;
  if (name.includes('bud')) return false;
  if (name.includes('button')) return false;
  if (name.includes('lever')) return false;
  if (name.includes('pressure_plate')) return false;
  if (name.includes('sign')) return false;

  return !isTransparent(blockState);
}

/**
 * Get the facing direction from a block state's properties.
 */
export function getFacing(blockState: string): string | undefined {
  const { properties } = parseBlockState(blockState);
  return properties['facing'];
}

/**
 * Get the axis from a block state (for logs).
 */
export function getAxis(blockState: string): string | undefined {
  const { properties } = parseBlockState(blockState);
  return properties['axis'];
}
