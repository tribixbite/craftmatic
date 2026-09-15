/**
 * Ghost preview entity for the Brick Wand: a translucent, coarse copy of the
 * whole placement (scenery blocks plus every vehicle component at its scene
 * position) that the wand spawns at the pinned origin and turns with the
 * chosen rotation, so the player sees the SHAPE and the ORIENTATION before
 * placing - the particle outline only ever showed a box and an arrow.
 *
 * Geometry: the scene occupancy is coarsened by an integer factor until the
 * greedy box cover fits `maxCubes`, then written as Bedrock cuboids relative
 * to the model's footprint centre. Frame: the entity is spawned at the
 * rotated footprint centre with yaw = the wand rotation; a world offset
 * (dx, dy, dz) from that centre is authored as JSON (-dx, dy, -dz), the same
 * X mirror the vehicle compiler uses plus the game's own 180° turn at yaw 0
 * (model -Z faces world +Z), so at yaw 0 the ghost covers exactly the cells
 * the structure tiles will occupy and at 90° it turns with them (the tile
 * rotation and Bedrock's yaw both map a centre-relative (px, pz) to (-pz, px)).
 */

import { BlockGrid } from '@craft/schem/types.js';
import { encodePngRgba } from './lego-resource-pack.js';
import { PACK_NAMESPACE } from './mcpack.js';

export interface PreviewComponentPlacement {
  grid: BlockGrid;
  /** Scene blocks per component cell. */
  scale: number;
  /** Component centre in scene blocks (x/z) and its floor (y). */
  x: number;
  y: number;
  z: number;
}

export interface PreviewGhostOptions {
  /** Cuboid cap for the whole ghost (mobile-safe default 1,536). */
  maxCubes?: number;
  /** RGBA tint of the ghost. */
  tint?: [number, number, number, number];
}

export interface PreviewGhostAssets {
  typeId: string;
  /** Geometry identifiers, one per ≤1,024-cube mesh. */
  meshIds: string[];
  geometry: unknown;
  behavior: unknown;
  clientEntity: unknown;
  renderControllers: unknown;
  texturePng: Uint8Array;
  cubeCount: number;
  /** Scene blocks per ghost cell. */
  factor: number;
  /** Footprint (scene blocks) the ghost represents. */
  size: { width: number; height: number; length: number };
}

interface Box { x: number; y: number; z: number; sx: number; sy: number; sz: number }

/** Greedy axis-aligned box cover of an occupancy bitmap (same sweep as the entity fallback's `greedyBoxes`). */
export function coverBoxes(occ: Uint8Array, w: number, h: number, l: number): Box[] {
  const seen = new Uint8Array(occ.length);
  const at = (x: number, y: number, z: number): number => (y * l + z) * w + x;
  const boxes: Box[] = [];
  for (let y = 0; y < h; y++) for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const i = at(x, y, z);
    if (seen[i] || !occ[i]) continue;
    let sx = 1;
    while (x + sx < w && !seen[at(x + sx, y, z)] && occ[at(x + sx, y, z)]) sx++;
    let sz = 1, ok = true;
    while (z + sz < l && ok) {
      for (let xx = x; xx < x + sx; xx++) if (seen[at(xx, y, z + sz)] || !occ[at(xx, y, z + sz)]) { ok = false; break; }
      if (ok) sz++;
    }
    let sy = 1;
    ok = true;
    while (y + sy < h && ok) {
      for (let zz = z; zz < z + sz && ok; zz++) for (let xx = x; xx < x + sx; xx++) if (seen[at(xx, y + sy, zz)] || !occ[at(xx, y + sy, zz)]) { ok = false; break; }
      if (ok) sy++;
    }
    for (let yy = y; yy < y + sy; yy++) for (let zz = z; zz < z + sz; zz++) for (let xx = x; xx < x + sx; xx++) seen[at(xx, yy, zz)] = 1;
    boxes.push({ x, y, z, sx, sy, sz });
  }
  return boxes;
}

/**
 * Occupancy of the scene at `factor` blocks per cell: scenery cells plus
 * every component cell mapped through its scene position and scale.
 */
export function sceneOccupancy(scenery: BlockGrid, components: PreviewComponentPlacement[], factor: number): { occ: Uint8Array; w: number; h: number; l: number } {
  const w = Math.max(1, Math.ceil(scenery.width / factor)), h = Math.max(1, Math.ceil(scenery.height / factor)), l = Math.max(1, Math.ceil(scenery.length / factor));
  const occ = new Uint8Array(w * h * l);
  const mark = (bx: number, by: number, bz: number): void => {
    const x = Math.floor(bx / factor), y = Math.floor(by / factor), z = Math.floor(bz / factor);
    if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= l) return;
    occ[(y * l + z) * w + x] = 1;
  };
  for (let y = 0; y < scenery.height; y++) for (let z = 0; z < scenery.length; z++) for (let x = 0; x < scenery.width; x++) {
    if (scenery.get(x, y, z) !== 'minecraft:air') mark(x, y, z);
  }
  for (const c of components) {
    const g = c.grid, s = c.scale;
    for (let y = 0; y < g.height; y++) for (let z = 0; z < g.length; z++) for (let x = 0; x < g.width; x++) {
      if (g.get(x, y, z) === 'minecraft:air') continue;
      // A component cell covers `s` scene blocks per side; mark each one.
      const x0 = c.x + (x - g.width / 2) * s, y0 = c.y + y * s, z0 = c.z + (z - g.length / 2) * s;
      for (let dy = 0; dy < Math.max(1, s); dy++) for (let dz = 0; dz < Math.max(1, s); dz++) for (let dx = 0; dx < Math.max(1, s); dx++) mark(x0 + dx + 0.001, y0 + dy + 0.001, z0 + dz + 0.001);
    }
  }
  return { occ, w, h, l };
}

/** Bedrock cuboid for a ghost box, relative to the footprint centre (blocks → 16 units). */
export function ghostCube(box: Box, factor: number, centre: { x: number; z: number }): { origin: [number, number, number]; size: [number, number, number]; uv: Record<string, { uv: [number, number]; uv_size: [number, number] }> } {
  const ax = box.x * factor - centre.x, bx = (box.x + box.sx) * factor - centre.x;
  const az = box.z * factor - centre.z, bz = (box.z + box.sz) * factor - centre.z;
  const ay = box.y * factor, by = (box.y + box.sy) * factor;
  const face = { uv: [0, 0] as [number, number], uv_size: [16, 16] as [number, number] };
  return {
    // World offset (dx, dz) → JSON (−dx, −dz): the min corner is the negated max.
    origin: [-bx * 16, ay * 16, -bz * 16],
    size: [(bx - ax) * 16, (by - ay) * 16, (bz - az) * 16],
    uv: { north: face, south: face, east: face, west: face, up: face, down: face },
  };
}

export function buildPreviewGhost(id: string, scenery: BlockGrid, components: PreviewComponentPlacement[], options: PreviewGhostOptions = {}): PreviewGhostAssets {
  const maxCubes = options.maxCubes ?? 1536;
  const tint = options.tint ?? [150, 215, 255, 118];
  const typeId = `${PACK_NAMESPACE}:${id}_preview`;
  let factor = 1, boxes: Box[] = [];
  for (;;) {
    const { occ, w, h, l } = sceneOccupancy(scenery, components, factor);
    boxes = coverBoxes(occ, w, h, l);
    if (boxes.length <= maxCubes || factor >= 64) break;
    factor *= 2;
  }
  const centre = { x: scenery.width / 2, z: scenery.length / 2 };
  const cubes = boxes.map(b => ghostCube(b, factor, centre));
  const size = { width: scenery.width, height: scenery.height, length: scenery.length };
  const meshIds: string[] = [];
  const meshes: unknown[] = [];
  const chunk = 1024;
  for (let offset = 0; offset < Math.max(1, cubes.length); offset += chunk) {
    const meshId = `geometry.${PACK_NAMESPACE}.${id}_preview_${meshIds.length}`;
    meshIds.push(meshId);
    meshes.push({
      description: {
        identifier: meshId, texture_width: 16, texture_height: 16,
        visible_bounds_width: Math.max(4, Math.max(size.width, size.length) + 2),
        visible_bounds_height: Math.max(4, size.height + 2),
        visible_bounds_offset: [0, size.height / 2, 0],
      },
      bones: [{ name: 'ghost', pivot: [0, 0, 0], cubes: cubes.slice(offset, offset + chunk) }],
    });
  }
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 256; i++) rgba.set(tint, i * 4);
  const materials: Record<string, string> = { default: 'entity_alphablend' };
  const geometryMap: Record<string, string> = {};
  meshIds.forEach((m, i) => { geometryMap[`mesh_${i}`] = m; });
  const controllers: Record<string, unknown> = {};
  meshIds.forEach((_, i) => { controllers[`controller.render.${PACK_NAMESPACE}.${id}_preview_${i}`] = { geometry: `Geometry.mesh_${i}`, materials: [{ '*': 'Material.default' }], textures: ['Texture.default'] }; });
  return {
    typeId, meshIds, cubeCount: cubes.length, factor, size,
    geometry: { format_version: '1.12.0', 'minecraft:geometry': meshes },
    behavior: {
      format_version: '1.26.30',
      'minecraft:entity': {
        description: { identifier: typeId, is_spawnable: false, is_summonable: true },
        components: {
          'minecraft:type_family': { family: ['craftmatic_preview'] },
          'minecraft:collision_box': { width: 0.1, height: 0.1 },
          'minecraft:physics': { has_gravity: false, has_collision: false },
          'minecraft:pushable': { is_pushable: false, is_pushable_by_piston: false },
          'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
          'minecraft:fire_immune': {},
          'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 400, max_dropped_ticks: 10, use_motion_prediction_hints: false } },
          // Not persistent: a ghost left behind by a crash despawns with distance; the wand also sweeps them on load.
          'minecraft:despawn': { despawn_from_distance: {} },
        },
      },
    },
    clientEntity: {
      format_version: '1.10.0',
      'minecraft:client_entity': {
        description: {
          identifier: typeId, materials, textures: { default: `textures/entity/${id}_preview` }, geometry: geometryMap,
          render_controllers: meshIds.map((_, i) => `controller.render.${PACK_NAMESPACE}.${id}_preview_${i}`),
        },
      },
    },
    renderControllers: { format_version: '1.8.0', render_controllers: controllers },
    texturePng: encodePngRgba(16, 16, rgba),
  };
}
