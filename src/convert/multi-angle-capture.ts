/**
 * Multi-angle LOD capture for Google 3D Tiles.
 *
 * Google Tiles use LOD based on camera distance — a single top-down ortho camera
 * gets rooftop detail but low-res facades. By sequentially orbiting the camera
 * through 5 positions (top-down + 4 cardinal angles at 45°), we force the
 * TilesRenderer to fetch high-LOD tiles for all facades.
 *
 * IMPORTANT: Cameras are positioned sequentially, not simultaneously, to avoid
 * OOM on ARM64 devices. Each angle waits for tiles to fully load before moving on.
 *
 * Browser-only (WebGL). CLI receives pre-saved GLB, so multi-angle capture
 * happens at browser save time and is embedded in the exported GLB.
 */

import * as THREE from 'three';

/** Camera angle definition for multi-angle capture */
export interface CameraAngle {
  /** Human-readable name for logging */
  name: string;
  /** Camera position relative to building center (meters) */
  offset: THREE.Vector3;
  /** Whether to use orthographic (true) or perspective (false) */
  orthographic: boolean;
}

/**
 * Pre-defined 5-angle capture preset.
 * Top-down orthographic + 4 cardinals at 45° elevation.
 *
 * Camera distance is scaled by building height at capture time.
 * These offsets assume a reference distance of 1.0 — multiply by actual distance.
 */
export const FIVE_ANGLE_PRESET: CameraAngle[] = [
  {
    name: 'top-down',
    offset: new THREE.Vector3(0, 1, 0),
    orthographic: true,
  },
  {
    name: 'north',
    // Looking south from north: camera at +Z, elevated 45°
    offset: new THREE.Vector3(0, 0.707, 0.707),
    orthographic: false,
  },
  {
    name: 'east',
    // Looking west from east: camera at +X, elevated 45°
    offset: new THREE.Vector3(0.707, 0.707, 0),
    orthographic: false,
  },
  {
    name: 'south',
    // Looking north from south: camera at -Z, elevated 45°
    offset: new THREE.Vector3(0, 0.707, -0.707),
    orthographic: false,
  },
  {
    name: 'west',
    // Looking east from west: camera at -X, elevated 45°
    offset: new THREE.Vector3(-0.707, 0.707, 0),
    orthographic: false,
  },
];

/**
 * Options for multi-angle capture sequence.
 */
export interface MultiAngleCaptureOptions {
  /** Camera angles to use (default: FIVE_ANGLE_PRESET) */
  angles?: CameraAngle[];
  /** Camera distance from building center in meters.
   *  For top-down ortho, this sets the ortho camera Y position.
   *  For perspective angles, this scales the offset vector magnitude. */
  distance?: number;
  /** Progress callback */
  onProgress?: (msg: string) => void;
  /** Per-angle timeout in ms (default: 30000) */
  angleTimeout?: number;
  /** Maximum cache size in bytes to prevent OOM (default: 384MB) */
  maxCacheBytes?: number;
}

/**
 * Position camera for a specific capture angle.
 *
 * Updates the camera position and lookAt target for the given angle.
 * Does NOT trigger tile loading — caller must call tiles.update() afterward.
 *
 * @param camera      Three.js camera to reposition
 * @param center      Building center in scene coordinates
 * @param angle       Camera angle definition
 * @param distance    Distance from center in meters
 */
export function positionCameraForAngle(
  camera: THREE.Camera,
  center: THREE.Vector3,
  angle: CameraAngle,
  distance: number,
): void {
  const pos = angle.offset.clone().multiplyScalar(distance).add(center);
  camera.position.copy(pos);

  if (camera instanceof THREE.OrthographicCamera && angle.orthographic) {
    // Top-down: look straight down
    camera.up.set(0, 0, -1);
    camera.lookAt(center);
  } else {
    // Perspective angles: look at building center
    camera.up.set(0, 1, 0);
    camera.lookAt(center);
  }

  camera.updateMatrixWorld(true);
}

/**
 * Compute an appropriate camera distance based on building bounds.
 *
 * For a building with bounding box diagonal D, the camera should be
 * positioned at roughly 1.5*D to ensure the full structure is visible
 * from all angles while still triggering high-LOD tile loading.
 *
 * @param buildingSize   Bounding box size vector of the building
 * @returns Recommended camera distance in meters
 */
export function computeCameraDistance(buildingSize: THREE.Vector3): number {
  const diagonal = Math.sqrt(
    buildingSize.x * buildingSize.x +
    buildingSize.y * buildingSize.y +
    buildingSize.z * buildingSize.z,
  );
  // 1.5x diagonal gives good LOD triggering while keeping building in frame
  return Math.max(diagonal * 1.5, 30);
}

/**
 * Wait for TilesRenderer to stabilize at the current camera position.
 *
 * Polls tiles.stats until downloading=0 and parsing=0 for N consecutive checks.
 * Used after repositioning camera to ensure LOD tiles for the new angle have loaded.
 *
 * @param tiles          TilesRenderer instance
 * @param timeoutMs      Maximum wait time in ms
 * @param stableCount    Number of consecutive stable polls required (default: 20)
 * @param onProgress     Progress callback
 */
export function waitForStable(
  tiles: { stats: Record<string, number>; update: () => void },
  timeoutMs: number,
  stableCount = 20,
  onProgress?: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stable = 0;

    const check = () => {
      const elapsed = Date.now() - start;
      if (elapsed > timeoutMs) {
        onProgress?.(`Angle timeout after ${Math.round(elapsed / 1000)}s`);
        resolve();
        return;
      }

      // Force a tiles update to trigger LOD evaluation for new camera position
      tiles.update();

      const { downloading = 0, parsing = 0, loaded = 0 } = tiles.stats;
      if (downloading === 0 && parsing === 0 && loaded > 0) {
        stable++;
        if (stable >= stableCount) {
          onProgress?.(`Stable after ${Math.round(elapsed / 1000)}s (${loaded} tiles)`);
          resolve();
          return;
        }
      } else {
        stable = 0;
      }

      onProgress?.(`d:${downloading} p:${parsing} ok:${loaded} stable:${stable}/${stableCount}`);
      setTimeout(check, 200);
    };

    setTimeout(check, 100);
  });
}
