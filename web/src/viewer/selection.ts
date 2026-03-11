/**
 * XZ rectangle selection overlay for the 3D viewer.
 *
 * Lets the user tap/click two corners on the ground plane to define
 * a bounding rectangle for cropping the voxel grid. Used when
 * auto-detection confidence is too low to reliably isolate the building.
 *
 * Touch-friendly: works with both mouse clicks and touch taps.
 */

import * as THREE from 'three';
import type { ViewerState } from './scene.js';

export interface SelectionBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface SelectionState {
  cornerA: THREE.Vector3 | null;
  cornerB: THREE.Vector3 | null;
  markerA: THREE.Mesh | null;
  rectLine: THREE.LineSegments | null;
  groundPlane: THREE.Plane;
  raycaster: THREE.Raycaster;
  /** Grid coordinate offsets (world = grid - halfW, grid = world + halfW) */
  halfW: number;
  halfL: number;
}

/**
 * Enable XZ rectangle selection on a viewer.
 *
 * The user taps two corners on the ground plane. A colored rectangle
 * is drawn between them. Returns a Promise that resolves with the
 * grid-coordinate bounds when the selection is confirmed.
 *
 * @param viewer   Active ViewerState (must have renderer, scene, camera)
 * @param groundY  Y level for the selection plane (grid coords, default 0)
 * @returns Promise resolving to SelectionBounds or null if cancelled
 */
export function enableSelection(
  viewer: ViewerState,
  groundY = 0,
): { promise: Promise<SelectionBounds | null>; cancel: () => void } {
  const { scene, camera, renderer, grid } = viewer;
  const canvas = renderer.domElement;

  const halfW = grid.width / 2;
  const halfL = grid.length / 2;

  const state: SelectionState = {
    cornerA: null,
    cornerB: null,
    markerA: null,
    rectLine: null,
    // Ground plane in world coords: y = groundY (grid) → world y = groundY
    groundPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundY),
    raycaster: new THREE.Raycaster(),
    halfW,
    halfL,
  };

  let resolve: (value: SelectionBounds | null) => void;
  const promise = new Promise<SelectionBounds | null>((r) => { resolve = r; });

  /** Convert a pointer/touch event to normalized device coords */
  function getNDC(e: MouseEvent | Touch): THREE.Vector2 {
    const rect = canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Raycast to ground plane, return world XZ intersection or null */
  function raycastGround(ndc: THREE.Vector2): THREE.Vector3 | null {
    state.raycaster.setFromCamera(ndc, camera);
    const target = new THREE.Vector3();
    const hit = state.raycaster.ray.intersectPlane(state.groundPlane, target);
    return hit;
  }

  /** Convert world position to grid coordinates (clamped to grid bounds) */
  function worldToGrid(world: THREE.Vector3): { x: number; z: number } {
    const x = Math.round(world.x + halfW);
    const z = Math.round(world.z + halfL);
    return {
      x: Math.max(0, Math.min(grid.width - 1, x)),
      z: Math.max(0, Math.min(grid.length - 1, z)),
    };
  }

  /** Place a small colored marker at a world position */
  function placeMarker(pos: THREE.Vector3): THREE.Mesh {
    const geo = new THREE.SphereGeometry(0.6, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    scene.add(mesh);
    return mesh;
  }

  /** Draw/update the selection rectangle between two world corners */
  function drawRect(a: THREE.Vector3, b: THREE.Vector3): THREE.LineSegments {
    // Remove previous rectangle
    if (state.rectLine) {
      scene.remove(state.rectLine);
      state.rectLine.geometry.dispose();
      (state.rectLine.material as THREE.Material).dispose();
    }

    const y = a.y + 0.1; // slight offset above ground to avoid z-fighting
    // 4 corners of the XZ rectangle
    const corners = [
      new THREE.Vector3(a.x, y, a.z),
      new THREE.Vector3(b.x, y, a.z),
      new THREE.Vector3(b.x, y, b.z),
      new THREE.Vector3(a.x, y, b.z),
    ];

    // Line segments: 4 edges (each edge = 2 vertices)
    const positions = new Float32Array([
      corners[0].x, corners[0].y, corners[0].z, corners[1].x, corners[1].y, corners[1].z,
      corners[1].x, corners[1].y, corners[1].z, corners[2].x, corners[2].y, corners[2].z,
      corners[2].x, corners[2].y, corners[2].z, corners[3].x, corners[3].y, corners[3].z,
      corners[3].x, corners[3].y, corners[3].z, corners[0].x, corners[0].y, corners[0].z,
    ]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
      color: 0x00ff88,
      linewidth: 2,
      depthTest: false, // always visible even behind blocks
    });

    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 999; // render on top
    scene.add(line);
    state.rectLine = line;
    return line;
  }

  /** Handle a click/tap: first click sets corner A, second sets B and resolves */
  function handlePoint(clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );

    const hit = raycastGround(ndc);
    if (!hit) return;

    if (!state.cornerA) {
      // First corner
      state.cornerA = hit;
      state.markerA = placeMarker(hit);
      const gp = worldToGrid(hit);
      console.log(`[selection] corner A: grid(${gp.x}, ${gp.z})`);
    } else {
      // Second corner — complete the selection
      state.cornerB = hit;
      drawRect(state.cornerA, state.cornerB);

      const gA = worldToGrid(state.cornerA);
      const gB = worldToGrid(state.cornerB);
      const bounds: SelectionBounds = {
        minX: Math.min(gA.x, gB.x),
        maxX: Math.max(gA.x, gB.x),
        minZ: Math.min(gA.z, gB.z),
        maxZ: Math.max(gA.z, gB.z),
      };
      console.log(`[selection] bounds: X[${bounds.minX}..${bounds.maxX}] Z[${bounds.minZ}..${bounds.maxZ}]`);

      cleanup();
      resolve(bounds);
    }
  }

  // ── Live preview rectangle while moving after first corner ──

  function handleMove(clientX: number, clientY: number): void {
    if (!state.cornerA) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const hit = raycastGround(ndc);
    if (hit) drawRect(state.cornerA, hit);
  }

  // ── Event listeners ──

  // Use pointerdown for unified mouse + touch handling
  function onPointerDown(e: PointerEvent): void {
    // Only respond to primary button / single touch
    if (e.button !== 0) return;

    // If OrbitControls consumed this as a drag, don't treat it as a tap.
    // Track the pointer position and only fire if it hasn't moved much.
    const startX = e.clientX;
    const startY = e.clientY;
    const startTime = Date.now();

    function onPointerUp(upEvt: PointerEvent): void {
      canvas.removeEventListener('pointerup', onPointerUp);
      const dx = upEvt.clientX - startX;
      const dy = upEvt.clientY - startY;
      const dt = Date.now() - startTime;
      // Tap threshold: < 10px movement and < 500ms
      if (Math.sqrt(dx * dx + dy * dy) < 10 && dt < 500) {
        handlePoint(upEvt.clientX, upEvt.clientY);
      }
    }
    canvas.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e: PointerEvent): void {
    handleMove(e.clientX, e.clientY);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      cleanup();
      resolve(null);
    }
    // Undo first corner with Backspace
    if (e.key === 'Backspace' && state.cornerA && !state.cornerB) {
      if (state.markerA) {
        scene.remove(state.markerA);
        state.markerA.geometry.dispose();
        (state.markerA.material as THREE.Material).dispose();
        state.markerA = null;
      }
      if (state.rectLine) {
        scene.remove(state.rectLine);
        state.rectLine.geometry.dispose();
        (state.rectLine.material as THREE.Material).dispose();
        state.rectLine = null;
      }
      state.cornerA = null;
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  document.addEventListener('keydown', onKeyDown);

  /** Remove all visual artifacts and event listeners */
  function cleanup(): void {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('keydown', onKeyDown);

    if (state.markerA) {
      scene.remove(state.markerA);
      state.markerA.geometry.dispose();
      (state.markerA.material as THREE.Material).dispose();
    }
    if (state.rectLine) {
      scene.remove(state.rectLine);
      state.rectLine.geometry.dispose();
      (state.rectLine.material as THREE.Material).dispose();
    }
  }

  function cancel(): void {
    cleanup();
    resolve(null);
  }

  return { promise, cancel };
}
