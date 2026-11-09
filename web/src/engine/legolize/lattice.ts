/**
 * Mesh -> stud lattice (BIZ-33, X-11): the first stage of turning an imported
 * 3D mesh (.obj / .glb / .stl) or an LDraw model into bricks.
 *
 * One lattice cell is 1 stud x 1 plate x 1 stud = 20 x 8 x 20 LDU. The mesh is
 * scaled to LDU (`lduPerUnit`), its Y axis stretched by 20/8, and then voxelised
 * ISOTROPICALLY at one 20 LDU cube per cell through the shared `threeToGridAsync`
 * (the same voxeliser the Minecraft pipeline uses), so a plate layer is exactly
 * one cell tall. Occupancy comes from that voxeliser; per-cell colour is read
 * separately (the voxeliser quantises colour to Minecraft blocks, which is no
 * use here) from the nearest surface point: COLOR_0, else the texture, else the
 * material colour, converted linear -> sRGB and snapped to an LDraw colour by an
 * injected `nearest`.
 *
 * Known limits (also in docs/plans, X-11):
 * - The lattice origin is the mesh's minimum corner, so a mesh whose lowest point
 *   is not on a plate multiple (e.g. LDraw studs, 4 LDU) can gain a sparse extra layer.
 *   TODO(X-12): add an optional lattice origin so two lattices can be aligned.
 * - 'solid' mode needs a watertight mesh; if it finds nothing (an open mesh) we
 *   fall back to 'surface' rather than return an empty model.
 * - Triangle counts in the millions are slow: the colour pass is one BVH query per filled cell.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { threeToGridAsync, type TextureSampler, type VoxelizeMode, type VoxelizeProgress } from '@craft/convert/voxelizer.js';
import type { RGB } from '@craft/types/index.js';
import { LDRAW_COLOR_RGB } from '../ldraw-colors.js';
import { capPlanarHoles } from './hole-cap.js';
import { createNearest, type NearestColour, type PaletteColour } from './palette.js';
import { latticeIndex, type IntentLabel, type IntentLattice } from './types.js';

/** Plate height stretch: a cell is 20 LDU wide but 8 LDU tall. */
const Y_STRETCH = 20 / 8;
/** Shrinks the scaled mesh a hair (> float32 rounding, 6e-8) so a face exactly on a cell boundary does not ceil into one more cell. */
const BOUNDARY_EPS = 1e-6;
/** Default ceiling on lattice cells (a 400 x 400 x 400 stud lattice would be 64M). */
const DEFAULT_MAX_CELLS = 20_000_000;

/** Options for {@link meshToLattice}. */
export interface MeshToLatticeOptions {
  /** LDU per input unit (default 1: the mesh is already in LDU). Metres: 1 stud = 8 mm -> 2500. */
  lduPerUnit?: number;
  /** 'solid' (watertight; interior filled) or 'surface' (open / photogrammetry shell). Default 'solid'. */
  mode?: VoxelizeMode;
  /** sRGB -> LDraw colour code. Default: nearest of the 40-colour {@link DEFAULT_PALETTE} in CIE-Lab. */
  nearest?: NearestColour;
  /** Samples a texture at a UV (browser: `createCanvasTextureSampler()`); without one, textured meshes use their material colour. */
  textureSampler?: TextureSampler;
  /** Throw before voxelising when the lattice would exceed this many cells. */
  maxCells?: number;
  onProgress?: (p: VoxelizeProgress) => void;
}

/** A triangle in any indexable form: three [x, y, z] vertices. */
export type TriangleLike = ReadonlyArray<readonly [number, number, number]>;

/** The slice of a parsed LDraw brick this module needs (structurally a `ParsedBrick`). */
export interface BrickLike {
  part: string;
  /** LDraw colour code (or a direct `0x2RRGGBB` colour). */
  color: number;
  /** LDU, LDraw frame (Y down). */
  x: number;
  y: number;
  z: number;
  /** Row-major 3x3 rotation; identity when absent. */
  rot?: number[];
}

/** Options for {@link latticeFromBricks}. */
export interface BricksToLatticeOptions {
  /** World-space (LDraw LDU, Y down) triangles of one brick. Default: the real part library via `__debugWorldTris`. */
  partTriangles?: (brick: BrickLike) => Promise<TriangleLike[]>;
  mode?: VoxelizeMode;
  maxCells?: number;
  onProgress?: (p: VoxelizeProgress) => void;
}

interface BvhGeometry extends THREE.BufferGeometry { boundsTree?: MeshBVH }

/** Result of the shared voxelise-and-colour core: occupancy + sRGB colour per filled cell. */
interface ColouredCells {
  dims: [number, number, number];
  /** Filled cells in plate-major order, with their sRGB colour. */
  filled: Array<{ index: number; rgb: RGB }>;
}

/** Linear-working-space RGB (0-1) to sRGB 0-255, clamped and rounded. */
const tmpColour = new THREE.Color();
function linearToSrgb255(r: number, g: number, b: number): RGB {
  tmpColour.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  const out = { r: 0, g: 0, b: 0 };
  tmpColour.getRGB(out, THREE.SRGBColorSpace);
  const c = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return [c(out.r), c(out.g), c(out.b)];
}

/** The material that draws triangle `faceIndex` (handles multi-material groups). */
function materialForFace(mesh: THREE.Mesh, faceIndex: number): THREE.Material {
  const m = mesh.material;
  if (!Array.isArray(m)) return m;
  for (const g of mesh.geometry.groups) {
    if (faceIndex * 3 >= g.start && faceIndex * 3 < g.start + g.count) return m[g.materialIndex ?? 0] ?? m[0]!;
  }
  return m[0]!;
}

/**
 * Colour (sRGB 0-255) of a mesh at a surface point: interpolated COLOR_0 if the
 * geometry has one, else the material's texture at the interpolated UV, else the
 * material colour. `local` is the closest point in the mesh's local space.
 */
function surfaceColour(
  mesh: THREE.Mesh, faceIndex: number, local: THREE.Vector3, sampler: TextureSampler | undefined,
): RGB {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.index;
  const ia = idx ? idx.getX(faceIndex * 3) : faceIndex * 3;
  const ib = idx ? idx.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
  const ic = idx ? idx.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;
  const a = new THREE.Vector3().fromBufferAttribute(pos, ia);
  const b = new THREE.Vector3().fromBufferAttribute(pos, ib);
  const c = new THREE.Vector3().fromBufferAttribute(pos, ic);
  const w = new THREE.Vector3();
  // A degenerate triangle has no barycentric coordinates; fall back to its first vertex.
  if (!THREE.Triangle.getBarycoord(local, a, b, c, w)) w.set(1, 0, 0);

  const mix = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, comp: number): number =>
    attr.getComponent(ia, comp) * w.x + attr.getComponent(ib, comp) * w.y + attr.getComponent(ic, comp) * w.z;

  const colourAttr = geo.getAttribute('color');
  if (colourAttr) return linearToSrgb255(mix(colourAttr, 0), mix(colourAttr, 1), mix(colourAttr, 2));

  const mat = materialForFace(mesh, faceIndex) as THREE.MeshStandardMaterial;
  const uvAttr = geo.getAttribute('uv');
  if (sampler && mat.map && uvAttr) {
    return sampler(mat.map, new THREE.Vector2(mix(uvAttr, 0), mix(uvAttr, 1)));
  }
  const out = { r: 0.69, g: 0.69, b: 0.69 };
  (mat.color ?? new THREE.Color(0xb0b0b0)).getRGB(out, THREE.SRGBColorSpace);
  return [Math.round(out.r * 255), Math.round(out.g * 255), Math.round(out.b * 255)];
}

/**
 * A copy of `meshes` whose meshes have their planar boundary loops capped (see hole-cap.ts), for the even-odd
 * fill. Meshes without a loop are shared as they are. The copy carries positions only: it is never coloured.
 */
function cappedGroup(meshes: readonly THREE.Mesh[]): THREE.Group {
  const out = new THREE.Group();
  for (const m of meshes) {
    const geo = m.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const caps = capPlanarHoles(pos.array, geo.index?.array);
    if (!caps || caps.closed === 0) { out.add(m.clone()); continue; }
    const idx = geo.index;
    const n = idx ? idx.count : pos.count;
    const flat = new Float32Array(n * 3 + caps.positions.length);
    for (let i = 0; i < n; i++) {
      const v = idx ? idx.getX(i) : i;
      flat[i * 3] = pos.getX(v); flat[i * 3 + 1] = pos.getY(v); flat[i * 3 + 2] = pos.getZ(v);
    }
    flat.set(caps.positions, n * 3);
    const capped = new THREE.BufferGeometry();
    capped.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    out.add(new THREE.Mesh(capped, m.material));
  }
  out.updateMatrixWorld(true);
  return out;
}

/**
 * Voxelise `source` onto the 20 x 8 x 20 LDU lattice and colour every filled
 * cell. `source` (and its geometry) is not modified or reparented.
 */
async function voxeliseAndColour(
  source: THREE.Object3D, lduPerUnit: number, mode: VoxelizeMode, sampler: TextureSampler | undefined,
  maxCells: number, onProgress: ((p: VoxelizeProgress) => void) | undefined,
): Promise<ColouredCells> {
  if (!(lduPerUnit > 0)) throw new RangeError(`lduPerUnit must be > 0, got ${lduPerUnit}`);

  // Bake source-world * lattice scale into COPIES of every geometry and use a flat,
  // identity-transform group. (The shared surface voxeliser returns nothing for a
  // mesh under a scaled node, so the scale must live in the vertices; baking also
  // leaves the caller's geometry, BVH and index buffers untouched.) Materials are
  // cloned double-sided: solid mode counts ray crossings from both sides.
  source.updateWorldMatrix(true, true);
  // One voxel (resolution 1) = one cell: x,z by lduPerUnit/20, y by lduPerUnit/8.
  const s = (lduPerUnit / 20) * (1 - BOUNDARY_EPS);
  const lattice = new THREE.Matrix4().makeScale(s, s * Y_STRETCH, s);
  const stretched = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  source.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry.getAttribute('position')) return;
    const dbl = (m: THREE.Material): THREE.Material => { const c = m.clone(); c.side = THREE.DoubleSide; return c; };
    const geo = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(lattice, o.matrixWorld));
    const m = new THREE.Mesh(geo, Array.isArray(o.material) ? o.material.map(dbl) : dbl(o.material));
    meshes.push(m);
    stretched.add(m);
  });
  if (meshes.length === 0) throw new Error('meshToLattice: the object contains no meshes');
  stretched.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(stretched);
  const size = box.getSize(new THREE.Vector3());
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) {
    // TODO(X-11): a perfectly flat sheet (zero extent on an axis) is not voxelised; the shared voxeliser drops it.
    throw new RangeError(`meshToLattice: mesh has zero extent (${size.x} x ${size.y} x ${size.z} cells)`);
  }
  const dims: [number, number, number] = [Math.ceil(size.x), Math.ceil(size.y), Math.ceil(size.z)];
  if (dims[0] * dims[1] * dims[2] > maxCells) {
    throw new RangeError(`meshToLattice: ${dims.join(' x ')} cells exceeds maxCells ${maxCells}`);
  }

  // Closest-point queries need a BVH per (copied) geometry.
  for (const m of meshes) {
    const g = m.geometry as BvhGeometry;
    g.boundsTree ??= new MeshBVH(g, { indirect: true });
  }

  // Solid mode counts shell crossings, so open planar rims (LDraw studs have no base) are closed on a position-only
  // copy; the colour pass and the surface fallback keep the original geometry.
  const solidGroup = cappedGroup(meshes);
  const run = (md: VoxelizeMode) => threeToGridAsync(md === 'solid' ? solidGroup : stretched, 1, { mode: md, onProgress, yieldInterval: 8 });
  let grid = await run(mode);
  // An open mesh has no inside: solid mode then finds nothing. Use its surface instead of returning air.
  if (mode === 'solid' && grid.countNonAir() === 0) grid = await run('surface');
  if (grid.width !== dims[0] || grid.height !== dims[1] || grid.length !== dims[2]) {
    throw new Error(`meshToLattice: voxeliser grid ${grid.width}x${grid.height}x${grid.length} disagrees with ${dims.join('x')}`);
  }

  // Colour pass: nearest surface point to each filled cell centre.
  const boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const centre = new THREE.Vector3();
  const filled: ColouredCells['filled'] = [];
  for (let y = 0; y < dims[1]; y++) {
    for (let z = 0; z < dims[2]; z++) {
      for (let x = 0; x < dims[0]; x++) {
        if (grid.getIndex(x, y, z) === 0) continue;
        centre.set(box.min.x + x + 0.5, box.min.y + y + 0.5, box.min.z + z + 0.5);
        let bestD = Infinity;
        let rgb: RGB | null = null;
        for (let i = 0; i < meshes.length; i++) {
          if (boxes[i]!.distanceToPoint(centre) >= bestD) continue;
          // Vertices are already in lattice space, so the mesh frame is the world frame.
          const r = (meshes[i]!.geometry as BvhGeometry).boundsTree!.closestPointToPoint(centre, hit);
          if (!r) continue;
          if (r.distance < bestD) { bestD = r.distance; rgb = surfaceColour(meshes[i]!, r.faceIndex, r.point, sampler); }
        }
        // Occupied by the voxeliser but no surface found (cannot happen for a non-empty mesh): mid grey.
        filled.push({ index: latticeIndex(dims, x, y, z), rgb: rgb ?? [128, 128, 128] });
      }
    }
  }
  return { dims, filled };
}

/** Pack coloured cells into an `IntentLattice`: one `solid` label per distinct snapped colour, in first-seen order. */
function packLattice(cc: ColouredCells, nearest: NearestColour): IntentLattice {
  const cells = new Uint16Array(cc.dims[0] * cc.dims[1] * cc.dims[2]);
  const labels: IntentLabel[] = [];
  const labelOfCode = new Map<number, number>();
  const snapCache = new Map<number, number>();
  // Flat plate-major order: first-seen colour order is deterministic.
  for (const { index, rgb } of [...cc.filled].sort((a, b) => a.index - b.index)) {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    let code = snapCache.get(key);
    if (code === undefined) { code = nearest(rgb); snapCache.set(key, code); }
    let label = labelOfCode.get(code);
    if (label === undefined) {
      label = labels.push({ role: 'solid', colour: code }); // 1-based id
      labelOfCode.set(code, label);
    }
    cells[index] = label;
  }
  return { dims: cc.dims, cells, labels };
}

/**
 * Voxelise a Three.js object (.obj / .glb / .stl once loaded) onto the stud
 * lattice. See the module comment for scale, mode and colour rules.
 *
 * @param object three.js object; not modified. Its world transform is honoured.
 * @returns lattice with `role: 'solid'` labels, one per distinct LDraw colour.
 */
export async function meshToLattice(object: THREE.Object3D, options: MeshToLatticeOptions = {}): Promise<IntentLattice> {
  const cc = await voxeliseAndColour(
    object, options.lduPerUnit ?? 1, options.mode ?? 'solid', options.textureSampler,
    options.maxCells ?? DEFAULT_MAX_CELLS, options.onProgress,
  );
  return packLattice(cc, options.nearest ?? createNearest());
}

/** sRGB of an LDraw colour code (direct `0x2RRGGBB` / `0x3RRGGBB` colours read their embedded RGB). */
function ldrawCodeRgb(code: number): RGB {
  if (code >= 0x2000000 && code < 0x4000000) return [(code >> 16) & 255, (code >> 8) & 255, code & 255];
  const hex = LDRAW_COLOR_RGB[code] ?? LDRAW_COLOR_RGB[16]!;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Default triangle source: the real LDraw library (loaded lazily, it is a heavy module). */
async function libraryTriangles(brick: BrickLike): Promise<TriangleLike[]> {
  const { __debugWorldTris } = await import('../ldraw-geometry.js');
  return (await __debugWorldTris(brick)) as unknown as TriangleLike[];
}

/**
 * Voxelise an LDraw model (a list of placed parts) onto the SAME lattice a mesh
 * gets, so a mesh's lattice can be scored against ground truth (X-12 / B16).
 * Each brick keeps its own LDraw colour code exactly (two codes that share an RGB
 * collapse to the first one seen). Parts are voxelised in 'solid' mode by
 * default, one mesh per brick, so a part must be a closed shell.
 *
 * LDraw is Y-down; the lattice is Y-up, so Y is negated here.
 */
export async function latticeFromBricks(bricks: readonly BrickLike[], options: BricksToLatticeOptions = {}): Promise<IntentLattice> {
  if (bricks.length === 0) throw new Error('latticeFromBricks: no bricks');
  const triangles = options.partTriangles ?? libraryTriangles;
  const root = new THREE.Group();
  const used = new Map<number, PaletteColour>();
  const byRgb = new Map<number, number>();
  for (const brick of bricks) {
    const tris = await triangles(brick);
    if (tris.length === 0) continue;
    const pos = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => {
      for (let j = 0; j < 3; j++) pos.set([t[j]![0], -t[j]![1], t[j]![2]], i * 9 + j * 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const rgb = ldrawCodeRgb(brick.color);
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
    mat.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
    root.add(new THREE.Mesh(geo, mat));
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (!byRgb.has(key)) { byRgb.set(key, brick.color); used.set(brick.color, { code: brick.color, rgb }); }
  }
  if (root.children.length === 0) throw new Error('latticeFromBricks: no brick produced any triangles');
  root.updateMatrixWorld(true);
  const cc = await voxeliseAndColour(root, 1, options.mode ?? 'solid', undefined, options.maxCells ?? DEFAULT_MAX_CELLS, options.onProgress);
  // Snap over only the colours the model uses: each brick colour maps back to itself.
  return packLattice(cc, createNearest([...used.values()]));
}
