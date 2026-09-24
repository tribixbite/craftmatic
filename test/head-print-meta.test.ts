/**
 * `0 !CRAFTMATIC HEAD_PRINT <id>` (2026-09-24): the print id of a PLAIN head
 * rides on the meta line before it, so the part stays drawable by every
 * reader, and the parser hands the id to the next type-1 line only.
 */
import { describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { classifyDirective } from '../web/src/engine/ldraw-directives.js';

const I = '1 0 0 0 1 0 0 0 1';
const doc = [
  '0 heads',
  '0 !CRAFTMATIC HEAD_PRINT 3626pb3484',
  `1 78 0 0 0 ${I} 3626c.dat`,
  `1 78 40 0 0 ${I} 3626c.dat`,
  '0 !CRAFTMATIC HEAD_PRINT 3626PB1367',
  '0 // a comment between does not consume it',
  `1 78 80 0 0 ${I} 3626c.dat`,
].join('\n');

describe('0 !CRAFTMATIC HEAD_PRINT', () => {
  it('attaches the id to the next type-1 line only', () => {
    const bricks = parseLDrawDocument(doc).bricks;
    expect(bricks.map(b => b.part)).toEqual(['3626c.dat', '3626c.dat', '3626c.dat']);
    expect(bricks.map(b => b.headPrint)).toEqual(['3626pb3484', undefined, '3626pb1367']);
  });

  it('is a known, handled directive', () => {
    const spec = classifyDirective('0 !CRAFTMATIC HEAD_PRINT 3626pb3484');
    expect(spec).not.toBe('unknown');
    expect(spec && spec !== 'unknown' && spec.handled).toBe(true);
  });
});
