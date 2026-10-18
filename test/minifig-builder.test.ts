/**
 * The custom-minifig popover's pure half (ui/minifig-builder.ts): form → rig
 * spec, stored-value sanitising, part-id cleaning. The DOM half is exercised by
 * scripts/_minifig_browser_check.mjs against the dev server.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MINIFIG_FORM, cleanPartId, figureCodeFromForm, formFromFigureCode, sanitizeForm, specFromForm } from '../web/src/ui/minifig-builder.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';
import { minifigCreatorLibrary } from '../web/src/engine/minifig-creator.js';

describe('specFromForm', () => {
  it('sends only the parts the user filled in, with the defaults for empty torso/head', () => {
    const spec = specFromForm({ ...DEFAULT_MINIFIG_FORM, torsoPart: '', headPart: ' 3626c.dat ', hairPart: '3901', hairColor: 0, heldRightPart: '3847', heldRightColor: 71, cape: true, capeColor: 4 });
    expect(spec.torso).toEqual({ part: '973', color: 4 });
    expect(spec.head).toEqual({ part: '3626c', color: 14 });
    expect(spec.hair).toEqual({ part: '3901', color: 0 });
    expect(spec.heldRight).toEqual({ part: '3847', color: 71 });
    expect(spec.heldLeft).toBeUndefined();
    expect(spec.cape).toEqual({ part: '4524', color: 4 });
    expect(spec.legs).toEqual({ color: 1 });
    // The rig accepts it and builds a full figure (torso, head, hair, hips, 2 legs, 2 arms, 2 hands, sword, cape).
    const figure = minifigFromSpec(spec);
    expect(figure.bricks.length).toBe(12);
  });

  it('leaves optional slots out when their part is blank', () => {
    const spec = specFromForm({ ...DEFAULT_MINIFIG_FORM });
    expect(spec.hair).toBeUndefined();
    expect(spec.heldRight).toBeUndefined();
    expect(spec.cape).toBeUndefined();
    expect(minifigFromSpec(spec).bricks.length).toBe(9);   // torso, head, hips, 2 legs, 2 arms, 2 hands
  });
});

describe('sanitizeForm', () => {
  it('keeps well-typed stored values and drops the rest field by field', () => {
    const f = sanitizeForm({ label: 'Knight', torsoColor: 15, headPart: 'x'.repeat(50), legsColor: -1, cape: 'yes', hairPart: '3901' });
    expect(f.label).toBe('Knight');
    expect(f.torsoColor).toBe(15);
    expect(f.headPart).toBe(DEFAULT_MINIFIG_FORM.headPart);
    expect(f.legsColor).toBe(DEFAULT_MINIFIG_FORM.legsColor);
    expect(f.cape).toBe(false);
    expect(f.hairPart).toBe('3901');
  });

  it('returns the defaults for garbage', () => {
    expect(sanitizeForm(null)).toEqual(DEFAULT_MINIFIG_FORM);
    expect(sanitizeForm('nope')).toEqual(DEFAULT_MINIFIG_FORM);
  });
});

it('cleanPartId strips .dat and whitespace', () => {
  expect(cleanPartId(' 3847.DAT ')).toBe('3847');
  expect(cleanPartId('')).toBe('');
});

it('has a real starter creator catalogue for the separate creator-wand export action', () => {
  const library = minifigCreatorLibrary('starter');
  expect(library.tier).toBe('starter');
  expect(library.slots.minifig.torso?.some(part => part.part === '973pbs')).toBe(true);
});

it('round-trips the builder state through a portable wand figure code', () => {
  const source = { ...DEFAULT_MINIFIG_FORM, label: 'Knight', torsoPart: '973pbs', torsoColor: 4, hairPart: '3901', heldRightPart: '3847', cape: true };
  const code = figureCodeFromForm(source);
  expect(code).toContain('mf1|m|');
  expect(formFromFigureCode(code)).toMatchObject(source);
});

it('preserves a backpack through code import and actual rig export', () => {
  const form = formFromFigureCode('mf1|m|bk=2524:4|n=Explorer');
  expect(form.backPart).toBe('2524');
  expect(specFromForm(form).cape).toEqual({ part: '2524', color: 4 });
  expect(figureCodeFromForm(form)).toContain('bk=2524:4');
});

it('rejects unsupported limb moulds instead of silently substituting defaults', () => {
  expect(() => formFromFigureCode('mf1|m|le=99999:4|n=Figure')).toThrow('supports 3816');
});
