/**
 * Export filename stems (engine/export-name.ts).
 *
 * The convention the user asked for: NO source suffix, the model name first
 * (≤12 chars, whole words, no spaces), then the set number —
 * `Colosseum-10276.schem`, never `10276-1-omr.schem`.
 */

import { describe, it, expect } from 'vitest';
import {
  modelExportStem, sanitizeNameStem, normalizeSetNumber, safeFilenameStem, NAME_STEM_MAX,
} from '../web/src/engine/export-name.js';

describe('modelExportStem', () => {
  it('is Name-setNumber, with the -1 variant suffix dropped', () => {
    expect(modelExportStem({ name: 'Colosseum', setNum: '10276-1' })).toBe('Colosseum-10276');
  });

  it('never carries the source suffix that the old stems leaked', () => {
    // The label the loader used internally was `10276-1-omr` / `21063-1-io`.
    const stem = modelExportStem({ name: 'Colosseum', setNum: '10276-1', fallback: '10276-1-omr' });
    expect(stem).toBe('Colosseum-10276');
    expect(stem).not.toContain('omr');
    expect(stem).not.toContain('-io');
  });

  it('keeps a non-primary variant suffix, which is real information', () => {
    expect(modelExportStem({ name: 'Tree House', setNum: '21318-2' })).toBe('TreeHouse-21318-2');
  });

  it('falls back to the set number alone when the name is missing', () => {
    expect(modelExportStem({ setNum: '10276-1' })).toBe('10276');
    expect(modelExportStem({ name: '', setNum: '75192-1' })).toBe('75192');
  });

  it('falls back to the caller label (an uploaded file) with no catalog entry', () => {
    expect(modelExportStem({ fallback: 'my-own-build' })).toBe('my-own-build');
  });

  it('never returns an empty stem', () => {
    expect(modelExportStem({})).toBe('model');
    expect(modelExportStem({ name: '   ', setNum: '', fallback: '' })).toBe('model');
  });

  it('produces a stem safe to use as a filename', () => {
    const stem = modelExportStem({ name: 'R2-D2', setNum: '75308-1' });
    expect(stem).toBe('R2D2-75308');
    expect(stem).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('sanitizeNameStem', () => {
  it('keeps whole words up to the budget and drops the rest', () => {
    // "Millennium" is 10; adding "Falcon" would be 16 — over budget, so it goes.
    expect(sanitizeNameStem('Millennium Falcon')).toBe('Millennium');
    expect(sanitizeNameStem('Hogwarts Castle')).toBe('Hogwarts');
    // Both words fit inside 12.
    expect(sanitizeNameStem('Tree House')).toBe('TreeHouse');
  });

  it('never truncates mid-word when a boundary exists', () => {
    const stem = sanitizeNameStem('Millennium Falcon');
    expect(stem.length).toBeLessThanOrEqual(NAME_STEM_MAX);
    expect(stem).not.toBe('MillenniumFa');
  });

  it('cuts a single over-long first word, because there is no boundary', () => {
    expect(sanitizeNameStem('Bricktacularly')).toBe('Bricktacular');
    expect(sanitizeNameStem('Bricktacularly').length).toBe(NAME_STEM_MAX);
  });

  it('strips punctuation and upper-cases each word so the join stays readable', () => {
    expect(sanitizeNameStem('the lego movie')).toBe('TheLegoMovie');
    expect(sanitizeNameStem('Ninjago® City')).toBe('NinjagoCity');
    expect(sanitizeNameStem('X-Wing')).toBe('XWing');
  });

  it('returns empty for nothing usable', () => {
    expect(sanitizeNameStem(undefined)).toBe('');
    expect(sanitizeNameStem('')).toBe('');
    expect(sanitizeNameStem('   ---   ')).toBe('');
  });

  it('honours a caller-supplied budget', () => {
    expect(sanitizeNameStem('Millennium Falcon', 20)).toBe('MillenniumFalcon');
  });
});

describe('normalizeSetNumber', () => {
  it('drops only the -1 primary variant', () => {
    expect(normalizeSetNumber('10276-1')).toBe('10276');
    expect(normalizeSetNumber('21318-2')).toBe('21318-2');
    expect(normalizeSetNumber('10276-11')).toBe('10276-11');
  });

  it('passes through a number with no variant', () => {
    expect(normalizeSetNumber('10276')).toBe('10276');
    expect(normalizeSetNumber(undefined)).toBe('');
  });
});

describe('safeFilenameStem', () => {
  it('removes path separators and reserved characters', () => {
    expect(safeFilenameStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('removes control characters (a NUL can disguise an extension)', () => {
    expect(safeFilenameStem('safe\u0000.exe')).toBe('safe-.exe');
  });

  it('collapses whitespace and trims leading/trailing separators', () => {
    expect(safeFilenameStem('  spaced  out  ')).toBe('spaced-out');
    expect(safeFilenameStem('..hidden..')).toBe('hidden');
  });
});
