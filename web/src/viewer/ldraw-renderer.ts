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
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SAOPass } from 'three/examples/jsm/postprocessing/SAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { BlockGrid } from '@craft/schem/types.js';
import { LDRAW_COLOR_RGB } from '@engine/ldraw-colors.js';
import type { ParsedBrick } from '@engine/ldraw-parser.js';
import type { ViewerState } from './scene.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type Vec3 = readonly [number, number, number];
type Triangle = readonly [Vec3, Vec3, Vec3];
type Edge = readonly [Vec3, Vec3];

interface PartGeom {
  tris: Triangle[];       // color-16 (inherit) triangles
  edges: Edge[];          // color-16 (inherit) edges
  colorTris: Map<number, Triangle[]>;  // explicit-color triangles (non-16)
  colorEdges: Map<number, Edge[]>;     // explicit-color edges (non-16)
}

export interface LDrawViewerOptions {
  /** Background color (default: 0x2d2d3d) */
  background?: number;
  /** Ground plane color (default: 0x4a4a5a) */
  groundColor?: number;
  /** Scale factor override (default: 1/20 — 1 stud = 1 unit) */
  scale?: number;
  /**
   * Raw MPD/LDR file content. When provided, inline sub-model sections are
   * pre-loaded into the .dat cache so they resolve without HTTP fetches.
   */
  mpdContent?: string;
  /** Maximum step to render (undefined = all steps) */
  maxStep?: number;
  /**
   * Progress callback, called as parts are resolved.
   * @param done Number of parts resolved so far
   * @param total Total number of parts to resolve
   */
  onProgress?: (done: number, total: number) => void;
}

// ─── LDraw primitive / Technic filtering ────────────────────────────────────

/**
 * For the 3D renderer, we keep almost ALL geometry — including fraction primitives
 * (4-4cyli, 1-8edge, etc.) which define cylinders, arcs, curves, and rings.
 * Only skip non-visual helper geometry that would clutter the render.
 */
function isLDrawPrimitive(part: string): boolean {
  const bare = part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
  // KEEP fraction primitives (4-4cyli, 1-8edge, 2-4ndis, etc.) — these define
  // the actual curved geometry for cylinders, arcs, rings, slopes. Essential!
  // KEEP studs, knobs, discs — they're visible geometry.
  // KEEP box primitives — used for internal geometry shapes.
  // KEEP stug- (anti-stud / under-brick tubes) — visible from below on elevated sections
  if (bare.startsWith('logo'))       return true;  // LEGO text stamps — too small to see
  if (/^ls\d+/.test(bare))          return true;  // LSynth virtual hose segments
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
      paths.push(`${LDRAW_BASE}/parts/${key}.dat`, `${LDRAW_BASE}/parts/s/${stem}.dat`);
    else if (key.startsWith('48/'))
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/p/48/${stem}.dat`);
    else
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/UnOfficial/p/${key}.dat`);
  }
  paths.push(
    `${LDRAW_BASE}/parts/${stem}.dat`,
    `${LDRAW_BASE}/p/${stem}.dat`,
    `${LDRAW_BASE}/parts/s/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/parts/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/parts/s/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/p/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/p/48/${stem}.dat`,
    `${LDRAW_BASE}/models/${stem}.dat`,
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

async function resolvePartGeometry(id: string, depth = 0, invertWinding = false): Promise<PartGeom> {
  const EMPTY: PartGeom = { tris: [], edges: [], colorTris: new Map(), colorEdges: new Map() };
  if (depth > 20) return EMPTY;
  const key = normId(id);

  if (partGeomCache.has(key)) return partGeomCache.get(key)!;
  if (geomInFlight.has(key))  return geomInFlight.get(key)!;

  const promise = (async (): Promise<PartGeom> => {
    const text = await fetchDatText(key);
    if (!text) return EMPTY;

    const geom: PartGeom = { tris: [], edges: [], colorTris: new Map(), colorEdges: new Map() };
    partGeomCache.set(key, geom); // cache early (cycle guard)

    const subPromises: Promise<void>[] = [];

    // Parse BFC meta-commands to determine winding convention
    let bfcCertified = false;
    let bfcCCW = true; // default CCW if certified
    let invertNext = false;

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const tok = line.split(/\s+/);

      // BFC meta-commands
      if (tok[0] === '0' && tok[1] === 'BFC') {
        const cmd = tok.slice(2).join(' ').toUpperCase();
        if (cmd.includes('CERTIFY')) {
          bfcCertified = true;
          bfcCCW = !cmd.includes('CW') || cmd.includes('CCW');
        }
        if (cmd === 'INVERTNEXT') invertNext = true;
        if (cmd === 'CW') bfcCCW = false;
        if (cmd === 'CCW') bfcCCW = true;
        continue;
      }
      // Inline color definition: 0 !COLOUR name CODE n VALUE #RRGGBB ...
      if (tok[0] === '0' && tok[1] === '!COLOUR') {
        const codeIdx = tok.indexOf('CODE');
        const valIdx = tok.indexOf('VALUE');
        if (codeIdx > 0 && valIdx > 0 && tok[codeIdx + 1] && tok[valIdx + 1]) {
          const cid = parseInt(tok[codeIdx + 1], 10);
          const rgb = tok[valIdx + 1];
          if (!isNaN(cid) && rgb.startsWith('#')) {
            // Dynamically import the RGB table and add the color
            const { LDRAW_COLOR_RGB } = await import('@engine/ldraw-colors.js');
            if (!(cid in LDRAW_COLOR_RGB)) {
              (LDRAW_COLOR_RGB as Record<number, string>)[cid] = rgb;
            }
          }
        }
        continue;
      }

      if (tok[0] === '2' && tok.length >= 8) {
        geom.edges.push([
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
        ]);
      } else if (tok[0] === '5' && tok.length >= 14) {
        // Type 5: conditional/optional edge line — treat as regular edge
        geom.edges.push([
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
        ]);
      } else if (tok[0] === '3' && tok.length >= 11) {
        const v0: Vec3 = [+tok[2]!, +tok[3]!, +tok[4]!];
        const v1: Vec3 = [+tok[5]!, +tok[6]!, +tok[7]!];
        const v2: Vec3 = [+tok[8]!, +tok[9]!, +tok[10]!];
        // Apply winding inversion if needed
        const shouldInvert = invertWinding !== (!bfcCCW);
        geom.tris.push(shouldInvert ? [v0, v2, v1] : [v0, v1, v2]);
      } else if (tok[0] === '4' && tok.length >= 14) {
        const v0: Vec3 = [+tok[2]!, +tok[3]!, +tok[4]!];
        const v1: Vec3 = [+tok[5]!, +tok[6]!, +tok[7]!];
        const v2: Vec3 = [+tok[8]!, +tok[9]!, +tok[10]!];
        const v3: Vec3 = [+tok[11]!, +tok[12]!, +tok[13]!];
        const shouldInvert = invertWinding !== (!bfcCCW);
        if (shouldInvert) {
          geom.tris.push([v0, v2, v1], [v0, v3, v2]);
        } else {
          geom.tris.push([v0, v1, v2], [v0, v2, v3]);
        }
      } else if (tok[0] === '1' && tok.length >= 15 && depth < 19) {
        const subColor = parseInt(tok[1]!, 10);
        const tx = +tok[2]!, ty = +tok[3]!, tz = +tok[4]!;
        const R = [+tok[5]!,+tok[6]!,+tok[7]!, +tok[8]!,+tok[9]!,+tok[10]!, +tok[11]!,+tok[12]!,+tok[13]!];
        const T: Vec3 = [tx, ty, tz];
        const subId = tok.slice(14).join(' ').trim();

        const det = R[0]*(R[4]*R[8]-R[5]*R[7]) - R[1]*(R[3]*R[8]-R[5]*R[6]) + R[2]*(R[3]*R[7]-R[4]*R[6]);
        const childInvert = invertWinding !== (det < 0) !== invertNext;
        invertNext = false;

        subPromises.push(
          resolvePartGeometry(subId, depth + 1, childInvert).then(sub => {
            // Color 16 = inherit from parent. Non-16 = explicit color for this sub-part.
            // Sub's own color-16 tris get assigned to subColor (or stay as 16 if subColor is also 16).
            const targetTris = (subColor !== 16 && subColor !== 24)
              ? (geom.colorTris.get(subColor) ?? (() => { const a: Triangle[] = []; geom.colorTris.set(subColor, a); return a; })())
              : geom.tris;
            const targetEdges = (subColor !== 16 && subColor !== 24)
              ? (geom.colorEdges.get(subColor) ?? (() => { const a: Edge[] = []; geom.colorEdges.set(subColor, a); return a; })())
              : geom.edges;

            for (const [sv0, sv1, sv2] of sub.tris) {
              targetTris.push([applyMat(sv0, R, T), applyMat(sv1, R, T), applyMat(sv2, R, T)]);
            }
            for (const [ev0, ev1] of sub.edges) {
              targetEdges.push([applyMat(ev0, R, T), applyMat(ev1, R, T)]);
            }
            // Also propagate sub's explicit-color tris up
            for (const [cid, ctris] of sub.colorTris) {
              const target = geom.colorTris.get(cid) ?? (() => { const a: Triangle[] = []; geom.colorTris.set(cid, a); return a; })();
              for (const [sv0, sv1, sv2] of ctris) {
                target.push([applyMat(sv0, R, T), applyMat(sv1, R, T), applyMat(sv2, R, T)]);
              }
            }
            for (const [cid, cedges] of sub.colorEdges) {
              const target = geom.colorEdges.get(cid) ?? (() => { const a: Edge[] = []; geom.colorEdges.set(cid, a); return a; })();
              for (const [ev0, ev1] of cedges) {
                target.push([applyMat(ev0, R, T), applyMat(ev1, R, T)]);
              }
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

/** LDraw transparent color IDs (33-47 range plus known extras + rubber trans) */
function isTransparentColor(colorId: number): boolean {
  if (colorId >= 33 && colorId <= 49) return true;  // standard trans range
  if (colorId >= 52 && colorId <= 54) return true;  // trans opal
  if (colorId === 57) return true;                   // trans orange
  if (colorId === 111 || colorId === 113 || colorId === 114 || colorId === 117) return true;
  if (colorId === 234 || colorId === 284 || colorId === 285 || colorId === 293) return true;
  if (colorId === 295 || colorId === 296 || colorId === 300 || colorId === 302) return true;
  if (colorId === 306 || colorId === 329 || colorId === 605) return true;
  if (colorId === 142 || colorId === 143 || colorId === 150) return true;
  if (colorId === 62 || colorId === 57 || colorId === 39) return true;
  if (colorId === 66 || colorId === 67) return true;    // rubber trans
  if (colorId === 10035 || colorId === 10036) return true; // rubber trans green/red
  if (colorId === 10043) return true;                   // rubber trans light blue
  if (colorId === 10351 || colorId === 10366) return true; // glitter/satin trans
  if (colorId === 10375) return true;                   // trans black
  return false;
}

/** LDraw metallic/chrome/pearl color IDs */
function isMetallicColor(colorId: number): boolean {
  // Chrome/silver/gold
  if (colorId === 80 || colorId === 81 || colorId === 82 || colorId === 83) return true;
  if (colorId === 87 || colorId === 179 || colorId === 383 || colorId === 65) return true;
  // Pearl gold, silver, dark gray
  if (colorId === 297 || colorId === 494 || colorId === 495) return true;
  // Bionicle metallic
  if (colorId === 10179 || colorId === 134 || colorId === 135) return true;
  // Speckle/pearl variants
  if (colorId === 132 || colorId === 133 || colorId === 148) return true;
  return false;
}

/** Rubber color IDs — higher roughness, no clearcoat */
function isRubberColor(colorId: number): boolean {
  if (colorId === 256 || colorId === 273 || colorId === 324 || colorId === 375) return true;
  if (colorId >= 10000 && colorId < 11000) return true; // 10xxx = BrickLink rubber
  return false;
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
  const bgColor = options?.background ?? 0x3a3a4a;
  const groundColor = options?.groundColor ?? 0x3a3a4a; // match background for seamless backdrop
  const scale = options?.scale ?? LDU_TO_UNITS;
  const onProgress = options?.onProgress;

  // ── Pre-load MPD inline sub-models into the .dat cache ─────────────────
  if (options?.mpdContent) {
    const lines = options.mpdContent.split(/\r?\n/);
    let currentName: string | null = null;
    let currentLines: string[] = [];
    for (const line of lines) {
      const fileMatch = /^0\s+FILE\s+(.+)$/i.exec(line.trim());
      if (fileMatch) {
        if (currentName) {
          datTextCache.set(normId(currentName), currentLines.join('\n'));
        }
        currentName = fileMatch[1].trim();
        currentLines = [];
      } else if (currentName) {
        currentLines.push(line);
      }
    }
    if (currentName) {
      datTextCache.set(normId(currentName), currentLines.join('\n'));
    }
  }

  // ── Filter bricks ──────────────────────────────────────────────────────
  const maxStep = options?.maxStep;
  const filteredBricks = bricks.filter(b => {
    if (isLDrawPrimitive(b.part)) return false;
    if (maxStep != null && (b.step ?? 1) > maxStep) return false;
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
  // Per-brick smooth normals: merge vertices WITHIN each brick (so cylinders
  // get smooth normals) then add the smoothed positions+normals to the color group.
  interface ColorGroup {
    positions: number[];  // flat xyz array
    normals: number[];    // flat xyz array (smooth per-brick)
  }
  interface EdgeGroup {
    positions: number[];
  }
  const colorGroups = new Map<number, ColorGroup>();
  const edgeGroups = new Map<number, EdgeGroup>(); // edges grouped by brick color
  let totalEdgeFloats = 0;
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
    if (!geom || (geom.tris.length === 0 && geom.colorTris.size === 0)) { missingCount++; continue; }
    renderedCount++;

    const R = brick.rot ?? IDENTITY;
    const T: Vec3 = [brick.x, brick.y, brick.z];

    const group = getGroup(brick.color);

    // Collect this brick's positions, compute smooth normals PER-BRICK,
    // then append both positions and normals to the color group.
    const brickPos: number[] = [];
    for (const [lv0, lv1, lv2] of geom.tris) {
      const wv0 = applyMat(lv0, R, T);
      const wv1 = applyMat(lv1, R, T);
      const wv2 = applyMat(lv2, R, T);
      brickPos.push(
        wv0[0] * scale, -wv0[1] * scale, wv0[2] * scale,
        wv1[0] * scale, -wv1[1] * scale, wv1[2] * scale,
        wv2[0] * scale, -wv2[1] * scale, wv2[2] * scale,
      );
    }

    // Per-brick smooth normals: merge coincident vertices WITHIN this brick,
    // compute vertex normals, then extract the smoothed data.
    // Skip merging for tiny bricks (< 60 floats = 20 tris) — no cylinders to smooth.
    const triCount = brickPos.length / 9;
    if (brickPos.length >= 9 && triCount >= 20) {
      const brickGeo = new THREE.BufferGeometry();
      brickGeo.setAttribute('position', new THREE.Float32BufferAttribute(brickPos, 3));
      const merged = mergeVertices(brickGeo, 1e-4);
      merged.computeVertexNormals();
      // Extract back to non-indexed flat arrays for the color group
      const idx = merged.index;
      const pos = merged.getAttribute('position');
      const norm = merged.getAttribute('normal');
      if (idx && pos && norm) {
        for (let i = 0; i < idx.count; i++) {
          const vi = idx.getX(i);
          group.positions.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
          group.normals.push(norm.getX(vi), norm.getY(vi), norm.getZ(vi));
        }
      } else {
        // Fallback: use raw positions with face normals
        group.positions.push(...brickPos);
        const rawGeo = new THREE.BufferGeometry();
        rawGeo.setAttribute('position', new THREE.Float32BufferAttribute(brickPos, 3));
        rawGeo.computeVertexNormals();
        const n = rawGeo.getAttribute('normal')!;
        for (let i = 0; i < n.count; i++) group.normals.push(n.getX(i), n.getY(i), n.getZ(i));
        rawGeo.dispose();
      }
      merged.dispose();
      brickGeo.dispose();
    } else if (brickPos.length >= 9) {
      // Small bricks: use flat face normals (no merging needed)
      group.positions.push(...brickPos);
      const rawGeo = new THREE.BufferGeometry();
      rawGeo.setAttribute('position', new THREE.Float32BufferAttribute(brickPos, 3));
      rawGeo.computeVertexNormals();
      const n = rawGeo.getAttribute('normal')!;
      for (let i = 0; i < n.count; i++) group.normals.push(n.getX(i), n.getY(i), n.getZ(i));
      rawGeo.dispose();
    }

    // Handle explicit-color triangles from multi-colored sub-parts (printed tiles, etc.)
    for (const [cid, ctris] of geom.colorTris) {
      const cGroup = getGroup(cid);
      const cPos: number[] = [];
      for (const [lv0, lv1, lv2] of ctris) {
        const wv0 = applyMat(lv0, R, T);
        const wv1 = applyMat(lv1, R, T);
        const wv2 = applyMat(lv2, R, T);
        cPos.push(
          wv0[0] * scale, -wv0[1] * scale, wv0[2] * scale,
          wv1[0] * scale, -wv1[1] * scale, wv1[2] * scale,
          wv2[0] * scale, -wv2[1] * scale, wv2[2] * scale,
        );
      }
      if (cPos.length > 0) {
        cGroup.positions.push(...cPos);
        const rawGeo = new THREE.BufferGeometry();
        rawGeo.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
        rawGeo.computeVertexNormals();
        const n = rawGeo.getAttribute('normal')!;
        for (let i = 0; i < n.count; i++) cGroup.normals.push(n.getX(i), n.getY(i), n.getZ(i));
        rawGeo.dispose();
      }
    }

    // Collect edge lines grouped by brick color (cap total at 2M segments)
    if (totalEdgeFloats < 12_000_000) {
      let eg = edgeGroups.get(brick.color);
      if (!eg) { eg = { positions: [] }; edgeGroups.set(brick.color, eg); }
      for (const [ev0, ev1] of geom.edges) {
        const we0 = applyMat(ev0, R, T);
        const we1 = applyMat(ev1, R, T);
        eg.positions.push(
          we0[0] * scale, -we0[1] * scale, we0[2] * scale,
          we1[0] * scale, -we1[1] * scale, we1[2] * scale,
        );
        totalEdgeFloats += 6;
      }
    }
  }

  if (missingCount > 0) {
    console.warn(`[ldraw-renderer] ${missingCount} bricks had no geometry (${renderedCount} rendered)`);
  }

  // ── Scene setup ────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bgColor);
  scene.fog = new THREE.FogExp2(bgColor, 0.008); // subtle depth fade

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.1,
    2000,
  );

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      logarithmicDepthBuffer: true, // prevents z-fighting on large models
      powerPreference: 'high-performance',
    });
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
  // Reinhard preserves color ratios better than ACES for gray/pastel tones,
  // maintaining the subtle bluish-gray distinctions critical for LEGO models.
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 1.6;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // ── Environment map for realistic plastic reflections ──────────────────
  {
    const pmremGen = new THREE.PMREMGenerator(renderer);
    pmremGen.compileEquirectangularShader();
    // Create a simple studio environment: white top hemisphere, gray bottom
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0xcccccc);
    const envLight = new THREE.HemisphereLight(0xffffff, 0x888888, 1.0);
    envScene.add(envLight);
    scene.environment = pmremGen.fromScene(envScene, 0.04).texture;
    pmremGen.dispose();
  }

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
  keyLight.shadow.mapSize.set(4096, 4096);
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);

  // Fill light (cooler, opposite side — softer)
  const fillLight = new THREE.DirectionalLight(0xd0e0ff, 1.0);
  fillLight.position.set(-40, 30, -30);
  scene.add(fillLight);

  // Rim/back light for edge definition
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
  rimLight.position.set(0, 20, -60);
  scene.add(rimLight);

  // Bottom fill to reduce harsh shadows under overhangs
  const bottomFill = new THREE.DirectionalLight(0xe0e0ff, 0.3);
  bottomFill.position.set(0, -20, 0);
  scene.add(bottomFill);

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
    if (group.normals.length === group.positions.length) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(group.normals, 3));
    } else {
      geometry.computeVertexNormals();
    }
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
    const rubber = isRubberColor(colorId);

    let material: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
    if (transparent) {
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.05, metalness: 0.0,
        transmission: 0.85, ior: 1.45, thickness: 0.5,
        transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
        // Subtle glow for colored transparent parts (headlights, signal lights)
        emissive: color.clone().multiplyScalar(0.15),
      });
    } else if (metallic) {
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.15, metalness: 0.85,
        side: THREE.DoubleSide,
      });
    } else if (rubber) {
      // Rubber: matte finish, no clearcoat, slightly higher roughness
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.6, metalness: 0.0,
        side: THREE.DoubleSide,
      });
    } else {
      // Standard ABS plastic: semi-glossy with clearcoat
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.3, metalness: 0.0,
        clearcoat: 0.3, clearcoatRoughness: 0.4,
        side: THREE.DoubleSide,
      });
    }

    // Slight emissive tint for richer plastic look
    if (!transparent && !metallic) {
      (material as THREE.MeshPhysicalMaterial).emissive = color.clone().multiplyScalar(0.01);
    }

    // Reduce z-fighting between overlapping coplanar surfaces
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (transparent) mesh.renderOrder = 1; // render after opaque
    scene.add(mesh);
    meshes.push(mesh);
  }

  // ── Edge lines (per-brick-color outlines) ──────────────────────────────
  for (const [colorId, eg] of edgeGroups) {
    if (eg.positions.length === 0) continue;
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(eg.positions, 3));
    // Contextual edge color: darken light bricks, lighten dark bricks
    const baseColor = getThreeColor(colorId);
    const lum = baseColor.r * 0.299 + baseColor.g * 0.587 + baseColor.b * 0.114;
    const edgeColor = lum > 0.4
      ? baseColor.clone().multiplyScalar(0.35) // dark edges for light bricks
      : new THREE.Color(0.25, 0.25, 0.3);     // subtle light edges for dark bricks
    const edgeMat = new THREE.LineBasicMaterial({
      color: edgeColor,
      transparent: true,
      opacity: lum > 0.4 ? 0.4 : 0.2,
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
  const shadowRange = maxDim * 1.2;
  keyLight.shadow.camera.left = -shadowRange;
  keyLight.shadow.camera.right = shadowRange;
  keyLight.shadow.camera.top = shadowRange;
  keyLight.shadow.camera.bottom = -shadowRange;
  keyLight.shadow.camera.far = maxDim * 4;
  keyLight.target.position.copy(center);
  scene.add(keyLight.target);

  // ── Curved studio backdrop (cyc-wall) ──────────────────────────────────
  // Seamless transition from floor to background — no visible horizon line
  {
    const gs = maxDim * 2.5;
    const curveR = gs * 0.6; // radius of the curved back wall
    const floorY = bboxMin.y - 0.01;
    const backdropMat = new THREE.MeshStandardMaterial({
      color: groundColor, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide,
    });
    // Floor plane
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(gs * 2, gs * 2), backdropMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(center.x, floorY, center.z);
    floor.receiveShadow = true;
    scene.add(floor);
    // Curved back wall (quarter-cylinder) — smoothly curves from floor upward
    const curveSegs = 24;
    const curveGeo = new THREE.BufferGeometry();
    const verts: number[] = [], norms: number[] = [], uvs: number[] = [];
    for (let i = 0; i <= curveSegs; i++) {
      const t = i / curveSegs;
      const angle = t * Math.PI * 0.5; // 0 → π/2 (floor → vertical wall)
      const y = floorY + curveR * Math.sin(angle);
      const z = center.z - gs + curveR * (1 - Math.cos(angle));
      for (const x of [center.x - gs, center.x + gs]) {
        verts.push(x, y, z);
        norms.push(0, Math.cos(angle), Math.sin(angle));
        uvs.push(x < center.x ? 0 : 1, t);
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < curveSegs; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
    curveGeo.setIndex(indices);
    curveGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    curveGeo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
    curveGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const backWall = new THREE.Mesh(curveGeo, backdropMat);
    backWall.receiveShadow = true;
    scene.add(backWall);
  }

  // ── Camera positioning ─────────────────────────────────────────────────
  // Adapt camera angle to model shape:
  //   Wide/flat models (buildings) → lower elevation, more frontal
  //   Tall models (towers, figures) → higher elevation, more offset
  const camDist = maxDim * 1.5;
  const aspectRatio = size.y / Math.max(size.x, size.z, 1); // height / footprint
  const elevationFactor = Math.min(0.5, 0.25 + aspectRatio * 0.15); // 0.25 → 0.5
  camera.position.set(
    center.x + camDist * 0.35,
    center.y + camDist * elevationFactor,
    center.z + camDist * 0.8,
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
  controls.autoRotate = false;
  controls.autoRotateSpeed = 1.5;
  controls.update();

  // ── Post-processing: SAO ambient occlusion ─────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const saoPass = new SAOPass(scene, camera);
  saoPass.params.saoBias = 0.5;
  saoPass.params.saoIntensity = 0.015;
  saoPass.params.saoScale = 10;
  saoPass.params.saoKernelRadius = 30;
  saoPass.params.saoBlurRadius = 4;
  composer.addPass(saoPass);
  composer.addPass(new OutputPass());
  composer.setSize(container.clientWidth, container.clientHeight);

  // ── Render loop ────────────────────────────────────────────────────────
  let animId = 0;
  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    composer.render();
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
    composer.setSize(w, h);
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
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      for (const mesh of meshes) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.dispose();
        mesh.geometry.dispose();
      }
      scene.environment?.dispose();
    },
  };
}
