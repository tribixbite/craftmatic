/**
 * The minifig assembly pipeline: a LEGO figure as a JOINTED Bedrock entity.
 *
 * Every figure in a set is rebuilt on the canonical LDraw minifig rig instead
 * of being compiled as the loose pile of parts the source happens to carry:
 * converted sources drop parts (the IOModel2V2 museum has NO arms in any of its
 * nine figures, three have no legs, two no head), pose limbs at random, and
 * merge hips and legs into one mould. The rig
 *
 *   1. classifies each part of a torso group into a slot (head, headwear,
 *      torso, back accessory, arms, hands, hips, legs, held items) by the
 *      library description first and the id family second;
 *   2. re-places the body parts at the STANDARD minifig offsets (measured
 *      2026-09-16 from OMR 7140 and BrickLink Designer Program .io files:
 *      head 0,−24,0; hips 0,32,0; legs 0,44,0; arms ±15.552,9,0 turned 10°;
 *      hands ±23.86,26.6,−10.32 = the arm's turn then 45° about X), keeping
 *      headwear, back accessories and held items where the source put them
 *      relative to the head, torso or hand they belong to;
 *   3. synthesises the core parts a source lacks (3626c head, 3815 hips,
 *      3816/3817 legs, 3818/3819 arms, 3820 hands) in the colours the figure
 *      gives away, and splits a hips-and-legs composite into its three moulds
 *      so the legs can move;
 *   4. hands the entity compiler a bone tree with pivots at the joints so a
 *      walk animation swings the legs and arms and a look animation turns the
 *      head (`MINIFIG_ANIMATIONS`).
 *
 * The same assembler builds a figure from scratch (`minifigFromSpec`) for a
 * custom head / torso / legs / hair / held items / cape.
 *
 * Frame: the figure's torso-local LDraw frame (Y down, the figure faces −Z,
 * its RIGHT side is −X: `Minifig Arm Right` 3818 stands at x −15.552 and
 * `Minifig Leg Right` 3816 spans x −19.5..−1.5). Feet are at y 72, the head
 * top at −24: 96 LDU, the `LDU_PER_MINIFIG` the scale is built on.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';

export type MinifigSlot =
  | 'torso' | 'head' | 'headwear' | 'back'
  | 'arm_right' | 'arm_left' | 'hand_right' | 'hand_left'
  | 'hips' | 'hips_legs' | 'leg_right' | 'leg_left'
  | 'held' ;

/** A bone of the figure rig: name, parent and pivot in the figure frame (LDU). */
export interface RigBone { name: string; parent?: string; pivotLdu: Vec3 }

/** What the entity compiler needs to build a jointed entity from `bricks`. */
export interface EntityRig {
  bones: RigBone[];
  /** The bone each placement belongs to, parallel to the assembled `bricks`. */
  boneOf: string[];
}

export interface AssembledMinifig {
  /** Placements in the figure frame, canonical pose. */
  bricks: ParsedBrick[];
  rig: EntityRig;
  /** Core parts the source lacked and the rig supplied (`legs`, `arms`, …). */
  synthesized: string[];
  /** Parts of the group the rig could not place (reported, not shipped). */
  dropped: string[];
  /** The slot of each assembled placement, parallel to `bricks`. */
  slots: MinifigSlot[];
  /** Torso's −Z through the source placement, horizontal unit (x, z) in the SOURCE frame. */
  facingLdu: [number, number];
  /** The source torso's transform: what maps the figure frame back into the source. */
  torso: { position: Vec3; rotation: number[] };
}

type Mat3 = readonly number[];
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul = (a: Mat3, b: Mat3): number[] => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!));
const transpose = (m: Mat3): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const r3 = (v: number): number => { const r = Math.round(v * 1000) / 1000; return r === 0 ? 0 : r; };

const C10 = Math.cos(10 * Math.PI / 180), S10 = Math.sin(10 * Math.PI / 180);
const C45 = Math.SQRT1_2;
/** Rotation about +Z by 10° (the right arm's canonical turn) and its mirror. */
const ARM_RIGHT_ROT: Mat3 = [C10, -S10, 0, S10, C10, 0, 0, 0, 1];
const ARM_LEFT_ROT: Mat3 = [C10, S10, 0, -S10, C10, 0, 0, 0, 1];
/** A hand is the arm's turn followed by 45° about X (the wrist pin's tilt). */
const HAND_TILT: Mat3 = [1, 0, 0, 0, C45, -C45, 0, C45, C45];
const HAND_RIGHT_ROT: Mat3 = mul(ARM_RIGHT_ROT, HAND_TILT);
const HAND_LEFT_ROT: Mat3 = mul(ARM_LEFT_ROT, HAND_TILT);

/** The standard minifig, torso-local LDU. */
export const MINIFIG_CANON = {
  torso: { position: [0, 0, 0] as Vec3, rotation: IDENTITY },
  head: { position: [0, -24, 0] as Vec3, rotation: IDENTITY },
  hips: { position: [0, 32, 0] as Vec3, rotation: IDENTITY },
  leg_right: { position: [0, 44, 0] as Vec3, rotation: IDENTITY },
  leg_left: { position: [0, 44, 0] as Vec3, rotation: IDENTITY },
  arm_right: { position: [-15.552, 9, 0] as Vec3, rotation: ARM_RIGHT_ROT },
  arm_left: { position: [15.552, 9, 0] as Vec3, rotation: ARM_LEFT_ROT },
  hand_right: { position: [-23.86, 26.6, -10.32] as Vec3, rotation: HAND_RIGHT_ROT },
  hand_left: { position: [23.86, 26.6, -10.32] as Vec3, rotation: HAND_LEFT_ROT },
} as const;

/** Feet of a standing minifig, torso-local (the legs' 28 LDU below their 44 origin). */
export const MINIFIG_FEET_Y = 72;

/** The default moulds the rig supplies when a source lacks them. */
export const MINIFIG_DEFAULT_PARTS = {
  head: '3626c', torso: '973', hips: '3815', leg_right: '3816', leg_left: '3817',
  arm_right: '3818', arm_left: '3819', hand_right: '3820', hand_left: '3820',
} as const;
/** LDraw yellow: the classic skin. */
const DEFAULT_SKIN = 14;

/** The bones every minifig entity has; pivots at the joints (torso-local LDU). */
export const MINIFIG_BONES: readonly RigBone[] = [
  { name: 'body', pivotLdu: [0, 0, 0] },
  { name: 'head', parent: 'body', pivotLdu: [0, -24, 0] },
  { name: 'arm_right', parent: 'body', pivotLdu: [-15.552, 9, 0] },
  { name: 'arm_left', parent: 'body', pivotLdu: [15.552, 9, 0] },
  { name: 'hand_right', parent: 'arm_right', pivotLdu: [-23.86, 26.6, -10.32] },
  { name: 'hand_left', parent: 'arm_left', pivotLdu: [23.86, 26.6, -10.32] },
  { name: 'hips', parent: 'body', pivotLdu: [0, 32, 0] },
  { name: 'leg_right', parent: 'hips', pivotLdu: [0, 44, 0] },
  { name: 'leg_left', parent: 'hips', pivotLdu: [0, 44, 0] },
];

const SLOT_BONE: Record<MinifigSlot, string> = {
  torso: 'body', head: 'head', headwear: 'head', back: 'body',
  arm_right: 'arm_right', arm_left: 'arm_left', hand_right: 'hand_right', hand_left: 'hand_left',
  hips: 'hips', hips_legs: 'hips', leg_right: 'leg_right', leg_left: 'leg_left',
  held: 'body',
};

const cleanId = (part: string): string => part.replace(/^.*[\\/]/, '').replace(/\.dat$/i, '').toLowerCase();
/** `bl_973pb5574c01_torso` → `973pb5574c01`; a print suffix stays (it still names the mould family). */
const familyId = (part: string): string => cleanId(part).replace(/^bl_/, '').replace(/_(torso|head|legs|hips|arm|hand)$/, '');
const stripAlias = (description: string): string => description.replace(/^[~=_]+\s*/, '');

/**
 * LDraw retires a mould by leaving a one-line stub whose whole description is
 * `~Moved to <newid>`. Those stubs carry no geometry and no name, so neither an
 * id list nor a `^Minifig Arm` description test sees anything. That is not
 * academic: the `.io`-derived Natural History Museum places its arms as
 * `981`/`982` and its hands as `983`, and all seven of its figures compiled
 * ARMLESS with "the source lacked the figure's right arm, left arm" - `983`
 * happened to be in the hand id list, `981`/`982` were in no list at all.
 * Following the redirect fixes the whole family at once instead of growing the
 * lists one retired mould at a time.
 */
export function movedTo(description: string): string | null {
  const m = /^[~=_]*\s*Moved to\s+(\S+)/i.exec(description);
  return m ? m[1].replace(/\.dat$/i, '').toLowerCase() : null;
}

/** The id to classify by: a retired mould answers with the id it moved to. */
export const mouldFamilyId = (part: string, description: string): string =>
  movedTo(description) ?? familyId(part);

/**
 * Which slot a part of a torso group fills. The library description decides
 * (it names every minifig mould); ids cover the core body when a description
 * is missing (a custom-part torso, an unresolved mesh).
 */
export function classifyMinifigPart(part: string, description: string): MinifigSlot | null {
  const d = stripAlias(description);
  const id = mouldFamilyId(part, description);
  if (/^Minifig Torso\b/i.test(d) || /^(973|3814|76382)(?![0-9])/.test(id) || /_torso$/.test(cleanId(part))) return 'torso';
  if (/^Minifig Hips and Legs\b/i.test(d) || /^Minifig Legs\b/i.test(d) || /^(970c|3815c|41879|16968)/.test(id) || /_legs$/.test(cleanId(part))) return 'hips_legs';
  if (/^Minifig Hips\b/i.test(d) || /^(970|3815)(?![0-9])/.test(id) || /_hips$/.test(cleanId(part))) return 'hips';
  if (/^Minifig Leg Right\b/i.test(d) || /^3816(?![0-9])/.test(id)) return 'leg_right';
  if (/^Minifig Leg Left\b/i.test(d) || /^3817(?![0-9])/.test(id)) return 'leg_left';
  if (/^Minifig Arm Right\b/i.test(d) || /^3818(?![0-9])/.test(id)) return 'arm_right';
  if (/^Minifig Arm Left\b/i.test(d) || /^3819(?![0-9])/.test(id)) return 'arm_left';
  if (/^Minifig Hand\b/i.test(d) || /^(3820|983)(?![0-9])/.test(id)) return 'hand_right'; // side decided by position
  if (/^Minifig Head\b/i.test(d) || /^(3626|3625|3624)(?![0-9])/.test(id) || /_head$/.test(cleanId(part))) return 'head';
  if (/^Minifig (Hair|Hat|Helmet|Cap|Hood|Crown|Mask|Bandana|Beard|Visor|Headdress|Turban|Wig|Tiara)\b/i.test(d)) return 'headwear';
  if (/^(3901|3624|3833|2446|30370|4485|4498|2447|3878|30367|30369|59363|85975|93553|62810)(?![0-9])/.test(id)) return 'headwear';
  if (/^Minifig (Cape|Backpack|Airtank|Epaulette|Armou?r|Neckwear|Wings?|Skirt|Tail|Jetpack|Quiver|Scabbard)\b/i.test(d)) return 'back';
  if (/^(3838|2524|4524|50231|2526|30375)(?![0-9])/.test(id)) return 'back';
  if (/^Minifig\b/i.test(d) || d === '') return 'held';
  return 'held';
}

interface SourcePart { brick: ParsedBrick; slot: MinifigSlot; local: Vec3; rot: number[]; desc: string }

const placeAt = (part: string, color: number, position: Vec3, rotation: Mat3): ParsedBrick => ({
  part, color, x: r3(position[0]), y: r3(position[1]), z: r3(position[2]), rot: rotation.map(r3),
});

/**
 * Assemble the figure a torso group describes. `parts` are the group's
 * placements in the SOURCE frame (world LDraw); the torso must be among them.
 */
export function assembleMinifig(parts: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>): AssembledMinifig {
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const classified = parts.map(b => ({ brick: b, slot: classifyMinifigPart(b.part, desc(b)) }));
  const torsoEntry = classified.find(c => c.slot === 'torso');
  if (!torsoEntry) throw new Error('assembleMinifig: no torso in the group');
  const torso = torsoEntry.brick;
  const Rt: Mat3 = torso.rot ?? IDENTITY;
  const RtT = transpose(Rt);
  const toLocal = (b: ParsedBrick): Vec3 => apply(RtT, sub([b.x, b.y, b.z], [torso.x, torso.y, torso.z]));
  const localRot = (b: ParsedBrick): number[] => mul(RtT, b.rot ?? IDENTITY);
  const source: SourcePart[] = classified
    .filter(c => c.slot !== null)
    .map(c => ({ brick: c.brick, slot: c.slot!, local: toLocal(c.brick), rot: localRot(c.brick), desc: desc(c.brick) }));

  // Hands: the side is where the source put them (right = −X).
  for (const s of source) if (s.slot === 'hand_right' || s.slot === 'hand_left') s.slot = s.local[0] < 0 ? 'hand_right' : 'hand_left';
  // A second head is headwear on top of the first (a helmet described as a head, a mask).
  const heads = source.filter(s => s.slot === 'head');
  for (const extra of heads.slice(1)) extra.slot = 'headwear';

  const out: ParsedBrick[] = [];
  const slots: MinifigSlot[] = [];
  const boneOf: string[] = [];
  const synthesized: string[] = [];
  const dropped: string[] = [];
  const push = (brick: ParsedBrick, slot: MinifigSlot, bone = SLOT_BONE[slot]): void => { out.push(brick); slots.push(slot); boneOf.push(bone); };
  const first = (slot: MinifigSlot): SourcePart | undefined => source.find(s => s.slot === slot);

  // 1. Core body at the canonical offsets. Colours the figure gives away:
  //    limbs match the torso, hips and legs each other, hands and head each other.
  const torsoColor = torso.color;
  const hipsSrc = first('hips'), compositeSrc = first('hips_legs'), legR = first('leg_right'), legL = first('leg_left');
  const legColor = legR?.brick.color ?? legL?.brick.color ?? hipsSrc?.brick.color ?? compositeSrc?.brick.color ?? torsoColor;
  const hipsColor = hipsSrc?.brick.color ?? compositeSrc?.brick.color ?? legColor;
  const handSrc = first('hand_right') ?? first('hand_left');
  const headSrc = first('head');
  const skin = handSrc?.brick.color ?? headSrc?.brick.color ?? DEFAULT_SKIN;

  push(placeAt(torso.part, torsoColor, MINIFIG_CANON.torso.position, MINIFIG_CANON.torso.rotation), 'torso');
  if (headSrc) push(placeAt(headSrc.brick.part, headSrc.brick.color, MINIFIG_CANON.head.position, MINIFIG_CANON.head.rotation), 'head');
  else { synthesized.push('head'); push(placeAt(MINIFIG_DEFAULT_PARTS.head, skin, MINIFIG_CANON.head.position, MINIFIG_CANON.head.rotation), 'head'); }

  // Short legs and other one-piece leg moulds keep their mould (they cannot
  // swing); a hips-and-legs composite becomes three moulds so the legs can.
  if (compositeSrc && /^(41879|16968)(?![0-9])/.test(familyId(compositeSrc.brick.part)) || (compositeSrc && /^Minifig Legs\b/i.test(stripAlias(compositeSrc.desc)) && !/Hips and Legs/i.test(compositeSrc.desc))) {
    push(placeAt(compositeSrc!.brick.part, compositeSrc!.brick.color, MINIFIG_CANON.hips.position, MINIFIG_CANON.hips.rotation), 'hips_legs');
  } else {
    if (hipsSrc) push(placeAt(hipsSrc.brick.part, hipsSrc.brick.color, MINIFIG_CANON.hips.position, MINIFIG_CANON.hips.rotation), 'hips');
    else { if (!compositeSrc) synthesized.push('hips'); push(placeAt(MINIFIG_DEFAULT_PARTS.hips, hipsColor, MINIFIG_CANON.hips.position, MINIFIG_CANON.hips.rotation), 'hips'); }
    if (legR) push(placeAt(legR.brick.part, legR.brick.color, MINIFIG_CANON.leg_right.position, MINIFIG_CANON.leg_right.rotation), 'leg_right');
    else { if (!compositeSrc) synthesized.push('right leg'); push(placeAt(MINIFIG_DEFAULT_PARTS.leg_right, legColor, MINIFIG_CANON.leg_right.position, MINIFIG_CANON.leg_right.rotation), 'leg_right'); }
    if (legL) push(placeAt(legL.brick.part, legL.brick.color, MINIFIG_CANON.leg_left.position, MINIFIG_CANON.leg_left.rotation), 'leg_left');
    else { if (!compositeSrc) synthesized.push('left leg'); push(placeAt(MINIFIG_DEFAULT_PARTS.leg_left, legColor, MINIFIG_CANON.leg_left.position, MINIFIG_CANON.leg_left.rotation), 'leg_left'); }
  }
  // A torso "with Integral Arms" or wing arms has no arm sockets: no arms, no hands.
  const integralArms = /Integral Arms|Bird Wing Arms|Wing Arms/i.test(stripAlias(desc(torso)));
  for (const side of ['right', 'left'] as const) {
    const armSlot = `arm_${side}` as const, handSlot = `hand_${side}` as const;
    const arm = first(armSlot), hand = first(handSlot);
    if (integralArms && !arm) continue;
    if (arm) push(placeAt(arm.brick.part, arm.brick.color, MINIFIG_CANON[armSlot].position, MINIFIG_CANON[armSlot].rotation), armSlot);
    else { synthesized.push(`${side} arm`); push(placeAt(MINIFIG_DEFAULT_PARTS[armSlot], torsoColor, MINIFIG_CANON[armSlot].position, MINIFIG_CANON[armSlot].rotation), armSlot); }
    if (hand) push(placeAt(hand.brick.part, hand.brick.color, MINIFIG_CANON[handSlot].position, MINIFIG_CANON[handSlot].rotation), handSlot);
    else { synthesized.push(`${side} hand`); push(placeAt(MINIFIG_DEFAULT_PARTS[handSlot], skin, MINIFIG_CANON[handSlot].position, MINIFIG_CANON[handSlot].rotation), handSlot); }
  }

  // 2. Dressing keeps its source offset relative to the part it belongs to:
  //    headwear to the head, a cape or backpack to the torso, a held item to
  //    the hand nearest it (re-expressed in the canonical hand's frame, so a
  //    posed arm's item lands in the standing hand).
  const headLocal = headSrc ? headSrc.local : MINIFIG_CANON.head.position;
  const headRot: Mat3 = headSrc ? headSrc.rot : IDENTITY;
  const canonHand = (side: 'right' | 'left') => MINIFIG_CANON[`hand_${side}`];
  const sourceHand = (side: 'right' | 'left'): SourcePart | undefined => first(`hand_${side}`);
  for (const s of source) {
    if (s.slot === 'headwear') {
      // Relative to the source head (its own frame), then onto the canonical head.
      const rel = apply(transpose(headRot), sub(s.local, headLocal));
      const relRot = mul(transpose(headRot), s.rot);
      push(placeAt(s.brick.part, s.brick.color, add(MINIFIG_CANON.head.position, rel), relRot), 'headwear');
    } else if (s.slot === 'back') {
      push(placeAt(s.brick.part, s.brick.color, s.local, s.rot), 'back');
    } else if (s.slot === 'held') {
      // Nearest hand within reach: the source hand when the source has one, else the canonical hand.
      const candidates = (['right', 'left'] as const).map(side => {
        const src = sourceHand(side);
        const pos = src ? src.local : canonHand(side).position;
        return { side, src, d: Math.hypot(...sub(s.local, pos)) };
      }).sort((a, b) => a.d - b.d);
      const best = candidates[0]!;
      if (best.d <= 60) {
        const src = best.src;
        const handPos: Vec3 = src ? src.local : canonHand(best.side).position;
        const handRot: Mat3 = src ? src.rot : canonHand(best.side).rotation;
        const rel = apply(transpose(handRot), sub(s.local, handPos));
        const relRot = mul(transpose(handRot), s.rot);
        const canon = canonHand(best.side);
        push(placeAt(s.brick.part, s.brick.color, add(canon.position, apply(canon.rotation, rel)), mul(canon.rotation, relRot)), 'held', `hand_${best.side}`);
      } else if (Math.hypot(s.local[0], s.local[2]) <= 30 && s.local[1] < -12) {
        // Over the head and not in a hand: a hat the description did not name.
        push(placeAt(s.brick.part, s.brick.color, s.local, s.rot), 'headwear');
      } else {
        // Worn or carried against the body: rides with the torso.
        push(placeAt(s.brick.part, s.brick.color, s.local, s.rot), 'back');
      }
    }
  }
  const torsoDesc = stripAlias(desc(torso));
  void torsoDesc;
  for (const c of classified) if (c.slot === null) dropped.push(c.brick.part);

  const f = apply(Rt, [0, 0, -1]);
  const h = Math.hypot(f[0], f[2]);
  const facingLdu: [number, number] = h > 0.5 ? [f[0] / h, f[2] / h] : [0, -1];
  return {
    bricks: out, slots, synthesized, dropped, facingLdu,
    rig: { bones: [...MINIFIG_BONES], boneOf },
    torso: { position: [torso.x, torso.y, torso.z], rotation: [...Rt] },
  };
}

/** A figure built from chosen parts: what a custom-minifig UI or CLI supplies. */
export interface MinifigSpec {
  torso: { part: string; color: number };
  head?: { part: string; color: number };
  hair?: { part: string; color: number; /** Offset from the head origin, LDU (default none). */ offset?: Vec3 };
  hips?: { part?: string; color: number };
  legs?: { right?: string; left?: string; color: number };
  arms?: { color?: number; right?: string; left?: string };
  hands?: { color?: number; part?: string };
  /** Held items: placed at the hand's grip (the canonical hand origin) unless `offset`/`rotation` say otherwise. */
  heldRight?: { part: string; color: number; offset?: Vec3; rotation?: number[] };
  heldLeft?: { part: string; color: number; offset?: Vec3; rotation?: number[] };
  /** A cape (4524 by default) hangs from the neck. */
  cape?: { part?: string; color: number };
  /** Anything else worn on the torso (backpack, airtanks, epaulettes), torso-local offset. */
  back?: Array<{ part: string; color: number; offset?: Vec3; rotation?: number[] }>;
}

/** The canonical cape mould and where it hangs (the neck, torso-local). */
export const MINIFIG_CAPE = { part: '4524', position: [0, 0, 0] as Vec3 };

/** Build a figure from a spec, in the figure frame, on the rig. */
export function minifigFromSpec(spec: MinifigSpec): AssembledMinifig {
  const skin = spec.hands?.color ?? spec.head?.color ?? DEFAULT_SKIN;
  const legColor = spec.legs?.color ?? spec.hips?.color ?? spec.torso.color;
  const hipsColor = spec.hips?.color ?? legColor;
  const armColor = spec.arms?.color ?? spec.torso.color;
  const out: ParsedBrick[] = [];
  const slots: MinifigSlot[] = [];
  const boneOf: string[] = [];
  const push = (brick: ParsedBrick, slot: MinifigSlot, bone = SLOT_BONE[slot]): void => { out.push(brick); slots.push(slot); boneOf.push(bone); };
  push(placeAt(spec.torso.part, spec.torso.color, MINIFIG_CANON.torso.position, MINIFIG_CANON.torso.rotation), 'torso');
  push(placeAt(spec.head?.part ?? MINIFIG_DEFAULT_PARTS.head, spec.head?.color ?? skin, MINIFIG_CANON.head.position, MINIFIG_CANON.head.rotation), 'head');
  if (spec.hair) push(placeAt(spec.hair.part, spec.hair.color, add(MINIFIG_CANON.head.position, spec.hair.offset ?? [0, 0, 0]), IDENTITY), 'headwear');
  push(placeAt(spec.hips?.part ?? MINIFIG_DEFAULT_PARTS.hips, hipsColor, MINIFIG_CANON.hips.position, MINIFIG_CANON.hips.rotation), 'hips');
  push(placeAt(spec.legs?.right ?? MINIFIG_DEFAULT_PARTS.leg_right, legColor, MINIFIG_CANON.leg_right.position, MINIFIG_CANON.leg_right.rotation), 'leg_right');
  push(placeAt(spec.legs?.left ?? MINIFIG_DEFAULT_PARTS.leg_left, legColor, MINIFIG_CANON.leg_left.position, MINIFIG_CANON.leg_left.rotation), 'leg_left');
  push(placeAt(spec.arms?.right ?? MINIFIG_DEFAULT_PARTS.arm_right, armColor, MINIFIG_CANON.arm_right.position, MINIFIG_CANON.arm_right.rotation), 'arm_right');
  push(placeAt(spec.arms?.left ?? MINIFIG_DEFAULT_PARTS.arm_left, armColor, MINIFIG_CANON.arm_left.position, MINIFIG_CANON.arm_left.rotation), 'arm_left');
  push(placeAt(spec.hands?.part ?? MINIFIG_DEFAULT_PARTS.hand_right, skin, MINIFIG_CANON.hand_right.position, MINIFIG_CANON.hand_right.rotation), 'hand_right');
  push(placeAt(spec.hands?.part ?? MINIFIG_DEFAULT_PARTS.hand_left, skin, MINIFIG_CANON.hand_left.position, MINIFIG_CANON.hand_left.rotation), 'hand_left');
  for (const [side, item] of [['right', spec.heldRight], ['left', spec.heldLeft]] as const) {
    if (!item) continue;
    const hand = MINIFIG_CANON[`hand_${side}`];
    const rel = item.offset ?? [0, 0, 0];
    const relRot: Mat3 = item.rotation ?? IDENTITY;
    push(placeAt(item.part, item.color, add(hand.position, apply(hand.rotation, rel)), mul(hand.rotation, relRot)), 'held', `hand_${side}`);
  }
  if (spec.cape) push(placeAt(spec.cape.part ?? MINIFIG_CAPE.part, spec.cape.color, MINIFIG_CAPE.position, IDENTITY), 'back');
  for (const b of spec.back ?? []) push(placeAt(b.part, b.color, b.offset ?? [0, 0, 0], b.rotation ?? IDENTITY), 'back');
  return {
    bricks: out, slots, synthesized: [], dropped: [], facingLdu: [0, -1],
    rig: { bones: [...MINIFIG_BONES], boneOf },
    torso: { position: [0, 0, 0], rotation: [...IDENTITY] },
  };
}

/**
 * The animations every minifig entity plays. Bone rotations are relative to
 * the bind pose the compiler emitted (pivots at the joints):
 *  - walk: legs swing ±32° and arms ±25° in opposite phase, driven by the
 *    distance travelled so the feet never slide, and only while the entity
 *    moves (`query.is_moving`);
 *  - look: the head follows the look target (vanilla's look_at_target);
 *  - sit: legs forward while riding a seat.
 */
export const MINIFIG_ANIMATION_IDS = {
  walk: 'animation.craftmatic.minifig.walk',
  look: 'animation.craftmatic.minifig.look',
  sit: 'animation.craftmatic.minifig.sit',
} as const;

export const MINIFIG_ANIMATIONS = {
  format_version: '1.8.0',
  animations: {
    [MINIFIG_ANIMATION_IDS.walk]: {
      loop: true,
      bones: {
        leg_right: { rotation: ['math.cos(query.modified_distance_moved * 38.17) * 32 * query.is_moving', 0, 0] },
        leg_left: { rotation: ['-math.cos(query.modified_distance_moved * 38.17) * 32 * query.is_moving', 0, 0] },
        arm_right: { rotation: ['-math.cos(query.modified_distance_moved * 38.17) * 25 * query.is_moving', 0, 0] },
        arm_left: { rotation: ['math.cos(query.modified_distance_moved * 38.17) * 25 * query.is_moving', 0, 0] },
      },
    },
    [MINIFIG_ANIMATION_IDS.look]: {
      loop: true,
      bones: {
        head: { relative_to: { rotation: 'entity' }, rotation: ['query.target_x_rotation', 'query.target_y_rotation', 0] },
      },
    },
    [MINIFIG_ANIMATION_IDS.sit]: {
      loop: true,
      bones: {
        leg_right: { rotation: [-90, 0, 0] },
        leg_left: { rotation: [-90, 0, 0] },
      },
    },
  },
} as const;

/** The client entity's `animations` map and `scripts.animate` list for a minifig. */
export const MINIFIG_CLIENT_ANIMATIONS = {
  animations: { walk: MINIFIG_ANIMATION_IDS.walk, look: MINIFIG_ANIMATION_IDS.look, sit: MINIFIG_ANIMATION_IDS.sit },
  animate: [{ walk: '!query.is_riding' }, { sit: 'query.is_riding' }, 'look'] as Array<string | Record<string, string>>,
};
