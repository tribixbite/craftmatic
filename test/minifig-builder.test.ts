/**
 * The custom-minifig popover's pure half (ui/minifig-builder.ts): form → rig
 * spec, stored-value sanitising, part-id cleaning. The DOM half is exercised by
 * scripts/_minifig_browser_check.mjs against the dev server.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MINIFIG_FORM, cleanPartId, sanitizeForm, specFromForm } from '../web/src/ui/minifig-builder.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';

describe('specFromForm', () => {
  it('sends only the parts the user filled in, with the defaults for empty torso/head', () => {
    const spec = specFromForm({ ...DEFAULT_MINIFIG_FORM, torsoPart: '', headPart: ' 3626c.dat ', hairPart: '3901', hairColor: 0, heldRightPart: '3847', heldRightColor: 71, cape: true, capeColor: 4 });
    expect(spec.torso).toEqual({ part: '973', color: 4 });
    expect(spec.head).toEqual({ part: '3626c', color: 14 });
    expect(spec.hair).toEqual({ part: '3901', color: 0 });
    expect(spec.heldRight).toEqual({ part: '3847', color: 71 });
    expect(spec.heldLeft).toBeUndefined();
    expect(spec.cape).toEqual({ color: 4 });
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
