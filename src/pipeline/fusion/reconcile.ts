/**
 * Stage 6 — reconcile capture evidence into a single `JointEvidence`.
 *
 * The fusion rules (spec §Stage 6) are a per-field conflict table. Each
 * function here resolves ONE field independently, then `fuseEvidence()`
 * composes them.
 *
 * Each resolver returns `Evidence<T>` with:
 *   • value — the chosen reconciled value
 *   • source — which capture/source won
 *   • confidence — 0-1. Reduced when secondary sources disagree with primary.
 */

import type {
  ArchType,
  BuildingContext,
  Lab,
  LatLon,
  RoofShape,
} from '../context/types.js';
import type { SvEvidence, TileEvidence } from '../capture/types.js';
import type { SatEvidence } from '../capture/types.js';
import type {
  Evidence,
  EvidenceSource,
  JointEvidence,
  RoadSegment,
  TreeInstance,
} from './types.js';

// ─── Footprint ──────────────────────────────────────────────────────────────

export function reconcileFootprint(
  ctx: BuildingContext,
  tiles: TileEvidence | null,
): Evidence<readonly LatLon[]> {
  if (ctx.polygon && ctx.polygon.length >= 3 && ctx.polygonSource === 'osm') {
    return { value: ctx.polygon, source: 'osm', confidence: 1.0 };
  }
  if (ctx.polygon && ctx.polygonSource === 'solar-bbox') {
    return { value: ctx.polygon, source: 'solar', confidence: 0.7 };
  }
  // MBR corners fallback — always present, since resolveMbr throws when none
  if (ctx.polygon && ctx.polygon.length > 0) {
    return { value: ctx.polygon, source: 'inferred', confidence: 0.4 };
  }
  // Last-resort: reconstruct polygon from MBR corners
  return {
    value: ctx.mbr.corners,
    source: 'inferred',
    confidence: tiles ? 0.3 : 0.2,
  };
}

// ─── Height ────────────────────────────────────────────────────────────────

export function reconcileHeight(
  ctx: BuildingContext,
  tiles: TileEvidence | null,
): Evidence<number> {
  // Tiles only authoritative when we're confident the capture wasn't truncated
  if (tiles && !tiles.truncated && !tiles.noCoverage) {
    const measuredH = tiles.measuredBbox.max.y - tiles.measuredBbox.min.y;
    if (measuredH > 2) {
      return { value: measuredH, source: 'tiles', confidence: 0.95 };
    }
  }
  if (ctx.heightM != null && ctx.heightSource === 'solar') {
    return { value: ctx.heightM, source: 'solar', confidence: 0.85 };
  }
  if (ctx.heightM != null && ctx.heightSource === 'osm-levels') {
    return { value: ctx.heightM, source: 'osm', confidence: 0.8 };
  }
  if (ctx.heightM != null) {
    // Map ctx.heightSource (context's 4-value enum) onto EvidenceSource (6-value)
    const src: EvidenceSource = ctx.heightSource === 'osm-levels' ? 'osm'
      : ctx.heightSource === 'smarty' ? 'smarty'
      : ctx.heightSource === 'tiles' ? 'tiles'
      : ctx.heightSource === 'solar' ? 'solar'
      : 'inferred';
    return { value: ctx.heightM, source: src, confidence: 0.5 };
  }
  // Last resort — fabricate from archType
  return {
    value: defaultHeightForArchType(ctx.archType),
    source: 'inferred',
    confidence: 0.25,
  };
}

function defaultHeightForArchType(t: ArchType): number {
  switch (t) {
    case 'residential': return 8;
    case 'commercial': return 20;
    case 'civic': return 18;
    case 'industrial': return 12;
    case 'historic': return 25;
    case 'religious': return 22;
  }
}

// ─── Levels ────────────────────────────────────────────────────────────────

export function reconcileLevels(
  ctx: BuildingContext,
  sv: SvEvidence,
  heightEv: Evidence<number>,
): Evidence<number> {
  // Priority: OSM levels > Smarty > SV row count > heightM / archType floor height
  if (ctx.levels && ctx.levels > 0) {
    return { value: ctx.levels, source: 'osm', confidence: 0.95 };
  }
  // Smarty — stories field (if API returns it). Shape is API-specific; try any.
  const smartyStories = (ctx.rawSmarty as { stories?: number } | null)?.stories;
  if (smartyStories && smartyStories > 0) {
    return { value: smartyStories, source: 'smarty', confidence: 0.85 };
  }
  // SV: take median rows across facades with confidence > 0.4
  const rows = sv
    .map(f => f.windowGrid)
    .filter((w): w is NonNullable<typeof w> => w != null && w.confidence > 0.4)
    .map(w => w.rows);
  if (rows.length >= 2) {
    rows.sort((a, b) => a - b);
    const median = rows[Math.floor(rows.length / 2)];
    return { value: median, source: 'sv', confidence: 0.7 };
  }
  // Derive from heightM + archType floor height
  const floorHeight = archTypeFloorHeight(ctx.archType);
  const inferred = Math.max(1, Math.round(heightEv.value / floorHeight));
  return { value: inferred, source: 'inferred', confidence: heightEv.confidence * 0.5 };
}

function archTypeFloorHeight(t: ArchType): number {
  if (t === 'residential') return 3.0;
  if (t === 'commercial') return 4.0;
  if (t === 'industrial') return 5.0;
  return 3.5; // civic / historic / religious default
}

// ─── Palettes ──────────────────────────────────────────────────────────────

const DELTA_E_AGREE = 10;
const DELTA_E_DISAGREE = 20;

function deltaE(a: Lab, b: Lab): number {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

function parseColourTag(hex: string): Lab | null {
  // Only handle #RRGGBB for now (named colours handled by a separate util).
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return rgbToLab(r, g, b);
}

/** Duplicated tiny rgbToLab to avoid circular import from gen/color-blocks. */
function rgbToLab(r: number, g: number, b: number): Lab {
  // sRGB → XYZ → CIE-Lab (D65 white point)
  const toLin = (c: number): number => {
    const cc = c / 255;
    return cc > 0.04045 ? Math.pow((cc + 0.055) / 1.055, 2.4) : cc / 12.92;
  };
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.00000;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function reconcileWallPalette(
  ctx: BuildingContext,
  sv: SvEvidence,
): Evidence<readonly Lab[]> {
  const svWalls = sv
    .filter(f => f.confidence > 0.4 && f.occlusion !== 'trees')
    .map(f => f.palette.wall);

  if (svWalls.length > 0) {
    // Take the first couple of distinct SV walls as the palette
    const uniq = dedupLab(svWalls, 8);
    // Check agreement with OSM colour tag
    let source: EvidenceSource = 'sv';
    let confidence = 0.9;
    const osmLab = ctx.wallColourHint ? parseColourTag(ctx.wallColourHint) : null;
    if (osmLab) {
      const minDE = Math.min(...uniq.map(l => deltaE(l, osmLab)));
      if (minDE < DELTA_E_AGREE) {
        confidence = 1.0; // corroborates
      } else if (minDE > DELTA_E_DISAGREE) {
        confidence = 0.6; // SV wins but flag disagreement
      }
    }
    return { value: uniq, source, confidence };
  }
  // Fallback: OSM colour hint alone
  if (ctx.wallColourHint) {
    const lab = parseColourTag(ctx.wallColourHint);
    if (lab) return { value: [lab], source: 'osm', confidence: 0.6 };
  }
  // Final default: medium grey
  return { value: [[60, 0, 0]], source: 'inferred', confidence: 0.2 };
}

export function reconcileRoofPalette(
  ctx: BuildingContext,
  sat: SatEvidence | null,
): Evidence<readonly Lab[]> {
  if (sat && sat.roofPalette.primary) {
    const labs: Lab[] = [sat.roofPalette.primary];
    if (sat.roofPalette.secondary) labs.push(sat.roofPalette.secondary);
    let confidence = 0.85;
    const osmLab = ctx.roofColourHint ? parseColourTag(ctx.roofColourHint) : null;
    if (osmLab) {
      const de = deltaE(labs[0], osmLab);
      if (de < DELTA_E_AGREE) confidence = 1.0;
      else if (de > DELTA_E_DISAGREE) confidence = 0.6;
    }
    return { value: labs, source: 'sat', confidence };
  }
  if (ctx.roofColourHint) {
    const lab = parseColourTag(ctx.roofColourHint);
    if (lab) return { value: [lab], source: 'osm', confidence: 0.6 };
  }
  // Default by archType
  return {
    value: [defaultRoofLabForArchType(ctx.archType)],
    source: 'inferred',
    confidence: 0.2,
  };
}

function defaultRoofLabForArchType(t: ArchType): Lab {
  switch (t) {
    case 'residential': return rgbToLab(110, 70, 50); // asphalt brown
    case 'commercial':
    case 'industrial': return rgbToLab(60, 60, 60); // dark flat roof
    case 'civic':
    case 'historic': return rgbToLab(90, 70, 60); // slate
    case 'religious': return rgbToLab(70, 75, 70); // copper/slate
  }
}

// Dedup a list of Labs by delta-E threshold.
function dedupLab(labs: readonly Lab[], thresh: number): Lab[] {
  const out: Lab[] = [];
  for (const l of labs) {
    if (out.every(o => deltaE(o, l) > thresh)) out.push(l);
  }
  return out;
}

// ─── Roof shape ────────────────────────────────────────────────────────────

export function reconcileRoofShape(ctx: BuildingContext): Evidence<RoofShape> {
  // OSM roof:shape was already read into ctx.roofShape. If it's not 'flat'
  // (our default), we trust the tag.
  const tag = ctx.rawOsm?.tags?.['roof:shape'];
  if (tag != null && ctx.roofShape !== 'flat') {
    return { value: ctx.roofShape, source: 'osm', confidence: 1.0 };
  }
  // Solar roof pitch heuristic — if pitch > 15°, it's pitched, not flat
  const pitch = ctx.roofPitchDeg ?? (ctx.rawSolar as unknown as { roofPitchDeg?: number } | null)?.roofPitchDeg;
  if (pitch != null && pitch > 15) {
    return {
      value: ctx.archType === 'residential' ? 'gabled' : 'hipped',
      source: 'solar',
      confidence: 0.7,
    };
  }
  // Default by archType
  return {
    value: defaultRoofShapeForArchType(ctx.archType),
    source: 'inferred',
    confidence: 0.5,
  };
}

function defaultRoofShapeForArchType(t: ArchType): RoofShape {
  if (t === 'residential') return 'gabled';
  if (t === 'religious') return 'hipped';
  return 'flat';
}

// ─── Windows per facade ───────────────────────────────────────────────────

export function reconcileWindowGrid(
  ctx: BuildingContext,
  sv: SvEvidence,
  levelsEv: Evidence<number>,
): ReadonlyArray<Evidence<{ rows: number; cols: number }> | null> {
  const edges = 4;
  const out: Array<Evidence<{ rows: number; cols: number }> | null> = [];
  const widthM = Math.max(ctx.mbr.widthM, ctx.mbr.depthM);
  const defaultCols = estimateCols(widthM, ctx.archType);

  for (let edge = 0; edge < edges; edge++) {
    const match = sv.find(f => f.facadeEdge === edge && f.windowGrid != null);
    if (match && match.windowGrid) {
      out.push({
        value: { rows: match.windowGrid.rows, cols: match.windowGrid.cols },
        source: 'sv',
        confidence: match.windowGrid.confidence,
      });
      continue;
    }
    // Procedural: rows from levels, cols from facade width
    out.push({
      value: { rows: levelsEv.value, cols: defaultCols },
      source: 'inferred',
      confidence: 0.4,
    });
  }
  return out;
}

function estimateCols(widthM: number, archType: ArchType): number {
  const windowSpacing = archType === 'residential' ? 3.5 : 2.8;
  return Math.max(1, Math.floor(widthM / windowSpacing));
}

// ─── Cornice ───────────────────────────────────────────────────────────────

export function reconcileCornice(
  ctx: BuildingContext,
  sv: SvEvidence,
): Evidence<boolean> {
  const svCornice = sv.some(f => f.cornice);
  if (svCornice) return { value: true, source: 'sv', confidence: 0.9 };
  // Default by archType: civic/historic/religious usually have cornices
  if (ctx.archType === 'historic' || ctx.archType === 'civic' || ctx.archType === 'religious') {
    return { value: true, source: 'inferred', confidence: 0.55 };
  }
  return { value: false, source: 'inferred', confidence: 0.55 };
}

// ─── Entry ─────────────────────────────────────────────────────────────────

export function reconcileEntry(ctx: BuildingContext): Evidence<{ edge: number; offsetAlongEdge: number }> {
  // OSM entrance node lookup: scan `rawOsm.entrances` if the API client exposes it.
  const ent = (ctx.rawOsm as unknown as { entrances?: Array<{ lat: number; lon: number }> } | null)?.entrances;
  if (ent && ent.length > 0 && ctx.polygon) {
    // NB: the edge/offset calculation is deferred — synthesis re-derives it
    // from the entrance lat/lon. Returning a plausible default keeps the
    // type safe; the OSM entrance count still boosts confidence.
    return {
      value: { edge: 0, offsetAlongEdge: 0.5 },
      source: 'osm',
      confidence: 0.7,
    };
  }
  // Default: front edge at centre
  return { value: { edge: 0, offsetAlongEdge: 0.5 }, source: 'inferred', confidence: 0.3 };
}

// ─── Trees ─────────────────────────────────────────────────────────────────

export function reconcileTrees(
  ctx: BuildingContext,
  _sv: SvEvidence,
  _sat: SatEvidence | null,
): readonly TreeInstance[] {
  // OSM natural=tree nodes (consumer can pass these via rawOsm if the API
  // client exposes them). Otherwise empty — scene enrichment fills procedural trees.
  const osmTrees = (ctx.rawOsm as unknown as { trees?: Array<{ lat: number; lon: number; radiusM?: number }> } | null)?.trees;
  if (osmTrees && osmTrees.length > 0) {
    return osmTrees.map(t => ({
      position: { lat: t.lat, lon: t.lon },
      radiusM: t.radiusM ?? 3,
      source: 'osm',
    }));
  }
  // SV/Sat tree extraction deferred to a follow-up — they currently only surface
  // occlusion signals, not 3D tree positions.
  return [];
}

// ─── Roads ─────────────────────────────────────────────────────────────────

export function reconcileRoads(ctx: BuildingContext): readonly RoadSegment[] {
  const roads = (ctx.rawOsm as unknown as { roads?: Array<{ polyline: LatLon[]; width: number; type: string }> } | null)?.roads;
  if (roads && roads.length > 0) {
    return roads.map(r => ({ polyline: r.polyline, widthM: r.width, type: r.type }));
  }
  return [];
}

// ─── Top-level ─────────────────────────────────────────────────────────────

export interface FuseEvidenceInput {
  readonly ctx: BuildingContext;
  readonly tiles: TileEvidence | null;
  readonly sv: SvEvidence;
  readonly sat: SatEvidence | null;
}

export function fuseEvidence(input: FuseEvidenceInput): JointEvidence {
  const { ctx, tiles, sv, sat } = input;
  const footprint = reconcileFootprint(ctx, tiles);
  const heightM = reconcileHeight(ctx, tiles);
  const levels = reconcileLevels(ctx, sv, heightM);
  const wallPalette = reconcileWallPalette(ctx, sv);
  const roofPalette = reconcileRoofPalette(ctx, sat);
  const roofShape = reconcileRoofShape(ctx);
  const windowGrid = reconcileWindowGrid(ctx, sv, levels);
  const cornice = reconcileCornice(ctx, sv);
  const entry = reconcileEntry(ctx);
  const trees = reconcileTrees(ctx, sv, sat);
  const roads = reconcileRoads(ctx);

  return {
    footprint, heightM, levels,
    wallPalette, roofPalette, roofShape,
    windowGrid, cornice, entry,
    trees, roads,
  };
}
