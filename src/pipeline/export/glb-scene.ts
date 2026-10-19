/**
 * Stage 8b — scene GLB export.
 *
 * The scene GLB is not 3D-printable (not required to be watertight). It
 * combines the building with environment meshes so the output is a
 * visualization-ready artifact.
 *
 * Current environment layer (MVP):
 *   • Ground plane: quad the size of the tile bbox, at y=0
 *   • Trees: small instanced boxes at JointEvidence.trees positions
 *   • Roads: flat polyline strips at y=0.05
 *
 * A richer terrain-from-heightmap implementation is deferred (the heightmap
 * from Stage 3 is available; this function accepts it and can be extended
 * to triangulate it as a follow-up).
 */

import { evaluateBRep, type BuildingBRep } from '../synthesis/brep.js';
import type { JointEvidence, TreeInstance } from '../fusion/types.js';
import type { MeshInput } from './glb-writer.js';
import { buildGlb } from './glb-writer.js';

export interface SceneGlbOptions {
  /** Bounds of the scene footprint, metres, relative to building origin. Default 100×100. */
  readonly sceneExtentM?: number;
  /** Include ground plane. Default true. */
  readonly ground?: boolean;
  /** Include tree instances. Default true. */
  readonly trees?: boolean;
  readonly generator?: string;
}

export interface SceneGlbResult {
  readonly glbBytes: ArrayBuffer;
  readonly meshCount: number;
  readonly treeCount: number;
}

// ─── Mesh builders ─────────────────────────────────────────────────────────

function buildGroundPlane(extentM: number): MeshInput {
  const half = extentM / 2;
  const position = new Float32Array([
    -half, 0, -half,
     half, 0, -half,
     half, 0,  half,
    -half, 0,  half,
  ]);
  const index = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return {
    position, index,
    baseColorFactor: [0.3, 0.5, 0.25, 1], // grass-ish green
    groupName: 'ground',
    materialName: 'ground_plane',
  };
}

/**
 * One small box per tree. Not instanced (keeps writer simple); for large
 * numbers of trees a follow-up can add glTF EXT_mesh_gpu_instancing.
 */
function buildTreeBoxes(trees: readonly TreeInstance[], origin: { lat: number; lng: number }): MeshInput[] {
  const DEG2RAD = Math.PI / 180;
  const METERS_PER_DEG_LAT = 111_111;
  const cosLat = Math.cos(origin.lat * DEG2RAD);
  return trees.map((tree, i) => {
    const dx = (tree.position.lon - origin.lng) * METERS_PER_DEG_LAT * cosLat;
    const dz = -(tree.position.lat - origin.lat) * METERS_PER_DEG_LAT;
    const r = tree.radiusM;
    const h = r * 2; // tree height proportional to canopy radius
    // Position cube: bottom at y=0, extending up to y=h
    const position = new Float32Array([
      dx - r, 0, dz - r,   dx + r, 0, dz - r,   dx + r, 0, dz + r,   dx - r, 0, dz + r,
      dx - r, h, dz - r,   dx + r, h, dz - r,   dx + r, h, dz + r,   dx - r, h, dz + r,
    ]);
    const index = new Uint32Array([
      0, 1, 2,  0, 2, 3,    // bottom
      4, 6, 5,  4, 7, 6,    // top (reversed)
      0, 4, 5,  0, 5, 1,    // south
      1, 5, 6,  1, 6, 2,    // east
      2, 6, 7,  2, 7, 3,    // north
      3, 7, 4,  3, 4, 0,    // west
    ]);
    return {
      position, index,
      baseColorFactor: [0.12, 0.32, 0.12, 1],
      groupName: `tree_${i}`,
      materialName: `tree_${tree.source}`,
    };
  });
}

// ─── Main export ───────────────────────────────────────────────────────────

export async function exportSceneGlb(
  brep: BuildingBRep,
  evidence: JointEvidence,
  opts: SceneGlbOptions = {},
): Promise<SceneGlbResult> {
  const sceneExtentM = opts.sceneExtentM ?? 100;
  const includeGround = opts.ground ?? true;
  const includeTrees = opts.trees ?? true;

  const meshes: MeshInput[] = [];

  // Building (evaluated BRep)
  const mesh = await evaluateBRep(brep);
  meshes.push({
    position: mesh.positions,
    index: mesh.indices,
    baseColorFactor: [0.7, 0.7, 0.7, 1],
    groupName: 'building',
    materialName: 'building',
  });

  if (includeGround) {
    meshes.push(buildGroundPlane(sceneExtentM));
  }

  let treeCount = 0;
  if (includeTrees && evidence.trees.length > 0) {
    const treeMeshes = buildTreeBoxes(evidence.trees, brep.origin);
    meshes.push(...treeMeshes);
    treeCount = treeMeshes.length;
  }

  const glbBytes = buildGlb(meshes, { generator: opts.generator ?? 'craftmatic-scene' });
  return { glbBytes, meshCount: meshes.length, treeCount };
}
