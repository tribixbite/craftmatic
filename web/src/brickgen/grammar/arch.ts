/**
 * Opening shapes (A08, BIZ-05): which cells of a `w` studs x `h` plates box are open for a rectangular, round-headed
 * or pointed (lancet) opening, and the rose window's disc with its mullions.
 *
 * A mask is row-major, row 0 the lowest plate: `mask[row * w + col]` is 1 where the opening is open. The shapes keep
 * the requested bounding box exactly (a round or pointed head never loses its top rows: the top row keeps at least
 * one cell, or two for an even width), so an opening's size is what A9 asked for within a stud and a plate.
 */
import type { Head } from './rules.js';

/**
 * Open cells of an opening.
 * @param w width in studs, @param h height in plates
 * @param head shape of the head; `flat` is a plain rectangle
 * @param headFraction share of the height the head occupies (springing line at `h * (1 - headFraction)`)
 * @param platesPerStud plates of height per stud of width at this scale (2.5 at the default scale)
 */
export function openingMask(w: number, h: number, head: Head, headFraction: number, platesPerStud: number): Uint8Array {
  const mask = new Uint8Array(w * h).fill(1);
  if (head === 'flat' || w < 2) return mask;
  const springing = Math.max(0, Math.min(h - 1, Math.round(h * (1 - headFraction))));
  const headPlates = h - springing;
  const headStuds = headPlates / platesPerStud;
  const minCells = w % 2 === 1 ? 1 : 2;
  for (let row = springing; row < h; row++) {
    const t = Math.min(1, (row - springing + 0.5) / platesPerStud / headStuds); // 0 at the springing line, 1 at the apex
    // Half-width as a share of the full half-width: a quarter ellipse for a round head, a sharper curve for a lancet.
    const share = head === 'round' ? Math.sqrt(Math.max(0, 1 - t * t)) : 1 - Math.pow(t, 1.5);
    let open = Math.round(w * share);
    if (open % 2 !== w % 2) open += open < w ? 1 : -1;
    open = Math.max(minCells, Math.min(w, open));
    const left = (w - open) / 2;
    for (let col = 0; col < w; col++) mask[row * w + col] = col >= left && col < left + open ? 1 : 0;
  }
  return mask;
}

/** A rose window: a disc of open cells of `diameter` studs, with `mullions` vertical bars (0 = none) of closed cells. */
export function roseMask(diameter: number, platesPerStud: number, mullions: number): { w: number; h: number; mask: Uint8Array; bars: Uint8Array } {
  const w = Math.max(1, diameter);
  const h = Math.max(1, Math.round(diameter * platesPerStud));
  const mask = new Uint8Array(w * h), bars = new Uint8Array(w * h);
  const r = w / 2;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const dx = col + 0.5 - r, dy = (row + 0.5 - h / 2) / platesPerStud;
    if (dx * dx + dy * dy <= r * r) mask[row * w + col] = 1;
  }
  // Vertical bars: the centre column (odd width) and, on a wide disc, one each side. Vertical only: a horizontal bar
  // would hang between two open cells with nothing under it to stand on.
  const cols: number[] = [];
  if (mullions >= 1) cols.push(Math.floor(w / 2));
  if (mullions >= 3 && w >= 7) cols.push(Math.floor(w / 2) - Math.round(w / 4), Math.floor(w / 2) + Math.round(w / 4));
  for (const col of cols) {
    if (col < 0 || col >= w) continue;
    for (let row = 0; row < h; row++) if (mask[row * w + col]) { bars[row * w + col] = 1; mask[row * w + col] = 0; }
  }
  return { w, h, mask, bars };
}
