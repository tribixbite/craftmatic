import { describe, expect, it } from 'vitest';
import { embeddedPartTexts, parseLDraw, parseLDrawColor, parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';

const MPD = [
  '0 FILE main.ldr',
  '0 Test model',
  '1 4 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr',
  '1 16 100 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat',
  '1 0x2FF8800 0 -48 0 1 0 0 0 1 0 0 0 1 custom1.dat',
  '0 STEP',
  '1 1 0 -72 0 1 0 0 0 1 0 0 0 1 3004.dat',
  '0 FILE sub.ldr',
  '1 16 20 0 0 1 0 0 0 1 0 0 0 1 3005.dat',
  '1 2 40 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat',
  '0 FILE custom1.dat',
  '0 Custom Part',
  '0 !LDRAW_ORG Unofficial_Part',
  '4 16 0 0 0 20 0 0 20 0 20 0 0 20',
  '1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat',
  '0 FILE s\\3001s01.dat',
  '0 Subpart',
  '0 !LDRAW_ORG Unofficial_Subpart',
  '3 16 0 0 0 10 0 0 0 0 10',
].join('\n');

describe('parseLDrawDocument', () => {
  it('returns exactly the bricks parseLDraw returns (same transforms, colours, steps)', () => {
    const doc = parseLDrawDocument(MPD);
    expect(doc.bricks).toEqual(parseLDraw(MPD));
    // Colour-16 inheritance through the sub-model: sub.ldr placed in red (4).
    const inherited = doc.bricks.find(b => b.part === '3005.dat')!;
    expect(inherited.color).toBe(4);
    expect(inherited.x).toBe(20);
    // A rotated placement keeps its world matrix.
    const rotated = doc.bricks.find(b => b.part === '3001.dat')!;
    expect(rotated.rot).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    expect(rotated.step).toBe(1);
    expect(doc.bricks.find(b => b.part === '3004.dat')!.step).toBe(2);
  });

  it('keeps every 0 FILE section, normalised, as copies', () => {
    const doc = parseLDrawDocument(MPD);
    expect(doc.rootSection).toBe('main.ldr');
    expect([...doc.sections.keys()]).toEqual(['main.ldr', 'sub.ldr', 'custom1.dat', 's/3001s01.dat']);
    const custom = doc.sections.get('custom1.dat')!;
    expect(custom.lines).toContain('4 16 0 0 0 20 0 0 20 0 20 0 0 20');
    custom.lines.push('junk');
    expect(parseLDrawDocument(MPD).sections.get('custom1.dat')!.lines).not.toContain('junk');
  });

  it('treats an embedded Unofficial_Part as a terminal brick and keeps its text for the resolver', () => {
    const doc = parseLDrawDocument(MPD);
    const custom = doc.bricks.find(b => b.part === 'custom1.dat')!;
    expect(custom).toBeDefined();
    // Direct colour 0x2FF8800 is preserved as its numeric id, not parsed to 0.
    expect(custom.color).toBe(0x2ff8800);
    const texts = new Map(embeddedPartTexts(doc));
    expect([...texts.keys()]).toEqual(['custom1.dat', 's/3001s01.dat']);
    expect(texts.get('custom1.dat')).toContain('stud.dat');
  });

  it('parses a plain .ldr as a single __main__ section', () => {
    const doc = parseLDrawDocument('1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n');
    expect(doc.rootSection).toBe('__main__');
    expect(doc.sections.size).toBe(1);
    expect(doc.bricks).toHaveLength(1);
    expect(embeddedPartTexts(doc)).toEqual([]);
  });

  it('parses colour tokens: decimal ids and hex direct colours', () => {
    expect(parseLDrawColor('4')).toBe(4);
    expect(parseLDrawColor('16')).toBe(16);
    expect(parseLDrawColor('0x2FF0000')).toBe(0x2ff0000);
    expect(parseLDrawColor('0X3A0B0C0')).toBe(0x3a0b0c0);
  });
});
