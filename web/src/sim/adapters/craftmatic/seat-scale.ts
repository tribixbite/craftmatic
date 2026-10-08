/**
 * Every rideable's seat against what its vehicle DRAWS, at every wand size,
 * from the pack's JSON alone (no world, no scenario): the size group's
 * `minecraft:rideable` seat times the group's `minecraft:scale` is where the
 * device puts the rider (quirk `seat-scales-with-entity`, Saga round 30k),
 * the rider's eye 1.12 over it (quirk `rider-eye-above-seat`), and the
 * geometry at that scale is `drawnBoxes`. A seat is IN or ON its vehicle
 * when it stands within the drawn footprint and no higher than
 * `SEAT_ON_DRAWN.over` blocks above the highest drawn surface under it;
 * anything else - over the hull, beside it, under it, over nothing drawn -
 * is what SEAT-01 forbids ("the player sits IN the cockpit, never on top or
 * outside").
 *
 * Why the drawn hull and not the collision box: a vehicle's box is its hit
 * target (a coaster car's covers the tub, a shell's is a cull needle); only
 * the geometry says where the cabin is. Why every size and not the sizes a
 * scenario places at: the fault this catches (a seat written pre-scaled, so
 * the device scales it twice) grows with the size - 76286's rider was still
 * inside the hull's envelope at 150 % and six blocks over it at 200 %.
 *
 * `seatOnDrawn` is the one judgement; `play.ts` applies it to the mounted
 * rider in a live scenario (`seat-on-vehicle`), `seatScaleAudit` to the
 * shipped JSON at every step (`seatsEverySize`), and
 * `scripts/_seat_scale_check.ts` prints the table.
 */

import { SIZE_EVENT_PREFIX, SIZE_STEPS, seatWorldOffset } from '../../../engine/bedrock-placement-pack.js';
import type { Box, Vec3 } from '../../core/vec.js';
import { EntityDefinitions, type Components } from '../../entity/definitions.js';
import { packFiles, type Pack } from '../../pack/pack.js';
import { quirkValue } from '../../quirks/registry.js';
import type { AddonAppearance } from './appearance.js';
import { drawnBoxes, drawnTopOver, type DrawnBox } from './drawn.js';

/**
 * The tolerances of "in or on" (blocks, world):
 *   - `footprint`: how far outside the drawn footprint a seat may stand -
 *     half a player's width, so a seat at a hull's very edge still counts;
 *   - `over`: how high over the highest drawn surface under it a seat may
 *     sit - a rider's hips on an open bench, plus the most a cabin eye is
 *     raised to see out (cockpit-seat.ts `AHEAD_SEARCH.up`, 0.6);
 *   - `under`: how far under the drawn hull's bottom the rider's EYE may be.
 *     The hips are not judged here on purpose: a seat is the driver's eye
 *     less 1.12 at every size while the model scales and the player does not
 *     (cockpit-seat.ts `seatPositionAt`), so below 100 % the hidden body
 *     hangs under a small car's floor by design (42172 at 25 %: 0.8).
 */
export const SEAT_ON_DRAWN = { footprint: 0.3, over: 0.75, under: 0.5 } as const;

/** Where a seat point stands against the drawn geometry. `ok` is SEAT-01's verdict. */
export interface SeatPlace {
  /** `inside` a drawn cube; `on` a drawn surface (within `over` of it); else how it is off the vehicle. */
  verdict: 'inside' | 'on' | 'over' | 'beside' | 'under' | 'nothing-drawn';
  ok: boolean;
  /** The highest drawn surface under the seat's column (undefined: nothing drawn under it). */
  topUnder?: number;
  /** The seat's height over `topUnder` (negative inside or under it). */
  over?: number;
  /** The drawn geometry's box. */
  hull?: Box;
}

/** The box round every drawn cube. */
function hullOf(drawn: readonly DrawnBox[]): Box | undefined {
  if (!drawn.length) return undefined;
  const h: Box = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (const { box: b } of drawn) {
    h.x0 = Math.min(h.x0, b.x0); h.y0 = Math.min(h.y0, b.y0); h.z0 = Math.min(h.z0, b.z0);
    h.x1 = Math.max(h.x1, b.x1); h.y1 = Math.max(h.y1, b.y1); h.z1 = Math.max(h.z1, b.z1);
  }
  return h;
}

/**
 * Judge one seat point (world) against the drawn geometry (world, the same
 * frame): in or on the vehicle, or off it and how.
 */
export function seatOnDrawn(seat: Vec3, drawn: readonly DrawnBox[], tolerance = SEAT_ON_DRAWN): SeatPlace {
  const hull = hullOf(drawn);
  if (!hull) return { verdict: 'nothing-drawn', ok: false };
  const fp = tolerance.footprint;
  if (seat.x < hull.x0 - fp || seat.x > hull.x1 + fp || seat.z < hull.z0 - fp || seat.z > hull.z1 + fp) return { verdict: 'beside', ok: false, hull };
  // The highest drawn surface within half a player of the seat's column (a turned cube by its own top there).
  let topUnder = -Infinity;
  for (const d of drawn) {
    const t = drawnTopOver(d, seat.x - fp, seat.x + fp, seat.z - fp, seat.z + fp);
    if (t !== undefined) topUnder = Math.max(topUnder, t);
  }
  if (topUnder === -Infinity) return { verdict: 'beside', ok: false, hull };
  const over = seat.y - topUnder;
  if (over > tolerance.over) return { verdict: 'over', ok: false, topUnder, over, hull };
  if (seat.y + quirkValue('rider-eye-above-seat', 'eyeAboveSeatBlocks') < hull.y0 - tolerance.under) return { verdict: 'under', ok: false, topUnder, over, hull };
  const inside = drawn.some(({ box: b }) => seat.x >= b.x0 && seat.x <= b.x1 && seat.y >= b.y0 && seat.y <= b.y1 && seat.z >= b.z0 && seat.z <= b.z1);
  return { verdict: inside ? 'inside' : 'on', ok: true, topUnder, over, hull };
}

/** One seat of one rideable at one wand step, as the device realises it. */
export interface SeatScaleRow {
  typeId: string;
  pct: number;
  /** The group's `minecraft:scale`. */
  scale: number;
  seatIndex: number;
  /** The seat as the size group's JSON declares it (the entity's unscaled frame). */
  declared: Vec3;
  /** The seat's world offset from the entity: declared x scale. */
  seat: Vec3;
  /** The rider's eye: the seat + 1.12. */
  eye: Vec3;
  place: SeatPlace;
  ok: boolean;
}

/** A rideable the audit could not judge, and why. */
export interface SeatScaleSkip { typeId: string; why: 'no-geometry' | 'no-size-groups' }

export interface SeatScaleAudit { rows: SeatScaleRow[]; skipped: SeatScaleSkip[] }

const asVec = (p: unknown): Vec3 => {
  const a = Array.isArray(p) ? p as number[] : [];
  return { x: Number(a[0] ?? 0), y: Number(a[1] ?? 0), z: Number(a[2] ?? 0) };
};

/** The seats of a `minecraft:rideable` component (one object or a list). */
function seatsOf(components: Components): Vec3[] {
  const r = components['minecraft:rideable'] as { seats?: unknown } | undefined;
  if (!r) return [];
  const raw = Array.isArray(r.seats) ? r.seats : r.seats ? [r.seats] : [];
  return raw.map(s => asVec((s as { position?: unknown }).position));
}

/**
 * Every rideable with size groups in a behaviour pack, at every wand step:
 * the seat the device realises against the geometry drawn at that scale.
 * An entity the pack draws nothing for (the invisible scenery and ride
 * seats, placed on the model by the runtime) is skipped, named.
 */
export function seatScaleAudit(behavior: Pack, appearance: AddonAppearance): SeatScaleAudit {
  const defs = new EntityDefinitions();
  const dec = new TextDecoder();
  const rows: SeatScaleRow[] = [], skipped: SeatScaleSkip[] = [];
  const eyeAbove = quirkValue('rider-eye-above-seat', 'eyeAboveSeatBlocks');
  for (const [path, data] of packFiles(behavior, 'entities/', '.json')) {
    const def = defs.load(path, dec.decode(data));
    if (!def) continue;
    const rideableAnywhere = 'minecraft:rideable' in def.components || Object.values(def.groups).some(g => 'minecraft:rideable' in g);
    if (!rideableAnywhere) continue;
    const steps = SIZE_STEPS.filter(pct => `${SIZE_EVENT_PREFIX}${pct}` in def.groups);
    if (!steps.length) { skipped.push({ typeId: def.identifier, why: 'no-size-groups' }); continue; }
    const entry = appearance.byType.get(def.identifier);
    if (!entry || !entry.cubeCount) { skipped.push({ typeId: def.identifier, why: 'no-geometry' }); continue; }
    for (const pct of steps) {
      const group = def.groups[`${SIZE_EVENT_PREFIX}${pct}`]!;
      const components: Components = { ...def.components, ...group };
      const scale = (components['minecraft:scale'] as { value?: number } | undefined)?.value ?? 1;
      const drawn = drawnBoxes(entry, { x: 0, y: 0, z: 0 }, 0, scale);
      seatsOf(components).forEach((declared, seatIndex) => {
        const [x, y, z] = seatWorldOffset([declared.x, declared.y, declared.z], scale);
        const seat = { x, y, z }, eye = { x, y: y + eyeAbove, z };
        const place = seatOnDrawn(seat, drawn);
        rows.push({ typeId: def.identifier, pct, scale, seatIndex, declared, seat, eye, place, ok: place.ok });
      });
    }
  }
  return { rows, skipped };
}

const r2 = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);
const vec = (p: Vec3): string => `(${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)})`;

/** One row as a sentence: where the seat is and, when off the vehicle, by how much. */
export function describeSeatRow(r: SeatScaleRow): string {
  const p = r.place;
  const where = p.verdict === 'over' ? `${r2(p.over!)} blocks OVER the drawn top (${r2(p.topUnder!)}) under it`
    : p.verdict === 'beside' ? `BESIDE the hull (x ${r2(p.hull!.x0)}..${r2(p.hull!.x1)}, z ${r2(p.hull!.z0)}..${r2(p.hull!.z1)})`
    : p.verdict === 'under' ? `eye ${r2(p.hull!.y0 - r.eye.y)} blocks UNDER the hull's bottom`
    : p.verdict === 'nothing-drawn' ? 'over NOTHING drawn'
    : `${p.verdict} the hull (drawn top under it ${r2(p.topUnder!)})`;
  return `${r.typeId} at ${r.pct} %, seat ${r.seatIndex}: declared ${vec(r.declared)} x scale ${r.scale} = ${vec(r.seat)}, eye ${vec(r.eye)}: ${where}`;
}
