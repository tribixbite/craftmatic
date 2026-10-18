/**
 * The parts a vehicle is steered by: a minifig's steering wheel (a car's, a
 * truck's, a kart's) and a ship's wheel. One leaf module so the cockpit
 * finder (ldraw-entity-compiler.ts), the nose inference (vehicle-facing.ts)
 * and the seat census (seat-census.ts) read the same list.
 */
import { partStem } from './part-id.js';

const strip = (d: string): string => d.replace(/^[~=_]+\s*/, '');
/** The mould behind a print or a BrickLink copy (`bl_3829c01` -> `3829c01`, `30663p01` -> `30663`). */
const mould = (part: string): string => partStem(part).replace(/^bl_/, '').replace(/p[0-9a-z]+$/, '');

/** Steering wheels and stands by id, for a source whose descriptions did not resolve. */
export const STEERING_WHEEL_IDS: ReadonlySet<string> = new Set(['3829', '3829c01', '73081', '3828', '30663', '16091', '30640c01']);
/**
 * Moulds named "steering wheel" that no minifig steers by: a 5 x 5 wheel
 * (67811, BrickLink's `Vehicle, Steering Wheel with 2 x 2 Center`) is a
 * decorative turnable on 10303's and 76457's buildings.
 */
const NOT_A_MINIFIG_WHEEL = new Set(['67811']);

/**
 * A steering wheel a figure drives by: a car's wheel, stand, or holder WITH
 * its wheel, the brick with a wheel moulded on, a tractor's (LDraw's names
 * and BrickLink's `Vehicle, Steering …`). A Technic steering wheel is not
 * one: it steers a Technic-scale model, whose seat is no minifig's (42172's
 * `2819`).
 */
export function isSteeringWheel(part: string, description: string): boolean {
  const id = mould(part);
  if (NOT_A_MINIFIG_WHEEL.has(id)) return false;
  if (STEERING_WHEEL_IDS.has(id)) return true;
  const d = strip(description);
  if (/^Technic\b/i.test(d)) return false;
  if (/Steering Wheel\s+([3-9]|\d{2,})\s*x/i.test(d)) return false;
  if (/^Car Steering Wheel Holder\b/i.test(d)) return /\(Complete\)|with .*Steering Wheel/i.test(d);
  return /^((Car|Minifig|Tractor Chassis|Vehicle,) )?Steering (Wheel|Stand)\b/i.test(d) || /^Minifig Brick\b.*\bwith Steering Wheel\b/i.test(d);
}

/** A ship's wheel (`4790`, `52395`, the Duplo helm): the helm a boat is steered from, by id or description. */
export function isShipWheel(part: string, description: string): boolean {
  return /^(4790|52395|4658)(?![0-9])/.test(mould(part)) || /^(Boat,? )?Ship'?s? Wheel\b|Boat Helm \/ Ship's Wheel$/i.test(strip(description));
}
