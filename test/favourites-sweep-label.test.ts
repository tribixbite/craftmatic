/**
 * PROC-19 / audit A-01: the favourites sweep must build the SAME pack a user gets from the LEGO tab.
 *
 * The LEGO tab labels an export `Name (set-1)` (ui/lego.ts), and the label is not cosmetic: the vehicle
 * classifier and the display scale read the title (`isWholeVehicleLabel`), and a pack's uuid follows it
 * (`packIdentity`). A sweep that labelled packs with the bare set number shipped 10365, 42663, 60446, 75397 and
 * 76286 static and 10337 / 42172 as buildings at 100 %. The pack's file stem must also be the regression set's
 * `newStem` (`<set>-<slug of the name>`), or `--scenario=regressions` over a sweep directory tests nothing.
 */
import { describe, expect, it } from 'vitest';
import { legoTabLabel, packStem } from '../scripts/favourite-sets.ts';
import { isWholeVehicleLabel } from '../web/src/engine/playable-components.ts';
import { REGRESSIONS } from '../web/src/sim/adapters/craftmatic/regressions.ts';

describe('favourites sweep labels', () => {
  it('labels a pack as the LEGO tab does: the name and the set number', () => {
    expect(legoTabLabel('42172', 'McLaren P1')).toBe('McLaren P1 (42172-1)');
    // A set the index has no name for keeps its number, so the label is never empty.
    expect(legoTabLabel('99999', undefined)).toBe('99999');
  });

  it('a sweep label lets the title classifier see the vehicle', () => {
    expect(isWholeVehicleLabel(legoTabLabel('42172', 'McLaren P1'))).toBe(true);
    expect(isWholeVehicleLabel('42172')).toBe(false);
  });

  it('names the pack file with the stem every regression case looks for', () => {
    expect(packStem('76417', "Gringotts Wizarding Bank – Collectors' Edition")).toBe('76417-gringotts-wizarding-bank-collectors-edition');
    expect(packStem('10788', "Gabby's Dollhouse")).toBe('10788-gabbys-dollhouse');
    expect(packStem('7140', 'X-wing Fighter')).toBe('7140-xwing-fighter');
    expect(packStem('76286', 'The Milano Spaceship')).toBe('76286-the-milano-spaceship');
    // Every set-numbered stem in the regression set has this shape.
    for (const c of REGRESSIONS) {
      if (!/^\d/.test(c.newStem)) continue;
      expect(c.newStem).toMatch(/^\d+-[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
