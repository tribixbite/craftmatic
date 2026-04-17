/**
 * Stage 3 — Google 3D Tiles capture into a `TileEvidence`.
 *
 * Orchestrates:
 *   1. Polyfill install + DRACO loader (via `tiles-deps.ts`)
 *   2. TilesRenderer + GoogleCloud auth + Reorientation
 *   3. Tile loading loop until stable (stats.downloading == 0 for N frames)
 *   4. Optional multi-angle + vertical-band capture for high-LOD facades
 *   5. Mesh filtering (XZ cylindrical radius + vertex bbox span threshold)
 *   6. Heightmap rasterization + bbox measurement
 *   7. GLB export (via shared `glb-writer.ts`)
 *
 * Pure-ish: the function is async and touches Three.js + network + filesystem,
 * but it does NOT touch `BuildingContext` directly — only consumes the subset
 * of fields it needs, so tests can stub without constructing full contexts.
 *
 * Lifted from `scripts/tiles-headless.ts`. The legacy script will be rewritten
 * as a thin wrapper over this function in Task 2.3.
 */

import * as THREE from 'three';
import { writeFile as fsWriteFile } from 'node:fs/promises';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  ReorientationPlugin,
  GLTFExtensionsPlugin,
} from '3d-tiles-renderer/plugins';

import {
  FIVE_ANGLE_PRESET,
  positionCameraForAngle,
  waitForStable,
  getAlignedAngles,
} from '../../convert/multi-angle-capture.js';

import { installNodePolyfills, createDracoLoader } from './tiles-deps.js';
import { extractMeshInputs } from './mesh-extract.js';
import {
  BboxAccumulator,
  addPositionsToHeightmap,
  createHeightmapState,
  encodeHeightmapSidecar,
  isHeightTruncated,
  normaliseHeightmap,
} from './heightmap.js';
import { buildGlb } from '../export/glb-writer.js';
import type { CaptureProgressFn, TileEvidence } from './types.js';

// ─── Input types ───────────────────────────────────────────────────────────

export interface CaptureTilesInput {
  /** Target centre. Reorientation plugin places this at scene origin. */
  readonly center: { readonly lat: number; readonly lng: number };
  /** Capture radius in metres (cylindrical XZ filter). From `profile.tiles.radiusM`. */
  readonly radiusM: number;
  /** Tile LOD error target. Lower = higher detail. From profile. */
  readonly errorTarget: number;
  /** How many vertical bands of height-100m to capture. `1` = single pass. */
  readonly verticalBands: number;
  /** ortho / perspective / street camera framing. */
  readonly cameraMode: 'ortho' | 'perspective' | 'street';
  /** Expected building height in metres (for camera sizing + truncation flag). */
  readonly expectedHeightM: number;
  /** Building MBR rotation in degrees (clockwise from north). `null` = no rotation known. */
  readonly rotationDeg: number | null;
  /** Google Maps/3D Tiles API key. */
  readonly apiKey: string;
  /** Project root — used to locate bundled DRACO decoder. */
  readonly projectRoot: string;
  /** Optional: when set, write `.glb` and `.heightmap.bin` sidecar to disk. */
  readonly outputPath?: string;
  /** Stable-frame threshold before tile loading is considered complete. Default 100. */
  readonly stableThreshold?: number;
  /** Max wall-clock milliseconds to wait for tile loading. Default 120_000. */
  readonly timeoutMs?: number;
  readonly onProgress?: CaptureProgressFn;
}

// ─── Implementation ────────────────────────────────────────────────────────

export async function captureTiles(input: CaptureTilesInput): Promise<TileEvidence> {
  installNodePolyfills();

  const { center, radiusM, errorTarget, cameraMode, expectedHeightM, rotationDeg, apiKey, projectRoot } = input;
  const verticalBands = Math.max(1, input.verticalBands);
  const stableThreshold = input.stableThreshold ?? 100;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const onProgress = input.onProgress ?? (() => { /* noop */ });

  // ── Camera ─────────────────────────────────────────────────────────────
  const camera = buildCamera(cameraMode, radiusM, expectedHeightM);
  camera.updateMatrixWorld(true);

  // ── TilesRenderer ──────────────────────────────────────────────────────
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, useRecommendedSettings: false }));
  tiles.registerPlugin(new ReorientationPlugin({
    lat: center.lat * THREE.MathUtils.DEG2RAD,
    lon: center.lng * THREE.MathUtils.DEG2RAD,
    height: 0,
    recenter: true,
  }));

  const dracoLoader = await createDracoLoader(projectRoot);
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }));

  tiles.errorTarget = errorTarget;
  tiles.setCamera(camera);
  tiles.setResolution(camera, 512, 512);

  // ── Load tiles (wait for stable) ───────────────────────────────────────
  onProgress({ stage: 'tiles', message: 'loading tiles…', ratio: 0 });
  await waitForTileLoad(tiles as unknown as TilesLike, camera, stableThreshold, timeoutMs, (msg, r) => {
    onProgress({ stage: 'tiles', message: msg, ratio: r });
  });

  // ── Extract meshes (with optional multi-angle band sweep) ──────────────
  const group = new THREE.Group();
  const capturedUUIDs = new Set<string>();
  const stats = { tested: 0, captured: 0, rejected: 0 };

  extractMeshesInto(group, capturedUUIDs, tiles.group, radiusM, stats);

  if (verticalBands > 0 && input.cameraMode === 'perspective' && expectedHeightM > 15) {
    onProgress({ stage: 'tiles', message: 'multi-angle band sweep', ratio: 0.5 });
    const bandHeight = 100;
    const numBands = verticalBands;
    const bandCamDist = Math.max(radiusM * 2, 80);
    const allAngles = rotationDeg !== null ? getAlignedAngles(rotationDeg) : FIVE_ANGLE_PRESET;
    const facadeAngles = allAngles.filter((a: { name: string }) => a.name !== 'top-down');

    for (let band = 0; band < numBands; band++) {
      const bandCenterY = band * bandHeight + bandHeight * 0.4;
      for (const angle of facadeAngles) {
        const centerVec = new THREE.Vector3(0, bandCenterY, 0);
        positionCameraForAngle(camera, centerVec, angle, bandCamDist);
        tiles.setCamera(camera);
        tiles.setResolution(camera, 512, 512);
        await waitForStable(
          tiles as unknown as { stats: Record<string, number>; update: () => void },
          30_000,
          30,
          () => { /* suppressed */ },
        );
        extractMeshesInto(group, capturedUUIDs, tiles.group, radiusM, stats);
      }
    }
  }

  const meshCount = stats.captured;
  const noCoverage = meshCount < 3;
  onProgress({ stage: 'tiles', message: `${meshCount} meshes captured`, ratio: 0.85 });

  // ── Bbox + heightmap ───────────────────────────────────────────────────
  const bboxAcc = new BboxAccumulator();
  const meshesForExtract: THREE.Mesh[] = [];
  group.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      meshesForExtract.push(m);
      const geo = m.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos) bboxAcc.addPositions(new Float32Array(pos.array));
    }
  });
  const measuredBbox = bboxAcc.get() ?? { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  const hmState = createHeightmapState(measuredBbox, 1);
  if (hmState) {
    for (const mesh of meshesForExtract) {
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos) addPositionsToHeightmap(hmState, new Float32Array(pos.array));
    }
    normaliseHeightmap(hmState);
  }

  const truncated = isHeightTruncated(measuredBbox, expectedHeightM);

  // ── GLB export ─────────────────────────────────────────────────────────
  onProgress({ stage: 'tiles', message: 'encoding GLB', ratio: 0.9 });
  const meshInputs = await extractMeshInputs(meshesForExtract);
  const glbBytes = buildGlb(meshInputs, { generator: 'craftmatic-capture-tiles' });

  // ── Optional disk write ────────────────────────────────────────────────
  let glbPath: string | null = null;
  if (input.outputPath) {
    glbPath = input.outputPath;
    await fsWriteFile(glbPath, Buffer.from(glbBytes));
    if (hmState) {
      const sidecarPath = glbPath.replace(/\.glb$/, '.heightmap.bin');
      await fsWriteFile(sidecarPath, Buffer.from(encodeHeightmapSidecar(hmState)));
    }
  }

  // Cleanup — safe even if tiles.dispose() throws on some paths.
  try { tiles.dispose(); } catch { /* noop */ }

  onProgress({ stage: 'tiles', message: 'done', ratio: 1 });

  return {
    glbPath,
    glbBytes,
    heightmap: hmState?.heights ?? new Float32Array(0),
    heightmapWidth: hmState?.width ?? 0,
    heightmapLength: hmState?.length ?? 0,
    measuredBbox: {
      min: { x: measuredBbox.minX, y: measuredBbox.minY, z: measuredBbox.minZ },
      max: { x: measuredBbox.maxX, y: measuredBbox.maxY, z: measuredBbox.maxZ },
    },
    truncated,
    meshCount,
    noCoverage,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildCamera(
  mode: 'ortho' | 'perspective' | 'street',
  radiusM: number,
  expectedHeightM: number,
): THREE.Camera {
  if (mode === 'ortho') {
    const halfExtent = radiusM * 1.5;
    const camY = Math.max(500, expectedHeightM * 1.2 + 50);
    const cam = new THREE.OrthographicCamera(-halfExtent, halfExtent, halfExtent, -halfExtent, 1, camY + 500);
    cam.position.set(0, camY, 0);
    cam.lookAt(0, 0, 0);
    return cam;
  }
  if (mode === 'perspective') {
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 4000);
    const dist = radiusM * 2;
    cam.position.set(dist * 0.7, dist, dist * 0.7);
    cam.lookAt(0, radiusM * 0.3, 0);
    return cam;
  }
  // street
  const cam = new THREE.PerspectiveCamera(60, 1, 1, 4000);
  cam.position.set(0, 8, 8);
  cam.lookAt(0, 0, 0);
  return cam;
}

interface TilesLike {
  stats: Record<string, number>;
  update: () => void;
}

async function waitForTileLoad(
  tiles: TilesLike,
  camera: THREE.Camera,
  stableThreshold: number,
  timeoutMs: number,
  log: (msg: string, ratio: number) => void,
): Promise<void> {
  const start = Date.now();
  let stableFrames = 0;
  let lastLog = 0;
  const MIN_LOADED = 3;

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const elapsed = Date.now() - start;
      camera.updateMatrixWorld(true);
      tiles.update();

      if (elapsed > timeoutMs) {
        resolve();
        return;
      }

      const downloading = tiles.stats['downloading'] ?? 0;
      const parsing = tiles.stats['parsing'] ?? 0;
      const loaded = tiles.stats['loaded'] ?? 0;

      if (downloading === 0 && parsing === 0 && loaded >= MIN_LOADED) {
        stableFrames++;
        if (stableFrames >= stableThreshold) {
          resolve();
          return;
        }
      } else {
        stableFrames = 0;
      }

      if (elapsed - lastLog > 2000) {
        lastLog = elapsed;
        log(`d:${downloading} p:${parsing} ok:${loaded} stable:${stableFrames}`, Math.min(0.8, elapsed / timeoutMs));
      }

      setTimeout(tick, 50);
    };
    setTimeout(tick, 100);
  });
}

function extractMeshesInto(
  dest: THREE.Group,
  capturedUUIDs: Set<string>,
  source: THREE.Object3D,
  radius: number,
  stats: { tested: number; captured: number; rejected: number },
): void {
  const centerXZ = new THREE.Vector2(0, 0);
  source.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (!child.geometry) return;
    if (capturedUUIDs.has(child.uuid)) return;
    stats.tested++;

    const geo = child.geometry as THREE.BufferGeometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const worldSphere = geo.boundingSphere!.clone();
    worldSphere.applyMatrix4(child.matrixWorld);

    const meshXZ = new THREE.Vector2(worldSphere.center.x, worldSphere.center.z);
    const xzDist = centerXZ.distanceTo(meshXZ) - worldSphere.radius;
    if (xzDist > radius) {
      stats.rejected++;
      return;
    }

    // Bake matrixWorld into cloned geometry before span-threshold check
    const cloned = child.clone();
    cloned.geometry = child.geometry.clone();
    cloned.geometry.applyMatrix4(child.matrixWorld);
    cloned.position.set(0, 0, 0);
    cloned.rotation.set(0, 0, 0);
    cloned.scale.set(1, 1, 1);
    cloned.updateMatrix();

    if (!cloned.geometry.boundingBox) cloned.geometry.computeBoundingBox();
    const bb = cloned.geometry.boundingBox!;
    const meshSpanX = bb.max.x - bb.min.x;
    const meshSpanZ = bb.max.z - bb.min.z;
    const meshCenterY = (bb.max.y + bb.min.y) / 2;
    const heightFactor = Math.max(0, meshCenterY) / 100;
    const spanThreshold = radius * (2 + heightFactor * 0.5);
    if (meshSpanX > spanThreshold || meshSpanZ > spanThreshold) {
      stats.rejected++;
      return;
    }

    dest.add(cloned);
    capturedUUIDs.add(child.uuid);
    stats.captured++;
  });
}
