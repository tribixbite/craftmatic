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

function labToRgbHex(lab: readonly [number, number, number]): string {
  // Lab → XYZ → RGB (inverse of the duplicated rgbToLab from fusion/reconcile.ts)
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const fInv = (t: number): number => t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787;
  const x = fInv(fx) * 0.95047;
  const y = fInv(fy) * 1.0;
  const z = fInv(fz) * 1.08883;
  const R = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const G = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const B = x * 0.0557 + y * -0.2040 + z * 1.0570;
  const toS = (c: number): number => c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  const r = Math.round(clamp(toS(R)) * 255);
  const g = Math.round(clamp(toS(G)) * 255);
  const bl = Math.round(clamp(toS(B)) * 255);
  return `#${[(r), (g), (bl)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Cheap Minecraft block picker — fuller mapping lives in `class-block-map.ts`. */
function pickWallBlock(lab: readonly [number, number, number]): string {
  const L = lab[0];
  if (L > 85) return 'minecraft:smooth_quartz';
  if (L > 70) return 'minecraft:white_concrete';
  if (L > 55) return 'minecraft:smooth_stone';
  if (L > 40) return 'minecraft:stone_bricks';
  if (L > 25) return 'minecraft:deepslate_bricks';
  return 'minecraft:polished_blackstone';
}

function pickRoofBlock(lab: readonly [number, number, number]): string {
  const [L, a, b] = lab;
  // Green-ish → copper roof
  if (a < -5 && b > -5) return 'minecraft:oxidized_copper';
  // Brown/red tint → brick / terracotta
  if (a > 10 && b > 10) return 'minecraft:brick';
  // Dark grey → slate
  if (L < 30) return 'minecraft:deepslate_tiles';
  // Medium grey → slate tiles
  return 'minecraft:stone_bricks';
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
  // Footprint in local MBR-aligned coords
  const rawPoly = ev.footprint.value;
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
