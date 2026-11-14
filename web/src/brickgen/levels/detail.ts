/**
 * Detail grammars that only exist at the finer levels (LSCALE, BIZ-05 / BIZ-10): a pinnacle that steps in as it
 * rises, and a rose window with a ring and spokes. At one stud per metre a pinnacle is two or three studs wide and a
 * rose is a disc with one or three bars, so there is nothing to taper or to divide: these rules start where the
 * stud grid has room for them (`PINNACLE_TAPER_MIN_SIDE`, `TRACERY_MIN_DIAMETER`) and leave coarser output unchanged.
 *
 * Both return plain cell data the facade grammar writes with its own labels, so a new idiom stays a rule here and
 * no stage names a building.
 */

/** One course of a stepped pinnacle shaft: the stud inset from the full side and the plate range (relative to the shaft). */
export interface PinnacleStage {
  /** Studs the course is set in from each side of the base square. */
  inset: number;
  p0: number;
  p1: number;
}

/** A pinnacle whose base is narrower than this stays a straight shaft (it has no stud to give up). */
export const PINNACLE_TAPER_MIN_SIDE = 5;
/** Fewest plates a course may be: a thinner one is a plate hanging as a ledge, not a stage. */
export const PINNACLE_MIN_STAGE_PLATES = 3;

/**
 * The courses of a pinnacle shaft `shaftPlates` tall on a base `side` studs wide, narrowing by one stud a side per
 * course until it is as wide as its cone cap (`capSide`). Courses share the height evenly, each at least
 * `PINNACLE_MIN_STAGE_PLATES`; where the shaft is too short for every step, the lowest steps are dropped (the shaft
 * then starts narrower than its base), never the thin ledge. A base under `PINNACLE_TAPER_MIN_SIDE` is one course.
 */
export function pinnacleStages(side: number, capSide: number, shaftPlates: number): PinnacleStage[] {
  if (shaftPlates <= 0) return [];
  const steps = side >= PINNACLE_TAPER_MIN_SIDE ? Math.max(0, Math.floor((side - capSide) / 2)) : 0;
  const courses = Math.max(1, Math.min(steps + 1, Math.floor(shaftPlates / PINNACLE_MIN_STAGE_PLATES)));
  // With fewer courses than steps the shaft starts at the inset that leaves exactly `courses` courses before the cap.
  const firstInset = steps + 1 - courses;
  const stages: PinnacleStage[] = [];
  for (let k = 0; k < courses; k++) {
    stages.push({ inset: firstInset + k, p0: Math.round((shaftPlates * k) / courses), p1: Math.round((shaftPlates * (k + 1)) / courses) });
  }
  return stages;
}

/** Fewest studs across a rose that gets tracery: a smaller disc has no room between the rim and a hub. */
export const TRACERY_MIN_DIAMETER = 14;

/** The open and tracery cells of a rose window, row-major from the lowest plate (as `roseMask` in `grammar/arch.ts`). */
export interface RoseTracery { w: number; h: number; mask: Uint8Array; bars: Uint8Array }

/**
 * A rose of `diameter` studs with tracery: a vertical and a horizontal mullion, two diagonals, and a ring at half the
 * radius, each a stud thick in real units (a plate is `1 / platesPerStud` studs tall, so a bar is that many plates thick).
 * Every bar cell sits on the disc; the diagonals and the vertical mullion run rim to rim, so each bar is held at the
 * rim by the wall above or below it, the way a stud join needs (no bar hangs on side contact alone: the horizontal
 * mullion crosses the vertical one, and the ring crosses all four).
 */
export function roseTracery(diameter: number, platesPerStud: number): RoseTracery {
  const w = Math.max(1, diameter), h = Math.max(1, Math.round(diameter * platesPerStud));
  const mask = new Uint8Array(w * h), bars = new Uint8Array(w * h);
  const r = w / 2;
  const ringR = r * 0.5, half = 0.5; // a bar is one stud thick: half a stud either side of its centre line
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    // Cell centre in studs from the disc centre; y is real height, so the disc is round whatever the plate ratio.
    const dx = col + 0.5 - r, dy = (row + 0.5) / platesPerStud - h / (2 * platesPerStud);
    const d = Math.hypot(dx, dy);
    if (d > r) continue;
    const onBar = Math.abs(dx) <= half || Math.abs(dy) <= half || Math.abs(Math.abs(dx) - Math.abs(dy)) <= half * Math.SQRT2 || Math.abs(d - ringR) <= half;
    if (onBar) bars[row * w + col] = 1; else mask[row * w + col] = 1;
  }
  return { w, h, mask, bars };
}
