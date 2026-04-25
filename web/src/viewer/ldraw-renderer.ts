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
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
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
const MAX_CACHE_ENTRIES = 10000; // prevent unbounded memory growth
/** Color IDs discovered to be transparent via inline !COLOUR ALPHA definitions */
const inlineTransparentColors = new Set<number>();
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
        const r = await fetch(path, { signal: AbortSignal.timeout(5000) });
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
    // Evict oldest cache entries if approaching limit
    if (partGeomCache.size > MAX_CACHE_ENTRIES) {
      const it = partGeomCache.keys();
      for (let i = 0; i < 1000; i++) { const k = it.next(); if (k.done) break; partGeomCache.delete(k.value); }
    }

    const geom: PartGeom = { tris: [], edges: [], colorTris: new Map(), colorEdges: new Map() };
    partGeomCache.set(key, geom); // cache early (cycle guard)

    const subPromises: Promise<void>[] = [];

    // Parse BFC meta-commands to determine winding convention
    let bfcCertified = false;
    let bfcCCW = true; // default CCW if certified
    let invertNext = false;
    let texmapDepth = 0; // skip geometry inside TEXMAP BEGIN...END blocks

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // Skip embedded data blocks (base64 texture data)
      if (/^0\s+!DATA\s/i.test(line)) { texmapDepth++; continue; }
      if (/^0\s+!:/i.test(line) && texmapDepth > 0) continue; // data continuation line

      // Track TEXMAP blocks — skip their geometry (we can't render textures)
      if (/^0\s+!TEXMAP\s+START/i.test(line) || /^0\s+!TEXMAP\s+NEXT/i.test(line)) {
        texmapDepth++;
        continue;
      }
      if (/^0\s+!TEXMAP\s+FALLBACK/i.test(line)) {
        // Use fallback geometry — it renders without textures
        texmapDepth = Math.max(0, texmapDepth - 1);
        continue;
      }
      if (/^0\s+!TEXMAP\s+END/i.test(line)) {
        texmapDepth = Math.max(0, texmapDepth - 1);
        continue;
      }
      if (texmapDepth > 0) continue; // skip textured geometry

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
        const alphaIdx = tok.indexOf('ALPHA');
        if (codeIdx > 0 && valIdx > 0 && tok[codeIdx + 1] && tok[valIdx + 1]) {
          const cid = parseInt(tok[codeIdx + 1], 10);
          const rgb = tok[valIdx + 1];
          if (!isNaN(cid) && rgb.startsWith('#')) {
            const { LDRAW_COLOR_RGB } = await import('@engine/ldraw-colors.js');
            if (!(cid in LDRAW_COLOR_RGB)) {
              (LDRAW_COLOR_RGB as Record<number, string>)[cid] = rgb;
            }
            // If ALPHA < 255, register as transparent
            if (alphaIdx > 0 && tok[alphaIdx + 1]) {
              const alpha = parseInt(tok[alphaIdx + 1], 10);
              if (alpha < 200) inlineTransparentColors.add(cid);
            }
          }
        }
        continue;
      }

      if (tok[0] === '2' && tok.length >= 8) {
        const edgeColor = parseInt(tok[1]!, 10);
        const edge: Edge = [[+tok[2]!, +tok[3]!, +tok[4]!], [+tok[5]!, +tok[6]!, +tok[7]!]];
        if (edgeColor !== 24 && edgeColor !== 16 && !isNaN(edgeColor)) {
          const ce = geom.colorEdges.get(edgeColor) ?? (() => { const a: Edge[] = []; geom.colorEdges.set(edgeColor, a); return a; })();
          ce.push(edge);
        } else {
          geom.edges.push(edge);
        }
      } else if (tok[0] === '5' && tok.length >= 14) {
        const edge: Edge = [[+tok[2]!, +tok[3]!, +tok[4]!], [+tok[5]!, +tok[6]!, +tok[7]!]];
        geom.edges.push(edge); // conditional edges always inherit
      } else if (tok[0] === '3' && tok.length >= 11) {
        const triColor = parseInt(tok[1]!, 10);
        const x0 = +tok[2]!, y0 = +tok[3]!, z0 = +tok[4]!;
        const x1 = +tok[5]!, y1 = +tok[6]!, z1 = +tok[7]!;
        const x2 = +tok[8]!, y2 = +tok[9]!, z2 = +tok[10]!;
        if (isNaN(x0+y0+z0+x1+y1+z1+x2+y2+z2)) continue; // skip corrupt data
        const v0: Vec3 = [x0, y0, z0];
        const v1: Vec3 = [x1, y1, z1];
        const v2: Vec3 = [x2, y2, z2];
        const shouldInvert = invertWinding !== (!bfcCCW);
        const tri: Triangle = shouldInvert ? [v0, v2, v1] : [v0, v1, v2];
        // Route non-16 colored triangles to their own color group
        if (triColor !== 16 && triColor !== 24 && !isNaN(triColor)) {
          const ct = geom.colorTris.get(triColor) ?? (() => { const a: Triangle[] = []; geom.colorTris.set(triColor, a); return a; })();
          ct.push(tri);
        } else {
          geom.tris.push(tri);
        }
      } else if (tok[0] === '4' && tok.length >= 14) {
        const quadColor = parseInt(tok[1]!, 10);
        const qx0=+tok[2]!,qy0=+tok[3]!,qz0=+tok[4]!,qx1=+tok[5]!,qy1=+tok[6]!,qz1=+tok[7]!;
        const qx2=+tok[8]!,qy2=+tok[9]!,qz2=+tok[10]!,qx3=+tok[11]!,qy3=+tok[12]!,qz3=+tok[13]!;
        if (isNaN(qx0+qy0+qz0+qx1+qy1+qz1+qx2+qy2+qz2+qx3+qy3+qz3)) continue;
        const v0: Vec3 = [qx0,qy0,qz0], v1: Vec3 = [qx1,qy1,qz1];
        const v2: Vec3 = [qx2,qy2,qz2], v3: Vec3 = [qx3,qy3,qz3];
        const shouldInvert = invertWinding !== (!bfcCCW);
        const t1: Triangle = shouldInvert ? [v0, v2, v1] : [v0, v1, v2];
        const t2: Triangle = shouldInvert ? [v0, v3, v2] : [v0, v2, v3];
        if (quadColor !== 16 && quadColor !== 24 && !isNaN(quadColor)) {
          const ct = geom.colorTris.get(quadColor) ?? (() => { const a: Triangle[] = []; geom.colorTris.set(quadColor, a); return a; })();
          ct.push(t1, t2);
        } else {
          geom.tris.push(t1, t2);
        }
      } else if (tok[0] === '1' && tok.length >= 15 && depth < 19) {
        const subColor = parseInt(tok[1]!, 10);
        const tx = +tok[2]!, ty = +tok[3]!, tz = +tok[4]!;
        if (isNaN(tx + ty + tz)) continue; // corrupt position
        const R = [+tok[5]!,+tok[6]!,+tok[7]!, +tok[8]!,+tok[9]!,+tok[10]!, +tok[11]!,+tok[12]!,+tok[13]!];
        if (R.some(isNaN)) continue; // corrupt rotation matrix
        const T: Vec3 = [tx, ty, tz];
        const subId = tok.slice(14).join(' ').trim();
        if (!subId) continue; // no sub-file reference

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

    await Promise.allSettled(subPromises); // don't fail entire part on one bad sub-ref
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
  if (colorId >= 0x3000000 && colorId < 0x4000000) return true; // direct trans colors
  if (inlineTransparentColors.has(colorId)) return true;       // inline !COLOUR ALPHA
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

/** Glow-in-dark color IDs — strong emissive */
function isGlowColor(colorId: number): boolean {
  return colorId === 21 || colorId === 294 || colorId === 601;
}

/** Rubber color IDs — higher roughness, no clearcoat */
function isRubberColor(colorId: number): boolean {
  if (colorId === 256 || colorId === 273 || colorId === 324 || colorId === 375) return true;
  if (colorId >= 10000 && colorId < 11000) return true; // 10xxx = BrickLink rubber
  return false;
}

function getThreeColor(colorId: number): THREE.Color {
  if (isNaN(colorId)) return new THREE.Color(0x808080);
  // LDraw direct colors: 0x2RRGGBB encodes RGB in the color ID itself
  if (colorId >= 0x2000000) {
    const r = ((colorId >> 16) & 0xFF) / 255;
    const g = ((colorId >> 8) & 0xFF) / 255;
    const b = (colorId & 0xFF) / 255;
    return new THREE.Color(r, g, b);
  }
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

  // ── Clear stale state from previous loads ───────────────────────────────
  inlineTransparentColors.clear();
  for (const key of [...partGeomCache.keys()]) {
    if (key.endsWith('.ldr')) { partGeomCache.delete(key); datTextCache.delete(key); }
  }

  // ── Pre-load MPD inline sub-models into the .dat cache ─────────────────
  if (options?.mpdContent) {
    const lines = options.mpdContent.split(/\r?\n/);
    let currentName: string | null = null;
    let currentLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      const fileMatch = /^0\s+FILE\s+(.+)$/i.exec(trimmed);
      const nofileMatch = /^0\s+NOFILE\s*$/i.test(trimmed);
      if (fileMatch) {
        if (currentName) {
          datTextCache.set(normId(currentName), currentLines.join('\n'));
        }
        currentName = fileMatch[1].trim();
        currentLines = [];
      } else if (nofileMatch) {
        if (currentName) {
          datTextCache.set(normId(currentName), currentLines.join('\n'));
          currentName = null;
          currentLines = [];
        }
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

  // Prefetch unique parts with concurrency limit to avoid overwhelming browser connections
  let done = 0;
  const CONCURRENCY = 20;
  for (let i = 0; i < uniqueParts.length; i += CONCURRENCY) {
    const batch = uniqueParts.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (partId) => {
      await resolvePartGeometry(partId);
      done++;
      onProgress?.(done, uniqueParts.length);
    }));
  }

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
    if (!geom || (geom.tris.length === 0 && geom.colorTris.size === 0)) {
      missingCount++;
      if (missingCount <= 5) console.warn(`[ldraw-renderer] Missing geometry for: ${brick.part}`);
      continue;
    }
    renderedCount++;

    const R = brick.rot ?? IDENTITY;
    const T: Vec3 = [brick.x, brick.y, brick.z];

    const group = getGroup(isNaN(brick.color) ? 71 : brick.color); // fallback to light gray

    // Collect this brick's positions, compute smooth normals PER-BRICK,
    // then append both positions and normals to the color group.
    const brickPos: number[] = [];
    for (const [lv0, lv1, lv2] of geom.tris) {
      const wv0 = applyMat(lv0, R, T);
      const wv1 = applyMat(lv1, R, T);
      const wv2 = applyMat(lv2, R, T);
      const x0 = wv0[0] * scale, y0 = -wv0[1] * scale, z0 = wv0[2] * scale;
      const x1 = wv1[0] * scale, y1 = -wv1[1] * scale, z1 = wv1[2] * scale;
      const x2 = wv2[0] * scale, y2 = -wv2[1] * scale, z2 = wv2[2] * scale;
      // Skip degenerate triangles (zero area — all vertices coincident)
      if (x0 === x1 && y0 === y1 && z0 === z1 &&
          x0 === x2 && y0 === y2 && z0 === z2) continue;
      brickPos.push(x0, y0, z0, x1, y1, z1, x2, y2, z2);
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
      // Also collect explicit-color edges
      for (const [cid, cedges] of geom.colorEdges) {
        let ceg = edgeGroups.get(cid);
        if (!ceg) { ceg = { positions: [] }; edgeGroups.set(cid, ceg); }
        for (const [ev0, ev1] of cedges) {
          const we0 = applyMat(ev0, R, T);
          const we1 = applyMat(ev1, R, T);
          ceg.positions.push(
            we0[0] * scale, -we0[1] * scale, we0[2] * scale,
            we1[0] * scale, -we1[1] * scale, we1[2] * scale,
          );
          totalEdgeFloats += 6;
        }
      }
    }
  }

  if (missingCount > 0) {
    console.warn(`[ldraw-renderer] ${missingCount} bricks had no geometry (${renderedCount} rendered)`);
  }
  // Expose brick counts on the container for debugging/QA
  container.dataset.brickCount = String(renderedCount);
  container.dataset.missingCount = String(missingCount);
  container.dataset.colorGroups = String(colorGroups.size);

  // ── Scene setup ────────────────────────────────────────────────────────
  const scene = new THREE.Scene();
  // Vertical gradient background: lighter at top, darker at bottom (studio look)
  {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const top = new THREE.Color(bgColor).multiplyScalar(1.4); // 40% brighter at top
    const bot = new THREE.Color(bgColor).multiplyScalar(0.8); // 20% darker at bottom
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, `rgb(${top.r*255|0},${top.g*255|0},${top.b*255|0})`);
    grad.addColorStop(1, `rgb(${bot.r*255|0},${bot.g*255|0},${bot.b*255|0})`);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 2, 256);
    const bgTex = new THREE.CanvasTexture(canvas);
    bgTex.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = bgTex;
  }
  // Fog added after model bounds are known (density scaled to model size)

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
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // needed for captureScreenshot()
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

  // Ensure container has dimensions — wait if needed
  let cw = container.clientWidth, ch = container.clientHeight;
  if (cw === 0 || ch === 0) {
    await new Promise<void>(resolve => {
      const obs = new ResizeObserver(() => {
        cw = container.clientWidth; ch = container.clientHeight;
        if (cw > 0 && ch > 0) { obs.disconnect(); resolve(); }
      });
      obs.observe(container);
      setTimeout(() => { obs.disconnect(); cw = cw || 800; ch = ch || 600; resolve(); }, 2000);
    });
  }
  renderer.setSize(cw, ch);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // ACES filmic preserves saturation under bright lights better than Reinhard,
  // which tends to wash colors out — Mecabricks-style renders rely on saturation.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Clear any pre-existing content (e.g. caller-provided "Loading..." spinner)
  // before mounting the canvas so overlay text doesn't sit on top of the render.
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(renderer.domElement);

  // ── Environment map for realistic plastic reflections ──────────────────
  try {
    const pmremGen = new THREE.PMREMGenerator(renderer);
    pmremGen.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0xd0d0d8);
    envScene.add(new THREE.HemisphereLight(0xfff8f0, 0x8090a0, 1.2));
    const ceilingLight = new THREE.RectAreaLight(0xffffff, 3.0, 50, 50);
    ceilingLight.position.set(0, 30, 0);
    ceilingLight.lookAt(0, 0, 0);
    envScene.add(ceilingLight);
    scene.environment = pmremGen.fromScene(envScene, 0.04).texture;
    scene.environmentIntensity = 0.6;
    pmremGen.dispose();
  } catch (e) {
    console.warn('[ldraw-renderer] Environment map failed (GPU limitation):', e);
  }

  // ── Lighting (product photography style) ───────────────────────────────
  // Soft ambient fill
  const ambient = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(ambient);

  // Hemisphere light for sky/ground gradient
  const hemi = new THREE.HemisphereLight(0xc8e0ff, 0x443322, 0.3);
  scene.add(hemi);

  // Key light (main directional — warm, upper-right)
  const keyLight = new THREE.DirectionalLight(0xfff5e6, 3.5);
  keyLight.position.set(50, 80, 40);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(4096, 4096);
  keyLight.shadow.bias = -0.0005;
  keyLight.shadow.normalBias = 0.02;
  keyLight.shadow.radius = 3; // soft shadow edges
  scene.add(keyLight);

  // Fill light (cooler, opposite side — softer)
  const fillLight = new THREE.DirectionalLight(0xd0e0ff, 0.8);
  fillLight.position.set(-40, 30, -30);
  scene.add(fillLight);

  // Rim/back light for edge definition
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
  rimLight.position.set(0, 20, -60);
  scene.add(rimLight);

  // Bottom fill to reduce harsh shadows under overhangs
  const bottomFill = new THREE.DirectionalLight(0xe0e0ff, 0.15);
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
    const glow = isGlowColor(colorId);

    let material: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
    if (glow) {
      // Glow-in-dark: strong yellowish-green emissive
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.35, metalness: 0.0,
        emissive: color.clone().multiplyScalar(0.3),
        clearcoat: 0.2, clearcoatRoughness: 0.5,
        side: THREE.DoubleSide,
      });
    } else if (transparent) {
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.05, metalness: 0.0,
        transmission: 0.85, ior: 1.45, thickness: 0.5,
        specularIntensity: 1.0,
        specularColor: new THREE.Color(0xffffff),
        transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
        emissive: color.clone().multiplyScalar(0.12),
      });
    } else if (metallic) {
      // Pearl/chrome: warm specular highlight for realistic metallic look
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.1, metalness: 0.92,
        envMapIntensity: 1.5, // metallic parts strongly reflect environment
        clearcoat: 0.6, clearcoatRoughness: 0.08,
        specularIntensity: 1.5,
        specularColor: color.clone().lerp(new THREE.Color(0xffffff), 0.3),
        side: THREE.DoubleSide,
        emissive: color.clone().multiplyScalar(0.04),
      });
    } else if (rubber) {
      // Rubber: matte finish, no clearcoat, minimal reflections
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.55, metalness: 0.0,
        envMapIntensity: 0.1, // rubber barely reflects
        side: THREE.DoubleSide,
        emissive: color.clone().multiplyScalar(0.005),
      });
    } else {
      // Standard ABS plastic: semi-glossy with clearcoat
      // Dark colors appear glossier in real LEGO (more visible reflections)
      const lum = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
      const clearcoatAmt = 0.2 + (1 - lum) * 0.25; // 0.2 (white) → 0.45 (black)
      material = new THREE.MeshPhysicalMaterial({
        color, roughness: 0.28, metalness: 0.0,
        envMapIntensity: 0.5 + (1 - lum) * 0.3, // dark bricks reflect more (0.5→0.8)
        clearcoat: clearcoatAmt, clearcoatRoughness: 0.35,
        side: THREE.DoubleSide,
      });
      // Subtle warm emissive tint for richness
      material.emissive = color.clone().multiplyScalar(0.008);
    }

    // z-fighting handled by logarithmic depth buffer (no polygon offset needed)

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (transparent) mesh.renderOrder = 1; // render after opaque
    scene.add(mesh);
    meshes.push(mesh);
  }

  // ── Edge lines (batched with per-vertex colors) ────────────────────────
  // Single draw call for ALL edge lines instead of one per color group.
  {
    const allEdgePos: number[] = [];
    const allEdgeCol: number[] = [];
    for (const [colorId, eg] of edgeGroups) {
      if (eg.positions.length === 0) continue;
      const baseColor = getThreeColor(colorId);
      const lum = baseColor.r * 0.299 + baseColor.g * 0.587 + baseColor.b * 0.114;
      const ec = lum > 0.4
        ? baseColor.clone().multiplyScalar(0.35)
        : new THREE.Color(0.25, 0.25, 0.3);
      const opacity = lum > 0.4 ? 0.4 : 0.2;
      for (let i = 0; i < eg.positions.length; i += 3) {
        allEdgePos.push(eg.positions[i]!, eg.positions[i+1]!, eg.positions[i+2]!);
        allEdgeCol.push(ec.r * opacity, ec.g * opacity, ec.b * opacity);
      }
    }
    if (allEdgePos.length > 0) {
      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(allEdgePos, 3));
      edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(allEdgeCol, 3));
      const edgeMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true, opacity: 1.0,
        depthWrite: false,
      });
      const edgeLines = new THREE.LineSegments(edgeGeo, edgeMat);
      edgeLines.renderOrder = 2;
      scene.add(edgeLines);
    }
  }

  // ── Compute model center and size ──────────────────────────────────────
  const center = new THREE.Vector3().lerpVectors(bboxMin, bboxMax, 0.5);
  const size = new THREE.Vector3().subVectors(bboxMax, bboxMin);
  const maxDim = Math.max(size.x, size.y, size.z) || 10;

  // ── Model-scaled fog for subtle depth fade ─────────────────────────────
  scene.fog = new THREE.FogExp2(bgColor, 0.15 / maxDim);

  // ── Reposition lights relative to model bounds ─────────────────────────
  const d = maxDim; // shorthand for model-relative offsets
  keyLight.position.set(center.x + d * 0.6, center.y + d * 1.0, center.z + d * 0.5);
  fillLight.position.set(center.x - d * 0.5, center.y + d * 0.4, center.z - d * 0.4);
  rimLight.position.set(center.x, center.y + d * 0.3, center.z - d * 0.8);
  bottomFill.position.set(center.x, center.y - d * 0.3, center.z);

  // ── Configure shadow camera to cover the model ─────────────────────────
  const shadowRange = maxDim * 1.2;
  keyLight.shadow.camera.left = -shadowRange;
  keyLight.shadow.camera.right = shadowRange;
  keyLight.shadow.camera.top = shadowRange;
  keyLight.shadow.camera.bottom = -shadowRange;
  keyLight.shadow.camera.near = maxDim * 0.1;
  keyLight.shadow.camera.far = maxDim * 4;
  keyLight.target.position.copy(center);
  scene.add(keyLight.target);

  // ── Curved studio backdrop (cyc-wall) ──────────────────────────────────
  // Seamless transition from floor to background — no visible horizon line
  {
    const gs = maxDim * 2.5;
    const curveR = gs * 0.6; // radius of the curved back wall
    const floorY = bboxMin.y - 0.01;
    const backdropMat = new THREE.MeshPhysicalMaterial({
      color: groundColor, roughness: 0.7, metalness: 0.0,
      clearcoat: 0.1, clearcoatRoughness: 0.5,
      side: THREE.DoubleSide,
    });
    // Floor plane
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(gs * 2, gs * 2), backdropMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(center.x, floorY, center.z);
    floor.receiveShadow = true;
    scene.add(floor);
    // Contact shadow — elliptical, matching model's XZ footprint
    const csx = Math.max(size.x, 1) * 0.55;
    const csz = Math.max(size.z, 1) * 0.55;
    const contactGeo = new THREE.CircleGeometry(1, 48);
    const contactMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.1, depthWrite: false,
    });
    const contactShadow = new THREE.Mesh(contactGeo, contactMat);
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.scale.set(csx, csz, 1);
    contactShadow.position.set(center.x, floorY + 0.005, center.z);
    scene.add(contactShadow);
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
  // Pick a 3/4 view direction, then iteratively fit the camera so all 8 corners
  // of the bbox project inside the viewport. This is tighter than fitting the
  // bounding sphere — buildings and other elongated models no longer leave a
  // large empty region on the minor axis.
  const aspectRatio = size.y / Math.max(size.x, size.z, 1); // height / footprint
  const elevationFactor = Math.min(0.45, 0.22 + aspectRatio * 0.15); // 0.22 → 0.45
  const dirX = 0.42, dirY = elevationFactor, dirZ = 0.85;
  const dirLen = Math.hypot(dirX, dirY, dirZ) || 1;
  const ndir = new THREE.Vector3(dirX / dirLen, dirY / dirLen, dirZ / dirLen);

  const aspect = camera.aspect;
  const fovV = (camera.fov * Math.PI) / 180;
  const tanV = Math.tan(fovV / 2);
  const tanH = tanV * aspect;

  // Bbox corners in world space
  const corners = [
    new THREE.Vector3(bboxMin.x, bboxMin.y, bboxMin.z),
    new THREE.Vector3(bboxMax.x, bboxMin.y, bboxMin.z),
    new THREE.Vector3(bboxMin.x, bboxMax.y, bboxMin.z),
    new THREE.Vector3(bboxMax.x, bboxMax.y, bboxMin.z),
    new THREE.Vector3(bboxMin.x, bboxMin.y, bboxMax.z),
    new THREE.Vector3(bboxMax.x, bboxMin.y, bboxMax.z),
    new THREE.Vector3(bboxMin.x, bboxMax.y, bboxMax.z),
    new THREE.Vector3(bboxMax.x, bboxMax.y, bboxMax.z),
  ];
  // Camera basis (looking from ndir toward center): forward = -ndir
  const forward = ndir.clone().negate();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  // For each corner, the required distance along ndir from center such that
  // the corner just fits is: dist >= |corner_x|/tanH + corner_z (and same for y).
  // corner_x = corner·right, corner_y = corner·up, corner_z = (corner-camPos)·forward
  // We solve for camPos = center + ndir * D such that all corners fit.
  let maxDist = 0;
  for (const c of corners) {
    const local = c.clone().sub(center);
    const lx = Math.abs(local.dot(right));
    const ly = Math.abs(local.dot(up));
    const lz = local.dot(ndir); // signed: positive = closer to camera
    // Required distance D so that lx <= tanH * (D - lz) and ly <= tanV * (D - lz)
    const reqH = lx / tanH + lz;
    const reqV = ly / tanV + lz;
    maxDist = Math.max(maxDist, reqH, reqV);
  }
  const fitDist = Math.max(maxDist, size.length() * 0.5) * 1.08;

  camera.position.set(
    center.x + ndir.x * fitDist,
    center.y + ndir.y * fitDist,
    center.z + ndir.z * fitDist,
  );
  camera.lookAt(center);
  camera.near = Math.max(0.01, fitDist * 0.001);
  camera.far = fitDist * 10;
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
  // Skip SAO for very large models (>3000 rendered bricks) to maintain framerate
  if (renderedCount <= 3000) {
    const saoPass = new SAOPass(scene, camera);
    saoPass.params.saoBias = 0.5;
    saoPass.params.saoIntensity = 0.012;
    saoPass.params.saoScale = Math.max(5, maxDim * 0.5);
    saoPass.params.saoKernelRadius = Math.max(15, maxDim * 1.5);
    saoPass.params.saoBlurRadius = 6;
    composer.addPass(saoPass);
  }
  // FXAA anti-aliasing for smoother geometry edges
  const fxaaPass = new ShaderPass(FXAAShader);
  const pixelRatio = renderer.getPixelRatio();
  fxaaPass.material.uniforms['resolution'].value.set(
    1 / (container.clientWidth * pixelRatio),
    1 / (container.clientHeight * pixelRatio),
  );
  composer.addPass(fxaaPass);
  // Subtle vignette for cinematic/studio look
  const vignettePass = new ShaderPass(VignetteShader);
  vignettePass.uniforms['offset'].value = 1.2;
  vignettePass.uniforms['darkness'].value = 0.8;
  composer.addPass(vignettePass);
  composer.addPass(new OutputPass());
  composer.setSize(container.clientWidth, container.clientHeight);

  // ── Render loop ────────────────────────────────────────────────────────
  let animId = 0;
  function animate() {
    // Stop rendering if container was removed from DOM (tab switch, cleanup)
    if (!container.isConnected) { cancelAnimationFrame(animId); return; }
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
    const pr = renderer.getPixelRatio();
    fxaaPass.material.uniforms['resolution'].value.set(1 / (w * pr), 1 / (h * pr));
  });
  resizeObs.observe(container);

  // ── Return ViewerState ─────────────────────────────────────────────────
  const dummyGrid = new BlockGrid(1, 1, 1);

  /** Capture a PNG screenshot of the current view */
  const captureScreenshot = (): string => {
    composer.render();
    return renderer.domElement.toDataURL('image/png');
  };

  /** Toggle auto-rotation for presentation mode */
  const setAutoRotate = (enabled: boolean) => {
    controls.autoRotate = enabled;
  };

  return {
    scene,
    camera,
    renderer,
    controls,
    meshes: meshes as unknown as THREE.InstancedMesh[],
    grid: dummyGrid,
    captureScreenshot,
    setAutoRotate,
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
      if (scene.background instanceof THREE.Texture) scene.background.dispose();
    },
  };
}
