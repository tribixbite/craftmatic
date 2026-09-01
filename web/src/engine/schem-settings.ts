/**
 * Minecraft-export settings — pure types + the resolution planner.
 *
 * Shared by BOTH export surfaces (LEGO tab and the Upload/inline-viewer
 * download menu) so there is one definition of what an export can be asked to
 * do. No DOM here; `ui/schem-settings-panel.ts` owns the popover and
 * persistence, `ui/schem-export.ts` owns the run.
 *
 * RESOLUTION. The export voxelizes at a UNIFORM cubic cell measured in LDU
 * (1 stud = 20 LDU, 1 plate = 8 LDU). `auto` walks [4,5,8,10,20] and takes the
 * FINEST cell whose grid still fits Minecraft-sane bounds — that ladder and its
 * caps are the 2026-08-23 proportion-exact behaviour and must not drift, or the
 * byte-identity gate on the 21063 reference export breaks. Explicit choices are
 * honoured when they fit and otherwise fall back to the auto pick (reported via
 * `requestedHonored: false` so the UI can say so).
 */

import { DEFAULT_PROFILE_ID } from './block-profiles.js';
import type { ParsedBrick } from './ldraw-parser.js';

/** Cell sizes the auto ladder considers, finest first. */
export const AUTO_CELL_LADDER = [4, 5, 8, 10, 20] as const;

/** Minecraft-sane bounds for a generated grid. */
export const RESOLUTION_CAPS = {
  maxHorizontal: 640,
  maxHeight: 320,
  maxCells: 30_000_000,
} as const;

/** `auto`, or a cell size in LDU rendered as a string (a `<select>` value). */
export type ResolutionChoice = 'auto' | '4' | '8' | '20';

export interface ResolutionOption {
  value: ResolutionChoice;
  label: string;
  /** LDU per cell; undefined for `auto`. */
  cellLDU?: number;
}

export const RESOLUTION_OPTIONS: readonly ResolutionOption[] = [
  { value: 'auto', label: 'Auto — finest that fits' },
  { value: '4', label: '5 blocks per stud (4 LDU)', cellLDU: 4 },
  { value: '8', label: '2.5 blocks per stud (8 LDU)', cellLDU: 8 },
  { value: '20', label: '1 block per stud (20 LDU)', cellLDU: 20 },
];

export interface SchemExportSettings {
  resolution: ResolutionChoice;
  /** Block-mapping profile id (see block-profiles.ts). */
  profile: string;
  /** Add light-emitting blocks to enclosed dark interiors. OFF by default. */
  lightFill: boolean;
}

export const DEFAULT_SCHEM_SETTINGS: SchemExportSettings = {
  resolution: 'auto',
  profile: DEFAULT_PROFILE_ID,
  lightFill: false,
};

/** Model extent in LDU (already padded by the caller). */
export interface SpanLDU { x: number; y: number; z: number }

/** Padded LDraw extent of a brick list — the input to resolution planning. */
export function spanOfBricks(bricks: ParsedBrick[]): SpanLDU {
  let nx = Infinity, xx = -Infinity, ny = Infinity, xy = -Infinity, nz = Infinity, xz = -Infinity;
  for (const b of bricks) {
    if (b.x < nx) nx = b.x; if (b.x > xx) xx = b.x;
    if (b.y < ny) ny = b.y; if (b.y > xy) xy = b.y;
    if (b.z < nz) nz = b.z; if (b.z > xz) xz = b.z;
  }
  // Brick origins understate extents — pad by ~2 studs a side.
  return { x: xx - nx + 80, y: xy - ny + 80, z: xz - nz + 80 };
}

export interface ResolutionPlan {
  cellLDU: number;
  /** 20 / cellLDU — "blocks per stud". */
  cellsPerStud: number;
  /** Approximate output dims in cells (ceil of span/cell). */
  dims: { width: number; height: number; length: number };
  cells: number;
  /** False when an explicit choice was too fine and the caps forced a coarser cell. */
  requestedHonored: boolean;
  /** The cell size the user asked for, when it wasn't honoured. */
  requestedCellLDU?: number;
  /** True when even the coarsest ladder step exceeds the caps. */
  overCap: boolean;
}

/** Does a cell size keep the grid inside the caps? (exact historical maths) */
function fits(span: SpanLDU, cellLDU: number): boolean {
  const w = span.x / cellLDU, h = span.y / cellLDU, l = span.z / cellLDU;
  return (
    Math.max(w, l) <= RESOLUTION_CAPS.maxHorizontal &&
    h <= RESOLUTION_CAPS.maxHeight &&
    w * h * l <= RESOLUTION_CAPS.maxCells
  );
}

function planFor(span: SpanLDU, cellLDU: number, extra: Partial<ResolutionPlan>): ResolutionPlan {
  const width = Math.max(1, Math.ceil(span.x / cellLDU));
  const height = Math.max(1, Math.ceil(span.y / cellLDU));
  const length = Math.max(1, Math.ceil(span.z / cellLDU));
  return {
    cellLDU,
    cellsPerStud: 20 / cellLDU,
    dims: { width, height, length },
    cells: width * height * length,
    requestedHonored: true,
    overCap: false,
    ...extra,
  };
}

/**
 * Choose the export cell size for a model span.
 *
 * `auto` reproduces the shipped ladder exactly (finest cell that fits, else the
 * coarsest). An explicit choice is used when it fits, otherwise the auto pick is
 * substituted and `requestedHonored` is false.
 */
export function planResolution(span: SpanLDU, choice: ResolutionChoice = 'auto'): ResolutionPlan {
  // Auto pick — also the fallback for an over-cap explicit request.
  let autoCell = AUTO_CELL_LADDER[AUTO_CELL_LADDER.length - 1]!;
  let anyFits = false;
  for (const c of AUTO_CELL_LADDER) {
    if (fits(span, c)) { autoCell = c; anyFits = true; break; }
  }

  if (choice === 'auto') return planFor(span, autoCell, { overCap: !anyFits });

  const requested = Number(choice);
  if (fits(span, requested)) return planFor(span, requested, {});
  return planFor(span, autoCell, {
    requestedHonored: false,
    requestedCellLDU: requested,
    overCap: !anyFits,
  });
}

/** Human-readable one-liner for the settings popover / status line. */
export function describePlan(plan: ResolutionPlan): string {
  const { width, height, length } = plan.dims;
  const cells = plan.cells >= 1e6
    ? `${(plan.cells / 1e6).toFixed(1)}M`
    : plan.cells.toLocaleString();
  const base = `≈ ${width}×${height}×${length} blocks (${cells} cells) at ${plan.cellsPerStud}× stud`;
  if (!plan.requestedHonored) {
    return `${base} — ${20 / (plan.requestedCellLDU ?? 20)}× stud would exceed the ${RESOLUTION_CAPS.maxHorizontal}-block limit`;
  }
  if (plan.overCap) return `${base} — larger than the usual limits, export may be slow`;
  return base;
}
