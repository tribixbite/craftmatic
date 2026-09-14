/**
 * Java Edition 1.19.4+ Display Entity Exporter.
 *
 * Converts a BlockGrid into a Minecraft Java .mcfunction file that summons
 * `minecraft:block_display` entities with exact floating-point translations
 * and scales, allowing sub-block precision 3D LEGO models in Java without mods.
 */

import type { BlockGrid } from '@craft/schem/types.js';

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
