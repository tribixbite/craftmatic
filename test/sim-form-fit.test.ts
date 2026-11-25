/**
 * PROC-20, Pixel round 24a: 21065's "Place ... ?" form wrapped its walk-through note to 14 lines and pushed "Place
 * now" below the fold; the tester's first tap landed on the text and placed nothing. The simulator now counts a form
 * body's wrapped lines as the phone wraps them (quirk `form-body-hides-buttons`, core invariant `form-button-visible`).
 */
import { describe, expect, it } from 'vitest';
import { FORM_BODY_LINES_ABOVE_BUTTON, formBodyLines } from '../web/src/sim/script-host/ui-module.js';

// The two bodies exactly as the Pixel showed them (p4-conf.jpg, p1-conf.jpg).
const SAGRADA = '21 × 30 × 25 blocks · 0°\nOrigin: 12600, -60, 6000 in minecraft:overworld\n\nBlocks in this area will be replaced.\n\n'
  + "Walk-through size is 200 percent, not 100 percent: Entrances are 0.4×2.2 blocks at 100 percent; 200 percent makes them 0.8×4.4 (a player needs 0.75×1.8 to walk through; 4/7 clear it); floors are 3.6 blocks under the ceiling at 200 percent; a player still reaches 10 percent of the model's height at 200 percent.";
const MINAS = '54 × 33 × 19 blocks · 0°\nOrigin: 12000, -60, 6000 in minecraft:overworld\n\nBlocks in this area will be replaced.';

describe('sim forms: the first button shows without scrolling (form-button-visible, PROC-20)', () => {
  it('wraps the two Pixel bodies to the lines the phone drew (14 and 5; the font is proportional, so within one)', () => {
    expect(Math.abs(formBodyLines(SAGRADA) - 14)).toBeLessThanOrEqual(1);
    expect(formBodyLines(MINAS)).toBe(5);
  });
  it('the 14-line body is over the limit and the 5-line one is not', () => {
    expect(formBodyLines(SAGRADA)).toBeGreaterThan(FORM_BODY_LINES_ABOVE_BUTTON);
    expect(formBodyLines(MINAS)).toBeLessThanOrEqual(FORM_BODY_LINES_ABOVE_BUTTON);
  });
});
