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
  type MinifigLibrarySpec, type CreatorPose, POSE_PROPERTY,
} from './minifig-creator-types.js';
import COLOUR_NAMES from '../../public/ldraw-color-names.json' with { type: 'json' };

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

/**
 * The poses the wand offers, in `craftmatic:pose` index order (index 0 is the
 * rig's own standing/walking look and adds nothing). Limb rotations are
 * x-only: the rig's `sit` animation proves -90 swings a leg forward, and an
 * arm hangs from its shoulder pivot the same way (-90 points it ahead, -170
 * holds it up). `Sitting` bends both legs forward and lowers the whole figure
 * by the hip height minus half the leg depth, so the bent legs rest on the
 * ground: hips pivot 44 LDU below the torso top and feet 72, the leg mould is
 * 20 LDU deep about its hinge, so 72 - 44 - 10 = 18 LDU.
 */
export const CREATOR_POSES: readonly CreatorPose[] = [
  { name: 'Standing', bones: {} },
  { name: 'Waving', bones: { arm_right: { rotation: ['-155 + math.sin(query.life_time * 360) * 15', 0, 0] } } },
  { name: 'Pointing', bones: { arm_right: { rotation: [-90, 0, 0] } } },
  { name: 'Arms up', bones: { arm_right: { rotation: [-170, 0, 0] }, arm_left: { rotation: [-170, 0, 0] } } },
  { name: 'Holding out', bones: { arm_right: { rotation: [-60, 0, 0] }, arm_left: { rotation: [-60, 0, 0] } } },
  { name: 'Sitting', still: true, bones: { leg_right: { rotation: [-90, 0, 0] }, leg_left: { rotation: [-90, 0, 0] }, body: { positionLdu: [0, -18, 0] } } },
];

/** The LDraw name of a colour (`web/public/ldraw-color-names.json`), or `Colour <id>` when it has none. */
export function ldrawColourName(id: number): string {
  return (COLOUR_NAMES as Record<string, string>)[String(id)] ?? `Colour ${id}`;
}

/** The client-side pose layer for a creator entity (`CREATOR_POSES`), for `scripts.animate` and the RP animation file. */
export interface CreatorPoseAnimations {
  /** `scripts`-level short names to animation ids. */
  animations: Record<string, string>;
  /** `scripts.animate` entries, each gated on `craftmatic:pose`. */
  animate: Array<Record<string, string>>;
  /** The `animations/<id>_minifig_pose.animation.json` document. */
  file: { format_version: string; animations: Record<string, unknown> };
}

/**
 * Emit one looping animation per non-trivial pose, gated on the pose property.
 * A still pose (sitting) is also gated off while the figure rides a seat: the
 * rig's own `sit` already bends the legs there, and both together fold them
 * 180 degrees. `positionLdu` is a Bedrock-frame (y up) offset in LDU, turned
 * into geometry units with the pack's figure scale.
 */
export function creatorPoseAnimations(id: string, unitsPerLdu: number): CreatorPoseAnimations {
  const animations: Record<string, string> = {};
  const animate: Array<Record<string, string>> = [];
  const file: CreatorPoseAnimations['file'] = { format_version: '1.8.0', animations: {} };
  const round = (v: number): number => Math.round(v * 1e4) / 1e4;
  CREATOR_POSES.forEach((pose, k) => {
    if (!Object.keys(pose.bones).length) return;
    const key = `mf_pose_${k}`;
    const animationId = `animation.craftmatic.${id}_mf_pose_${k}`;
    animations[key] = animationId;
    animate.push({ [key]: `q.property('${POSE_PROPERTY}') == ${k}${pose.still ? ' && !query.is_riding' : ''}` });
    const bones: Record<string, unknown> = {};
    for (const [bone, b] of Object.entries(pose.bones)) {
      bones[bone] = {
        ...(b.rotation ? { rotation: b.rotation } : {}),
        ...(b.positionLdu ? { position: b.positionLdu.map(v => round(v * unitsPerLdu)) } : {}),
      };
    }
    file.animations[animationId] = { loop: true, bones };
  });
  return { animations, animate, file };
}
