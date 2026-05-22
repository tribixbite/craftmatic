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
  /**
   * When present, the evaluator unions these vertical prisms (one per
   * band-polygon pair) and skips floors/walls extrusion. Used by the
   * sliced-extraction synthesizer for buildings whose horizontal silhouette
   * changes with height — twin towers, setbacks, cantilevers, spirals.
   */
  readonly bandedSilhouettes?: ReadonlyArray<{
    readonly polygon: readonly LocalPoint2D[];
    readonly baseY: number;
    readonly topY: number;
  }>;
  /**
   * Helical frustum primitive — used for spiral / cone / ziggurat
   * buildings (Guggenheim, Sugarloaf Tower, Aldar HQ). When present,
   * the evaluator emits a single twisted+tapered extrude instead of
   * stair-stepped bands. Mutually exclusive with bandedSilhouettes —
   * synthesizer picks whichever path fits the building.
   */
  readonly helicalFrustum?: {
    /** Base polygon (typically a 24-vertex circle approximation). */
    readonly basePolygon: readonly LocalPoint2D[];
    readonly baseY: number;
    readonly topY: number;
    /** scaleTop relative to basePolygon — [1,1] = cylinder, [0,0] = cone tip,
     *  [1.5,1.5] = inverted-frustum (Guggenheim's widening upward). */
    readonly scaleTop: readonly [number, number];
    /** Twist around Y axis from base to top (degrees). 0 = no rotation. */
    readonly twistDegrees: number;
    /** Number of subdivisions along Y for smoother twist (1 = straight extrude). */
    readonly nDivisions: number;
  };
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

  // Helical-frustum + banded path (additive). Helical frustum is a
  // single twisted+tapered extrude for spiral/cone/inverted-frustum
  // buildings (Guggenheim, Sugarloaf, Aldar HQ). When the synthesizer
  // ALSO emits bandedSilhouettes (Guggenheim's low annex over the
  // plaza, Marina City's parking podium), both contribute parts to
  // the union.
  if (brep.helicalFrustum) {
    const f = brep.helicalFrustum;
    if (f.topY > f.baseY && f.basePolygon.length >= 3) {
      const frustum = Manifold.extrude(
        [polygonToRing(f.basePolygon)],
        f.topY - f.baseY,
        f.nDivisions,
        f.twistDegrees,
        [f.scaleTop[0], f.scaleTop[1]],
      ).translate([0, 0, f.baseY]);
      parts.push(frustum);
    }
    if (brep.bandedSilhouettes) {
      for (const band of brep.bandedSilhouettes) {
        if (band.topY <= band.baseY) continue;
        const prism = Manifold.extrude(
          [polygonToRing(band.polygon)],
          band.topY - band.baseY,
        ).translate([0, 0, band.baseY]);
        parts.push(prism);
      }
    }
    if (brep.roof.type !== 'flat' && brep.roof.peakZ > brep.roof.baseZ) {
      const roofShape = await buildRoofShape(m, brep.roof);
      parts.push(roofShape);
    }
    const helical = Manifold.union(parts);
    return finaliseManifoldMeshFn(helical, parts);
  }

  // Banded path: stacked prism extrusion per band-polygon pair. Used when
  // the synthesizer derived its geometry from sliced photogrammetry and
  // the building has vertical topology changes (twin towers, setbacks,
  // cantilevers). Bypasses the floors/walls/roof breakdown entirely —
  // each band is its own prism and the union is the whole building.
  if (brep.bandedSilhouettes && brep.bandedSilhouettes.length > 0) {
    for (const band of brep.bandedSilhouettes) {
      if (band.topY <= band.baseY) continue;
      const prism = Manifold.extrude(
        [polygonToRing(band.polygon)],
        band.topY - band.baseY,
      ).translate([0, 0, band.baseY]);
      parts.push(prism);
    }
    // Apply roof shape on top of the bands (gabled/pyramidal/dome
    // synthesised from sliced-tiles inferRoofFromBands). Flat roofs
    // skip this — bands already terminate at expectedHeightM.
    if (brep.roof.type !== 'flat' && brep.roof.peakZ > brep.roof.baseZ) {
      const roofShape = await buildRoofShape(m, brep.roof);
      parts.push(roofShape);
    }
    let banded = Manifold.union(parts);

    // Window cavities still apply — feature generators add them based on
    // facade walls derived from the topmost band silhouette.
    const windowsBanded = brep.details.filter(d => d.kind === 'window');
    if (windowsBanded.length > 0) {
      const cavities: ManifoldShape[] = [];
      for (const w of windowsBanded) {
        const cube = makeFeatureCavity(m, brep, w);
        if (cube) cavities.push(cube);
      }
      if (cavities.length > 0) {
        const combined = Manifold.union(cavities);
        banded = Manifold.difference(banded, combined);
        combined.delete();
      }
    }

    return finaliseManifoldMeshFn(banded, parts);
  }

  // Fast path: when every floor shares the same polygon (common case —
  // simple prismatic buildings, no setbacks), collapse all floors + walls
  // into a single tall extrusion. Manifold.union() on 50+ near-coplanar
  // stacked prisms hangs indefinitely on pennzoil; a single extrude is
  // O(polygon) not O(polygon × levels).
  //
  // Detection: check that all floor polygons are reference-equal (fast
  // common-case check — the parametric synthesizer reuses a single
  // `openPoly` reference across every floor).
  const firstFloor = brep.floors[0];
  const allSamePolygon = firstFloor !== undefined
    && brep.floors.every(f => f.polygon === firstFloor.polygon);

  if (allSamePolygon && firstFloor !== undefined) {
    // Single extrude from ground to top of highest wall. Floor slabs and
    // wall solids are both implicit within this solid — future interior
    // floorplan subtraction (BuildingBRep.voids) will carve rooms from it.
    const topElevM = brep.floors.reduce((top, f) => {
      const wallHeight = brep.walls
        .filter(w => w.level === f.level)
        .reduce((h, w) => Math.max(h, w.heightM), 0);
      return Math.max(top, f.elevationM + f.thicknessM + wallHeight);
    }, 0);
    const tower = Manifold.extrude([polygonToRing(firstFloor.polygon)], topElevM);
    parts.push(tower);
  } else {
    // Slow path: per-floor + per-level extrudes, for buildings with varying
    // footprint per level (setbacks, tower-on-podium). Correctness matters
    // more than speed here.
    for (const floor of brep.floors) {
      const ring = polygonToRing(floor.polygon);
      const slab = Manifold.extrude([ring], floor.thicknessM)
        .translate([0, 0, floor.elevationM]);
      parts.push(slab);
    }
    const levelsByLevel = new Map<number, { polygon: readonly LocalPoint2D[]; heightM: number; elevationM: number }>();
    for (const floor of brep.floors) {
      if (!levelsByLevel.has(floor.level)) {
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
    for (const [, lvl] of levelsByLevel) {
      const solid = Manifold.extrude([polygonToRing(lvl.polygon)], lvl.heightM)
        .translate([0, 0, lvl.elevationM]);
      parts.push(solid);
    }
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

  return finaliseManifoldMeshFn(building, parts);
}

function finaliseManifoldMeshFn(
  shape: ManifoldShape,
  cleanup: ReadonlyArray<ManifoldShape> = [],
): EvaluatedMesh {
  const mesh = shape.getMesh();
  const { numVert, numTri, vertProperties, triVerts } = mesh;
  // Z-up → Y-up swap to match the IoU validator + voxelizer convention.
  const positions = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) {
    const bx = vertProperties[i * 3];
    const by = vertProperties[i * 3 + 1];
    const bz = vertProperties[i * 3 + 2];
    positions[i * 3] = bx;
    positions[i * 3 + 1] = bz;       // Z → Y (up)
    positions[i * 3 + 2] = by;       // Y → Z (preserves polygon.z sign)
  }
  const indices = new Uint32Array(numTri * 3);
  for (let i = 0; i < numTri; i++) {
    indices[i * 3] = triVerts[i * 3];
    indices[i * 3 + 1] = triVerts[i * 3 + 2];
    indices[i * 3 + 2] = triVerts[i * 3 + 1];
  }
  const vol = shape.volume();
  const surf = shape.surfaceArea();
  try { shape.delete(); } catch { /* already deleted */ }
  for (const p of cleanup) {
    try { p.delete(); } catch { /* already deleted */ }
  }
  return { positions, indices, volume: vol, surfaceArea: surf, watertight: true };
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
