/**
 * Unit tests for the three LEGO colour systems.
 *
 * The single most error-prone thing in the LEGO pipeline is conflating the
 * three *different* numeric colour-id systems (CLAUDE.md "Color systems — don't
 * conflate"): LDraw ids, BrickLink/Studio ids, and LDD material ids all use
 * small integers that mean different colours. These tests pin the distinction
 * so a future edit can't silently swap one table for another.
 */

import { describe, it, expect } from 'vitest';
import {
  ldrawColorToBlock,
  LDRAW_COLOR_TO_BLOCK,
  LDRAW_COLOR_RGB,
} from '../web/src/engine/ldraw-colors.js';
import { studioColorToBlock } from '../web/src/engine/studio-colors.js';
import { lddToLDraw } from '../web/src/engine/ldd-colors.js';

describe('LDraw colour ids', () => {
  it('maps the canonical ids (0=Black, 1=Blue, 4=Red, 15=White)', () => {
    expect(ldrawColorToBlock(0)).toBe('minecraft:black_concrete');
    expect(ldrawColorToBlock(1)).toBe('minecraft:blue_concrete');
    expect(ldrawColorToBlock(4)).toBe('minecraft:red_concrete');
    expect(ldrawColorToBlock(15)).toBe('minecraft:white_concrete');
  });

  it('has matching RGB hex for the canonical ids', () => {
    expect(LDRAW_COLOR_RGB[0]).toBe('#05131D');
    expect(LDRAW_COLOR_RGB[15]).toBe('#FFFFFF');
    expect(LDRAW_COLOR_RGB[1]).toBe('#0055BF');
    expect(LDRAW_COLOR_RGB[4]).toBe('#C91A09');
  });

  it('falls back to gray_concrete for a completely unknown id', () => {
    expect(ldrawColorToBlock(987654)).toBe('minecraft:gray_concrete');
  });

  it('uses a perceptual nearest-block fallback for ids known only by RGB', () => {
    // Find an id present in the RGB table but absent from the explicit block table.
    const rgbOnly = Object.keys(LDRAW_COLOR_RGB)
      .map(Number)
      .find((id) => !(id in LDRAW_COLOR_TO_BLOCK));
    expect(rgbOnly).toBeDefined();
    const block = ldrawColorToBlock(rgbOnly!);
    expect(block).toMatch(/^minecraft:/);
    expect(block).not.toBe('minecraft:gray_concrete'); // a real perceptual match, not the default
  });

  it('every explicit block mapping is a minecraft block id', () => {
    for (const v of Object.values(LDRAW_COLOR_TO_BLOCK)) {
      expect(v).toMatch(/^minecraft:[a-z_]+$/);
    }
  });
});

describe('Studio/BrickLink colour ids', () => {
  it('maps the canonical ids (1=White, 7=Blue, 11=Black)', () => {
    expect(studioColorToBlock(1)).toBe('minecraft:white_concrete');
    expect(studioColorToBlock(7)).toBe('minecraft:blue_concrete');
    expect(studioColorToBlock(11)).toBe('minecraft:black_concrete');
  });

  it('falls back to gray_concrete for unknown ids', () => {
    expect(studioColorToBlock(987654)).toBe('minecraft:gray_concrete');
  });
});

describe('the systems are NOT interchangeable (don\'t-conflate invariant)', () => {
  // The same integer means a different colour in each system. If a future edit
  // pointed the Studio loader at the LDraw table (or vice-versa), these break.
  it('id 1 is Blue in LDraw but White in Studio', () => {
    expect(ldrawColorToBlock(1)).toBe('minecraft:blue_concrete');
    expect(studioColorToBlock(1)).toBe('minecraft:white_concrete');
    expect(ldrawColorToBlock(1)).not.toBe(studioColorToBlock(1));
  });

  it('id 7 is Light Gray in LDraw but Blue in Studio', () => {
    expect(ldrawColorToBlock(7)).toBe('minecraft:light_gray_concrete');
    expect(studioColorToBlock(7)).toBe('minecraft:blue_concrete');
  });

  it('id 11 differs between LDraw and Studio', () => {
    expect(ldrawColorToBlock(11)).not.toBe(studioColorToBlock(11));
    expect(studioColorToBlock(11)).toBe('minecraft:black_concrete');
  });
});

describe('LDD material ids → LDraw colour codes', () => {
  it('maps known LDD materials to their LDraw codes', () => {
    expect(lddToLDraw(1)).toBe(15); // White
    expect(lddToLDraw(26)).toBe(0); // Black
    expect(lddToLDraw(21)).toBe(4); // Bright Red
    expect(lddToLDraw(23)).toBe(1); // Bright Blue
    expect(lddToLDraw(24)).toBe(14); // Bright Yellow
  });

  it('falls back to Light Bluish Gray (71) for unknown materials', () => {
    expect(lddToLDraw(987654)).toBe(71);
  });

  it('round-trips LDD→LDraw→Minecraft for a primary colour', () => {
    // LDD 26 (Black) → LDraw 0 → black_concrete: the real .lxf path.
    expect(ldrawColorToBlock(lddToLDraw(26))).toBe('minecraft:black_concrete');
  });
});
