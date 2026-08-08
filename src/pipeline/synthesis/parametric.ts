/**
 * Stage 7a — parametric synthesis.
 *
 * Input:  RefinedBuildingContext + JointEvidence
 * Output: BuildingBRep (CSG-evaluable)
 *
 * Deterministic: same inputs always produce the same B-rep. The evaluator
 * runs CSG to get a watertight mesh (via `evaluateBRep`).
 */

import type { JointEvidence } from '../fusion/types.js';
import type {
  RefinedBuildingContext,
  MaterialRef,
} from '../context/types.js';
import {
  buildCornice,
  buildEntry,
  buildWindowGrid,
  projectPolygonToLocal,
} from './features.js';
import { douglasPeucker } from '../context/classify.js';
import { rgbToWallBlock, rgbToRoofOverride, roofBaseToFullBlock } from '../../gen/color-blocks.js';
import { labToRgb, labToRgbHex } from '../color.js';
import type {
  BuildingBRep,
  Feature,
  FloorSlab,
  RoofVolume,
  Wall,
} from './brep.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function archTypeFloorHeight(t: RefinedBuildingContext['archType']): number {
  if (t === 'residential') return 3.0;
  if (t === 'commercial') return 4.0;
  if (t === 'industrial') return 5.0;
  return 3.5;
}

// Full-colour SV palette samples feed the shared 36-cluster Lab-delta-E
// block matcher (not the old L-only picker, which threw away 2/3 of the
// colour information and mapped every mid-lightness colour to
// `stone_bricks` regardless of hue). Lab→sRGB lives in pipeline/color.ts.
function pickWallBlock(lab: readonly [number, number, number]): string {
  const [r, g, b] = labToRgb(lab);
  return rgbToWallBlock(r, g, b);
}

function pickRoofBlock(lab: readonly [number, number, number]): string {
  const [r, g, b] = labToRgb(lab);
  // `rgbToRoofOverride` returns stairs + slab. For the parametric B-rep's
  // flat extrusion the cap slab is the right choice — stairs would need
  // orientation awareness we don't have yet at the material-ref level.
  // roofBaseToFullBlock owns the base→full-block suffix map (planks/`s`).
  const override = rgbToRoofOverride(r, g, b);
  return roofBaseToFullBlock(override.cap);
}

function makeMaterial(lab: readonly [number, number, number], blockName: string): MaterialRef {
  const tuple: readonly [number, number, number] = [lab[0], lab[1], lab[2]];
  return { blockName, lab: tuple };
}

// ─── Main synthesizer ──────────────────────────────────────────────────────

export function synthesizeParametric(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
): BuildingBRep {
  // Footprint in local MBR-aligned coords.
  //
  // Douglas-Peucker simplification before synthesis — complex OSM polygons
  // with 50+ vertices hang manifold-3d's CSG (Geisel Library had 58
  // cantilever-cross vertices and never finished after 2 minutes). 1m
  // tolerance in lat/lon degrees ≈ 0.00001°. Simplification typically cuts
  // Geisel-class polygons to 10-20 vertices with minimal IoU loss.
  const simplifyTol = 0.00001; // ~1.1m
  const simplifiedRaw = douglasPeucker(ev.footprint.value, simplifyTol);
  const rawPoly = simplifiedRaw.length >= 3 ? simplifiedRaw : ev.footprint.value;
  const localPoly = projectPolygonToLocal(
    rawPoly.map(p => ({ lat: p.lat, lon: p.lon })),
    ctx.center,
    ctx.mbr.rotationDeg,
  );
  // Remove closing vertex if present
  const closed = localPoly.length >= 2
    && Math.abs(localPoly[0].x - localPoly[localPoly.length - 1].x) < 1e-6
    && Math.abs(localPoly[0].z - localPoly[localPoly.length - 1].z) < 1e-6;
  const openPoly = closed ? localPoly.slice(0, -1) : localPoly;

  // Levels + heights
  //
  // heightM is the FULL building height (wall-top + roof peak) — the
  // objective gate compares against it directly. We split heightM into:
  //   roofExtrude: top 0.5m (flat) or ~15% (pitched, ≥2m)
  //   wallsTotal:  heightM − roofExtrude (floors stack up to this)
  //
  // Previously this was wrong in two ways: (1) levels × archFloorHeight
  // ignored heightM entirely, giving 71% error on Flatiron; (2) roofExtrude
  // was added on top of levels×floorHeight, overshooting heightM by 2m on
  // small pitched roofs (25% error on an 8m house).
  const heightM = Math.max(3, ev.heightM.value);
  const roofType = ev.roofShape.value;
  const isPitched = roofType !== 'flat';
  const roofExtrude = Math.min(
    heightM * 0.4, // never more than 40% of total (prevents collapse on tiny buildings)
    isPitched ? Math.max(2, heightM * 0.15) : 0.5,
  );
  const wallsTotal = Math.max(2.5, heightM - roofExtrude);

  // Use OSM levels when they imply a plausible floor height; else infer.
  const archFloorH = archTypeFloorHeight(ctx.archType);
  const inferredLevels = Math.max(1, Math.round(wallsTotal / archFloorH));
  const evLevels = Math.max(1, ev.levels.value);
  const osmLevelsPlausible = wallsTotal / evLevels >= 2.5 && wallsTotal / evLevels <= 5.0;
  const levels = osmLevelsPlausible ? evLevels : inferredLevels;
  const floorHeightM = wallsTotal / levels;
  const slabThicknessM = Math.min(0.3, floorHeightM * 0.1);
  const wallHeightPerLevel = floorHeightM - slabThicknessM;

  // Build floor slabs + walls per level
  const floors: FloorSlab[] = [];
  const walls: Wall[] = [];
  for (let level = 0; level < levels; level++) {
    const elevationM = level * floorHeightM;
    floors.push({ level, elevationM, thicknessM: slabThicknessM, polygon: openPoly });

    // Wall per edge
    for (let e = 0; e < openPoly.length; e++) {
      const start = openPoly[e];
      const end = openPoly[(e + 1) % openPoly.length];
      walls.push({
        level,
        facadeEdge: e % 4, // always 0-3 for MBR edge bucketing
        start,
        end,
        heightM: wallHeightPerLevel,
        thicknessM: 0.3,
        material: 'wall',
      });
    }
  }

  // Roof volume — sits on top of walls; peak reaches heightM exactly.
  const topElevM = levels * floorHeightM;
  const roof: RoofVolume = {
    type: roofType,
    baseZ: topElevM,
    peakZ: topElevM + roofExtrude,
    pitchDeg: isPitched ? 30 : 0,
    polygon: openPoly,
    params: {},
  };

  // Features: windows per facade, cornice for civic/historic, entry door
  const details: Feature[] = [];

  // Windows — only on the 4 MBR edges (first 4 walls per level are the canonical facades)
  const firstLevelWalls = walls.filter(w => w.level === 0 && w.facadeEdge < 4).slice(0, 4);
  for (let edge = 0; edge < Math.min(4, firstLevelWalls.length); edge++) {
    const windowEv = ev.windowGrid[edge];
    if (!windowEv) continue;
    const wall = firstLevelWalls[edge];
    // Use the SAME wall object for every level (windows will tile vertically
    // via the rows parameter)
    const grid = buildWindowGrid({
      wall,
      rows: Math.min(levels, windowEv.value.rows),
      cols: windowEv.value.cols,
      floorHeightM,
      archType: ctx.archType,
    });
    details.push(...grid);
  }

  // Cornice (one per facade) on historic/civic/religious
  if (ev.cornice.value) {
    for (const wall of firstLevelWalls) {
      const cornice = buildCornice({
        wall,
        totalBuildingHeightM: topElevM,
        bandHeightM: 0.5,
        depthM: 0.15,
      });
      details.push(cornice);
    }
  }

  // Entry door — use evidence's edge and offset
  if (firstLevelWalls.length > 0) {
    const entryEdge = Math.min(firstLevelWalls.length - 1, ev.entry.value.edge);
    const entry = buildEntry({
      wall: firstLevelWalls[entryEdge],
      offsetAlongEdge: ev.entry.value.offsetAlongEdge,
      archType: ctx.archType,
    });
    details.push(entry);
  }

  // Materials from palette evidence
  const wallLab = ev.wallPalette.value[0];
  const roofLab = ev.roofPalette.value[0];
  const trimLab = ev.wallPalette.value[1] ?? wallLab;

  return {
    origin: ctx.center,
    rotationDeg: ctx.mbr.rotationDeg,
    floors,
    walls,
    roof,
    details,
    materials: {
      wall: makeMaterial(wallLab, pickWallBlock(wallLab)),
      trim: makeMaterial(trimLab, pickWallBlock(trimLab)),
      roof: makeMaterial(roofLab, pickRoofBlock(roofLab)),
      window: makeMaterial([50, 0, 0], 'minecraft:glass'),
    },
  };
}

/**
 * Re-export for convenience — callers often want both the B-rep and the hex
 * colour for logging / comparison.
 */
export { labToRgbHex };
