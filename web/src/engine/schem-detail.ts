/**
 * Shape-aware detail post-processor for voxelized LEGO models.
 * Ported and enhanced from HotSchem (Phase 1).
 *
 * Smooths block-staircased slopes into real Minecraft stairs (and optional top-caps into slabs),
 * adding dramatic apparent detail so a smaller/coarser voxelization reads as sleek and detailed.
 *
 * Colored concrete/wool/terracotta have no vanilla stair or slab forms in Minecraft.
 * This pass maps each color to its closest tonally-matched stair/slab material.
 * Only exposed surface voxels on a clear step edge are upgraded; interior voxels and unmapped
 * materials remain full cubes.
 */

import type { BlockGrid } from '@craft/schem/types.js';

export const DETAIL_MATERIALS: Readonly<Record<string, string>> = {
  white: 'quartz',
  light_gray: 'polished_diorite',
  gray: 'cobbled_deepslate', // Cobbled deepslate matches both Java and Bedrock (Bedrock stone_stairs is cobblestone)
  black: 'blackstone',
  brown: 'mud_brick',
  red: 'brick',
  orange: 'waxed_cut_copper',
  yellow: 'sandstone',
  purple: 'purpur',
  magenta: 'purpur',
  pink: 'purpur',
  green: 'mossy_stone_brick',
  lime: 'mossy_stone_brick',
  cyan: 'prismarine',
  blue: 'warped',
  light_blue: 'prismarine',
};

const DIRS = [
  { d: 'east', dx: 1, dz: 0 },
  { d: 'west', dx: -1, dz: 0 },
  { d: 'south', dx: 0, dz: 1 },
  { d: 'north', dx: 0, dz: -1 },
] as const;

export function isAirState(s: string | null | undefined): boolean {
  return !s || /(?:^|:)(?:air|cave_air|void_air)(?:\[|$)/.test(s);
}

/** Color family of a block state, or null if not an upgradeable colored solid. */
export function colorBaseOf(state: string): string | null {
  const name = state.split('[', 1)[0]!.replace(/^minecraft:/, '');
  const m = /^([a-z_]+)_(concrete|wool|terracotta|concrete_powder)$/.exec(name);
  return m ? m[1]! : null;
}

export interface DetailMaterialsOptions {
  stairs?: boolean;
  slabs?: boolean;
}

export interface DetailMaterialsStats {
  stairs: number;
  slabs: number;
  skippedNoMaterial: number;
  byFacing: Record<string, number>;
}

export function applyDetailMaterials(
  grid: BlockGrid,
  opts: DetailMaterialsOptions = {},
): DetailMaterialsStats {
  const { stairs = true, slabs = false } = opts;
  const stats: DetailMaterialsStats = { stairs: 0, slabs: 0, skippedNoMaterial: 0, byFacing: {} };
  if (!stairs && !slabs) return stats;

  const W = grid.width, H = grid.height, L = grid.length;
  const isSolid = (x: number, y: number, z: number): boolean => {
    if (x < 0 || x >= W || y < 0 || y >= H || z < 0 || z >= L) return false;
    return !isAirState(grid.get(x, y, z));
  };

  // Process a snapshot to avoid order-dependent cascading changes.
  const upgrades: Array<{ x: number; y: number; z: number; state: string; facing?: string; isSlab?: boolean }> = [];

  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const state = grid.get(x, y, z);
        if (isAirState(state)) continue;

        const base = colorBaseOf(state);
        if (!base) continue;

        const mat = DETAIL_MATERIALS[base];
        const up = isSolid(x, y + 1, z);
        const down = isSolid(x, y - 1, z);

        if (stairs) {
          // Normal stair: top exposed, down is solid, steps down in 1 horizontal dir.
          if (!up && down) {
            const matches = DIRS.filter(({ dx, dz }) =>
              !isSolid(x + dx, y, z + dz) &&
              isSolid(x + dx, y - 1, z + dz) &&
              isSolid(x - dx, y, z - dz),
            );
            if (matches.length === 1) {
              if (!mat) { stats.skippedNoMaterial++; continue; }
              const facing = matches[0]!.d;
              upgrades.push({
                x, y, z,
                state: `minecraft:${mat}_stairs[facing=${facing},half=bottom,shape=straight]`,
                facing,
              });
              continue;
            }
          }

          // Inverted stair (overhang/underside): bottom exposed, up is solid, steps up in 1 dir.
          if (!down && up) {
            const matches = DIRS.filter(({ dx, dz }) =>
              !isSolid(x + dx, y, z + dz) &&
              isSolid(x + dx, y + 1, z + dz) &&
              isSolid(x - dx, y, z - dz),
            );
            if (matches.length === 1) {
              if (!mat) { stats.skippedNoMaterial++; continue; }
              const facing = matches[0]!.d;
              upgrades.push({
                x, y, z,
                state: `minecraft:${mat}_stairs[facing=${facing},half=top,shape=straight]`,
                facing,
              });
              continue;
            }
          }
        }

        if (slabs) {
          // Flat top cap: top exposed, down solid, all 4 horizontal neighbors solid.
          if (!up && down && DIRS.every(({ dx, dz }) => isSolid(x + dx, y, z + dz))) {
            if (!mat) { stats.skippedNoMaterial++; continue; }
            upgrades.push({
              x, y, z,
              state: `minecraft:${mat}_slab[type=bottom]`,
              isSlab: true,
            });
          }
        }
      }
    }
  }

  for (const u of upgrades) {
    grid.set(u.x, u.y, u.z, u.state);
    if (u.isSlab) {
      stats.slabs++;
    } else {
      stats.stairs++;
      if (u.facing) {
        stats.byFacing[u.facing] = (stats.byFacing[u.facing] ?? 0) + 1;
      }
    }
  }

  return stats;
}
