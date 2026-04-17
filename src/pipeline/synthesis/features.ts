/**
 * Parametric feature generators — windows, cornices, entry doors.
 *
 * Each function produces `Feature[]` for one logical element. The parametric
 * synthesizer composes them into the final BRep detail list.
 */

import type { ArchType, LocalPoint2D } from '../context/types.js';
import type { Feature, Wall } from './brep.js';

// ─── Window grid ───────────────────────────────────────────────────────────

export interface BuildWindowGridInput {
  readonly wall: Wall;
  readonly rows: number;
  readonly cols: number;
  /** Floor-to-floor distance in metres. */
  readonly floorHeightM: number;
  readonly archType: ArchType;
}

/**
 * Build a regular rectangular grid of windows on `wall`. The grid is padded
 * so windows don't touch the wall corners.
 *
 * Window sizes vary by archType:
 *   residential  — 1.0m × 1.3m double-hung style
 *   commercial   — 1.5m × 1.8m curtain-wall style
 *   historic     — 1.2m × 2.0m arched (modelled as rect here)
 *   civic/relig. — 1.2m × 2.2m
 *   industrial   — 1.5m × 1.5m
 */
export function buildWindowGrid(input: BuildWindowGridInput): Feature[] {
  const { wall, rows, cols, floorHeightM, archType } = input;
  const dx = wall.end.x - wall.start.x;
  const dz = wall.end.z - wall.start.z;
  const wallLen = Math.hypot(dx, dz);
  if (wallLen < 2 || rows < 1 || cols < 1) return [];

  const dims = windowDimsFor(archType);

  // Horizontal spacing: distribute `cols` windows with equal margins
  const horizStep = wallLen / (cols + 1);
  // Vertical spacing: one row per floor, centred in the floor height
  const vertMargin = (floorHeightM - dims.heightM) / 2;

  const out: Feature[] = [];
  for (let r = 0; r < rows; r++) {
    const elevationBase = r * floorHeightM + vertMargin;
    for (let c = 0; c < cols; c++) {
      const offsetAlongEdge = (c + 1) * horizStep / wallLen;
      out.push({
        kind: 'window',
        facadeEdge: wall.facadeEdge,
        level: r,
        offsetAlongEdge,
        widthM: dims.widthM,
        heightM: dims.heightM,
        depthM: 0.08,
        elevationM: elevationBase,
      });
    }
  }
  return out;
}

function windowDimsFor(archType: ArchType): { widthM: number; heightM: number } {
  switch (archType) {
    case 'residential': return { widthM: 1.0, heightM: 1.3 };
    case 'commercial':  return { widthM: 1.5, heightM: 1.8 };
    case 'historic':    return { widthM: 1.2, heightM: 2.0 };
    case 'civic':
    case 'religious':   return { widthM: 1.2, heightM: 2.2 };
    case 'industrial':  return { widthM: 1.5, heightM: 1.5 };
  }
}

// ─── Cornice ───────────────────────────────────────────────────────────────

export interface BuildCorniceInput {
  readonly wall: Wall;
  readonly totalBuildingHeightM: number;
  /** Cornice band height (typical: 0.5m). */
  readonly bandHeightM?: number;
  /** Cornice protrusion depth (typical: 0.15m). */
  readonly depthM?: number;
}

/**
 * A horizontal band near the top of the facade. Modelled here as a single
 * `cornice` feature that the BRep evaluator doesn't currently subtract or
 * union specially — synthesis treats it as an additive detail.
 */
export function buildCornice(input: BuildCorniceInput): Feature {
  const dx = input.wall.end.x - input.wall.start.x;
  const dz = input.wall.end.z - input.wall.start.z;
  const wallLen = Math.hypot(dx, dz);
  const bandHeightM = input.bandHeightM ?? 0.5;
  const depthM = input.depthM ?? 0.15;
  return {
    kind: 'cornice',
    facadeEdge: input.wall.facadeEdge,
    level: input.wall.level,
    offsetAlongEdge: 0.5,
    widthM: wallLen,
    heightM: bandHeightM,
    depthM,
    elevationM: input.totalBuildingHeightM - bandHeightM - 0.1,
  };
}

// ─── Entry door ────────────────────────────────────────────────────────────

export interface BuildEntryInput {
  readonly wall: Wall;
  readonly offsetAlongEdge: number;
  readonly archType: ArchType;
}

export function buildEntry(input: BuildEntryInput): Feature {
  const dims = doorDimsFor(input.archType);
  return {
    kind: 'door',
    facadeEdge: input.wall.facadeEdge,
    level: input.wall.level,
    offsetAlongEdge: input.offsetAlongEdge,
    widthM: dims.widthM,
    heightM: dims.heightM,
    depthM: 0.1,
    elevationM: 0,
  };
}

function doorDimsFor(archType: ArchType): { widthM: number; heightM: number } {
  if (archType === 'commercial') return { widthM: 1.8, heightM: 2.4 };
  if (archType === 'civic' || archType === 'religious') return { widthM: 2.0, heightM: 3.0 };
  if (archType === 'historic') return { widthM: 1.4, heightM: 2.4 };
  return { widthM: 0.9, heightM: 2.1 };
}

// ─── Polygon projection helper ─────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_111;

/**
 * Project a LatLon polygon into local MBR-aligned LocalPoint2D space.
 *
 * Origin: building centre.
 * Axes: rotated so MBR long axis is along X.
 */
export function projectPolygonToLocal(
  polygon: ReadonlyArray<{ readonly lat: number; readonly lon: number }>,
  center: { readonly lat: number; readonly lng: number },
  rotationDeg: number,
): LocalPoint2D[] {
  const cosLat = Math.cos(center.lat * DEG2RAD);
  const rot = -rotationDeg * DEG2RAD; // rotate INTO MBR-aligned frame
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return polygon.map(p => {
    // First project to flat metres
    const ex = (p.lon - center.lng) * METERS_PER_DEG_LAT * cosLat;
    const ey = (p.lat - center.lat) * METERS_PER_DEG_LAT;
    // Z+ is south, so flip Y
    const x = ex;
    const z = -ey;
    // Rotate
    return {
      x: x * cos - z * sin,
      z: x * sin + z * cos,
    };
  });
}
