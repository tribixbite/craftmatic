/**
 * Stage 8a — printable GLB export.
 *
 * Takes a `BuildingBRep`, evaluates it via manifold-3d, and writes a glTF 2.0
 * binary with named scene groups:
 *   • `group_structural` — the watertight + manifold building volume
 *   • `group_fixtures`   — non-structural meshes (windowpanes, decorations)
 *   • `group_plinth`     — optional pedestal for stand-alone printing
 *
 * Objective gates in Stage 9 are run on `group_structural` only (fixtures
 * may be thin / non-manifold).
 */

import type { BuildingBRep } from '../synthesis/brep.js';
import { evaluateBRep } from '../synthesis/brep.js';
import type { MeshInput } from './glb-writer.js';
import { buildGlb } from './glb-writer.js';
import type { LocalPoint2D } from '../context/types.js';

export interface PrintGlbOptions {
  /** Include a 5mm-thick plinth under the building footprint. Default false. */
  readonly plinth?: boolean;
  /** Plinth margin around footprint, metres. Default 0.02 (2cm). */
  readonly plinthMarginM?: number;
  readonly generator?: string;
}

export interface PrintGlbResult {
  readonly glbBytes: ArrayBuffer;
  readonly structuralPositions: Float32Array;
  readonly structuralIndices: Uint32Array;
  readonly structuralVolume: number;
  readonly watertight: boolean;
  readonly hasPlinth: boolean;
}

function labToColor(lab: readonly [number, number, number]): readonly [number, number, number, number] {
  // Shortcut: convert Lab L to a neutral grey in sRGB. Full Lab→RGB is in
  // parametric.ts; here we just need a visually plausible tint so the GLB
  // looks right in viewers. The voxel exporter uses the Lab + block mapping
  // for authoritative colouring.
  const L = Math.max(0, Math.min(100, lab[0])) / 100;
  return [L, L, L, 1] as const;
}

function buildPlinthMesh(
  footprint: readonly LocalPoint2D[],
  thicknessM: number,
  marginM: number,
): MeshInput {
  // Inflate polygon by marginM
  const cx = footprint.reduce((s, p) => s + p.x, 0) / footprint.length;
  const cz = footprint.reduce((s, p) => s + p.z, 0) / footprint.length;
  const inflated = footprint.map(p => {
    const dx = p.x - cx, dz = p.z - cz;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return p;
    const scale = (dist + marginM) / dist;
    return { x: cx + dx * scale, z: cz + dz * scale };
  });

  // Build a prism — two polygons (top + bottom), connected by quads (as tri
  // pairs). We build it as triangles to stay compatible with buildGlb.
  const n = inflated.length;
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3 + 0] = inflated[i].x;
    positions[i * 3 + 1] = -thicknessM;        // bottom Y
    positions[i * 3 + 2] = inflated[i].z;
    positions[(n + i) * 3 + 0] = inflated[i].x;
    positions[(n + i) * 3 + 1] = 0;            // top Y — sits at ground level
    positions[(n + i) * 3 + 2] = inflated[i].z;
  }
  // Triangulate top as a fan from vertex 0
  const topTris: number[] = [];
  for (let i = 1; i < n - 1; i++) topTris.push(n + 0, n + i, n + i + 1);
  // Bottom as reverse fan
  const botTris: number[] = [];
  for (let i = 1; i < n - 1; i++) botTris.push(0, i + 1, i);
  // Side quads (as tri pairs)
  const sideTris: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n;
    const c = n + b, d = n + a;
    sideTris.push(a, b, c, a, c, d);
  }
  const index = new Uint32Array([...topTris, ...botTris, ...sideTris]);
  return {
    position: positions,
    index,
    baseColorFactor: [0.2, 0.2, 0.2, 1],
    groupName: 'group_plinth',
    materialName: 'plinth',
  };
}

export async function exportPrintGlb(
  brep: BuildingBRep,
  opts: PrintGlbOptions = {},
): Promise<PrintGlbResult> {
  const mesh = await evaluateBRep(brep);

  const structural: MeshInput = {
    position: mesh.positions,
    index: mesh.indices,
    baseColorFactor: labToColor(brep.materials.wall.lab),
    groupName: 'group_structural',
    materialName: 'building',
  };
  const meshes: MeshInput[] = [structural];
  const minecraftBlocks: Array<string | undefined> = [brep.materials.wall.blockName];

  let hasPlinth = false;
  if (opts.plinth) {
    const topFootprint = brep.floors[0]?.polygon ?? brep.roof.polygon;
    const plinth = buildPlinthMesh(topFootprint, 0.005, opts.plinthMarginM ?? 0.02);
    meshes.push(plinth);
    minecraftBlocks.push('minecraft:smooth_stone');
    hasPlinth = true;
  }

  const glbBytes = buildGlb(meshes, {
    generator: opts.generator ?? 'craftmatic-print',
    minecraftBlocks,
  });

  return {
    glbBytes,
    structuralPositions: mesh.positions,
    structuralIndices: mesh.indices,
    structuralVolume: mesh.volume,
    watertight: mesh.watertight,
    hasPlinth,
  };
}
