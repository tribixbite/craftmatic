import { describe, expect, it } from 'vitest';
import { partStem } from '../web/src/engine/part-id.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';

/**
 * The canonical-id normaliser and the stub-description fallback: the two things
 * that decide whether a detector can recognise a part at all.
 *
 * Both faults below shipped a pack: 10261 exported from its `.mpd` produced a
 * fabricated grey cart and zero minifigs, while the same set's `.ldr` produced
 * six ride cars and eight figures. Nothing errored — every canonical-id match
 * and every description match simply failed, so the pipeline fell back to its
 * "this set has no cars" path. These tests pin both halves so a source whose
 * parts are EMBEDDED cannot silently detect nothing again.
 */
describe('partStem', () => {
  it('drops the directory and the extension', () => {
    expect(partStem('parts/3001.dat')).toBe('3001');
    expect(partStem('s\\3001s01.dat')).toBe('3001s01');
    expect(partStem('3001.DAT')).toBe('3001');
    expect(partStem('3001')).toBe('3001');
  });

  it('drops the set prefix an MPD embeds its own parts under', () => {
    expect(partStem('10261 - 26021.dat')).toBe('26021');
    expect(partStem('10261 - 24869.dat')).toBe('24869');
    expect(partStem('s\\10261 - 26021s01.dat')).toBe('26021s01');
    expect(partStem('10261-1 - 25061.dat')).toBe('25061');
    expect(partStem('10261 - 3816.dat')).toBe('3816');
  });

  it('keeps a mould id that merely begins with digits', () => {
    // No ` - ` separator, so there is no set prefix to strip.
    expect(partStem('10261.dat')).toBe('10261');
    expect(partStem('3069b.dat')).toBe('3069b');
    expect(partStem('973pb5574c01.dat')).toBe('973pb5574c01');
    expect(partStem('26021c01.dat')).toBe('26021c01');
    // LDraw primitives hyphenate a fraction; too few digits to be a set number.
    expect(partStem('4-4cyli.dat')).toBe('4-4cyli');
    expect(partStem('1-4ndis.dat')).toBe('1-4ndis');
  });
});

describe('embedded part descriptions', () => {
  const EMBEDDED_STUB = '0 26021\n0 Name: 10261 - 26021.dat\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\10261 - 26021s01.dat\n';
  const LIBRARY = '0 Train Base  4 x  5 Roller Coaster\n0 Name: 26021.dat\n';

  it('falls back to the library description when the embedded section is a stub', async () => {
    const provider = createPartGeometryProvider({
      embedded: [['10261 - 26021.dat', EMBEDDED_STUB]],
      fetchPartText: async (id: string) => (id === '26021' ? LIBRARY : null),
    });
    const mesh = await provider.getPartMesh('10261 - 26021.dat');
    // Without the fallback this is '26021', which no description-based
    // classifier matches — the exact failure that produced the grey cart.
    expect(mesh?.description).toBe('Train Base  4 x  5 Roller Coaster');
  });

  it('keeps a real embedded description instead of the library one', async () => {
    const provider = createPartGeometryProvider({
      embedded: [['10261 - 26021.dat', '0 Candy Floss Cart\n0 Name: 10261 - 26021.dat\n']],
      fetchPartText: async (id: string) => (id === '26021' ? LIBRARY : null),
    });
    const mesh = await provider.getPartMesh('10261 - 26021.dat');
    expect(mesh?.description).toBe('Candy Floss Cart');
  });

  it('keeps the stub when the library has no such part', async () => {
    const provider = createPartGeometryProvider({
      embedded: [['10261 - 99999.dat', '0 99999\n0 Name: 10261 - 99999.dat\n']],
      fetchPartText: async () => null,
    });
    const mesh = await provider.getPartMesh('10261 - 99999.dat');
    expect(mesh?.description).toBe('99999');
  });
});
