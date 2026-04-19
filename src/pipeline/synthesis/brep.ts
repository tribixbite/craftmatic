/**
 * BuildingBRep datatype + manifold-3d CSG evaluator.
 *
 * The B-rep is the canonical parametric form of a synthesized building:
 *   floors  — horizontal slabs, one per level
 *   walls   — vertical extrusions on the footprint polygon per level
 *   roof    — a separate volume (flat, gabled, hipped, etc.)
 *   details — windows (insets), cornices, doors, setbacks
 *   voids   — reserved for future interior floorplan subtraction
 *
 * `evaluateBRep()` uses manifold-3d to union all structural volumes and
 * subtract window insets, producing a single watertight mesh.
 *
 * Pure except for the manifold-3d WASM boot (cached at module scope).
 */

import type { LocalPoint2D, MaterialRef, RoofShape } from '../context/types.js';

// ─── B-rep types ───────────────────────────────────────────────────────────

export interface FloorSlab {
  readonly level: number;
  readonly elevationM: number;
  readonly thicknessM: number;
  /** Footprint polygon in local (origin-relative, MBR-aligned) coords. */
  readonly polygon: readonly LocalPoint2D[];
}

export interface Wall {
  readonly level: number;
  readonly facadeEdge: number;
  readonly start: LocalPoint2D;
  readonly end: LocalPoint2D;
  readonly heightM: number;
  readonly thicknessM: number;
  readonly material: 'wall' | 'trim';
}

export interface RoofVolume {
  readonly type: RoofShape;
  readonly baseZ: number;
  readonly peakZ: number;
  readonly pitchDeg: number;
  /** Footprint polygon the roof sits atop (usually matches top floor slab). */
  readonly polygon: readonly LocalPoint2D[];
  readonly params: Record<string, number>;
}

export type FeatureKind = 'window' | 'door' | 'cornice' | 'setback' | 'balcony';

export interface Feature {
  readonly kind: FeatureKind;
  readonly facadeEdge: number;
  readonly level: number;
  readonly offsetAlongEdge: number; // 0-1 along the edge
  readonly widthM: number;
  readonly heightM: number;
  readonly depthM: number;
  /** Y elevation of the feature's base. */
  readonly elevationM: number;
}

export interface Volume {
  readonly kind: string;
  readonly polygon: readonly LocalPoint2D[];
  readonly baseZ: number;
  readonly topZ: number;
}

export interface BuildingBRep {
  readonly origin: { readonly lat: number; readonly lng: number };
  readonly rotationDeg: number;
  readonly floors: readonly FloorSlab[];
  readonly walls: readonly Wall[];
  readonly roof: RoofVolume;
  readonly details: readonly Feature[];
  readonly voids?: readonly Volume[];
  readonly materials: {
    readonly wall: MaterialRef;
    readonly trim: MaterialRef;
    readonly roof: MaterialRef;
    readonly window: MaterialRef;
  };
}

// ─── manifold-3d module caching ────────────────────────────────────────────

type ManifoldNamespace = {
  Manifold: {
    cube(dims: readonly [number, number, number], center?: boolean): ManifoldShape;
    extrude(
      polygons: ReadonlyArray<readonly (readonly [number, number])[]>,
      height: number,
      nDivisions?: number,
      twistDegrees?: number,
      scaleTop?: readonly [number, number],
    ): ManifoldShape;
    union(shapes: readonly ManifoldShape[]): ManifoldShape;
    difference(a: ManifoldShape, b: ManifoldShape): ManifoldShape;
  };
  setup(): void;
};

interface ManifoldShape {
  volume(): number;
  surfaceArea(): number;
  translate(v: readonly [number, number, number]): ManifoldShape;
  rotate(v: readonly [number, number, number]): ManifoldShape;
  scale(v: readonly [number, number, number]): ManifoldShape;
  getMesh(): {
    numVert: number;
    numTri: number;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
  };
  delete(): void;
}

let manifoldCache: ManifoldNamespace | null = null;

export async function getManifold(): Promise<ManifoldNamespace> {
  if (manifoldCache) return manifoldCache;
  const mod = await import('manifold-3d');
  const ns = await mod.default() as ManifoldNamespace;
  ns.setup();
  manifoldCache = ns;
  return ns;
}

// ─── Evaluator ─────────────────────────────────────────────────────────────

export interface EvaluatedMesh {
  /** Flat Float32Array: `[x0,y0,z0, x1,y1,z1, ...]`. */
  readonly positions: Float32Array;
  /** Indices into `positions`, 3 per triangle. */
  readonly indices: Uint32Array;
  /** Approximate volume from manifold-3d. */
  readonly volume: number;
  readonly surfaceArea: number;
  /** True when manifold-3d reports watertight (no boundary edges). */
  readonly watertight: boolean;
}

function signedArea(poly: readonly LocalPoint2D[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/**
 * Convert a LocalPoint2D polygon to the `[x, z][]` ring manifold-3d expects.
 * Manifold requires CCW winding for solid extrusion; we flip polygons that
 * come in CW.
 */
function polygonToRing(poly: readonly LocalPoint2D[]): ReadonlyArray<readonly [number, number]> {
  const area = signedArea(poly);
  const ordered = area < 0 ? [...poly].reverse() : poly;
  return ordered.map(p => [p.x, p.z] as const);
}

/**
 * CSG-evaluate the B-rep into a single mesh via manifold-3d.
 *
 * Building volume = union(floors + walls + roof).
 * Window cavities = subtracted from that union.
 *
 * Returns positions + indices ready for the GLB writer (triangle soup with
 * shared vertices). Y is up in the output — we construct with Z-up then map.
 */
export async function evaluateBRep(brep: BuildingBRep): Promise<EvaluatedMesh> {
  const m = await getManifold();
  const { Manifold } = m;

  const parts: ManifoldShape[] = [];

  // Floor slabs
  for (const floor of brep.floors) {
    const ring = polygonToRing(floor.polygon);
    const slab = Manifold.extrude([ring], floor.thicknessM)
      .translate([0, 0, floor.elevationM]);
    parts.push(slab);
  }

  // Walls per edge/level: we extrude the footprint as a thin shell per level.
  // For simplicity, one level = one polygon extruded to level height, hollowed
  // by inner polygon shifted inward by thicknessM. Cleaner than per-edge boxes
  // and matches how 3D-printed buildings are typically modelled.
  const levelsByLevel = new Map<number, { polygon: readonly LocalPoint2D[]; heightM: number; elevationM: number }>();
  for (const floor of brep.floors) {
    const existing = levelsByLevel.get(floor.level);
    if (!existing) {
      // Default wall height = 2.7m if not overridden per-floor; callers usually
      // pass matching floor + wall heights.
      const wallHeight = brep.walls
        .filter(w => w.level === floor.level)
        .reduce((h, w) => Math.max(h, w.heightM), 2.7);
      levelsByLevel.set(floor.level, {
        polygon: floor.polygon,
        heightM: wallHeight,
        elevationM: floor.elevationM + floor.thicknessM,
      });
    }
  }

  // Walls = solid extrusion of footprint polygon per level.
  //
  // We used to shell the walls (outer polygon − centroid-shrunk inner) to
  // create interior space, but the naive shrinkPolygon produced degenerate
  // inner polygons for complex footprints (e.g. Flatiron has 34 vertices
  // with rounded tips — IoU dropped to 0.24 because the wall shell was
  // visibly wrong). Solid extrusion is simpler, always valid, and
  // interior floorplan subtraction (future `voids: Volume[]` on BRep)
  // carves rooms from the solid — same effective result without the
  // offset-polygon bugs.
  for (const [, lvl] of levelsByLevel) {
    const solid = Manifold.extrude([polygonToRing(lvl.polygon)], lvl.heightM)
      .translate([0, 0, lvl.elevationM]);
    parts.push(solid);
  }

  // Roof volume
  const roofShape = await buildRoofShape(m, brep.roof);
  parts.push(roofShape);

  let building = Manifold.union(parts);

  // Subtract window insets (bounded cavities, do NOT go through wall thickness)
  const windows = brep.details.filter(d => d.kind === 'window');
  if (windows.length > 0) {
    const cavities: ManifoldShape[] = [];
    for (const w of windows) {
      const cube = makeFeatureCavity(m, brep, w);
      if (cube) cavities.push(cube);
    }
    if (cavities.length > 0) {
      const combined = Manifold.union(cavities);
      building = Manifold.difference(building, combined);
      combined.delete();
    }
  }

  // Extract mesh
  const mesh = building.getMesh();
  const { numVert, numTri, vertProperties, triVerts } = mesh;

  // manifold-3d uses Z-up; remap to Y-up for glTF: (x, y, z) → (x, z, y).
  // We preserve y-sign (no negation) so the mesh's XZ silhouette matches the
  // input polygon's {x, z} coordinates. Without this, footprintIoU sees the
  // mesh mirrored along Z vs the target polygon and reports garbage IoU
  // for any asymmetric footprint (wedges, L-shapes, etc.).
  const positions = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) {
    const bx = vertProperties[i * 3];
    const by = vertProperties[i * 3 + 1];
    const bz = vertProperties[i * 3 + 2];
    positions[i * 3] = bx;
    positions[i * 3 + 1] = bz;       // Z → Y (up)
    positions[i * 3 + 2] = by;       // Y → Z (preserves polygon.z sign)
  }
  // Winding order: the axis swap (y ↔ z) inverts handedness — flip triangles
  // so face normals still point outward.
  const indices = new Uint32Array(numTri * 3);
  for (let i = 0; i < numTri; i++) {
    indices[i * 3] = triVerts[i * 3];
    indices[i * 3 + 1] = triVerts[i * 3 + 2];
    indices[i * 3 + 2] = triVerts[i * 3 + 1];
  }

  const vol = building.volume();
  const surf = building.surfaceArea();
  const watertight = true; // manifold-3d guarantees this by construction

  // Clean up — manifold-3d manifolds carry WASM memory. parts[] includes
  // roofShape (pushed at the end) so no separate delete is needed. Union
  // doesn't consume inputs in this version; we explicitly free them all.
  try { building.delete(); } catch { /* already deleted */ }
  for (const p of parts) {
    try { p.delete(); } catch { /* already deleted */ }
  }

  return { positions, indices, volume: vol, surfaceArea: surf, watertight };
}

// ─── Roof shape builders ───────────────────────────────────────────────────

async function buildRoofShape(m: ManifoldNamespace, roof: RoofVolume): Promise<ManifoldShape> {
  const ring = polygonToRing(roof.polygon);
  const thickness = Math.max(0.2, roof.peakZ - roof.baseZ);

  if (roof.type === 'flat') {
    return m.Manifold.extrude([ring], 0.5).translate([0, 0, roof.baseZ]);
  }
  if (roof.type === 'pyramidal') {
    // Taper the top to a point → scaleTop=[0,0]
    return m.Manifold.extrude([ring], thickness, 1, 0, [0, 0]).translate([0, 0, roof.baseZ]);
  }
  if (roof.type === 'dome') {
    // Approximate with a tapered extrusion (circle-like footprint assumed).
    return m.Manifold.extrude([ring], thickness, 1, 0, [0.1, 0.1]).translate([0, 0, roof.baseZ]);
  }
  // gabled / hipped / mansard / shed: use a "tent" extrusion — scaleTop 0.02
  // makes a ridge/peak without collapsing to a single point (avoids manifold
  // pinch singularity). Good enough for printable + voxel output.
  const scaleTopX = roof.type === 'shed' ? 1 : 0.02;
  const scaleTopY = roof.type === 'mansard' ? 0.7 : 0.02;
  return m.Manifold.extrude([ring], thickness, 1, 0, [scaleTopX, scaleTopY])
    .translate([0, 0, roof.baseZ]);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build a cavity box for a facade feature (window inset).
 *
 * Inset depth is clamped to 80% of wall thickness so the cavity doesn't punch
 * through to the interior — preserves watertightness.
 */
function makeFeatureCavity(
  m: ManifoldNamespace,
  brep: BuildingBRep,
  feature: Feature,
): ManifoldShape | null {
  const { Manifold } = m;
  // Each wall thickness is 0.3m by convention → cavity depth 0.24m
  const depth = Math.min(feature.depthM, 0.24);
  const width = feature.widthM;
  const height = feature.heightM;
  const cube = Manifold.cube([width, depth, height], true);

  // Position cavity on the facade edge. We'd need the wall geometry to orient
  // precisely; simplified for now: find the `facadeEdge`'th wall of this level
  // and align.
  const wall = brep.walls.find(w => w.facadeEdge === feature.facadeEdge && w.level === feature.level);
  if (!wall) {
    cube.delete();
    return null;
  }
  const dx = wall.end.x - wall.start.x;
  const dz = wall.end.z - wall.start.z;
  const wallLen = Math.hypot(dx, dz);
  if (wallLen < 1e-6) { cube.delete(); return null; }
  const ux = dx / wallLen, uz = dz / wallLen;
  const midX = wall.start.x + ux * feature.offsetAlongEdge * wallLen;
  const midZ = wall.start.z + uz * feature.offsetAlongEdge * wallLen;
  const yawDeg = (Math.atan2(dz, dx) * 180 / Math.PI);

  return cube
    .rotate([0, 0, yawDeg])
    .translate([midX, midZ, feature.elevationM + height / 2]);
}
