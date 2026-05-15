/**
 * Shared types for the modular LDraw renderer.
 */

export type Vec3 = readonly [number, number, number];
export type Triangle = readonly [Vec3, Vec3, Vec3];
export type Edge = readonly [Vec3, Vec3];
export type UV = readonly [number, number];

/**
 * A triangle with per-vertex UVs, sourced from a !TEXMAP block. The image
 * field is the texmap's data-URL — viewer resolves it through partTextureUrls.
 */
export interface TexturedTriangle {
  v: Triangle;
  uv: readonly [UV, UV, UV];
  /** color-16 means inherit; explicit color overrides */
  color: number;
}

export interface PartGeom {
  /** color-16 (inherit) triangles in part-local space */
  tris: Triangle[];
  /** color-16 (inherit) edges in part-local space */
  edges: Edge[];
  /** explicit-color triangles (non-16, non-24) keyed by colorId */
  colorTris: Map<number, Triangle[]>;
  /** explicit-color edges keyed by colorId */
  colorEdges: Map<number, Edge[]>;
  /** textured triangles keyed by image filename (lowercased) */
  texTris?: Map<string, TexturedTriangle[]>;
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
   * Progress callback during initial part fetch. Called as parts are resolved.
   * @param done Number of parts resolved so far
   * @param total Total number of parts to resolve
   */
  onProgress?: (done: number, total: number) => void;
}
