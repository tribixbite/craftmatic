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
import { LDU_PER_BLOCK } from './lego-scale.js';
import type { ParsedBrick } from './ldraw-parser.js';
import type { AddonScaleChoice } from './addon-scale.js';

/** Cell sizes the auto ladder considers, finest first. */
export const AUTO_CELL_LADDER = [4, 5, 8, 10, 20] as const;

/** Minecraft-sane bounds for a generated grid. */
export const RESOLUTION_CAPS = {
  maxHorizontal: 640,
  maxHeight: 320,
  maxCells: 30_000_000,
} as const;

/** `auto`, or a cell size in LDU rendered as a string (a `<select>` value). */
export type ResolutionChoice = 'auto' | '2' | '4' | '8' | '20' | 'minifig';

export interface ResolutionOption {
  value: ResolutionChoice;
  label: string;
  /** LDU per cell; undefined for `auto`. */
  cellLDU?: number;
}

export const RESOLUTION_OPTIONS: readonly ResolutionOption[] = [
  { value: 'auto', label: 'Auto — finest that fits' },
  // 10 blocks per stud is OPT-IN only and deliberately NOT in AUTO_CELL_LADDER:
  // it is 6.9× the cells of the 5×/stud tier (measured on 5969-1: 15,502 →
  // 107,191 non-air, 98 → 186 ms) and only small models clear the caps at all
  // (21063, 60380, 71043 and 76416 are all refused — see scripts/_res_survey.ts).
  // Adding it to the ladder would silently make every small export 7× bigger.
  { value: '2', label: '10 blocks per stud (2 LDU) · Museum 10×', cellLDU: 2 },
  { value: '4', label: '5 blocks per stud (4 LDU) · Museum 5×', cellLDU: 4 },
  { value: '8', label: '2.5 blocks per stud (8 LDU) · Display 2.5×', cellLDU: 8 },
  { value: '20', label: '1 block per stud (20 LDU) · Minifig 1:1', cellLDU: 20 },
  // THE Bedrock scale (lego-scale.ts): a minifig stands as tall as the player,
  // so 1 block = 53.33 LDU. The default for every Bedrock add-on export, so a
  // building's doors fit the figures that walk through them and a vehicle is
  // the size its driver implies.
  { value: 'minifig', label: 'Minifig scale · player-height minifigs (53.3 LDU)', cellLDU: LDU_PER_BLOCK },
];

export interface SchemExportSettings {
  resolution: ResolutionChoice;
  /** Block-mapping profile id (see block-profiles.ts). */
  profile: string;
  /** Add light-emitting blocks to enclosed dark interiors. OFF by default. */
  lightFill: boolean;
  lightCoverage?: 'sealed' | 'covered';
  lightStyle?: 'profile' | 'lantern' | 'sea_lantern';
  lightSpacing?: number;
  vehicleFacing?: 'auto' | '+x' | '-x' | '+z' | '-z';
  /**
   * Cuboid budget for the playable add-on's vehicle entities: how finely each
   * LEGO part is decomposed (balanced 4 LDU / high 2 LDU / ultra 1 LDU).
   */
  addonDetail?: 'balanced' | 'high' | 'ultra';
  /**
   * Playable add-on: export ONLY the main vehicle. Off by default, so the
   * figures and any second vehicle found beside it ship as their own entities.
   */
  addonMainVehicleOnly?: boolean;
  /**
   * Playable add-on: buildings as brick-accurate geometry (a static entity
   * compiled from the real parts over invisible walkable blocks). ON by
   * default; off ships the coloured block structure.
   */
  addonBuildingBricks?: boolean;
  /**
   * Playable add-on: the model's scale as a multiplier of the minifig scale
   * (engine/addon-scale.ts). `auto` keeps minifig-scale sets at 1× and shrinks
   * a figure-less display vehicle to its real length; a fixed step applies to
   * the blocks, the colliders, the entities and the figures alike. Used when
   * the resolution is `auto` or `minifig`; an explicit block resolution sets
   * the cell itself and the entities follow it.
   */
  addonScale?: AddonScaleChoice;
  /**
   * Emit partial Minecraft blocks (slabs, stairs) where the LEGO geometry is
   * genuinely partial — engine/block-shapes.ts. ON by default (the proposal's
   * recommendation): it only ever refines a cell that is already solid, so the
   * worst case is the previous all-cubes output. Turning it off reproduces that
   * output byte for byte.
   */
  shapes: boolean;
  /**
   * Smooth block-staircased slopes into real Minecraft stairs and slabs using
   * tonally-matched materials for colored concrete/wool (HotSchem detail engine).
   */
  detailMaterials?: boolean;
}

export const DEFAULT_SCHEM_SETTINGS: SchemExportSettings = {
  resolution: 'auto',
  profile: DEFAULT_PROFILE_ID,
  lightFill: false,
  lightCoverage: 'covered',
  lightStyle: 'profile',
  lightSpacing: 6,
  vehicleFacing: 'auto',
  addonDetail: 'balanced',
  addonMainVehicleOnly: false,
  addonBuildingBricks: true,
  addonScale: 'auto',
  shapes: true,
  detailMaterials: false,
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
  /** Which cap refused the requested cell size. */
  refusedBy?: 'horizontal' | 'height' | 'cells';
  /** True when even the coarsest ladder step exceeds the caps. */
  overCap: boolean;
}

/**
 * Which cap a cell size breaks, or null when it fits.
 * (The maths is the exact historical `fits` test, just reported.)
 */
export function capViolation(span: SpanLDU, cellLDU: number): 'horizontal' | 'height' | 'cells' | null {
  const w = span.x / cellLDU, h = span.y / cellLDU, l = span.z / cellLDU;
  if (Math.max(w, l) > RESOLUTION_CAPS.maxHorizontal) return 'horizontal';
  if (h > RESOLUTION_CAPS.maxHeight) return 'height';
  if (w * h * l > RESOLUTION_CAPS.maxCells) return 'cells';
  return null;
}

/** Does a cell size keep the grid inside the caps? (exact historical maths) */
function fits(span: SpanLDU, cellLDU: number): boolean {
  return capViolation(span, cellLDU) === null;
}

function planFor(span: SpanLDU, cellLDU: number, extra: Partial<ResolutionPlan>): ResolutionPlan {
  const width = Math.max(1, Math.ceil(span.x / cellLDU));
  const height = Math.max(1, Math.ceil(span.y / cellLDU));
  const length = Math.max(1, Math.ceil(span.z / cellLDU));
  return {
    cellLDU,
    cellsPerStud: Math.round(20 / cellLDU * 1000) / 1000,
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

  const requested = RESOLUTION_OPTIONS.find(o => o.value === choice)?.cellLDU ?? Number(choice);
  const violation = capViolation(span, requested);
  if (violation === null) return planFor(span, requested, {});
  return planFor(span, autoCell, {
    requestedHonored: false,
    requestedCellLDU: requested,
    refusedBy: violation,
    overCap: !anyFits,
  });
}

/**
 * Plan for an EXPLICIT cell size in LDU (the add-on scale's cell): honoured
 * when it fits the caps, otherwise the auto pick with `requestedHonored: false`,
 * exactly as an explicit menu choice is treated.
 */
export function planResolutionAtCell(span: SpanLDU, cellLDU: number): ResolutionPlan {
  let autoCell = AUTO_CELL_LADDER[AUTO_CELL_LADDER.length - 1]!;
  let anyFits = false;
  for (const c of AUTO_CELL_LADDER) {
    if (fits(span, c)) { autoCell = c; anyFits = true; break; }
  }
  const violation = capViolation(span, cellLDU);
  if (violation === null) return planFor(span, cellLDU, {});
  return planFor(span, autoCell, { requestedHonored: false, requestedCellLDU: cellLDU, refusedBy: violation, overCap: !anyFits });
}

/** Which cap the requested (refused) cell size broke — set only when refused. */
const CAP_REASON: Record<'horizontal' | 'height' | 'cells', string> = {
  horizontal: `the ${RESOLUTION_CAPS.maxHorizontal}-block width limit`,
  height: `the ${RESOLUTION_CAPS.maxHeight}-block height limit`,
  cells: `the ${RESOLUTION_CAPS.maxCells / 1e6}M-block limit`,
};

/** Human-readable one-liner for the settings popover / status line. */
export function describePlan(plan: ResolutionPlan): string {
  const { width, height, length } = plan.dims;
  const cells = plan.cells >= 1e6
    ? `${(plan.cells / 1e6).toFixed(1)}M`
    : plan.cells.toLocaleString();
  const base = `≈ ${width}×${height}×${length} blocks (${cells} cells) at ${plan.cellsPerStud}× stud`;
  if (!plan.requestedHonored) {
    // Name the cap that actually refused it — it is usually height, not width,
    // and a wrong reason sends the user resizing the wrong thing.
    const reason = plan.refusedBy ? CAP_REASON[plan.refusedBy] : CAP_REASON.horizontal;
    return `${base} — ${20 / (plan.requestedCellLDU ?? 20)}× stud would exceed ${reason}`;
  }
  if (plan.overCap) return `${base} — larger than the usual limits, export may be slow`;
  return base;
}
