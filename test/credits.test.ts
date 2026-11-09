/** `CREDITS.txt` rendering (BIZ-07 / X-04). */
import { describe, expect, it } from 'vitest';
import { renderCredits } from '../web/src/engine/credits.js';
import type { PartSourceEntry } from '../web/src/engine/part-source.js';

const entry = (part: string, author: string | null, extra: Partial<PartSourceEntry> = {}): PartSourceEntry => ({
  part, kind: 'ldraw-official', file: `parts/${part}.dat`, licence: 'Licensed under CC BY 4.0', author, ...extra,
});

describe('credits', () => {
  it('credits list every author of every used part exactly once', () => {
    const text = renderCredits([
      entry('3001', 'James Jessiman'), entry('3002', 'James Jessiman'), entry('3003', 'Zed Zebra'),
      entry('a', 'Anna Able', { kind: 'ldraw-unofficial' }),
      entry('studio-only', 'Nobody Credited', { kind: 'studio' }),
    ]);
    const lines = text.split('\n');
    expect(lines.filter(l => l.trim() === '- James Jessiman')).toHaveLength(1);
    const authors = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2));
    expect(authors).toEqual(['Anna Able', 'James Jessiman', 'Zed Zebra']);
    expect(text).toContain('not endorsed by LDraw.org');
    expect(text).toMatch(/CC BY 2\.0/);
    expect(text).toMatch(/CC BY 4\.0/);
  });

  it('credits never contain part descriptions', () => {
    // A ledger entry carries no description; the renderer must not read one from anywhere.
    const text = renderCredits([entry('3001', 'James Jessiman') as PartSourceEntry & { description?: string }]);
    expect(text).not.toMatch(/Brick|Plate|Slope/i);
    expect(text).not.toContain('3001');
  });

  it('OSM attribution appears only when a source is odbl', () => {
    const parts = [entry('3001', 'James Jessiman')];
    expect(renderCredits(parts)).not.toMatch(/OpenStreetMap/);
    expect(renderCredits(parts, { sources: [{ licence: 'CC0-1.0' }] })).not.toMatch(/OpenStreetMap/);
    expect(renderCredits(parts, { sources: [{ licence: 'ODbL-1.0' }] })).toContain('(c) OpenStreetMap contributors (ODbL)');
  });
});
