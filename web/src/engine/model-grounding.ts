/**
 * Whether a model stands on the ground on its broad base or hangs over it on thin parts (PROC-20), as ONE rule for
 * the simulator (`model-grounded`, which judges the drawn boxes of a placed pack) and the export (which names the
 * source parts that would hold the model up, `hangingPartsWarning`).
 *
 * The export grounds the shell on its LOWEST part (`SceneActors.groundLdu`), and the Pixel showed that this is what
 * the player sees (round 24c: the rule matched the phone on all six sets). So a part placed under the model's base
 * by its source - a misconverted row, a reconstruction's door hung through the base brick - holds the whole model up
 * on it. Each such case was a source fault (gate-k, 2026-11-25: 5582 6243 76417 76435), traced by hand with
 * `scripts/_lowest_parts.ts`; the export now names those parts so the next one is found at build time.
 */
import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh } from './ldraw-part-geometry.js';
import type { SceneGridFrame } from './bedrock-scene-actors.js';
import { placementBox } from './scene-vehicles.js';

/** An axis-aligned box in blocks (y up). */
export interface GroundBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/** A placed model's footing: how far its broad base starts over the ground, and what share of it reaches the ground. */
export interface GroundedVerdict { hanging: boolean; hangBlocks: number; groundShare: number; message?: string }

/** The raster cell (blocks at 100 %) the footprint per height band is counted on. */
const GROUND_CELL = 0.25;
/** A band whose footprint is at least this share of the model's widest band is its BROAD base. */
const BROAD_SHARE = 0.25;
/** A model is hanging when the ground band's footprint is under this share of the widest band... 1 percent passed
 * 42652 on one 2 x 2 post (1.3 percent) 4 blocks up (Pixel round 24b); a tree trunk under its house keeps several. */
const GROUND_SHARE_MIN = 0.02;
/** ...and its broad base starts at least this far over the ground (blocks at 100 %). 2 passed 11377's 2.8-block hover
 * on the Pixel (round 24a): the base was read in whole one-block bands, 2.81 -> 2; '> 1' passed 11388's plate a whole
 * block over the grass, a gap the Pixel showed (round 24b); 1 passed 11377's castle plate 0.75 blocks up on three
 * window frames (0.32 percent on the ground), a float with a wide shadow on the Pixel (round 25d). Half a block is two
 * bands: over every favourite gate run since the rule existed (gates f-i) no grounded model read 0.5-1 under 2 percent. */
const HANG_MIN_BLOCKS = 0.5;
/** The height band the footprint is counted in (blocks at 100 %): a quarter block, so a base is read to within it. */
const GROUND_BAND = 0.25;

/**
 * Whether boxes standing on `groundY` hang over it on thin parts. The boxes are rastered on a `GROUND_CELL` grid in
 * `GROUND_BAND` height bands (both times the size factor `f`) from `groundY`: the BROAD base is the lowest band whose
 * footprint is a quarter of the widest band's. It hangs when that base starts at least `HANG_MIN_BLOCKS` up and the
 * lowest band's footprint is under `GROUND_SHARE_MIN` of the widest: 11388's two flexible axles drawn straight down
 * from its bridge held the whole set 6 blocks up. A stilt house, a tree house on its trunk and a car on its wheels keep
 * far more than 1 % on the ground. Overlapping boxes count once.
 */
export function groundedVerdict(boxes: readonly GroundBox[], groundY: number, f: number): GroundedVerdict {
  if (!boxes.length) return { hanging: false, hangBlocks: 0, groundShare: 1 };
  const cell = GROUND_CELL * f, band = GROUND_BAND * f;
  const top = Math.max(...boxes.map(b => b.y1));
  const bands = Math.max(1, Math.ceil((top - groundY) / band));
  const cells: Array<Set<string>> = Array.from({ length: bands }, () => new Set<string>());
  for (const b of boxes) {
    const k0 = Math.max(0, Math.floor((b.y0 - groundY) / band)), k1 = Math.min(bands - 1, Math.floor((b.y1 - groundY - 1e-6) / band));
    const i0 = Math.floor(b.x0 / cell), i1 = Math.ceil(b.x1 / cell), j0 = Math.floor(b.z0 / cell), j1 = Math.ceil(b.z1 / cell);
    for (let k = k0; k <= k1; k++) for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) cells[k]!.add(`${i},${j}`);
  }
  const area = cells.map(s => s.size);
  const widest = Math.max(...area);
  if (!widest) return { hanging: false, hangBlocks: 0, groundShare: 1 };
  const broad = area.findIndex(a => a >= BROAD_SHARE * widest);
  const hangBlocks = broad * band, groundShare = area[0]! / widest;
  const hanging = hangBlocks >= HANG_MIN_BLOCKS * f && groundShare < GROUND_SHARE_MIN;
  return {
    hanging, hangBlocks, groundShare,
    ...(hanging ? { message: `the model hangs ${hangBlocks.toFixed(1)} blocks over the ground: its broad base starts there and only ${(groundShare * 100).toFixed(2)} percent of its footprint reaches the ground (thin parts under it)` } : {}),
  };
}

/** The items whose box starts under a hanging model's broad base (`depthBlocks` under the base's own underside), deepest first, and the verdict. */
export interface UnderBroadBase<T> { verdict: GroundedVerdict; under: Array<{ item: T; depthBlocks: number }> }

/**
 * The verdict over labelled boxes grounded on their lowest box (as the export grounds a shell), and - when the model
 * hangs - every item whose box starts below its broad base, with how far below (blocks). Nothing when it stands.
 */
export function partsUnderBroadBase<T>(items: ReadonlyArray<{ box: GroundBox; item: T }>, f: number): UnderBroadBase<T> {
  if (!items.length) return { verdict: groundedVerdict([], 0, f), under: [] };
  const groundY = Math.min(...items.map(i => i.box.y0));
  const verdict = groundedVerdict(items.map(i => i.box), groundY, f);
  if (!verdict.hanging) return { verdict, under: [] };
  // The broad base's band starts at `baseY` (a quarter block's resolution); its own underside is the lowest box at or
  // over that band's floor, so a part's depth is measured from where the base really is.
  const bandY = groundY + verdict.hangBlocks;
  const below = (i: { box: GroundBox }): boolean => i.box.y0 < bandY - 1e-6;
  const rest = items.filter(i => !below(i));
  const baseY = rest.length ? Math.min(...rest.map(i => i.box.y0)) : bandY;
  const under = items.filter(below).map(i => ({ item: i.item, depthBlocks: baseY - i.box.y0 }));
  under.sort((a, b) => b.depthBlocks - a.depthBlocks);
  return { verdict, under };
}

/** A part reaching at most this share of a voxel cell under the base sinks (fills no grid row): 10316's two 40239
 * hairs 25-27 LDU under it at a 53.3-LDU cell (0.51) - the sim reads the shipped pack grounded, 0.00 blocks - while
 * 11377's 3662 frames 32-40 LDU under (0.6-0.75) held its plate up on the Pixel (round 25d). Between the two. */
const SINKS_WITHIN_CELLS = 0.55;

/** How many of the parts under the base a warning names. */
const WARNING_PARTS = 6;

/**
 * The export warning for a model its source places on thin parts under its broad base (`partsUnderBroadBase` over
 * the bricks' placement boxes, at the pack's 100 %), naming the parts with how far under the base they reach (LDU)
 * and where they are; undefined when the model stands on its base. `bricks` are what the shell is grounded on:
 * figures left out (the export raises a line-up onto the underside, and a figure is its own entity).
 */
export function hangingPartsWarning(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null | undefined>, frame: SceneGridFrame): string | undefined {
  // Blocks at the pack's 100 %, y up (LDraw y is down): the grid's own scale per LDU on each axis.
  const across = frame.scale / frame.cellXZ, up = frame.scale / frame.cellY;
  const items = bricks.map(b => {
    const p = placementBox(b, meshes.get(b.part));
    return { box: { x0: p.min[0] * across, x1: p.max[0] * across, z0: p.min[2] * across, z1: p.max[2] * across, y0: -p.max[1] * up, y1: -p.min[1] * up }, item: b };
  });
  const { verdict, under: all } = partsUnderBroadBase(items, 1);
  // A part reaching about half a voxel cell or less under the base fills no grid row of its own (the voxelizer
  // centres cells), so the shell still starts at the base and the part sinks.
  const under = all.filter(u => u.depthBlocks / up > SINKS_WITHIN_CELLS * frame.cellY);
  if (!verdict.hanging || !under.length) return undefined;
  const named = under.slice(0, WARNING_PARTS).map(({ item: b, depthBlocks }) =>
    `${b.part.replace(/\.dat$/i, '')} (${Math.round(depthBlocks / up)} LDU under it, at LDU ${[b.x, b.y, b.z].map(v => Math.round(v)).join(',')})`);
  return `Ground: the source holds the model up on thin parts - its broad base starts ${verdict.hangBlocks.toFixed(2)} blocks over its lowest part and only ${(verdict.groundShare * 100).toFixed(2)} percent of its footprint reaches the ground, so it hangs that far over the ground in game (sim model-grounded). Under the base: ${named.join(', ')}${under.length > WARNING_PARTS ? ` and ${under.length - WARNING_PARTS} more` : ''}. A source placement fault: check them with scripts/_lowest_parts.ts.`;
}
