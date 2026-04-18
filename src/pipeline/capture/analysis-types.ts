/**
 * Analysis result types — massing / typology classifier output from the
 * voxel analyzer.
 *
 * These types live here (not in mesh-filter/) so browser consumers don't
 * pull in the 21-phase pipeline barrel to get the type signature. The
 * `analyzeGrid()` implementation still lives in mesh-filter/analysis.ts
 * until that module is deleted as part of Chunk 12 cleanup.
 */

/** Building shape classification from volumetric analysis. */
export type BuildingTypology = 'tower' | 'flatiron' | 'block' | 'house' | 'complex';

/** Detected front-face direction for street frontage. */
export type FaceDirection = '+x' | '-x' | '+z' | '-z';

/** Complete analysis result with recommended pipeline parameters. */
export interface AnalysisResult {
  // 1. Terrain / ground plane
  groundPlaneY: number;
  slopeAngle: number;
  isFlat: boolean;

  // 2. Central component isolation
  componentCount: number;
  centralAABB: {
    minX: number; maxX: number;
    minZ: number; maxZ: number;
    minY: number; maxY: number;
  };
  suggestedCropRadius: number;

  // 3. Capture boundary intersection
  edgeTouchPct: number;
  isPartialCapture: boolean;

  // 4. Volumetric typology
  typology: BuildingTypology;
  aspectRatio: number;
  footprintFill: number;
  isRectangular: boolean;

  // 4b. Shape classification for filter gating
  rectangularity: number;
  hasSetbacks: boolean;
  heightProfile: 'uniform' | 'tapered' | 'stepped' | 'domed';

  // 5. Roof analysis
  isFlatRoof: boolean;
  roofVariance: number;

  // 6. Facade colour clustering (k=2)
  dominantBlock: string;
  secondaryBlock: string;
  dominantPct: number;
  suggestedRemaps: Map<string, string>;

  // 7. Noise estimation
  protrusion1vCount: number;
  noisePct: number;
  suggestedClean: number;

  // 8. Street frontage
  frontFace: FaceDirection;

  // 9. Confidence score
  confidence: number;

  // 10. Entry / door detection
  entryPosition: { x: number; z: number } | null;
  entryFace: FaceDirection;
  entryWidth: number;

  // 11. Ground boundary / footprint
  footprintArea: number;
  perimeterLength: number;
  groundContactY: number;

  // 12. Entry path
  entryPath: Array<{ x: number; z: number }>;

  // 13. Data quality
  compactness: number;
  dataQuality: 'good' | 'fair' | 'poor';

  // 14. Building extent
  estimatedWidthM: number;
  estimatedHeightM: number;
  estimatedDepthM: number;
  estimatedFloors: number;

  // Recommended CLI args
  recommended: {
    generic: boolean;
    fill: boolean;
    noPalette: boolean;
    noCornice: boolean;
    noFireEscape: boolean;
    smoothPct: number;
    modePasses: number;
    cropRadius: number;
    useAABBCrop: boolean;
    cleanMinSize: number;
    remaps: Map<string, string>;
  };
}
