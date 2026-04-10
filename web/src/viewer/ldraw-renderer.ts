/**
 * Direct LDraw triangle renderer — bypasses voxelization entirely.
 *
 * Takes ParsedBrick[] and renders the actual .dat triangle geometry as a
 * Three.js scene with proper materials, lighting, and camera controls.
 * Produces output visually similar to Mecabricks — real brick geometry
 * with plastic-like materials and product photography lighting.
 *
 * Usage:
 *   const viewer = await createLDrawViewer(container, bricks, { ldrawRoot: '/ldraw-parts' });
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BlockGrid } from '@craft/schem/types.js';
import { LDRAW_COLOR_RGB } from '@engine/ldraw-colors.js';
import type { ParsedBrick } from '@engine/ldraw-parser.js';
import type { ViewerState } from './scene.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type Vec3 = readonly [number, number, number];
type Triangle = readonly [Vec3, Vec3, Vec3];
type Edge = readonly [Vec3, Vec3];

interface PartGeom {
  tris: Triangle[];
  edges: Edge[];
}

export interface LDrawViewerOptions {
  /** Background color (default: 0x1a1a2e) */
  background?: number;
  /** Ground plane color (default: 0x3a3a3a) */
  groundColor?: number;
  /** Scale factor override (default: 1/20 — 1 stud = 1 unit) */
  scale?: number;
  /**
   * Progress callback, called as parts are resolved.
   * @param done Number of parts resolved so far
   * @param total Total number of parts to resolve
   */
  onProgress?: (done: number, total: number) => void;
}

// ─── LDraw primitive / Technic filtering ────────────────────────────────────

function isLDrawPrimitive(part: string): boolean {
  const bare = part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
  if (/^\d+-\d+/.test(bare))         return true;
  if (bare.startsWith('stug-'))      return true;
  if (bare === 'axl2hole' || bare.startsWith('axlhol')) return true;
  if (bare.startsWith('connect'))    return true;
  if (bare.startsWith('npeghol'))    return true;
  if (bare.startsWith('npeghole'))   return true;
  if (bare.startsWith('logo'))       return true;
  if (bare.startsWith('stud'))       return true;
  if (bare === 'box' || /^box[\da-z]/.test(bare)) return true;
  if (bare === 'disc')               return true;
  if (bare === 'knob' || bare === 'tooth') return true;
  if (/^\d+s\d+$/.test(bare))       return true;
  if (/^ls\d+/.test(bare))          return true;
  return false;
}

const TECHNIC_INTERNAL_PARTS = new Set([
  '3673','4274','6558','4459','32054','32556','65304','6562','32002',
  '43093','6628','11214',
  '32062','4519','3705','32073','3706','3707','3737','3708','50451',
  '4265c','3713b','32123',
  '6536','6538b',
]);

// ─── Geometry helpers (mirrored from ldraw-geometry.ts) ─────────────────────

function normId(id: string): string {
  return id.replace(/\\/g, '/').toLowerCase().replace(/\.dat$/i, '').trim();
}

function applyMat(v: Vec3, R: readonly number[], T: Vec3): Vec3 {
  return [
    R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + T[0],
    R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + T[1],
    R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + T[2],
  ];
}

// ─── .dat fetching and triangle resolution ──────────────────────────────────

const datTextCache  = new Map<string, string | null>();
const partGeomCache = new Map<string, PartGeom>();
const datInFlight   = new Map<string, Promise<string | null>>();
const geomInFlight  = new Map<string, Promise<PartGeom>>();

let LDRAW_BASE = '/ldraw-parts';

async function fetchDatText(id: string): Promise<string | null> {
  const key = normId(id);
  if (datTextCache.has(key)) return datTextCache.get(key)!;
  if (datInFlight.has(key))  return datInFlight.get(key)!;

  const stem = key.split('/').pop()!;
  const paths: string[] = [];
  if (key.includes('/')) {
    if (key.startsWith('s/'))
      paths.push(`${LDRAW_BASE}/parts/${key}.dat`);
    else
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/UnOfficial/p/${key}.dat`);
  }
  paths.push(
    `${LDRAW_BASE}/parts/${stem}.dat`,
    `${LDRAW_BASE}/p/${stem}.dat`,
    `${LDRAW_BASE}/parts/s/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/parts/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/p/${stem}.dat`,
  );

  const promise = (async (): Promise<string | null> => {
    for (const path of paths) {
      try {
        const r = await fetch(path);
        if (r.ok) {
          const text = await r.text();
          datTextCache.set(key, text);
          return text;
        }
      } catch { /* try next */ }
    }
    datTextCache.set(key, null);
    return null;
  })();

  datInFlight.set(key, promise);
  const result = await promise;
  datInFlight.delete(key);
  return result;
}

async function resolvePartGeometry(id: string, depth = 0): Promise<PartGeom> {
  const EMPTY: PartGeom = { tris: [], edges: [] };
  if (depth > 12) return EMPTY;
  const key = normId(id);

  if (partGeomCache.has(key)) return partGeomCache.get(key)!;
  if (geomInFlight.has(key))  return geomInFlight.get(key)!;

  const promise = (async (): Promise<PartGeom> => {
    const text = await fetchDatText(key);
    if (!text) return EMPTY;

    const geom: PartGeom = { tris: [], edges: [] };
    partGeomCache.set(key, geom); // cache early (cycle guard)

    const subPromises: Promise<void>[] = [];

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const tok = line.split(/\s+/);

      if (tok[0] === '2' && tok.length >= 8) {
        // Type 2: edge line
        geom.edges.push([
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
        ]);
      } else if (tok[0] === '3' && tok.length >= 11) {
        geom.tris.push([
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
          [+tok[8]!, +tok[9]!, +tok[10]!],
        ]);
      } else if (tok[0] === '4' && tok.length >= 14) {
        const v0: Vec3 = [+tok[2]!, +tok[3]!, +tok[4]!];
        const v1: Vec3 = [+tok[5]!, +tok[6]!, +tok[7]!];
        const v2: Vec3 = [+tok[8]!, +tok[9]!, +tok[10]!];
        const v3: Vec3 = [+tok[11]!, +tok[12]!, +tok[13]!];
        geom.tris.push([v0, v1, v2], [v0, v2, v3]);
      } else if (tok[0] === '1' && tok.length >= 15 && depth < 11) {
        const tx = +tok[2]!, ty = +tok[3]!, tz = +tok[4]!;
        const R = [+tok[5]!,+tok[6]!,+tok[7]!, +tok[8]!,+tok[9]!,+tok[10]!, +tok[11]!,+tok[12]!,+tok[13]!];
        const T: Vec3 = [tx, ty, tz];
        const subId = tok.slice(14).join(' ').trim();

        subPromises.push(
          resolvePartGeometry(subId, depth + 1).then(sub => {
            for (const [sv0, sv1, sv2] of sub.tris) {
              geom.tris.push([applyMat(sv0, R, T), applyMat(sv1, R, T), applyMat(sv2, R, T)]);
            }
            for (const [ev0, ev1] of sub.edges) {
              geom.edges.push([applyMat(ev0, R, T), applyMat(ev1, R, T)]);
            }
          }),
        );
      }
    }

    await Promise.all(subPromises);
    return geom;
  })();

  geomInFlight.set(key, promise);
  const result = await promise;
  geomInFlight.delete(key);
  return result;
}

// ─── Color helpers ──────────────────────────────────────────────────────────

/** LDraw transparent color IDs (33-47 range plus known extras) */
function isTransparentColor(colorId: number): boolean {
  if (colorId >= 33 && colorId <= 49) return true;
  if (colorId === 111 || colorId === 113 || colorId === 114 || colorId === 117) return true;
  if (colorId === 234 || colorId === 284 || colorId === 285 || colorId === 293) return true;
  if (colorId === 295 || colorId === 296 || colorId === 300 || colorId === 302) return true;
  if (colorId === 306 || colorId === 329 || colorId === 605) return true;
  if (colorId === 142 || colorId === 143 || colorId === 150) return true;
  if (colorId === 62 || colorId === 57 || colorId === 39) return true;
  if (colorId === 66 || colorId === 67) return true; // rubber trans
  return false;
}

/** LDraw metallic/chrome color IDs */
function isMetallicColor(colorId: number): boolean {
  return colorId === 80 || colorId === 81 || colorId === 82 || colorId === 83
    || colorId === 87 || colorId === 297 || colorId === 494 || colorId === 495
    || colorId === 179 || colorId === 383 || colorId === 65;
}

function getThreeColor(colorId: number): THREE.Color {
  const hex = LDRAW_COLOR_RGB[colorId] ?? '#808080';
  return new THREE.Color(hex);
}

// ─── Scene builder ──────────────────────────────────────────────────────────

const IDENTITY = [1,0,0, 0,1,0, 0,0,1];
const LDU_TO_UNITS = 1 / 20; // 1 stud (20 LDU) = 1 scene unit

/**
 * Create a Three.js scene that renders LDraw brick geometry directly.
 *
 * @param container DOM element to mount the renderer into
 * @param bricks ParsedBrick[] from the LDraw parser
 * @param options Optional configuration
 * @returns ViewerState (grid is a dummy empty BlockGrid)
 */
export async function createLDrawViewer(
  container: HTMLElement,
  bricks: ParsedBrick[],
  options?: LDrawViewerOptions,
): Promise<ViewerState> {
  const bgColor = options?.background ?? 0x2d2d3d;
  const groundColor = options?.groundColor ?? 0x3a3a3a;
  const scale = options?.scale ?? LDU_TO_UNITS;
  const onProgress = options?.onProgress;

  // ── Filter bricks ──────────────────────────────────────────────────────
  const filteredBricks = bricks.filter(b => {
    if (isLDrawPrimitive(b.part)) return false;
    const bareId = b.part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
    if (TECHNIC_INTERNAL_PARTS.has(bareId)) return false;
    return true;
  });

  // ── Resolve triangle geometry for each brick ───────────────────────────
  // Group by unique part ID to avoid duplicate fetches
  const uniqueParts = [...new Set(filteredBricks.map(b => normId(b.part)))];

  // Prefetch all unique parts in parallel
  let done = 0;
  await Promise.all(uniqueParts.map(async (partId) => {
    await resolvePartGeometry(partId);
    done++;
    onProgress?.(done, uniqueParts.length);
  }));

  // ── Build world-space triangles grouped by color + collect edge lines ──
  interface ColorGroup {
    positions: number[];  // flat xyz array
    normals: number[];    // flat xyz array
  }
  const colorGroups = new Map<number, ColorGroup>();
  const edgePositions: number[] = []; // all edge lines (dark outlines)
  let renderedCount = 0;
  let missingCount = 0;

  function getGroup(colorId: number): ColorGroup {
    let g = colorGroups.get(colorId);
    if (!g) {
      g = { positions: [], normals: [] };
      colorGroups.set(colorId, g);
    }
    return g;
  }

  for (const brick of filteredBricks) {
    const geom = partGeomCache.get(normId(brick.part));
    if (!geom || geom.tris.length === 0) { missingCount++; continue; }
    renderedCount++;

    const R = brick.rot ?? IDENTITY;
    const T: Vec3 = [brick.x, brick.y, brick.z];

    const group = getGroup(brick.color);

    for (const [lv0, lv1, lv2] of geom.tris) {
      const wv0 = applyMat(lv0, R, T);
      const wv1 = applyMat(lv1, R, T);
      const wv2 = applyMat(lv2, R, T);

      const x0 = wv0[0] * scale, y0 = -wv0[1] * scale, z0 = wv0[2] * scale;
      const x1 = wv1[0] * scale, y1 = -wv1[1] * scale, z1 = wv1[2] * scale;
      const x2 = wv2[0] * scale, y2 = -wv2[1] * scale, z2 = wv2[2] * scale;

      const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
      const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-10) { nx /= len; ny /= len; nz /= len; }

      group.positions.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
      group.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    }

    // Collect edge lines for dark outlines
    for (const [ev0, ev1] of geom.edges) {
      const we0 = applyMat(ev0, R, T);
      const we1 = applyMat(ev1, R, T);
      edgePositions.push(
        we0[0] * scale, -we0[1] * scale, we0[2] * scale,
        we1[0] * scale, -we1[1] * scale, we1[2] * scale,
      );
    }
  }

  if (missingCount > 0) {
    console.warn(`[ldraw-renderer] ${missingCount} bricks had no geometry (${renderedCount} rendered)`);
  }

  // ── Scene setup ────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bgColor);

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    2000,
  );

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  } catch {
    const fallback = document.createElement('div');
    fallback.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#999;font:14px/1.4 system-ui;text-align:center;padding:1em;';
    fallback.textContent = '3D viewer requires WebGL.';
    container.appendChild(fallback);
    return {
      scene, camera,
      renderer: null as unknown as THREE.WebGLRenderer,
      controls: null as unknown as OrbitControls,
      meshes: [], grid: new BlockGrid(1, 1, 1),
      dispose: () => { fallback.remove(); },
    };
  }

  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // ── Lighting (product photography style) ───────────────────────────────
  // Soft ambient fill
  const ambient = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambient);

  // Hemisphere light for sky/ground gradient
  const hemi = new THREE.HemisphereLight(0xc8e0ff, 0x443322, 0.6);
  scene.add(hemi);

  // Key light (main directional — warm, upper-right)
  const keyLight = new THREE.DirectionalLight(0xfff5e6, 2.0);
  keyLight.position.set(50, 80, 40);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.001;
  scene.add(keyLight);

  // Fill light (cooler, opposite side — softer)
  const fillLight = new THREE.DirectionalLight(0xc0d8ff, 0.6);
  fillLight.position.set(-40, 30, -30);
  scene.add(fillLight);

  // Rim/back light for edge definition
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
  rimLight.position.set(0, 20, -60);
  scene.add(rimLight);

  // ── Create meshes per color group ──────────────────────────────────────
  const meshes: THREE.Mesh[] = [];
  let bboxMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  let bboxMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  // Sort: render opaque first, then transparent (for correct blending)
  const sortedEntries = [...colorGroups.entries()].sort((a, b) => {
    const aT = isTransparentColor(a[0]) ? 1 : 0;
    const bT = isTransparentColor(b[0]) ? 1 : 0;
    return aT - bT;
  });

  for (const [colorId, group] of sortedEntries) {
    if (group.positions.length === 0) continue;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(group.normals, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    // Expand scene bounding box
    if (geometry.boundingBox) {
      bboxMin.min(geometry.boundingBox.min);
      bboxMax.max(geometry.boundingBox.max);
    }

    const color = getThreeColor(colorId);
    const transparent = isTransparentColor(colorId);
    const metallic = isMetallicColor(colorId);

    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: metallic ? 0.2 : 0.35,
      metalness: metallic ? 0.8 : 0.04,
      transparent,
      opacity: transparent ? 0.5 : 1.0,
      side: THREE.DoubleSide,
      depthWrite: !transparent,
      flatShading: true,
    });

    // Slight emissive tint for richer plastic look
    if (!transparent && !metallic) {
      material.emissive = color.clone().multiplyScalar(0.03);
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (transparent) mesh.renderOrder = 1; // render after opaque
    scene.add(mesh);
    meshes.push(mesh);
  }

  // ── Edge lines (dark outlines between bricks) ─────────────────────────
  if (edgePositions.length > 0) {
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x333333,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
    edgeLines.renderOrder = 2;
    scene.add(edgeLines);
  }

  // ── Compute model center and size ──────────────────────────────────────
  const center = new THREE.Vector3().lerpVectors(bboxMin, bboxMax, 0.5);
  const size = new THREE.Vector3().subVectors(bboxMax, bboxMin);
  const maxDim = Math.max(size.x, size.y, size.z) || 10;

  // ── Configure shadow camera to cover the model ─────────────────────────
  const shadowRange = maxDim * 0.8;
  keyLight.shadow.camera.left = -shadowRange;
  keyLight.shadow.camera.right = shadowRange;
  keyLight.shadow.camera.top = shadowRange;
  keyLight.shadow.camera.bottom = -shadowRange;
  keyLight.shadow.camera.far = maxDim * 4;
  keyLight.target.position.copy(center);
  scene.add(keyLight.target);

  // ── Ground plane ───────────────────────────────────────────────────────
  const groundSize = maxDim * 4;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({
      color: groundColor,
      roughness: 0.9,
      metalness: 0.0,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = bboxMin.y - 0.01;
  ground.receiveShadow = true;
  scene.add(ground);

  // ── Camera positioning ─────────────────────────────────────────────────
  const camDist = maxDim * 1.5;
  camera.position.set(
    center.x + camDist * 0.7,
    center.y + camDist * 0.5,
    center.z + camDist * 0.7,
  );
  camera.lookAt(center);
  camera.near = maxDim * 0.01;
  camera.far = maxDim * 10;
  camera.updateProjectionMatrix();

  // ── OrbitControls ──────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxDistance = maxDim * 5;
  controls.minDistance = maxDim * 0.1;
  controls.update();

  // ── Render loop ────────────────────────────────────────────────────────
  let animId = 0;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }

  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    cancelAnimationFrame(animId);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    animate();
  });

  animate();

  // ── Resize observer ────────────────────────────────────────────────────
  const resizeObs = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObs.observe(container);

  // ── Return ViewerState ─────────────────────────────────────────────────
  const dummyGrid = new BlockGrid(1, 1, 1);

  return {
    scene,
    camera,
    renderer,
    controls,
    meshes: meshes as unknown as THREE.InstancedMesh[], // ViewerState expects InstancedMesh[]
    grid: dummyGrid,
    dispose: () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      for (const mesh of meshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.dispose();
        mesh.geometry.dispose();
      }
    },
  };
}
