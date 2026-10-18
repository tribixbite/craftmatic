/**
 * The per-set canon (engine/set-canon.ts): the set number is read from every
 * text an export carries, only a set the table names has a canon, and the
 * mount colour families read a placed colour by code or by hue.
 */
import { describe, expect, it } from 'vitest';
import { SET_CANON, canonFor, canonSetNumber, isMountColour, ldrawColourRgb, ldrawColourTranslucent } from '../web/src/engine/set-canon.js';

describe('set canon', () => {
  it('finds 11390 by the label the LEGO tab writes, the CLI --label, the stem and the provenance', () => {
    expect(canonFor('Dragon Ball: Shenron & Goku (11390-1)')?.setNumber).toBe('11390');
    expect(canonFor('Dragon Ball: Shenron & Goku (11390-1)', 'DragonBall')?.name).toBe('Dragon Ball: Shenron & Goku');
    expect(canonFor('nimbus-fixture', '11390-1-nimbus')?.setNumber).toBe('11390');
    expect(canonFor('anything', undefined, '11390-1')?.setNumber).toBe('11390');
    expect(canonFor(undefined, '11390.ldr')?.setNumber).toBe('11390');
  });

  it('has no canon for a set the table does not name, whatever numbers its title carries', () => {
    expect(canonFor('Ecto-1 (10274-1)', 'Ecto1')).toBeUndefined();
    expect(canonFor('Gringotts Bank (76417-1)', '76417')).toBeUndefined();
    expect(canonSetNumber('Roller Coaster (10261-1)', '10261', '10261-1')).toBeUndefined();
    expect(canonFor(undefined, undefined, undefined)).toBeUndefined();
  });

  it('every entry names its own set number and at least one hint', () => {
    for (const [k, c] of Object.entries(SET_CANON)) {
      expect(c.setNumber).toBe(k);
      expect(c.mounts?.length ?? 0).toBeGreaterThan(0);
      for (const m of c.mounts ?? []) expect(m.hud ?? '').not.toMatch(/%/);
    }
  });

  it('the cloud family is the yellows, light oranges, white, tan and the trans yellow and clear; the rock and the dragon are not', () => {
    for (const c of [14, 191, 18, 226, 15, 19, 46, 47]) expect(isMountColour('cloud', c), `code ${c}`).toBe(true);
    for (const c of [72, 8, 288, 0, 2, 1, 4, 25]) expect(isMountColour('cloud', c), `code ${c}`).toBe(false);
  });

  it("a direct colour (a source's own !COLOUR) is judged by its hue: a yellow is cloud, a red is not", () => {
    expect(isMountColour('cloud', 0x2000000 + 0xFAC80A)).toBe(true);
    expect(isMountColour('cloud', 0x2000000 + 0xB40000)).toBe(false);
    expect(isMountColour('cloud', 0x2000000 + 0xF8F8F8)).toBe(true); // a near-white
    expect(ldrawColourRgb(0x2000000 + 0xFAC80A)).toEqual([0xFA, 0xC8, 0x0A]);
    expect(ldrawColourRgb(999999)).toBeNull();
    expect(isMountColour('cloud', 999999)).toBe(false);
  });

  it('knows which codes see through (a clear bar or stand never joins a mount to the model)', () => {
    expect(ldrawColourTranslucent(47)).toBe(true);
    expect(ldrawColourTranslucent(46)).toBe(true);
    expect(ldrawColourTranslucent(0x3000000 + 0xFFFFFF)).toBe(true);
    expect(ldrawColourTranslucent(14)).toBe(false);
    expect(ldrawColourTranslucent(0x2000000 + 0xFFFFFF)).toBe(false);
  });
});
