/**
 * Java Edition 1.19.4+ Display Entity Exporter.
 *
 * Converts a BlockGrid into a Minecraft Java .mcfunction file that summons
 * `minecraft:block_display` entities with exact floating-point translations
 * and scales, allowing sub-block precision 3D LEGO models in Java without mods.
 */

import type { BlockGrid } from '@craft/schem/types.js';
import { getPartDims } from './ldraw-part-dims.js';
import { ldrawColorToBlock } from './ldraw-colors.js';

export interface DisplayEntityBox {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  state: string;
}

export interface DisplayEntitiesResult {
  mcfunction: string;
  spawnCommand: string;
  boxCount: number;
}

/**
 * Greedy-mesh the BlockGrid into cuboid bounding boxes.
 */
export function gridToDisplayBoxes(grid: BlockGrid): DisplayEntityBox[] {
  const seen = new Uint8Array(grid.totalBlocks);
  const boxes: DisplayEntityBox[] = [];
  const at = (x: number, y: number, z: number) => (y * grid.length + z) * grid.width + x;

  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        const idx = at(x, y, z);
        const state = grid.get(x, y, z);
        if (seen[idx] || state === 'minecraft:air') continue;

        let sx = 1;
        while (x + sx < grid.width && !seen[at(x + sx, y, z)] && grid.get(x + sx, y, z) === state) {
          sx++;
        }

        let sz = 1;
        let ok = true;
        while (z + sz < grid.length && ok) {
          for (let xx = x; xx < x + sx; xx++) {
            if (seen[at(xx, y, z + sz)] || grid.get(xx, y, z + sz) !== state) {
              ok = false;
              break;
            }
          }
          if (ok) sz++;
        }

        let sy = 1;
        ok = true;
        while (y + sy < grid.height && ok) {
          for (let zz = z; zz < z + sz; zz++) {
            for (let xx = x; xx < x + sx; xx++) {
              if (seen[at(xx, y + sy, zz)] || grid.get(xx, y + sy, zz) !== state) {
                ok = false;
                break;
              }
            }
          }
          if (ok) sy++;
        }

        for (let yy = y; yy < y + sy; yy++) {
          for (let zz = z; zz < z + sz; zz++) {
            for (let xx = x; xx < x + sx; xx++) {
              seen[at(xx, yy, zz)] = 1;
            }
          }
        }

        boxes.push({ x, y, z, sx, sy, sz, state });
      }
    }
  }

  return boxes;
}

/**
 * Clean block state string for Java NBT `block_state: {Name: "..."}`.
 */
function parseBlockStateNbt(state: string): string {
  const bracket = state.indexOf('[');
  if (bracket === -1) {
    return `{Name:"${state}"}`;
  }
  const name = state.slice(0, bracket);
  const props = state.slice(bracket + 1, -1).split(',');
  const propsNbt = props
    .map(p => {
      const [k, v] = p.split('=');
      return `${k}:"${v}"`;
    })
    .join(',');
  return `{Name:"${name}",Properties:{${propsNbt}}}`;
}

/**
 * Build Java 1.19.4+ .mcfunction containing summon commands for block_display entities.
 */
export function buildDisplayEntitiesFunction(
  grid: BlockGrid,
  options: {
    tag?: string;
    scale?: number;
    originOffset?: [number, number, number];
  } = {}
): DisplayEntitiesResult {
  const boxes = gridToDisplayBoxes(grid);
  const tag = options.tag ?? 'craftmatic_model';
  const scale = options.scale ?? 1.0;
  const [ox, oy, oz] = options.originOffset ?? [
    -Math.floor(grid.width / 2) * scale,
    0,
    -Math.floor(grid.length / 2) * scale,
  ];

  const lines: string[] = [
    `# Craftmatic Java Display Entities Model`,
    `# Java Edition 1.19.4+ required (block_display entities)`,
    `# Total display boxes: ${boxes.length}`,
    `# Despawn previous: /kill @e[type=block_display,tag=${tag}]`,
    `kill @e[type=block_display,tag=${tag},distance=..64]`,
    ``,
  ];

  for (const b of boxes) {
    const tx = (ox + b.x * scale).toFixed(3);
    const ty = (oy + b.y * scale).toFixed(3);
    const tz = (oz + b.z * scale).toFixed(3);
    const sx = (b.sx * scale).toFixed(3);
    const sy = (b.sy * scale).toFixed(3);
    const sz = (b.sz * scale).toFixed(3);
    const blockNbt = parseBlockStateNbt(b.state);

    lines.push(
      `summon block_display ~${tx} ~${ty} ~${tz} {Tags:["${tag}"],block_state:${blockNbt},transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[${sx}f,${sy}f,${sz}f]}}`
    );
  }

  const mcfunction = lines.join('\n') + '\n';
  return {
    mcfunction,
    spawnCommand: `/function <namespace>:${tag}`,
    boxCount: boxes.length,
  };
}

/**
 * Convert row-major 3x3 rotation matrix to quaternion [qx, qy, qz, qw] for Java Display Entities.
 * LDraw has +Y down, Minecraft has +Y up: the change of basis is the half turn
 * about X, `F = diag(1, −1, −1)` (the same frame as the block grid,
 * `ldraw-geometry.ts`), so the rotation is conjugated, `F · R · F`, which
 * negates the four entries that mix X with Y or Z. A Y-only sign flip is a
 * reflection and placed every brick as its mirror image.
 */
export function matrixToQuaternion(r: number[]): [number, number, number, number] {
  const r00 = r[0], r01 = -r[1], r02 = -r[2];
  const r10 = -r[3], r11 = r[4], r12 = r[5];
  const r20 = -r[6], r21 = r[7], r22 = r[8];

  const trace = r00 + r11 + r22;
  let qx = 0, qy = 0, qz = 0, qw = 1;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    qw = 0.25 / s;
    qx = (r21 - r12) * s;
    qy = (r02 - r20) * s;
    qz = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r00 - r11 - r22);
    qw = (r21 - r12) / s;
    qx = 0.25 * s;
    qy = (r01 + r10) / s;
    qz = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r11 - r00 - r22);
    qw = (r02 - r20) / s;
    qx = (r01 + r10) / s;
    qy = 0.25 * s;
    qz = (r12 + r21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + r22 - r00 - r11);
    qw = (r10 - r01) / s;
    qx = (r02 + r20) / s;
    qy = (r12 + r21) / s;
    qz = 0.25 * s;
  }

  const len = Math.hypot(qx, qy, qz, qw);
  if (len > 1e-6) {
    qx /= len; qy /= len; qz /= len; qw /= len;
  }

  return [
    Math.round(qx * 10000) / 10000,
    Math.round(qy * 10000) / 10000,
    Math.round(qz * 10000) / 10000,
    Math.round(qw * 10000) / 10000,
  ];
}

/**
 * Direct LDraw-to-Java Display Entities Compiler.
 * Translates parsed LDraw bricks directly into minecraft:block_display entities
 * with sub-block fractional scales and exact rotations (Pillar 4).
 */
export function ldrawToDisplayEntities(
  bricks: Array<{ part: string; color: number; x: number; y: number; z: number; rot?: number[] }>,
  options: {
    tag?: string;
    scale?: number;
    originOffset?: [number, number, number];
  } = {}
): DisplayEntitiesResult {
  const tag = options.tag ?? 'craftmatic_model';
  // 1 stud = 20 LDU = 0.2 blocks in Minecraft (at 1:1 minifig scale)
  const lduToBlock = options.scale ?? (0.2 / 20);

  const xs = bricks.map(b => b.x), ys = bricks.map(b => b.y), zs = bricks.map(b => b.z);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const maxY = Math.max(...ys); // ground in LDraw (+Y is down)
  const midZ = (Math.min(...zs) + Math.max(...zs)) / 2;

  const [ox, oy, oz] = options.originOffset ?? [0, 0, 0];

  const lines: string[] = [
    `# Craftmatic Java Display Entities Model (Direct Non-Voxelized LDraw)`,
    `# Java Edition 1.19.4+ required (block_display entities)`,
    `# Total bricks: ${bricks.length}`,
    `# Despawn previous: /kill @e[type=block_display,tag=${tag}]`,
    `kill @e[type=block_display,tag=${tag},distance=..64]`,
    ``,
  ];

  for (const b of bricks) {
    const [sW, sH, sL] = getPartDims(b.part);

    const sx = (sW * 20 * lduToBlock).toFixed(3);
    const sy = (sH * 8 * lduToBlock).toFixed(3);
    const sz = (sL * 20 * lduToBlock).toFixed(3);

    // The block-grid frame (half turn about X): Y up, and Java +Z is LDraw −Z.
    const cx = (b.x - midX) * lduToBlock;
    const cy = (maxY - b.y) * lduToBlock;
    const cz = (midZ - b.z) * lduToBlock;

    const tx = (ox + cx).toFixed(3);
    const ty = (oy + cy).toFixed(3);
    const tz = (oz + cz).toFixed(3);

    const r = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const [qx, qy, qz, qw] = matrixToQuaternion(r);

    // Map color to closest concrete/glass block
    const isTrans = (b.color >= 33 && b.color <= 47) || b.color === 52 || b.color === 54 || b.color === 57 || b.color === 111 || b.color === 114;
    const blockState = isTrans ? 'minecraft:glass' : ldrawColorToBlock(b.color);
    const blockNbt = parseBlockStateNbt(blockState);

    lines.push(
      `summon block_display ~${tx} ~${ty} ~${tz} {Tags:["${tag}"],block_state:${blockNbt},transformation:{left_rotation:[${qx}f,${qy}f,${qz}f,${qw}f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[${sx}f,${sy}f,${sz}f]}}`
    );
  }

  const mcfunction = lines.join('\n') + '\n';
  return {
    mcfunction,
    spawnCommand: `/function <namespace>:${tag}`,
    boxCount: bricks.length,
  };
}
