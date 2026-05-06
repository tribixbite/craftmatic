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
  // Tiles authoritative only when:
  //   • not truncated (top of building captured)
  //   • not covered by ≤3 meshes (noCoverage)
  //   • measurement is within 1.3× of OSM/Solar expected — otherwise the
  //     captured Y span includes underground/sidewalk geometry that
  //     extends well below the actual building base, blowing height_err
  //     past the 10% gate. When OSM/Solar disagrees with photogrammetry
  //     by >30%, prefer the surveyed value.
  if (tiles && !tiles.truncated && !tiles.noCoverage) {
    const measuredH = tiles.measuredBbox.max.y - tiles.measuredBbox.min.y;
    if (measuredH > 2) {
      const surveyed = ctx.heightM ?? 0;
      // Plausibility check:
      //   • Surveyed exists → reject tile measurements >30% larger
      //     (photogrammetry over-measures via sub-grade noise)
      //   • Surveyed absent → cap at the larger of:
      //       archType default × 4 (small residential trees etc.)
      //       MBR diagonal × 0.7 (big footprint plausibly tall)
      //     This passes Geisel (88×60m base → 76m cap, photogrammetry
      //     53m OK) while still catching residential overshoots
      //     (240-highland 31×21m → 27m cap, 51m measurement rejected).
      const archCap = defaultHeightForArchType(ctx.archType) * 5;
      const diag = Math.hypot(ctx.mbr.widthM, ctx.mbr.depthM);
      const footprintCap = diag * 0.9;
      const cap = surveyed > 0
        ? surveyed * 1.3
        : Math.max(archCap, footprintCap);
      if (measuredH <= cap) {
        return { value: measuredH, source: 'tiles', confidence: 0.95 };
      }
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

/**
 * Named colour → RGB table for common OSM `building:colour` values. The OSM
 * wiki lists ~140 valid names but mappers in practice stick to a much smaller
 * core vocabulary; this covers the ones the wiki shows in examples plus
 * anything we've seen in goldens.
 */
const OSM_NAMED_COLOURS: Record<string, readonly [number, number, number]> = {
  white: [240, 240, 240], cream: [238, 223, 204], ivory: [255, 255, 240],
  beige: [220, 200, 170], tan: [210, 180, 140], sand: [200, 180, 130],
  yellow: [240, 220, 130], gold: [200, 170, 90],
  orange: [220, 130, 60], red: [180, 60, 50],
  brown: [140, 90, 60], maroon: [130, 50, 60],
  gray: [140, 140, 140], grey: [140, 140, 140], silver: [180, 180, 180],
  black: [40, 40, 40], darkgray: [80, 80, 80], darkgrey: [80, 80, 80],
  green: [100, 140, 80], olive: [140, 140, 70],
  blue: [80, 110, 160], navy: [40, 60, 110],
  pink: [220, 180, 190],
};

function parseColourTag(hex: string): Lab | null {
  const trimmed = hex.trim().toLowerCase();
  const m = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (m) {
    const n = parseInt(m[1], 16);
    return rgbToLab((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const named = OSM_NAMED_COLOURS[trimmed.replace(/[^a-z]/g, '')];
  if (named) return rgbToLab(named[0], named[1], named[2]);
  return null;
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
  const osmLab = ctx.wallColourHint ? parseColourTag(ctx.wallColourHint) : null;

  // Priority flip (2026-04-20): when OSM has an explicit `building:colour`
  // tag it's a manually-curated mapper assertion about the actual facade
  // material. That's far more reliable than K-means on 4-6 SV images
  // where the top-clustered pixel can easily be a shadow, an awning, a
  // reflection of the sky, or a signal-bleed from a neighbouring building.
  // We now treat OSM colour as authoritative for the PRIMARY value and
  // keep any distinct SV samples as secondary/accent entries so trim
  // picking still has variety.
  //
  // Flatiron is the canonical case: OSM `building:colour=#CBC7AC` is
  // cream limestone, but SV K-means on a cloudy-day capture lands on
  // grey (L≈73, chroma≈3) because the actual cream pixels are sparse
  // and get outvoted by sidewalk + sky-leak greys.
  if (osmLab) {
    const svUniq = dedupLab(svWalls, 8);
    const svAgreement = svUniq.length > 0
      ? Math.min(...svUniq.map(l => deltaE(l, osmLab)))
      : Infinity;
    const confidence = svAgreement < DELTA_E_AGREE ? 1.0
      : svAgreement < DELTA_E_DISAGREE ? 0.85
      : 0.75; // SV disagrees; still trust the mapper but flag it
    // Primary = OSM, then distinct SV samples as secondary for trim/accent.
    const value: Lab[] = [osmLab];
    for (const l of svUniq) {
      if (deltaE(l, osmLab) > 8) value.push(l);
    }
    return { value, source: 'osm', confidence };
  }

  if (svWalls.length > 0) {
    // No OSM hint — same logic as before, SV-first.
    const uniq = dedupLab(svWalls, 8);
    return { value: uniq, source: 'sv', confidence: 0.9 };
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
