import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLDraw, parseLDrawDocument, parseLocalColours, colourOverrides } from '../web/src/engine/ldraw-parser.js';
import { classifyDirective, directiveKey, LDRAW_DIRECTIVES } from '../web/src/engine/ldraw-directives.js';
import { LXFML_ATTRIBUTES, LXFML_ELEMENTS, lxfmlElementSpec } from '../web/src/engine/lxfml-schema.js';

/**
 * The reader used to act on exactly two line-type-0 directives, `FILE` and
 * `STEP`, and treat the other 70-odd in the corpus as comments. That is not
 * visible as an error — the model just comes out wrong — so each case below
 * pins a behaviour that a corpus sweep measured.
 *
 * `scripts/_converter_coverage_audit.ts` is the other half: it walks every
 * source file and fails on a directive missing from the table.
 */

const t1 = (colour: number, x: number, y: number, z: number, part: string): string =>
  `1 ${colour} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 ${part}`;

describe('directiveKey', () => {
  it('reads a command', () => {
    expect(directiveKey('0 MLCAD SKIP_BEGIN')).toBe('MLCAD SKIP_BEGIN');
    expect(directiveKey('0 !TEXMAP FALLBACK')).toBe('!TEXMAP FALLBACK');
    expect(directiveKey('0 STEP')).toBe('STEP');
  });

  it('does NOT mistake a model title for a command', () => {
    // Without a closed list of legacy unprefixed metas, every `0 <Title>` line
    // reports as an unknown directive and buries the real gaps.
    expect(directiveKey('0 UCS Millennium Falcon')).toBeNull();
    expect(directiveKey('0 Untitled Model')).toBeNull();
    expect(directiveKey('0 // a comment')).toBeNull();
    expect(directiveKey('0')).toBeNull();
  });

  it('flags a directive the table has never seen', () => {
    expect(classifyDirective('0 !SOMETHING_NEW 1 2 3')).toBe('unknown');
    expect(classifyDirective('0 STEP')).toMatchObject({ handled: true });
  });
});

describe('0 NOFILE', () => {
  it('closes the section, so trailing content places nothing', () => {
    const mpd = [
      '0 FILE a.ldr',
      t1(4, 0, 0, 0, '3001.dat'),
      '0 NOFILE',
      t1(4, 100, 0, 0, '3002.dat'),   // belongs to no model
    ].join('\n');
    const bricks = parseLDraw(mpd);
    expect(bricks.map(b => b.part)).toEqual(['3001.dat']);
  });

  it('still parses a plain .ldr with no FILE header', () => {
    expect(parseLDraw(t1(4, 0, 0, 0, '3001.dat'))).toHaveLength(1);
  });
});

describe('0 GHOST', () => {
  it('places the type-1 line it carries', () => {
    // MLCad draws a ghosted part faded; it is still in the model. 10186
    // General Grievous hides a whole 14-part sub-model behind one of these.
    const doc = [t1(4, 0, 0, 0, '3001.dat'), `0 GHOST ${t1(4, 20, 0, 0, '3002.dat')}`].join('\n');
    expect(parseLDraw(doc).map(b => b.part)).toEqual(['3001.dat', '3002.dat']);
  });
});

describe('0 MLCAD HIDE', () => {
  it('does NOT place the type-1 line it carries', () => {
    // Measured over the corpus: 1,235 of 1,627 hidden placements land on an
    // origin a visible part already occupies, so they are alternates.
    const doc = [t1(4, 0, 0, 0, '3001.dat'), `0 MLCAD HIDE ${t1(4, 0, 0, 0, '3002.dat')}`].join('\n');
    expect(parseLDraw(doc).map(b => b.part)).toEqual(['3001.dat']);
  });
});

describe('0 BUFEXCHG', () => {
  it('RETRIEVE discards the parts placed since STORE', () => {
    const doc = [
      t1(4, 0, 0, 0, '3001.dat'),
      '0 BUFEXCHG A STORE',
      t1(4, 20, 0, 0, '3002.dat'),
      t1(4, 40, 0, 0, '3003.dat'),
      '0 BUFEXCHG A RETRIEVE',
      t1(4, 60, 0, 0, '3004.dat'),
    ].join('\n');
    expect(parseLDraw(doc).map(b => b.part)).toEqual(['3001.dat', '3004.dat']);
  });

  it('a RETRIEVE with no STORE changes nothing', () => {
    const doc = [t1(4, 0, 0, 0, '3001.dat'), '0 BUFEXCHG A RETRIEVE'].join('\n');
    expect(parseLDraw(doc)).toHaveLength(1);
  });
});

describe('0 MLCAD SKIP_BEGIN', () => {
  it('KEEPS a block that expands a generator we do not implement', () => {
    // Every one of the 231 skip blocks in the corpus expands a FLEXHOSE,
    // RUBBER_BELT or SPRING. Skipping them deleted 40,862 parts of hose.
    const doc = [
      t1(4, 0, 0, 0, '3001.dat'),
      '0 MLCAD FLEXHOSE 7 0 0 0 1 0 0 0 1 0 0 0 1  50 -202 190  0 80 0 70 -194 250 0 80 0 50 756.dat 754.dat 0',
      '0 MLCAD SKIP_BEGIN',
      t1(4, 20, 0, 0, 'axlehol8.dat'),
      t1(4, 21, 0, 0, 'axlehol8.dat'),
      '0 MLCAD SKIP_END',
    ].join('\n');
    expect(parseLDraw(doc)).toHaveLength(3);
  });

  it('skips a block with no generator above it', () => {
    const doc = [
      t1(4, 0, 0, 0, '3001.dat'),
      '0 MLCAD SKIP_BEGIN',
      t1(4, 20, 0, 0, '3002.dat'),
      '0 MLCAD SKIP_END',
      t1(4, 40, 0, 0, '3003.dat'),
    ].join('\n');
    expect(parseLDraw(doc).map(b => b.part)).toEqual(['3001.dat', '3003.dat']);
  });
});

describe('0 !TEXMAP', () => {
  it('uses the FALLBACK and ignores the textured copy, so the part is not doubled', () => {
    const doc = [
      '0 !TEXMAP START PLANAR 0 0 0 1 0 0 0 1 0 tex.png',
      `0 !: ${t1(15, 0, 0, 0, '64683s05.dat')}`,
      '0 !TEXMAP FALLBACK',
      t1(15, 0, 0, 0, '64683s05.dat'),
      '0 !TEXMAP END',
    ].join('\n');
    expect(parseLDraw(doc)).toHaveLength(1);
  });

  it('uses the `0 !:` geometry when the block has no fallback', () => {
    const doc = [
      '0 !TEXMAP START PLANAR 0 0 0 1 0 0 0 1 0 tex.png',
      `0 !: ${t1(15, 0, 0, 0, '64683s05.dat')}`,
      '0 !TEXMAP END',
    ].join('\n');
    expect(parseLDraw(doc)).toHaveLength(1);
  });
});

describe("a document's own colour palette", () => {
  it('reads the LDraw !COLOUR spelling', () => {
    const c = parseLocalColours('0 !COLOUR SandBlue CODE 64 VALUE #88A2B5 EDGE 0 ALPHA 255');
    expect(c.get(64)).toMatchObject({ rgb: '#88A2B5', alpha: 255, name: 'SandBlue' });
  });

  it('reads the LDLite COLOR spelling, counting fields from the END', () => {
    // `0 COLOR <code> <name> <flags> <r> <g> <b> <a> <er> <eg> <eb> <ea>` — the
    // name may contain spaces and a flags field sits before the colour, so
    // taking the first three numbers reads `<flags> <r> <g>` at alpha 63.
    const c = parseLocalColours('0 COLOR 64 Red 0 237 28 36 255 237 28 36 255');
    expect(c.get(64)).toMatchObject({ rgb: '#ED1C24', alpha: 255, name: 'Red' });
    const spaced = parseLocalColours('0 COLOR 65 Dark Bluish Gray 0 99 95 97 255 99 95 97 255');
    expect(spaced.get(65)).toMatchObject({ rgb: '#635F61', name: 'Dark Bluish Gray' });
  });

  it('overrides only the codes that DISAGREE with the shared palette', () => {
    const colours = parseLocalColours([
      '0 !COLOUR Red CODE 4 VALUE #C91A09',        // agrees with the table
      '0 !COLOUR Mine CODE 64 VALUE #88A2B5',      // disagrees
      '0 !COLOUR Glass CODE 500 VALUE #112233 ALPHA 128',
    ].join('\n'));
    const o = colourOverrides(colours);
    expect(o.has(4)).toBe(false);
    expect(o.get(64)).toBe(0x2000000 | 0x88a2b5);
    // Alpha below 255 becomes the TRANSPARENT direct-colour form.
    expect(o.get(500)).toBe(0x3000000 | 0x112233);
  });

  it('never overrides the contextual codes 16 and 24', () => {
    const colours = parseLocalColours('0 !COLOUR Main CODE 16 VALUE #123456');
    expect(colourOverrides(colours).has(16)).toBe(false);
  });

  it('paints a brick with the document palette, through inheritance', () => {
    const doc = parseLDrawDocument([
      '0 !COLOUR Mine CODE 64 VALUE #88A2B5',
      t1(64, 0, 0, 0, '3001.dat'),
    ].join('\n'));
    expect(doc.colours.get(64)?.rgb).toBe('#88A2B5');
    expect(doc.bricks[0]!.color).toBe(0x2000000 | 0x88a2b5);
  });

  it('leaves a document with no palette untouched', () => {
    const doc = parseLDrawDocument(t1(4, 0, 0, 0, '3001.dat'));
    expect(doc.colours.size).toBe(0);
    expect(doc.bricks[0]!.color).toBe(4);
  });
});

describe('the coverage tables themselves', () => {
  it('give every entry an effect and a note', () => {
    for (const [key, spec] of Object.entries(LDRAW_DIRECTIVES)) {
      expect(spec.note, key).toBeTruthy();
      expect(spec.effect, key).toBeTruthy();
    }
    for (const [key, spec] of Object.entries(LXFML_ELEMENTS)) {
      expect(spec.note, key).toBeTruthy();
    }
    for (const [key, spec] of Object.entries(LXFML_ATTRIBUTES)) {
      expect(spec.note, key).toBeTruthy();
      expect(key, key).toContain('@');
    }
  });

  it('never marks an entry both handled and expansion-only', () => {
    const all = [...Object.entries(LDRAW_DIRECTIVES), ...Object.entries(LXFML_ELEMENTS), ...Object.entries(LXFML_ATTRIBUTES)];
    for (const [key, spec] of all) {
      expect(spec.handled && spec.viaExpansion, key).toBeFalsy();
    }
  });

  it('resolves an element family by prefix', () => {
    expect(lxfmlElementSpec('EBT_SCENE_PREFS_LEGO_BMImageFormat')).toMatchObject({ effect: 'view' });
    expect(lxfmlElementSpec('Brick')).toMatchObject({ handled: true });
    expect(lxfmlElementSpec('NoSuchElement')).toBeUndefined();
  });
});

/**
 * The corpus gate. Skipped where the reference corpus is not checked out —
 * the condition is evaluated at collection time, which is why it is a plain
 * `existsSync` and not something computed in `beforeAll`.
 */
const CORPUS = 'C:/git/clego/lego_sets';
describe.skipIf(!existsSync(CORPUS))('corpus coverage', () => {
  it('has a table entry for every directive in the OMR class', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = `${CORPUS}/OMR`;
    const unknown = new Map<string, string>();
    for (const name of readdirSync(dir).slice(0, 400)) {
      if (!/\.(ldr|mpd)$/i.test(name)) continue;
      const text = readFileSync(`${dir}/${name}`, 'latin1');
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.charCodeAt(0) !== 48) continue;
        const key = directiveKey(line);
        if (key !== null && !LDRAW_DIRECTIVES[key]) unknown.set(key, `${name}: ${line.slice(0, 90)}`);
      }
    }
    expect([...unknown.entries()]).toEqual([]);
  });
});
