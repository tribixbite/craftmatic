import { describe, expect, it } from 'vitest';
import { DOOR_LABEL, FAVOURITES, FAVOURITE_DOORWAYS_NOT_OK_AT_100, FAVOURITE_DOOR_ROUTES_PACK_AT_100, ceilingCheck, doorRouteCeiling } from '../scripts/favourite-sets.js';

describe('the favourites\' doorways that are not walkable at 100 % are a recorded list that only shrinks (A-11)', () => {
  it('a doorway not OK that the record does not explain, or explains under another verdict, fails the gate; a recorded one now OK must leave the record', () => {
    const record = { 'Door 2': 'SEALED: model:solid, a bunk a stud inside' };
    expect(ceilingCheck(record, [{ label: 'Door 2', verdict: 'SEALED' }])).toEqual({ unlisted: [], nowOk: [] });
    expect(ceilingCheck(record, [{ label: 'Door 2', verdict: 'ONE-WAY' }]).unlisted).toEqual([{ label: 'Door 2', verdict: 'ONE-WAY' }]);
    expect(ceilingCheck(record, [{ label: 'Door 3', verdict: 'SEALED' }])).toEqual({ unlisted: [{ label: 'Door 3', verdict: 'SEALED' }], nowOk: ['Door 2'] });
    expect(ceilingCheck(undefined, [])).toEqual({ unlisted: [], nowOk: [] });
  });
  it('every recorded doorway belongs to a favourite and names its verdict and the reason', () => {
    for (const [set, rows] of Object.entries(FAVOURITE_DOORWAYS_NOT_OK_AT_100)) {
      expect(FAVOURITES, set).toContain(set);
      for (const [label, why] of Object.entries(rows)) expect(why, `${set} ${label}`).toMatch(/^(ONE-WAY|SMALL|FAIL|NO-APPROACH|SEALED|STEP): \S.{10,}/);
    }
  });
});

describe('the doors the pack keeps from a walk the model draws have a ceiling per favourite that only goes down (A-20)', () => {
  it('over the ceiling fails, under it asks for a lower number, an unlisted favourite has 0', () => {
    expect(doorRouteCeiling('11371', 3)).toEqual({ ceiling: 2, over: true, under: false });
    expect(doorRouteCeiling('11371', 1)).toEqual({ ceiling: 2, over: false, under: true });
    expect(doorRouteCeiling('10261', 1).over).toBe(true);
    for (const set of Object.keys(FAVOURITE_DOOR_ROUTES_PACK_AT_100)) expect(FAVOURITES).toContain(set);
    expect(['Door 3', 'Gate 1', 'Garage door 1'].every(l => DOOR_LABEL.test(l))).toBe(true);
    expect(['Window 2', 'Doorbell', 'Turnable 1'].some(l => DOOR_LABEL.test(l))).toBe(false);
  });
});
