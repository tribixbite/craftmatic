import { describe, expect, it } from 'vitest';
import { decodeFigureCode, encodeFigureCode, FigureCodeError, minifigCreatorLibrary } from '../web/src/engine/minifig-creator.js';
import { CREATOR_PROPERTY_COUNT, CREATOR_SLOTS, MINIFIG_CREATOR_COLOURS, OPTIONAL_SLOTS } from '../web/src/engine/minifig-creator-types.js';
import { LDRAW_COLOR_RGB } from '../web/src/engine/ldraw-colors.js';

describe('minifig creator code', () => {
  const figure = {
    family: 'minifig' as const, name: 'Knight', slots: {
      torso: { part: '973pbs', color: 4 }, head: { part: '3626cp01', color: 14 },
      hair: { part: '3901', color: 0 }, held_right: { part: '3847', color: 71 }, back: { part: '', color: 4 },
    },
  };
  it('round-trips ids, optional empty slots, colours and name', () => {
    expect(decodeFigureCode(encodeFigureCode(figure))).toEqual(figure);
  });
  it('rejects malformed, duplicate and non-portable fields rather than defaulting them', () => {
    expect(() => decodeFigureCode('mf1|m|to=973:4|to=973:4|n=Knight')).toThrow(FigureCodeError);
    expect(() => decodeFigureCode('mf1|m|to=973:-1|n=Knight')).toThrow(FigureCodeError);
    expect(() => decodeFigureCode('mf1|m|to=../973:4|n=Knight')).toThrow(FigureCodeError);
    for (const colour of ['', ' ', '1e2', '0x4', '9007199254740992']) {
      expect(() => decodeFigureCode(`mf1|m|to=973:${colour}|n=Knight`)).toThrow(FigureCodeError);
    }
    expect(() => decodeFigureCode('mf1|m|to=973:4|n=   ')).toThrow(FigureCodeError);
  });
});

describe('minifig creator contract', () => {
  it('fits Bedrock entity property limits and all swatches resolve to RGB', () => {
    expect(CREATOR_PROPERTY_COUNT).toBeLessThanOrEqual(32);
    expect(CREATOR_SLOTS).toHaveLength(10);
    expect(OPTIONAL_SLOTS.size).toBe(4);
    for (const colour of MINIFIG_CREATOR_COLOURS) expect(LDRAW_COLOR_RGB[colour]).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('ships a conservative, real starter catalogue with no guessed mini-doll rig', () => {
    const library = minifigCreatorLibrary('starter');
    expect(library.slots.minifig.torso?.map(p => p.part)).toContain('973');
    expect(library.slots.minidoll).toEqual({});
  });
});
