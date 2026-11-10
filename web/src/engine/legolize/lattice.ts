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
 *   X-12's `metrics.ts` aligns two lattices by a best integer shift instead (no lattice origin option needed yet).
 * - 'solid' mode is an even-odd ray fill, so a shell must be closed: planar boundary loops (LDraw studs have no
 *   base) are capped first (`hole-cap.ts`). Shells with open loops that are not planar and convex (about 17 of the
 *   120 part moulds in the batcave fixture, e.g. 3048, 17485, 64799) still leave a column of "inside" cells above
 *   them: batcave car voxel IoU is 0.66, the rest of the corpus fixtures are >= 0.99. V-01 added the fix
 *   behind `insideTest: 'winding'` (default 'parity', unchanged): batcave 0.656 -> 1.000 when mesh and per-brick truth both use it.
 * - 'solid' mode needs a watertight mesh; if it finds nothing (an open mesh) we
 *   fall back to 'surface' rather than return an empty model.
 * - Triangle counts in the millions are slow: the colour pass is one BVH query per filled cell.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { threeToGridAsync, type InsideTest, type TextureSampler, type VoxelizeMode, type VoxelizeProgress } from '@craft/convert/voxelizer.js';
import type { RGB } from '@craft/types/index.js';
import { LDRAW_COLOR_RGB } from '../ldraw-colors.js';
import { capPlanarHoles } from './hole-cap.js';
import { elementFor, frameFor } from '../../brickgen/vocab/index.js';
import { partStem } from '../part-id.js';
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
  /**
   * Inside test for 'solid' mode: 'parity' (default, even-odd ray fill after planar hole capping) or 'winding'
   * (generalised winding number: robust to open, non-planar shells and to overlapping bodies in one mesh; slower).
   */
  insideTest?: InsideTest;
  /** Leave LDraw studs (small stud-sized components) out of the occupancy. Default true; see {@link cullStuds}. */
  ignoreStuds?: boolean;
  /** Fill the open underside cavity of a brick (a closed pocket under a roof). Default true; see {@link fillUndersideCavities}. */
  fillUndersides?: boolean;
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
  /**
   * Inside test for 'solid' mode: 'parity' (default, even-odd ray fill after planar hole capping) or 'winding'
   * (generalised winding number: robust to open, non-planar shells and to overlapping bodies in one mesh; slower).
   */
  insideTest?: InsideTest;
  /** See {@link MeshToLatticeOptions.ignoreStuds}. */
  ignoreStuds?: boolean;
  /** See {@link MeshToLatticeOptions.fillUndersides}. */
  fillUndersides?: boolean;
  onProgress?: (p: VoxelizeProgress) => void;
}

interface BvhGeometry extends THREE.BufferGeometry { boundsTree?: MeshBVH }

/** Result of the shared voxelise-and-colour core: occupancy + sRGB colour per filled cell. */
interface ColouredCells {
  dims: [number, number, number];
  /** Filled cells in plate-major order, with their sRGB colour. */
  filled: Array<{ index: number; rgb: RGB }>;
}

/** Cleanups applied to a lattice before it is read (L-01): both default on, both can be switched off. */
interface LatticeCleanup { ignoreStuds: boolean; fillUndersides: boolean }

const cleanupOf = (o: { ignoreStuds?: boolean; fillUndersides?: boolean }): LatticeCleanup =>
  ({ ignoreStuds: o.ignoreStuds ?? true, fillUndersides: o.fillUndersides ?? true });

/** A stud is 12 x 4 x 12 LDU: 0.6 cells across (x, z are 20 LDU) and 0.5 cells tall (y is 8 LDU). Bounds with slack for stud variants. */
const STUD_MIN_XZ = 0.3;
const STUD_MAX_XZ = 0.65;
const STUD_MAX_Y = 0.6;
/** Vertex weld resolution (cells) when finding connected components. */
const COMPONENT_WELD = 1e4;

/**
 * Removes LDraw studs from geometries given in lattice space (cells). Returns one geometry per input, in order: a
 * new non-indexed geometry, or the input itself when it loses nothing.
 *
 * Why: a stud is 4 LDU tall, half a plate, and stands on every top face, so a merged mesh reads one partial
 * layer taller than the bricks it came from (V-02: the 3-course wall read 8x10x2 against a true 8x9x2). The
 * options were (a) ignore geometry within stud height above a part's top plane, or (b) stud-primitive
 * awareness. A merged mesh has no part boundaries, so (a) cannot be applied; (b) needs the library's
 * primitives. This takes the geometric form of (b): a stud is a small connected component (a side wall plus
 * a top disc, joined to nothing: the LDraw stud has no base) no bigger than a stud, so every connected
 * component of that size is dropped. Only studs this size are lost: a 1x1 round plate is 20 LDU across.
 *
 * Components are found over ALL the geometries together (one weld map), so the same studs go whether the parts
 * arrive as one merged mesh or as one mesh each: otherwise a stud welded to a neighbouring part (about one in ten
 * in the nimbus fixture, where round parts sit on studs with a ring of the same radius) is kept in the merged mesh
 * and dropped in the per-brick one, and the two lattices stop agreeing.
 *
 * Limits: a stud welded to a neighbour is kept (above: about one in ten) and costs at most the half-layer it
 * stands in; a geometry with material groups is left alone (the rewrite would break them); a set made only of
 * stud-sized pieces is kept whole rather than emptied.
 */
function cullStuds(sources: readonly THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  // Work on the non-indexed form: the result must also lose the stud VERTICES, or Box3.setFromObject (which reads
  // the position attribute, not the index) would still see the studs' height.
  const geos = sources.map((g) => (g.groups.length > 0 ? g : g.index ? g.toNonIndexed() : g));
  const skip = sources.map((g) => g.groups.length > 0);

  // One weld map over every geometry (a raw triangle soup shares no indices), then union the corners of each triangle.
  const weldIds = new Map<string, number>();
  const parent: number[] = [];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; } return a; };
  const weldOf = geos.map((g) => new Int32Array(g.getAttribute('position').count).fill(-1));
  const weld = (gi: number, v: number): number => {
    let w = weldOf[gi]![v]!;
    if (w >= 0) return w;
    const pos = geos[gi]!.getAttribute('position') as THREE.BufferAttribute;
    const key = `${Math.round(pos.getX(v) * COMPONENT_WELD)},${Math.round(pos.getY(v) * COMPONENT_WELD)},${Math.round(pos.getZ(v) * COMPONENT_WELD)}`;
    const known = weldIds.get(key);
    if (known !== undefined) w = known;
    else { w = parent.length; parent.push(w); weldIds.set(key, w); }
    weldOf[gi]![v] = w;
    return w;
  };
  geos.forEach((g, gi) => {
    if (skip[gi]) return;
    const triCount = Math.floor((g.getAttribute('position') as THREE.BufferAttribute).count / 3);
    for (let t = 0; t < triCount; t++) {
      const a = weld(gi, t * 3), b = weld(gi, t * 3 + 1), c = weld(gi, t * 3 + 2);
      parent[find(b)] = find(a);
      parent[find(c)] = find(a);
    }
  });

  // Bounds per component.
  const lo = new Map<number, [number, number, number]>();
  const hi = new Map<number, [number, number, number]>();
  const rootOf = geos.map((g, gi) => {
    if (skip[gi]) return new Int32Array(0);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const roots = new Int32Array(Math.floor(pos.count / 3));
    for (let t = 0; t < roots.length; t++) {
      const root = find(weld(gi, t * 3));
      roots[t] = root;
      const l = lo.get(root) ?? lo.set(root, [Infinity, Infinity, Infinity]).get(root)!;
      const h = hi.get(root) ?? hi.set(root, [-Infinity, -Infinity, -Infinity]).get(root)!;
      for (let k = 0; k < 3; k++) {
        const p = [pos.getX(t * 3 + k), pos.getY(t * 3 + k), pos.getZ(t * 3 + k)] as const;
        for (let a = 0; a < 3; a++) { l[a] = Math.min(l[a]!, p[a]); h[a] = Math.max(h[a]!, p[a]); }
      }
    }
    return roots;
  });
  const studRoots = new Set<number>();
  for (const [root, l] of lo) {
    const h = hi.get(root)!;
    const sx = h[0]! - l[0]!, sy = h[1]! - l[1]!, sz = h[2]! - l[2]!;
    if (sx >= STUD_MIN_XZ && sx <= STUD_MAX_XZ && sz >= STUD_MIN_XZ && sz <= STUD_MAX_XZ && sy > 0 && sy <= STUD_MAX_Y) studRoots.add(root);
  }
  if (studRoots.size === 0 || studRoots.size === lo.size) return [...sources];

  return geos.map((g, gi) => {
    if (skip[gi]) return sources[gi]!;
    const roots = rootOf[gi]!;
    const keptTris: number[] = [];
    for (let t = 0; t < roots.length; t++) if (!studRoots.has(roots[t]!)) keptTris.push(t);
    if (keptTris.length === roots.length) return sources[gi]!;
    const out = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) {
      const a = attr as THREE.BufferAttribute;
      const Ctor = a.array.constructor as new (n: number) => THREE.TypedArray;
      const data = new Ctor(keptTris.length * 3 * a.itemSize);
      keptTris.forEach((t, i) => {
        for (let k = 0; k < 3; k++) for (let c = 0; c < a.itemSize; c++) data[(i * 3 + k) * a.itemSize + c] = a.getComponent(t * 3 + k, c);
      });
      out.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize, a.normalized));
    }
    return out;
  });
}

/** How far above a pocket cell its roof may be (cells): a brick's cavity is 20 LDU = 2.5 plates deep. */
const POCKET_ROOF_GAP = 3;
/** How far (cells, x/z) the four side walls of a pocket may be: a 2 x 16 brick's middle cell is 8 cells from each end. */
const POCKET_WALL_REACH = 10;
/** The probe starts a hair below the cell centre so a roof lying exactly on the centre plane is hit, not skipped. */
const POCKET_PROBE_DROP = 0.05;

/**
 * Fills the underside cavity of a brick in `occ` (flat plate-major occupancy, modified in place).
 *
 * Why: an LDraw brick is a closed bowl: a 4 LDU roof, 4 LDU walls and a 20 LDU cavity open to the ground. A
 * cell centre in that cavity is air, so a shell fill leaves layers 0..1 of every brick empty and keeps only the
 * roof layer (X-10: a single 3001 filled 1 layer of 3). The lattice is an occupancy of bricks, and a brick
 * occupies its whole envelope.
 *
 * What: an empty cell is a pocket cell when (1) a roof lies within {@link POCKET_ROOF_GAP} cells straight above
 * it and (2) a wall lies within {@link POCKET_WALL_REACH} cells in each of the four horizontal directions, i.e.
 * it is closed on every side but the bottom. A bridge or an arch tunnel is open to at least two sides, so it
 * stays air; a window opening is open through the wall.
 * TODO(L-01): a plate roofing a courtyard no more than 3 plates high and walled on all four sides is filled too;
 * telling it from a brick's cavity needs the part boundaries a merged mesh does not carry.
 */
function fillUndersideCavities(
  occ: Uint8Array, dims: readonly [number, number, number], meshes: readonly THREE.Mesh[], origin: THREE.Vector3,
): void {
  const [nx, ny, nz] = dims;
  const ray = new THREE.Ray();
  const dir = new THREE.Vector3();
  const from = new THREE.Vector3();
  /** Distance to the nearest surface along `d` within `far`, or null. */
  const reach = (d: readonly [number, number, number], far: number): number | null => {
    ray.origin.copy(from);
    ray.direction.copy(dir.set(d[0], d[1], d[2]));
    let best: number | null = null;
    for (const m of meshes) {
      const tree = (m.geometry as BvhGeometry).boundsTree;
      const h = tree?.raycastFirst(ray, THREE.DoubleSide, 0, far);
      if (h && (best === null || h.distance < best)) best = h.distance;
    }
    return best;
  };
  const WALLS: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
  const pockets: number[] = [];
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    // Only cells with something above them in the column can be under a roof.
    let top = -1;
    for (let y = ny - 1; y >= 0; y--) if (occ[latticeIndex(dims as [number, number, number], x, y, z)] !== 0) { top = y; break; }
    for (let y = 0; y < top; y++) {
      const i = latticeIndex(dims as [number, number, number], x, y, z);
      if (occ[i] !== 0) continue;
      from.set(origin.x + x + 0.5, origin.y + y + 0.5 - POCKET_PROBE_DROP, origin.z + z + 0.5);
      if (reach([0, 1, 0], POCKET_ROOF_GAP + POCKET_PROBE_DROP) === null) continue;
      if (WALLS.every((d) => reach(d, POCKET_WALL_REACH) !== null)) pockets.push(i);
    }
  }
  for (const i of pockets) occ[i] = 1;
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
  maxCells: number, onProgress: ((p: VoxelizeProgress) => void) | undefined, insideTest: InsideTest = 'parity',
  cleanup: LatticeCleanup = { ignoreStuds: true, fillUndersides: true },
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
  const sourceMeshes: Array<{ mesh: THREE.Mesh; geo: THREE.BufferGeometry }> = [];
  source.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry.getAttribute('position')) return;
    sourceMeshes.push({ mesh: o, geo: o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(lattice, o.matrixWorld)) });
  });
  const dbl = (m: THREE.Material): THREE.Material => { const c = m.clone(); c.side = THREE.DoubleSide; return c; };
  const geometries = cleanup.ignoreStuds ? cullStuds(sourceMeshes.map((s) => s.geo)) : sourceMeshes.map((s) => s.geo);
  sourceMeshes.forEach(({ mesh: o }, i) => {
    const m = new THREE.Mesh(geometries[i]!, Array.isArray(o.material) ? o.material.map(dbl) : dbl(o.material));
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
  // Both inside tests read the capped copy: the planar caps make an LDraw brick's hollow underside a solid
  // (the lattice is an occupancy of bricks, not of shells), and winding then only has to cope with what is left.
  const run = (md: VoxelizeMode) => threeToGridAsync(
    md === 'solid' && insideTest === 'parity' ? solidGroup : stretched, 1,
    { mode: md, onProgress, yieldInterval: 8, insideTest },
  );
  let grid = await run(mode);
  let surfaceFallback = false;
  // An open mesh has no inside: solid mode then finds nothing. Use its surface instead of returning air.
  if (mode === 'solid' && grid.countNonAir() === 0) { grid = await run('surface'); surfaceFallback = true; }
  if (grid.width !== dims[0] || grid.height !== dims[1] || grid.length !== dims[2]) {
    throw new Error(`meshToLattice: voxeliser grid ${grid.width}x${grid.height}x${grid.length} disagrees with ${dims.join('x')}`);
  }

  // Occupancy: the voxeliser's cells, plus (solid mode) the closed underside pockets of bricks.
  const occ = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let y = 0; y < dims[1]; y++) for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) {
    if (grid.getIndex(x, y, z) !== 0) occ[latticeIndex(dims, x, y, z)] = 1;
  }
  if (cleanup.fillUndersides && mode === 'solid' && !surfaceFallback) fillUndersideCavities(occ, dims, meshes, box.min);

  // Colour pass: nearest surface point to each filled cell centre.
  const boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const centre = new THREE.Vector3();
  const filled: ColouredCells['filled'] = [];
  for (let y = 0; y < dims[1]; y++) {
    for (let z = 0; z < dims[2]; z++) {
      for (let x = 0; x < dims[0]; x++) {
        if (occ[latticeIndex(dims, x, y, z)] === 0) continue;
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
    options.maxCells ?? DEFAULT_MAX_CELLS, options.onProgress, options.insideTest, cleanupOf(options),
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
  const cc = await voxeliseAndColour(root, 1, options.mode ?? 'solid', undefined, options.maxCells ?? DEFAULT_MAX_CELLS, options.onProgress, options.insideTest, cleanupOf(options));
  // Snap over only the colours the model uses: each brick colour maps back to itself.
  return packLattice(cc, createNearest([...used.values()]));
}

type AbsCell = readonly [x: number, p: number, z: number, colour: number];

/** True when `m` (row-major 3x3) is a signed permutation matrix: every row and column holds one +-1, the rest 0. */
function isSignedPermutation(m: readonly number[]): boolean {
  const near = (v: number, t: number): boolean => Math.abs(v - t) < 1e-3;
  for (let r = 0; r < 3; r++) {
    let ones = 0;
    for (let c = 0; c < 3; c++) {
      const v = m[r * 3 + c]!;
      if (near(v, 1) || near(v, -1)) ones++; else if (!near(v, 0)) return false;
    }
    if (ones !== 1) return false;
  }
  for (let c = 0; c < 3; c++) {
    let ones = 0;
    for (let r = 0; r < 3; r++) if (Math.abs(m[r * 3 + c]!) > 0.5) ones++;
    if (ones !== 1) return false;
  }
  return true;
}

/**
 * The cells a vocabulary brick occupies, or null when it has no vocabulary entry or is turned off the axes
 * (a tilted brick's footprint cells are not an axis-aligned stud grid: it takes the mesh route instead).
 *
 * Each footprint cell (column i, row j, plate layer k, from the element's occupancy mask, or every cell for a
 * full cuboid) is placed by the brick's body frame (`frameFor`: where the body sits against the part origin),
 * turned by the brick's rotation and moved by its position; the cell centre is then snapped to the nearest
 * lattice cell. Studs are not part of the body, so they are not cells.
 */
function footprintCells(brick: BrickLike): AbsCell[] | null {
  const name = `${partStem(brick.part).toLowerCase()}.dat`;
  const el = elementFor(name);
  const frame = frameFor(name);
  if (!el || !frame) return null;
  const m = brick.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (m.length !== 9 || !isSignedPermutation(m)) return null;
  const [fx, fz] = el.footprint;
  const out: AbsCell[] = [];
  for (let k = 0; k < el.heightPlates; k++) for (let j = 0; j < fz; j++) for (let i = 0; i < fx; i++) {
    if (el.occupancy && el.occupancy[i + fx * (j + fz * k)] === 0) continue;
    // Cell centre in the part's frame (LDU, y down): body centre +- stud steps, mid height of plate layer k.
    const lx = frame.centreX + (i - (fx - 1) / 2) * 20;
    const lz = frame.centreZ + (j - (fz - 1) / 2) * 20;
    const ly = frame.bottomY - (k + 0.5) * 8;
    const wx = brick.x + m[0]! * lx + m[1]! * ly + m[2]! * lz;
    const wy = brick.y + m[3]! * lx + m[4]! * ly + m[5]! * lz;
    const wz = brick.z + m[6]! * lx + m[7]! * ly + m[8]! * lz;
    out.push([Math.round(wx / 20 - 0.5), Math.round(-wy / 8 - 0.5), Math.round(wz / 20 - 0.5), brick.color]);
  }
  return out;
}

/** Counts from {@link latticeFromFootprints}: how the truth was built. */
export interface FootprintStats {
  /** Bricks whose cells came from the vocabulary's occupancy. */
  vocabBricks: number;
  /** Bricks voxelised from their mesh (part not in the vocabulary, or turned off the quarter-turn grid). */
  meshBricks: number;
  /** Mesh-fallback bricks by part stem, for reading what the vocabulary lacks. */
  meshParts: Record<string, number>;
  /** Filled cells that came from the vocabulary / from the mesh fallback (before overlaps are merged). */
  vocabCells: number;
  meshCells: number;
}

/** Options for {@link latticeFromFootprints}. */
export interface FootprintsOptions {
  /** World triangles of a fallback brick (see {@link BricksToLatticeOptions.partTriangles}); default: the part library. */
  partTriangles?: (brick: BrickLike) => Promise<TriangleLike[]>;
  /** Inside test for the fallback bricks' voxelisation. */
  insideTest?: InsideTest;
}

/**
 * The TRUTH lattice of an LDraw model: every brick contributes the stud x plate cells it really occupies, read
 * from the X-08 vocabulary's occupancy (`brickgen/vocab`) and placed by its position and quarter-turn, instead
 * of a voxelisation of its mesh. A mesh voxelisation is a model of the brick, not the brick (parity leaves a
 * brick's underside cavity empty, winding fills it), so it cannot be the reference a mesh lattice is scored
 * against. Only parts the vocabulary lacks (or bricks turned off the axes) fall back to their mesh, through
 * {@link latticeFromBricks}; `stats` says how many, so a score can state what share of its truth is exact.
 *
 * Frame: absolute (cell = 20 x 8 x 20 LDU anchored at the LDraw origin, Y up), cropped to the filled extent; the
 * mesh fallback's own origin (its minimum corner) is rounded onto that grid. Colour: one `solid` label per
 * distinct brick colour code, in first-seen order. Later bricks overwrite earlier ones where they overlap.
 */
export async function latticeFromFootprints(bricks: readonly BrickLike[], options: FootprintsOptions = {}): Promise<{ lattice: IntentLattice; stats: FootprintStats }> {
  if (bricks.length === 0) throw new Error('latticeFromFootprints: no bricks');
  const stats: FootprintStats = { vocabBricks: 0, meshBricks: 0, meshParts: {}, vocabCells: 0, meshCells: 0 };
  const cells: AbsCell[] = [];
  const fallback: BrickLike[] = [];
  for (const brick of bricks) {
    const own = footprintCells(brick);
    if (own) { stats.vocabBricks++; stats.vocabCells += own.length; for (const c of own) cells.push(c); continue; }
    stats.meshBricks++;
    const stem = partStem(brick.part).toLowerCase();
    stats.meshParts[stem] = (stats.meshParts[stem] ?? 0) + 1;
    fallback.push(brick);
  }

  if (fallback.length > 0) {
    const source = options.partTriangles ?? libraryTriangles;
    const tris = new Map<BrickLike, TriangleLike[]>();
    let minX = Infinity, maxY = -Infinity, minZ = Infinity;
    for (const b of fallback) {
      const t = await source(b);
      tris.set(b, t);
      for (const tri of t) for (const v of tri) { minX = Math.min(minX, v[0]); maxY = Math.max(maxY, v[1]); minZ = Math.min(minZ, v[2]); }
    }
    if (Number.isFinite(minX)) {
      const mesh = await latticeFromBricks(fallback, {
        partTriangles: async (b) => tris.get(b) ?? [],
        mode: 'solid',
        ...(options.insideTest ? { insideTest: options.insideTest } : {}),
      });
      // The fallback lattice starts at its mesh's minimum corner: x/20, -maxY/8 (Y flipped up), z/20 cells.
      const ox = Math.round(minX / 20), oy = Math.round(-maxY / 8), oz = Math.round(minZ / 20);
      const [nx, ny, nz] = mesh.dims;
      for (let p = 0; p < ny; p++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
        const c = mesh.cells[latticeIndex(mesh.dims, x, p, z)]!;
        if (c === 0) continue;
        stats.meshCells++;
        cells.push([ox + x, oy + p, oz + z, mesh.labels[c - 1]!.colour]);
      }
    }
  }
  if (cells.length === 0) throw new Error('latticeFromFootprints: no brick produced any cells');

  let x0 = Infinity, p0 = Infinity, z0 = Infinity, x1 = -Infinity, p1 = -Infinity, z1 = -Infinity;
  for (const [x, p, z] of cells) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); p0 = Math.min(p0, p); p1 = Math.max(p1, p); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const dims: IntentLattice['dims'] = [x1 - x0 + 1, p1 - p0 + 1, z1 - z0 + 1];
  const out = new Uint16Array(dims[0] * dims[1] * dims[2]);
  const labels: IntentLabel[] = [];
  const labelOf = new Map<number, number>();
  for (const [x, p, z, colour] of cells) {
    let id = labelOf.get(colour);
    if (id === undefined) { id = labels.push({ role: 'solid', colour }); labelOf.set(colour, id); }
    out[latticeIndex(dims, x - x0, p - p0, z - z0)] = id;
  }
  return { lattice: { dims, cells: out, labels }, stats };
}
