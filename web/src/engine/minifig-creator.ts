/**
 * Portable creator-library data and figure-code codec.
 *
 * This module deliberately contains no Bedrock API calls.  The web builder,
 * CLI and generated wand all use the same self-describing code, while the pack
 * emitter consumes the curated library specification.  A code names LDraw
 * parts and colours rather than generated geometry/property indices, so it
 * remains useful after a pack is rebuilt with a different library order.
 */
import {
  CREATOR_SLOTS, FIGURE_CODE_SLOT_KEYS, FIGURE_CODE_VERSION, OPTIONAL_SLOTS,
  type CreatorFamily, type CreatorSlot, type FigureCode, type MinifigLibraryEntry,
  type MinifigLibrarySpec,
} from './minifig-creator-types.js';

const FAMILY_CODE: Record<CreatorFamily, string> = { minifig: 'm', minidoll: 'd' };
const CODE_FAMILY: Record<string, CreatorFamily | undefined> = { m: 'minifig', d: 'minidoll' };
const SLOT_FROM_KEY = new Map(Object.entries(FIGURE_CODE_SLOT_KEYS).map(([slot, key]) => [key, slot as CreatorSlot]));
const PART_ID = /^[a-z0-9][a-z0-9/_-]*$/i;

/** A validation error suitable for display in the builder or in a wand form. */
export class FigureCodeError extends Error {
  constructor(message: string) { super(message); this.name = 'FigureCodeError'; }
}

/** Encode a portable, human-readable creator figure code. */
export function encodeFigureCode(figure: FigureCode): string {
  if (!figure.name.trim() || figure.name.length > 24) throw new FigureCodeError('Figure name must be 1–24 characters.');
  if (/[|\r\n]/.test(figure.name)) throw new FigureCodeError('Figure name cannot contain a pipe or newline.');
  const pieces = [FIGURE_CODE_VERSION, FAMILY_CODE[figure.family]];
  for (const slot of CREATOR_SLOTS) {
    const value = figure.slots[slot];
    if (!value) continue;
    if (!Number.isInteger(value.color) || value.color < 0) throw new FigureCodeError(`${slot} has an invalid LDraw colour.`);
    if (value.part && !PART_ID.test(value.part)) throw new FigureCodeError(`${slot} has an invalid LDraw part id.`);
    if (!value.part && !OPTIONAL_SLOTS.has(slot)) throw new FigureCodeError(`${slot} needs a part id.`);
    pieces.push(`${FIGURE_CODE_SLOT_KEYS[slot]}=${value.part}:${value.color}`);
  }
  pieces.push(`n=${figure.name}`);
  return pieces.join('|');
}

/** Decode a code strictly: malformed or duplicated fields are never guessed. */
export function decodeFigureCode(code: string): FigureCode {
  const pieces = code.trim().split('|');
  if (pieces.length < 3 || pieces[0] !== FIGURE_CODE_VERSION) throw new FigureCodeError(`Expected ${FIGURE_CODE_VERSION} figure code.`);
  const family = CODE_FAMILY[pieces[1]!];
  if (!family) throw new FigureCodeError(`Unknown figure family "${pieces[1]}".`);
  const slots: FigureCode['slots'] = {};
  let name: string | undefined;
  for (const piece of pieces.slice(2)) {
    const eq = piece.indexOf('=');
    if (eq <= 0) throw new FigureCodeError(`Malformed figure field "${piece}".`);
    const key = piece.slice(0, eq), value = piece.slice(eq + 1);
    if (key === 'n') {
      if (name !== undefined || !value.trim() || value.length > 24 || /[\r\n|]/.test(value)) throw new FigureCodeError('Figure name is missing, duplicated, or invalid.');
      name = value;
      continue;
    }
    const slot = SLOT_FROM_KEY.get(key);
    if (!slot || slots[slot]) throw new FigureCodeError(`Unknown or duplicate slot "${key}".`);
    const colon = value.lastIndexOf(':');
    const part = colon < 0 ? '' : value.slice(0, colon);
    const color = Number(value.slice(colon + 1));
    if (colon < 0 || !/^\d+$/.test(value.slice(colon + 1)) || !Number.isSafeInteger(color) || color < 0 || (part !== '' && !PART_ID.test(part)) || (!part && !OPTIONAL_SLOTS.has(slot))) {
      throw new FigureCodeError(`Invalid ${slot} field.`);
    }
    slots[slot] = { part, color };
  }
  if (!name) throw new FigureCodeError('Figure code has no name.');
  return { family, slots, name };
}

const entry = (part: string, label: string, group: string): MinifigLibraryEntry => ({ part, label, group });
const core = {
  head: [entry('3626c', 'Classic head', 'Classic'), entry('3626cp01', 'Smiling head', 'Faces')],
  torso: [entry('973', 'Plain torso', 'Plain'), entry('973pbs', 'Classic printed torso', 'Printed')],
  hair: [entry('3901', 'Hair, male', 'Hair'), entry('3625', 'Hair, ponytail', 'Hair'), entry('3624', 'Police cap', 'Headwear'), entry('2446', 'Classic helmet', 'Headwear')],
  held: [entry('3847', 'Sword', 'Tools'), entry('3846', 'Shield', 'Tools'), entry('3962', 'Radio', 'Tools'), entry('3899', 'Cup', 'Tools')],
  back: [entry('4524', 'Cape', 'Capes'), entry('2524', 'Backpack', 'Packs')],
} as const;

const clone = (items: readonly MinifigLibraryEntry[]): MinifigLibraryEntry[] => items.map(item => ({ ...item }));
const repeatTo = (items: readonly MinifigLibraryEntry[], count: number): MinifigLibraryEntry[] => {
  const out = clone(items);
  // The curated base must be extended with real ids, never made to look larger
  // by duplicate selections.  This guards accidental tier claims in callers.
  if (count > out.length) throw new FigureCodeError(`The bundled creator catalogue has ${out.length} entries, not ${count}.`);
  return out.slice(0, count);
};

/**
 * A real, conservative minifig starter library.  Larger tiers are rejected
 * until their curated, measured part lists are supplied by the compiler/UI;
 * duplicating parts to meet a marketing count would create misleading forms.
 */
export function minifigCreatorLibrary(tier: 'starter'): MinifigLibrarySpec {
  return {
    tier,
    slots: {
      minifig: {
        head: repeatTo(core.head, 2), torso: repeatTo(core.torso, 2), hair: repeatTo(core.hair, 4),
        hips: [entry('3815', 'Hips', 'Core')], legs: [entry('3816', 'Classic leg pair', 'Core')],
        arms: [entry('3818', 'Classic arm pair', 'Core')], hands: [entry('3820', 'Hands', 'Core')],
        held_right: repeatTo(core.held, 4), held_left: repeatTo(core.held, 4), back: repeatTo(core.back, 2),
      },
      // No mini-doll geometry is emitted: canonical placement vectors are not
      // measured yet, and a creator must not guess a rig.
      minidoll: {},
    },
  };
}

/** True only for the one tier that is currently backed by an actual catalogue. */
export function isSupportedCreatorTier(tier: string): tier is 'starter' { return tier === 'starter'; }
