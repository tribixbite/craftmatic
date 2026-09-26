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
import { partStem } from './part-id.js';

export type MinifigSlot =
  | 'torso' | 'head' | 'headwear' | 'back'
  | 'arm_right' | 'arm_left' | 'hand_right' | 'hand_left'
  | 'hips' | 'hips_legs' | 'legs' | 'leg_right' | 'leg_left'
  | 'held' ;

/**
 * The three LEGO figure skeletons the rig knows. Each has its own joint
 * offsets, and a part of one system never belongs on another's rig:
 *  - `minifig`: the classic 96 LDU figure (head 24 above the torso, arms at
 *    ±15.552, hips 32, legs 44);
 *  - `minidoll`: LEGO Friends (head 33.2, arms ±11, hips 29.4, one-piece legs
 *    47.4 below the hips) — measured on the library's own composites
 *    (`92456` = torso + arms at ±11) and the parts' `!HELP` origin notes
 *    (`92248` "Torso position: Y=-29.4, Z=1.2", `92251`/`16529` "Hips
 *    Rotation point: Y=-47.4, Z=2.7");
 *  - `bigfig`: Hagrid / Hulk class — one body mould with the legs, two
 *    "Arm Large with Pin" arms on the torso's shoulder pins (`37777` places
 *    its `peghole` primitives at ±20, 9.5, 0) and a hair-with-beard piece
 *    that IS the head, on the neck stud 24 above the torso origin.
 */
export type FigureSystem = 'minifig' | 'minidoll' | 'bigfig';

/** A bone of the figure rig: name, parent and pivot in the figure frame (LDU). */
export interface RigBone {
  name: string;
  parent?: string;
  pivotLdu: Vec3;
  /**
   * A static rotation of the bone about its pivot, row-major 3x3 in the LDraw
   * frame (the frame `pivotLdu` is in). The compiler converts it to the render
   * frame exactly as it does a rotated part's bone. A pinball flipper uses two
   * of these to turn its spin axis onto the tilted playfield's normal.
   */
  rotation?: number[];
}

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
  /**
   * Parts this rig has no slot for, kept where the source put them rather than
   * dressed onto a slot they do not belong in — today, mini-doll parts caught
   * in a minifig's group.
   */
  bystanders: string[];
  /** The slot of each assembled placement, parallel to `bricks`. */
  slots: MinifigSlot[];
  /** Torso's −Z through the source placement, horizontal unit (x, z) in the SOURCE frame. */
  facingLdu: [number, number];
  /**
   * The figure frame's transform into the source: the torso's rotation, and
   * its position AFTER any re-anchoring (`reanchoredLdu`), so it is where the
   * assembled figure actually stands, not where a mis-converted torso sat.
   */
  torso: { position: Vec3; rotation: number[] };
  /** Which skeleton the figure was assembled on. */
  system: FigureSystem;
  /**
   * Set when the torso disagreed with the rest of the body: the offset (torso
   * frame, LDU) by which the frame was moved to the limbs' consensus. 76417's
   * `37777` big-fig torso has no LDD→LDraw alignment row, so the converter
   * left it at its raw LDD origin, 10 / −70.5 LDU from where its own arms and
   * hair say the shoulders are; anchoring on that torso put Hagrid's body in
   * the ground and his hair and arms in the air (Pixel 8 Pro, 2026-09-24).
   */
  reanchoredLdu?: Vec3;
  /**
   * Feet level of the ASSEMBLED figure, figure-frame LDU (the lowest point of
   * its body moulds): `MINIFIG_FEET_Y` for a standard minifig, the short-leg
   * mould's own bottom for a child, the body mould's for a big-fig.
   */
  feetY: number;
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
/** The eight corners of an axis-aligned box. */
const cornersOf = (lo: Vec3, hi: Vec3): Vec3[] => [
  [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]],
  [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]],
];
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

/** A slot's canonical placement in a figure system's torso frame. */
interface CanonPose { position: Vec3; rotation: Mat3 }
type SystemCanon = Partial<Record<MinifigSlot, CanonPose>>;

/**
 * The mini-doll skeleton, torso-local LDU. Head 33.2 above the torso; arms
 * on the shoulder pins at ±11 (`92456` = `92241` + `92244` at +11 + `92245`
 * at −11); hips 29.4 below and 1.2 forward (`92248`'s `!HELP`); the one-piece
 * legs 47.4 below the hips and 2.7 further forward (`92251`, `16529`); a
 * held item sits at ∓25.9, 29.7, −4 — where 42703's two dolls hold their
 * microphones (both at exactly that offset). Dolls have no hand mould: the
 * hand slots exist so a held item has a bone, on the arm.
 */
export const MINIDOLL_CANON: SystemCanon = {
  torso: { position: [0, 0, 0], rotation: IDENTITY },
  head: { position: [0, -33.2, 0], rotation: IDENTITY },
  arm_right: { position: [-11, 0, 0], rotation: IDENTITY },
  arm_left: { position: [11, 0, 0], rotation: IDENTITY },
  hand_right: { position: [-25.9, 29.7, -4], rotation: IDENTITY },
  hand_left: { position: [25.9, 29.7, -4], rotation: IDENTITY },
  hips: { position: [0, 29.4, -1.2], rotation: IDENTITY },
  hips_legs: { position: [0, 29.4, -1.2], rotation: IDENTITY },
  legs: { position: [0, 76.8, -3.9], rotation: IDENTITY },
};

/**
 * The big-fig skeleton, torso-local LDU: the body mould carries the legs, the
 * arms pin to the shoulders at ±20, 9.5, 0 (`37777`'s `peghole` primitives),
 * and the hair-with-beard piece sits on the neck stud at −24 exactly like a
 * minifig head — 76417's Hagrid places `37784` 24.0 LDU above the shoulder
 * line its arms define. A held item hangs off the arm's end.
 * # TODO: measure the older Hulk-class body (`10128`, arms `10124`/`10154`,
 * separate hands `10126`/`10127`); no corpus set with one has been checked.
 */
export const BIGFIG_CANON: SystemCanon = {
  torso: { position: [0, 0, 0], rotation: IDENTITY },
  head: { position: [0, -24, 0], rotation: IDENTITY },
  arm_right: { position: [-20, 9.5, 0], rotation: IDENTITY },
  arm_left: { position: [20, 9.5, 0], rotation: IDENTITY },
  // The arms end in ordinary minifig hands: 76417's Hagrid holds his at
  // ∓36.5, 33.9, 3.3 from the shoulder line.
  hand_right: { position: [-36.5, 33.9, 3.3], rotation: IDENTITY },
  hand_left: { position: [36.5, 33.9, 3.3], rotation: IDENTITY },
  // Under the coat: ordinary minifig legs (Hagrid wears short legs 41879 in
  // dark brown, 64 LDU below the torso origin - 88 to the feet; the coat's
  // own bottom is at 71). Hips-and-legs at 64; separate hips/legs keep the
  // minifig's 12 LDU hips-to-legs step.
  hips_legs: { position: [0, 64, 0], rotation: IDENTITY },
  hips: { position: [0, 64, 0], rotation: IDENTITY },
  leg_right: { position: [0, 76, 0], rotation: IDENTITY },
  leg_left: { position: [0, 76, 0], rotation: IDENTITY },
};

const SYSTEM_CANON: Record<FigureSystem, SystemCanon> = {
  minifig: MINIFIG_CANON as SystemCanon,
  minidoll: MINIDOLL_CANON,
  bigfig: BIGFIG_CANON,
};

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

/**
 * The mini-doll's bones: the minifig's names for what the two share (walk
 * swings `arm_*`, look turns `head`), with pivots at the doll's joints, and
 * one `legs` bone for the one-piece legs mould (`92251`, `16529`), hinged
 * where the real doll's legs hinge on its hips: the moulds' `!HELP` "Hips
 * Rotation point: Y=-47.4, Z=2.7" from the legs origin (76.8, -3.9 below the
 * torso) is 29.4 / -1.2, the hips joint itself. The doll's own animations
 * (`MINIDOLL_CLIENT_ANIMATIONS`) bend it there to sit and rock it as one
 * piece to walk; a one-piece HIPS-and-legs mould has no hinge and stays on
 * `hips`.
 */
export const MINIDOLL_BONES: readonly RigBone[] = [
  { name: 'body', pivotLdu: [0, 0, 0] },
  { name: 'head', parent: 'body', pivotLdu: [0, -33.2, 0] },
  { name: 'arm_right', parent: 'body', pivotLdu: [-11, 0, 0] },
  { name: 'arm_left', parent: 'body', pivotLdu: [11, 0, 0] },
  { name: 'hand_right', parent: 'arm_right', pivotLdu: [-25.9, 29.7, -4] },
  { name: 'hand_left', parent: 'arm_left', pivotLdu: [25.9, 29.7, -4] },
  { name: 'hips', parent: 'body', pivotLdu: [0, 29.4, -1.2] },
  { name: 'legs', parent: 'hips', pivotLdu: [0, 29.4, -1.2] },
];

/** The big-fig's bones: body, the head on the neck, two pinned arms with hands, the legs under the coat. */
export const BIGFIG_BONES: readonly RigBone[] = [
  { name: 'body', pivotLdu: [0, 0, 0] },
  { name: 'head', parent: 'body', pivotLdu: [0, -24, 0] },
  { name: 'arm_right', parent: 'body', pivotLdu: [-20, 9.5, 0] },
  { name: 'arm_left', parent: 'body', pivotLdu: [20, 9.5, 0] },
  { name: 'hand_right', parent: 'arm_right', pivotLdu: [-36.5, 33.9, 3.3] },
  { name: 'hand_left', parent: 'arm_left', pivotLdu: [36.5, 33.9, 3.3] },
  { name: 'hips', parent: 'body', pivotLdu: [0, 64, 0] },
  { name: 'leg_right', parent: 'hips', pivotLdu: [0, 76, 0] },
  { name: 'leg_left', parent: 'hips', pivotLdu: [0, 76, 0] },
];

const SYSTEM_BONES: Record<FigureSystem, readonly RigBone[]> = { minifig: MINIFIG_BONES, minidoll: MINIDOLL_BONES, bigfig: BIGFIG_BONES };

const SLOT_BONE: Record<MinifigSlot, string> = {
  torso: 'body', head: 'head', headwear: 'head', back: 'body',
  arm_right: 'arm_right', arm_left: 'arm_left', hand_right: 'hand_right', hand_left: 'hand_left',
  hips: 'hips', hips_legs: 'hips', legs: 'hips', leg_right: 'leg_right', leg_left: 'leg_left',
  held: 'body',
};
/** Where a system's skeleton differs from `SLOT_BONE`: the doll's one-piece legs hinge on their own bone. */
const SYSTEM_SLOT_BONE: Record<FigureSystem, Partial<Record<MinifigSlot, string>>> = { minifig: {}, minidoll: { legs: 'legs' }, bigfig: {} };

/** The slots that stand on the floor: their lowest point is where the figure's feet are. */
const FLOOR_SLOTS: ReadonlySet<MinifigSlot> = new Set<MinifigSlot>(['torso', 'hips', 'hips_legs', 'legs', 'leg_right', 'leg_left']);

/**
 * Slots whose canonical placement is EXACT for the system, so a source part in
 * that slot votes on where the figure frame is (see the re-anchoring in
 * `assembleMinifig`). Hands, held items and headwear are posed or offset by
 * design and do not vote.
 */
const ANCHOR_SLOTS: ReadonlySet<MinifigSlot> = new Set<MinifigSlot>(['torso', 'head', 'arm_right', 'arm_left', 'hips', 'hips_legs', 'legs', 'leg_right', 'leg_left']);
/** Two parts agree on the frame origin when their implied origins are this close (LDU). */
const ANCHOR_AGREE_LDU = 4;

const cleanId = (part: string): string => partStem(part);
/** `bl_973pb5574c01_torso` → `973pb5574c01`; a print suffix stays (it still names the mould family). */
const familyId = (part: string): string => cleanId(part).replace(/^bl_/, '').replace(/_(torso|head|legs|hips|arm|hand)$/, '');
/**
 * A description with its alias marks stripped and BrickLink's naming folded
 * onto LDraw's. A Studio-private part (an `.io` embedded definition the
 * library lacks) is described the BrickLink way - `Minifigure, Hair Swept
 * Back Tousled`, `Minifigure, Headgear Hat …` - which `^Minifig\b` never
 * matches (`Minifigure` carries on past the word boundary). 10303's top
 * drop-track rider lost her hair 43753 to the building shell that way
 * (Pixel 8 Pro, 2026-09-21).
 */
export const normaliseFigureDescription = (description: string): string =>
  description.replace(/^[~=_]+\s*/, '').replace(/^Minifigure,\s*/i, 'Minifig ');
const stripAlias = normaliseFigureDescription;

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
  // Big-fig moulds fill minifig slots (they are re-placed on the BIGFIG canon).
  if (isBigFigTorsoDescription(d)) return 'torso';
  if (/^(Arm Large\b.*\bRight\b|Bigfig Arm Right\b)/i.test(d)) return 'arm_right';
  if (/^(Arm Large\b.*\bLeft\b|Bigfig Arm Left\b)/i.test(d)) return 'arm_left';
  if (/^Bigfig Hand\b/i.test(d)) return 'hand_right'; // side decided by position
  if (/^Minifig Torso\b/i.test(d) || /^(973|3814|76382)(?![0-9])/.test(id) || /_torso$/.test(cleanId(part))) return 'torso';
  if (/^Minifig Hips and Legs\b/i.test(d) || /^Minifig Legs\b/i.test(d) || /^(970c|3815c|41879|16968)/.test(id) || /_legs$/.test(cleanId(part))) return 'hips_legs';
  if (/^Minifig Hips\b/i.test(d) || /^(970|3815)(?![0-9])/.test(id) || /_hips$/.test(cleanId(part))) return 'hips';
  if (/^Minifig Leg Right\b/i.test(d) || /^3816(?![0-9])/.test(id)) return 'leg_right';
  if (/^Minifig Leg Left\b/i.test(d) || /^3817(?![0-9])/.test(id)) return 'leg_left';
  if (/^Minifig Arm Right\b/i.test(d) || /^3818(?![0-9])/.test(id)) return 'arm_right';
  if (/^Minifig Arm Left\b/i.test(d) || /^3819(?![0-9])/.test(id)) return 'arm_left';
  if (/^Minifig Hand\b/i.test(d) || /^(3820|983)(?![0-9])/.test(id)) return 'hand_right'; // side decided by position
  if (/^Minifig Head\b/i.test(d) || /^(3626|3625|3624)(?![0-9])/.test(id) || /_head$/.test(cleanId(part))) return 'head';
  // `Headgear` is BrickLink's word (`Minifigure, Headgear Hat …`), folded in by `normaliseFigureDescription`.
  if (/^Minifig (Hair|Hat|Headgear|Helmet|Cap|Hood|Crown|Mask|Bandana|Beard|Visor|Headdress|Turban|Wig|Tiara)\b/i.test(d)) return 'headwear';
  // BrickLink's generic hair name (`MINI WIG NO. 13`, `MINI WIG, NO. 366`) is a
  // minifig's hair on a minifig and a doll's on a doll (`classifyMiniDollPart`).
  if (/^Mini ?Wig\b/i.test(d)) return 'headwear';
  if (/^(3901|3624|3833|2446|30370|4485|4498|2447|3878|30367|30369|59363|85975|93553|62810)(?![0-9])/.test(id)) return 'headwear';
  if (/^Minifig (Cape|Backpack|Airtank|Epaulette|Armou?r|Neckwear|Wings?|Skirt|Tail|Jetpack|Quiver|Scabbard)\b/i.test(d)) return 'back';
  if (/^(3838|2524|4524|50231|2526|30375)(?![0-9])/.test(id)) return 'back';
  // A MINI-DOLL part is not a minifig part and must not be dressed onto a
  // minifig rig. Without this it fell through to `held`, so a doll standing
  // beside a minifig had its head, arms and hips teleported into the minifig's
  // fists — the doll skeleton shares nothing with this one (head 33.20 LDU
  // against 24, arm 11.00 against 18, hips 29.42 against 32), so there is no
  // slot here that could hold it. `null` means "this rig has no opinion", and
  // `assembleMinifig` leaves such a part exactly where the source put it.
  if (classifyMiniDollPart(part, description) !== null) return null;
  if (/^Minifig\b/i.test(d) || d === '') return 'held';
  return 'held';
}

/**
 * The mini-doll (LEGO Friends) slots. A DIFFERENT skeleton from the minifig:
 * head 33.20 LDU from the torso, arms 11.00, hips 29.42, hips->legs 47.48 —
 * nothing in common with the minifig's 24 / 18 / 32, so anything that assumes
 * minifig numbers for a doll is wrong by construction.
 *
 * `classifyMinifigPart` is deliberately NOT extended to return these: it feeds
 * the minifig assembler, which would then re-place a doll on the minifig rig.
 * The two classifiers share this module's helpers (`stripAlias`, `cleanId`,
 * `movedTo`) and the same rule — the LIBRARY DESCRIPTION names the mould, the
 * id is only a fallback — so there is one family convention, not two.
 */
export type MiniDollSlot =
  | 'doll_head' | 'doll_torso' | 'doll_torso_arms' | 'doll_body' | 'doll_hips_legs'
  | 'doll_hips' | 'doll_leg' | 'doll_arm' | 'doll_hair';

/**
 * Mini-doll families by LDraw description, in order (the first match wins).
 * LDraw names the whole system `Figure Friends …`; a handful of newer moulds
 * use `Mini Doll, …`. Mirrors clego's `geograde/part_family.py` so the two
 * pipelines classify a mould identically — with ONE deliberate difference,
 * `doll_hair`: clego admits `Figure Friends Hair Decoration …` and
 * `… Hair Dryer` into the hair family, and this does not. A decoration is a
 * separate mould pinned INTO the hair, not the hair: measured over the library
 * composites that place both, the decoration sits 11.65 LDU above the hair,
 * while LDD places it at the hair's own height (median 0.0 over the LXFML
 * corpus, n=9) — so it has its own, unmeasured origin difference and must not
 * inherit the hair's 2.29 LDU one.
 */
const MINIDOLL_PATTERNS: ReadonlyArray<readonly [MiniDollSlot, RegExp]> = [
  ['doll_head', /^(Figure Friends (Female |Male |Boy |Girl |Baby )?Head\b|Mini ?Doll,? Head\b)/i],
  // A torso that CARRIES ITS ARMS is a different mould with a different origin
  // — `92456p03` sits 12.8 LDU below the plain `92241p03` it is the composite
  // of — and 131 of the library's 233 doll torsos are one. It gets its own slot
  // and no correction: LDD emits the plain torso plus two arms, never the
  // composite, so there is no LDD side to measure a correction against.
  ['doll_torso_arms', /^Figure Friends (Girl|Boy|Woman|Man|Baby)\b[^,]*\bTorso with Arms\b/i],
  ['doll_torso', /^Figure Friends (Girl|Boy|Woman|Man|Baby)\b[^,]*\bTorso\b/i],
  ['doll_body', /^(Figure Friends Baby Body\b|Figure Micro Doll Body\b)/i],
  ['doll_hips_legs', /^(Figure Friends Hips and Legs?\b|Mini ?Doll Hips and (Skirt|Legs?)\b)/i],
  ['doll_hips', /^Figure Friends Hips\b/i],
  ['doll_leg', /^Figure Friends Legs?\b/i],
  ['doll_arm', /^Figure Friends ((Female|Male) )?(Left|Right) Arm\b/i],
  // BrickLink's own copies (`bl_2645.dat`) name a doll's hair `MINI WIG, NO. 366`:
  // unnamed here it was `held` and rode in the doll's hand (41732, 42703).
  ['doll_hair', /^(Figure Friends Hair\b(?! ?(Brush|Comb|Dryer|Decoration))|Mini ?(Doll,? )?(Hair|Wig)\b)/i],
];

/**
 * Which mini-doll slot a part fills, by its LDraw description, or null.
 *
 * A `~Moved to <id>` stub carries no name of its own, so it classifies as
 * nothing here — the caller resolves the redirect first (`mouldFamilyId` for
 * the id, the library for the target's description). `part` is accepted for
 * symmetry with `classifyMinifigPart` and to keep the redirect visible at the
 * call site; the decision is the description's alone, because a doll mould id
 * carries no family pattern (`1006030`, `92244`, `59595` share nothing).
 */
export function classifyMiniDollPart(part: string, description: string): MiniDollSlot | null {
  void part;
  const d = stripAlias(description);
  if (movedTo(description) !== null) return null;
  for (const [slot, re] of MINIDOLL_PATTERNS) if (re.test(d)) return slot;
  return null;
}

/**
 * A big-fig body: LDraw's `Bigfig … Body` (Hulk class) or Studio's `Torso
 * Large, …` (Hagrid class). Both carry the legs; neither has a separate head.
 */
const isBigFigTorsoDescription = (stripped: string): boolean =>
  /^(Torso Large\b|Bigfig\b.*\bBody\b|Bigfig Figure\b)/i.test(stripped);

/**
 * Which figure system a TORSO belongs to, or null when the part is not a
 * torso of any system. The anchor of every figure group: `groupFigures` looks
 * for these, and the answer picks the canon the group is assembled on.
 */
export function figureSystemOfTorso(part: string, description: string): FigureSystem | null {
  const d = stripAlias(description);
  if (isBigFigTorsoDescription(d)) return 'bigfig';
  const doll = classifyMiniDollPart(part, description);
  if (doll === 'doll_torso' || doll === 'doll_torso_arms' || doll === 'doll_body') return 'minidoll';
  if (doll !== null) return null;
  return classifyMinifigPart(part, description) === 'torso' ? 'minifig' : null;
}

/**
 * The rig slot a mini-doll part fills. The doll's one-piece legs take the
 * `legs` slot (a single mould on the hips bone); a torso that carries its arms
 * or a baby body is a torso with nothing to hang arms on.
 */
function dollRigSlot(doll: MiniDollSlot): MinifigSlot {
  switch (doll) {
    case 'doll_head': return 'head';
    case 'doll_torso': case 'doll_torso_arms': case 'doll_body': return 'torso';
    case 'doll_hips_legs': return 'hips_legs';
    case 'doll_hips': return 'hips';
    case 'doll_leg': return 'legs';
    case 'doll_arm': return 'arm_right'; // side decided by position
    case 'doll_hair': return 'headwear';
  }
}

/**
 * The slot a part fills on a figure of `system`, or null when the part
 * belongs to a different system (kept where the source put it). A minifig
 * part in a doll's group is as foreign as a doll part in a minifig's.
 */
export function classifyFigurePart(system: FigureSystem, part: string, description: string): MinifigSlot | null {
  const doll = classifyMiniDollPart(part, description);
  if (system === 'minidoll') {
    if (doll !== null) return dollRigSlot(doll);
    const slot = classifyMinifigPart(part, description);
    // Minifig body moulds are foreign; accessories (hair the library files as
    // `Minifig Hair`, a held microphone, a cape) are shared vocabulary.
    if (slot === null) return null;
    return slot === 'headwear' || slot === 'held' || slot === 'back' ? slot : null;
  }
  // A `MINI WIG` is hair on either system; every other doll mould is foreign to a minifig.
  if (doll !== null && !(doll === 'doll_hair' && /^Mini ?Wig\b/i.test(stripAlias(description)))) return null;
  return classifyMinifigPart(part, description);
}

interface SourcePart { brick: ParsedBrick; slot: MinifigSlot; local: Vec3; rot: number[]; desc: string }

const placeAt = (part: string, color: number, position: Vec3, rotation: Mat3): ParsedBrick => ({
  part, color, x: r3(position[0]), y: r3(position[1]), z: r3(position[2]), rot: rotation.map(r3),
});

/**
 * Where a source part says the figure frame's origin is, in the torso frame:
 * its own position minus its slot's canonical one. Parts of every slot in
 * `ANCHOR_SLOTS` vote; the torso votes 0 for itself.
 */
function impliedOrigin(canon: SystemCanon, s: SourcePart): Vec3 | null {
  if (!ANCHOR_SLOTS.has(s.slot)) return null;
  const c = canon[s.slot];
  return c ? sub(s.local, c.position) : null;
}

/**
 * The largest set of body parts that agree on where the figure frame is, and
 * the mean of their votes. The torso itself always votes (at 0), so a figure
 * whose parts all agree with the torso returns the zero offset, and a source
 * whose one mis-converted torso disagrees with two or more limbs returns the
 * limbs' consensus. Ties go to the torso.
 */
function consensusOrigin(canon: SystemCanon, source: SourcePart[]): { offset: Vec3; voters: number; total: number } {
  const votes = source.map(s => ({ s, at: impliedOrigin(canon, s) })).filter((v): v is { s: SourcePart; at: Vec3 } => v.at !== null);
  const torsoVote = votes.find(v => v.s.slot === 'torso');
  let best = torsoVote ? votes.filter(v => Math.hypot(...sub(v.at, torsoVote.at)) <= ANCHOR_AGREE_LDU) : [];
  for (const seed of votes) {
    const cluster = votes.filter(v => Math.hypot(...sub(v.at, seed.at)) <= ANCHOR_AGREE_LDU);
    if (cluster.length > best.length) best = cluster;
  }
  if (!best.length || (torsoVote && best.includes(torsoVote))) return { offset: [0, 0, 0], voters: best.length, total: votes.length };
  const mean: Vec3 = [0, 0, 0];
  for (const v of best) for (let i = 0; i < 3; i++) mean[i] += v.at[i]! / best.length;
  return { offset: mean, voters: best.length, total: votes.length };
}

/** The torso mould synthesised for a figure whose source has none (official library parts). */
/**
 * Plain mini-doll moulds for a body part the source lacks (`assembleMinifig`
 * supplies them the way `MINIFIG_DEFAULT_PARTS` completes a minifig): `92248`
 * Figure Friends Hips, `92251` Legs with Cropped Trousers, `92245` Female
 * Right Arm, `92244` Female Left Arm - each authored at its doll joint, so the
 * `MINIDOLL_CANON` offsets place them.
 */
export const MINIDOLL_DEFAULT_PARTS = { hips: '92248', legs: '92251', arm_right: '92245', arm_left: '92244' } as const;

const DEFAULT_TORSO: Record<FigureSystem, string> = { minifig: MINIFIG_DEFAULT_PARTS.torso, minidoll: '92241', bigfig: MINIFIG_DEFAULT_PARTS.torso };

/**
 * The part a figure group is assembled around: its torso, or — when the
 * source lost the torso — a head that has hips or legs of the same system
 * below it (42703's fifth doll arrived as head, hair, arm stump, hips and
 * legs with no torso; as loose parts its hand floated in the shell where the
 * shoulder should be, Pixel 8 Pro 2026-09-24). `headless` says which.
 */
export function figureAnchor(parts: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>): { index: number; system: FigureSystem; headless: boolean } | null {
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const torsoIndex = parts.findIndex(b => figureSystemOfTorso(b.part, desc(b)) !== null);
  if (torsoIndex >= 0) return { index: torsoIndex, system: figureSystemOfTorso(parts[torsoIndex]!.part, desc(parts[torsoIndex]!))!, headless: false };
  const headIndex = parts.findIndex(b => classifyMiniDollPart(b.part, desc(b)) === 'doll_head' || classifyMinifigPart(b.part, desc(b)) === 'head');
  if (headIndex < 0) return null;
  const head = parts[headIndex]!;
  const system: FigureSystem = classifyMiniDollPart(head.part, desc(head)) === 'doll_head' ? 'minidoll' : 'minifig';
  const hasLower = parts.some(b => {
    const slot = classifyFigurePart(system, b.part, desc(b));
    return slot === 'hips' || slot === 'hips_legs' || slot === 'legs' || slot === 'leg_right' || slot === 'leg_left';
  });
  return hasLower ? { index: headIndex, system, headless: true } : null;
}

/**
 * Assemble the figure a torso group describes. `sourceParts` are the group's
 * placements in the SOURCE frame (world LDraw); the torso must be among them,
 * or a head with legs (`figureAnchor`). The torso names the figure system
 * (minifig, mini-doll or big-fig) and the group is rebuilt on that system's
 * canon.
 */
export function assembleMinifig(sourceParts: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>): AssembledMinifig {
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const root = figureAnchor(sourceParts, meshes);
  if (!root) throw new Error('assembleMinifig: no torso in the group');
  const synthesized: string[] = [];
  let parts = sourceParts;
  let torsoIndex = root.index;
  if (root.headless) {
    // No torso in the source: make one under the head, in the colour the
    // figure gives away (an arm's sleeve, else the hips), so the figure is
    // whole rather than a head and legs with a gap.
    const head = sourceParts[root.index]!;
    const Rh: Mat3 = head.rot ?? IDENTITY;
    const headCanon = SYSTEM_CANON[root.system].head!.position;
    const at = add([head.x, head.y, head.z], apply(Rh, [-headCanon[0], -headCanon[1], -headCanon[2]]));
    const by = (pick: (slot: MinifigSlot | null, doll: MiniDollSlot | null) => boolean): ParsedBrick | undefined =>
      sourceParts.find(b => pick(classifyMinifigPart(b.part, desc(b)), classifyMiniDollPart(b.part, desc(b))));
    const sleeve = by((s, d) => s === 'arm_right' || s === 'arm_left' || d === 'doll_arm');
    const lower = by((s, d) => s === 'hips' || s === 'hips_legs' || d === 'doll_hips' || d === 'doll_hips_legs' || d === 'doll_leg');
    const color = sleeve?.color ?? lower?.color ?? DEFAULT_SKIN;
    parts = [...sourceParts, placeAt(DEFAULT_TORSO[root.system], color, at, Rh)];
    torsoIndex = parts.length - 1;
    synthesized.push('torso');
  }
  const torso = parts[torsoIndex]!;
  const system = root.system;
  const canon = SYSTEM_CANON[system];
  const classified = parts.map((b, i) => ({ brick: b, slot: i === torsoIndex ? 'torso' as MinifigSlot : classifyFigurePart(system, b.part, desc(b)) }));
  // A second torso in the group (a doll's torso caught beside a minifig's) is foreign, not a second body.
  for (const c of classified) if (c.slot === 'torso' && c.brick !== torso) c.slot = null;
  const Rt: Mat3 = torso.rot ?? IDENTITY;
  const RtT = transpose(Rt);
  const toLocal = (b: ParsedBrick): Vec3 => apply(RtT, sub([b.x, b.y, b.z], [torso.x, torso.y, torso.z]));
  const localRot = (b: ParsedBrick): number[] => mul(RtT, b.rot ?? IDENTITY);
  const source: SourcePart[] = classified
    .filter(c => c.slot !== null)
    .map(c => ({ brick: c.brick, slot: c.slot!, local: toLocal(c.brick), rot: localRot(c.brick), desc: desc(c.brick) }));

  // Hands and doll/big-fig arms: the side is where the source put them (right = −X).
  for (const s of source) {
    if (s.slot === 'hand_right' || s.slot === 'hand_left') s.slot = s.local[0] < 0 ? 'hand_right' : 'hand_left';
    if (system !== 'minifig' && (s.slot === 'arm_right' || s.slot === 'arm_left')) s.slot = s.local[0] < 0 ? 'arm_right' : 'arm_left';
  }

  // The frame is the body's consensus, not the torso's word alone: a converted
  // source can carry ONE part at a raw, unaligned origin (76417's big-fig
  // torso, 70 LDU below its own shoulders) and anchoring on it would rebuild
  // the whole figure around the one wrong part.
  const anchor = consensusOrigin(canon, source);
  const moved = Math.hypot(...anchor.offset) > 1e-6;
  if (moved) for (const s of source) s.local = sub(s.local, anchor.offset);
  const torsoPosition: Vec3 = moved ? add([torso.x, torso.y, torso.z], apply(Rt, anchor.offset)) : [torso.x, torso.y, torso.z];

  // A second head is headwear on top of the first (a helmet described as a head, a mask).
  const heads = source.filter(s => s.slot === 'head');
  for (const extra of heads.slice(1)) extra.slot = 'headwear';
  // A part no vocabulary could name that sits AT the head's origin is worn on
  // the head: every hair, hat and helmet mould is placed exactly there. Left
  // as `held`, the nearest-hand rule below (60 LDU reach) put it in a fist.
  const headCanon = canon.head ?? MINIFIG_CANON.head;
  const headOrigin: Vec3 = heads[0]?.local ?? headCanon.position;
  for (const s of source) if (s.slot === 'held' && Math.hypot(...sub(s.local, headOrigin)) <= 6) s.slot = 'headwear';

  const out: ParsedBrick[] = [];
  const slots: MinifigSlot[] = [];
  const boneOf: string[] = [];
  const dropped: string[] = [];
  const bystanders: string[] = [];
  const push = (brick: ParsedBrick, slot: MinifigSlot, bone = SYSTEM_SLOT_BONE[system][slot] ?? SLOT_BONE[slot]): void => { out.push(brick); slots.push(slot); boneOf.push(bone); };
  const first = (slot: MinifigSlot): SourcePart | undefined => source.find(s => s.slot === slot);
  /** Place a source part at its slot's canon when the system has one, else keep its (re-anchored) source pose. */
  const placeCanon = (s: SourcePart, slot: MinifigSlot, bone?: string): void => {
    const c = canon[slot];
    // A head's print id (`0 !CRAFTMATIC HEAD_PRINT`) rides along with it.
    const keep = s.brick.headPrint ? { headPrint: s.brick.headPrint } : {};
    if (c) push({ ...placeAt(s.brick.part, s.brick.color, c.position, c.rotation), ...keep }, slot, bone);
    else push({ ...placeAt(s.brick.part, s.brick.color, s.local, s.rot), ...keep }, slot, bone);
  };

  // 1. Core body at the canonical offsets. Colours the figure gives away:
  //    limbs match the torso, hips and legs each other, hands and head each other.
  const torsoColor = torso.color;
  const hipsSrc = first('hips'), compositeSrc = first('hips_legs'), legsSrc = first('legs'), legR = first('leg_right'), legL = first('leg_left');
  const legColor = legR?.brick.color ?? legL?.brick.color ?? legsSrc?.brick.color ?? hipsSrc?.brick.color ?? compositeSrc?.brick.color ?? torsoColor;
  const hipsColor = hipsSrc?.brick.color ?? compositeSrc?.brick.color ?? legColor;
  const handSrc = first('hand_right') ?? first('hand_left');
  const headSrc = first('head');
  const skin = handSrc?.brick.color ?? headSrc?.brick.color ?? DEFAULT_SKIN;

  push(placeAt(torso.part, torsoColor, canon.torso!.position, canon.torso!.rotation), 'torso');
  if (headSrc) placeCanon(headSrc, 'head');
  else if (system === 'minifig') { synthesized.push('head'); push(placeAt(MINIFIG_DEFAULT_PARTS.head, skin, MINIFIG_CANON.head.position, MINIFIG_CANON.head.rotation), 'head'); }

  if (system === 'minifig') {
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
  } else {
    // A doll's hips and one-piece legs, or a hips-and-skirt composite, at the
    // doll canon; a big-fig body carries its legs.
    if (hipsSrc) placeCanon(hipsSrc, 'hips');
    if (compositeSrc) placeCanon(compositeSrc, 'hips_legs');
    if (legsSrc) placeCanon(legsSrc, 'legs');
    for (const leg of [legR, legL]) if (leg) placeCanon(leg, leg.slot);
    // A doll whose source lost its legs (41732: three of seven dolls are hips
    // only - their leg element has no LDraw mapping) walked as a torso on a
    // belt. Give it the plain doll moulds in the colours it gives away.
    if (system === 'minidoll' && !compositeSrc && !legsSrc && !legR && !legL) {
      if (!hipsSrc) { synthesized.push('hips'); push(placeAt(MINIDOLL_DEFAULT_PARTS.hips, hipsColor, MINIDOLL_CANON.hips!.position, MINIDOLL_CANON.hips!.rotation), 'hips'); }
      synthesized.push('legs');
      push(placeAt(MINIDOLL_DEFAULT_PARTS.legs, legColor, MINIDOLL_CANON.legs!.position, MINIDOLL_CANON.legs!.rotation), 'legs');
    }
  }
  // A torso "with Integral Arms" or wing arms has no arm sockets: no arms, no hands.
  const torsoDesc = stripAlias(desc(torso));
  const integralArms = /Integral Arms|Bird Wing Arms|Wing Arms|Torso with Arms|Baby Body|Micro Doll Body/i.test(torsoDesc);
  for (const side of ['right', 'left'] as const) {
    const armSlot = `arm_${side}` as const, handSlot = `hand_${side}` as const;
    const arm = first(armSlot), hand = first(handSlot);
    if (integralArms && !arm) continue;
    if (arm) placeCanon(arm, armSlot);
    else if (system === 'minifig') { synthesized.push(`${side} arm`); push(placeAt(MINIFIG_DEFAULT_PARTS[armSlot], torsoColor, MINIFIG_CANON[armSlot].position, MINIFIG_CANON[armSlot].rotation), armSlot); }
    // A doll with ONE arm may be built that way (42703's stump); one with none lost both.
    else if (system === 'minidoll' && !first('arm_right') && !first('arm_left')) { synthesized.push(`${side} arm`); push(placeAt(MINIDOLL_DEFAULT_PARTS[armSlot], torsoColor, MINIDOLL_CANON[armSlot]!.position, MINIDOLL_CANON[armSlot]!.rotation), armSlot); }
    if (hand) {
      if (system === 'bigfig' && arm) {
        // A separate big-fig hand keeps its source offset from its arm, in the arm's frame.
        const rel = apply(transpose(arm.rot), sub(hand.local, arm.local));
        const c = canon[armSlot]!;
        push(placeAt(hand.brick.part, hand.brick.color, add(c.position, apply(c.rotation, rel)), mul(c.rotation, mul(transpose(arm.rot), hand.rot))), handSlot, armSlot);
      } else placeCanon(hand, handSlot);
    } else if (system === 'minifig') { synthesized.push(`${side} hand`); push(placeAt(MINIFIG_DEFAULT_PARTS[handSlot], skin, MINIFIG_CANON[handSlot].position, MINIFIG_CANON[handSlot].rotation), handSlot); }
  }

  // 2. Dressing keeps its source offset relative to the part it belongs to:
  //    headwear to the head, a cape or backpack to the torso, a held item to
  //    the hand nearest it (re-expressed in the canonical hand's frame, so a
  //    posed arm's item lands in the standing hand).
  const headLocal = headSrc ? headSrc.local : headCanon.position;
  const headRot: Mat3 = headSrc ? headSrc.rot : IDENTITY;
  const canonHand = (side: 'right' | 'left'): CanonPose => canon[`hand_${side}`] ?? MINIFIG_CANON[`hand_${side}`];
  const sourceHand = (side: 'right' | 'left'): SourcePart | undefined => first(`hand_${side}`);
  for (const s of source) {
    if (s.slot === 'headwear') {
      // Relative to the source head (its own frame), then onto the canonical head.
      const rel = apply(transpose(headRot), sub(s.local, headLocal));
      const relRot = mul(transpose(headRot), s.rot);
      push(placeAt(s.brick.part, s.brick.color, add(headCanon.position, rel), relRot), 'headwear');
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
        const c = canonHand(best.side);
        push(placeAt(s.brick.part, s.brick.color, add(c.position, apply(c.rotation, rel)), mul(c.rotation, relRot)), 'held', `hand_${best.side}`);
      } else if (Math.hypot(s.local[0], s.local[2]) <= 30 && s.local[1] < -12) {
        // Over the head and not in a hand: a hat the description did not name.
        push(placeAt(s.brick.part, s.brick.color, s.local, s.rot), 'headwear');
      } else {
        // Worn or carried against the body: rides with the torso.
        push(placeAt(s.brick.part, s.brick.color, s.local, s.rot), 'back');
      }
    }
  }
  // A part this rig has no slot for (a mini-doll part caught in a minifig's
  // group, or the reverse) is KEPT, at exactly the transform the source gave
  // it expressed in the (re-anchored) torso frame, and reported. Dropping it
  // would delete geometry the model has; dressing it onto a slot would move it
  // somewhere it never was. It rides the body bone, which is what the whole
  // group already did.
  for (const c of classified) {
    if (c.slot !== null) continue;
    bystanders.push(c.brick.part);
    push(placeAt(c.brick.part, c.brick.color, sub(toLocal(c.brick), anchor.offset), localRot(c.brick)), 'held', 'body');
  }

  // 3. Where the feet are: the lowest point of the body moulds as assembled.
  //    A standard minifig's legs give 72; a short-leg child, a doll or a
  //    big-fig body answers for itself. A synthesised mould the map lacks
  //    (the library was not asked for it) falls back to the canon.
  let feetY = -Infinity;
  out.forEach((b, i) => {
    if (!FLOOR_SLOTS.has(slots[i]!)) return;
    const m = meshes.get(b.part);
    if (m && m.triangles.length) {
      const R: Mat3 = b.rot ?? IDENTITY;
      for (const corner of cornersOf(m.bounds.min, m.bounds.max)) feetY = Math.max(feetY, apply(R, corner)[1] + b.y);
    } else if (slots[i] === 'leg_right' || slots[i] === 'leg_left') feetY = Math.max(feetY, MINIFIG_FEET_Y);
  });
  if (!Number.isFinite(feetY)) feetY = system === 'minifig' ? MINIFIG_FEET_Y : 0;

  const f = apply(Rt, [0, 0, -1]);
  const h = Math.hypot(f[0], f[2]);
  const facingLdu: [number, number] = h > 0.5 ? [f[0] / h, f[2] / h] : [0, -1];
  return {
    bricks: out, slots, synthesized, dropped, bystanders, facingLdu, system, feetY,
    rig: { bones: [...SYSTEM_BONES[system]], boneOf },
    torso: { position: torsoPosition, rotation: [...Rt] },
    ...(moved ? { reanchoredLdu: anchor.offset } : {}),
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
    bricks: out, slots, synthesized: [], dropped: [], bystanders: [], facingLdu: [0, -1],
    system: 'minifig', feetY: MINIFIG_FEET_Y,
    rig: { bones: [...MINIFIG_BONES], boneOf },
    torso: { position: [0, 0, 0], rotation: [...IDENTITY] },
  };
}

/**
 * The animations every minifig entity plays. Bone rotations are relative to
 * the bind pose the compiler emitted (pivots at the joints):
 *  - walk: legs swing ±`MINIFIG_GAIT.legSwingDeg` and arms ±`armSwingDeg`
 *    in opposite phase, phased by the distance travelled at the rate that
 *    keeps a planted foot still (`MINIFIG_GAIT`), faded in and out with the
 *    walk speed, and only while the entity moves (`query.is_moving`);
 *  - look: the head follows the look target (vanilla's look_at_target);
 *  - sit: legs forward while riding a seat.
 */
export const MINIFIG_ANIMATION_IDS = {
  walk: 'animation.craftmatic.minifig.walk',
  look: 'animation.craftmatic.minifig.look',
  sit: 'animation.craftmatic.minifig.sit',
  /** The mini-doll's own walk and sit (its one-piece legs on the `legs` hinge, `MINIDOLL_BONES`). */
  dollWalk: 'animation.craftmatic.minidoll.walk',
  dollSit: 'animation.craftmatic.minidoll.sit',
} as const;

/**
 * The mini-doll's walk. Its legs are one moulded piece, so they cannot
 * scissor: the doll rocks side to side on the hip hinge (the whole legs
 * piece rolls `waddleDeg` about the walking direction, one rock per step, at
 * the minifig's distance-locked rate) with its arms swinging as a minifig's.
 * Sitting bends the legs forward 90 degrees at the same hinge, as the toy's
 * legs do.
 */
export const MINIDOLL_GAIT = { waddleDeg: 5, armSwingDeg: 22 } as const;

/**
 * The walk's gait, derived so a foot does not slide.
 *
 * A leg of length L (hip pivot to sole: 72 - 44 = 28 LDU = 0.525 blocks at the
 * 96 LDU = 1.8 block scale) swung ±A carries its foot 2·L·sin A per step and
 * 4·L·sin A per full cycle (two steps). `query.modified_distance_moved` is the
 * engine's limb-swing position; the phase rate is 360 / (u · 4·L·sin A)
 * degrees per unit, u being its units per block.
 *
 * MEASURED on the Pixel 8 Pro (GameTest `gait_<id>`, a server-side animation
 * controller counting whole units while a figure is pushed exactly as the
 * walker pushes it, ~25 blocks per speed, 2026-09-25): u = 3.88 at 0.021 and
 * 0.042 blocks/tick (96 and 97 units), 3.76 at 0.083 (the limb swing's
 * start-up lag, counted once per pass, weighs more on the short fast passes).
 * The earlier guess of 4 was 3 % fast.
 *
 * The same probe measured `query.modified_move_speed` = 3.9 x blocks per tick
 * (0.075-0.1 at 0.021, 0.15-0.175 at 0.042, 0.325-0.35 at 0.083): the old
 * swing amount `modified_move_speed x 4` was 0.65 at the walker's real 100 %
 * speed (0.042 blocks/tick, not the 0.06 it asks for) and 0.33 at 50 %, so the
 * legs swung 23 and 11 degrees against a phase rate derived for 35: the feet
 * covered 68 % and 33 % of the ground - the sliding. `GAIT_FULL_SWING_SPEED`
 * now reaches the full swing at 0.01 blocks/tick (a 25 % figure's walk) and
 * only fades it in and out at a start and a stop.
 */
export const MINIFIG_GAIT = (() => {
  const legBlocks = (MINIFIG_FEET_Y - 44) / 96 * 1.8;
  const legSwingDeg = 35, armSwingDeg = 28, unitsPerBlock = 3.88;
  const cycleBlocks = 4 * legBlocks * Math.sin(legSwingDeg * Math.PI / 180);
  return { legBlocks, legSwingDeg, armSwingDeg, unitsPerBlock, cycleBlocks, degPerUnit: Math.round(360 / (unitsPerBlock * cycleBlocks) * 100) / 100 };
})();
/** `query.modified_move_speed` at which the walk swings fully: 0.04 = 0.01 blocks/tick at the measured 3.9 per block. */
export const GAIT_FULL_SWING_SPEED = 0.04;
const GAIT_PHASE = `math.cos(query.modified_distance_moved * ${MINIFIG_GAIT.degPerUnit})`;
const GAIT_AMOUNT = `math.clamp(query.modified_move_speed / ${GAIT_FULL_SWING_SPEED}, 0.0, 1.0) * query.is_moving`;

export const MINIFIG_ANIMATIONS = {
  format_version: '1.8.0',
  animations: {
    [MINIFIG_ANIMATION_IDS.walk]: {
      loop: true,
      bones: {
        leg_right: { rotation: [`${GAIT_PHASE} * ${MINIFIG_GAIT.legSwingDeg} * ${GAIT_AMOUNT}`, 0, 0] },
        leg_left: { rotation: [`-${GAIT_PHASE} * ${MINIFIG_GAIT.legSwingDeg} * ${GAIT_AMOUNT}`, 0, 0] },
        arm_right: { rotation: [`-${GAIT_PHASE} * ${MINIFIG_GAIT.armSwingDeg} * ${GAIT_AMOUNT}`, 0, 0] },
        arm_left: { rotation: [`${GAIT_PHASE} * ${MINIFIG_GAIT.armSwingDeg} * ${GAIT_AMOUNT}`, 0, 0] },
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
    [MINIFIG_ANIMATION_IDS.dollWalk]: {
      loop: true,
      bones: {
        legs: { rotation: [0, 0, `${GAIT_PHASE} * ${MINIDOLL_GAIT.waddleDeg} * ${GAIT_AMOUNT}`] },
        arm_right: { rotation: [`-${GAIT_PHASE} * ${MINIDOLL_GAIT.armSwingDeg} * ${GAIT_AMOUNT}`, 0, 0] },
        arm_left: { rotation: [`${GAIT_PHASE} * ${MINIDOLL_GAIT.armSwingDeg} * ${GAIT_AMOUNT}`, 0, 0] },
      },
    },
    [MINIFIG_ANIMATION_IDS.dollSit]: {
      loop: true,
      bones: { legs: { rotation: [-90, 0, 0] } },
    },
  },
} as const;

/** The client entity's `animations` map and `scripts.animate` list for a minifig. */
/** A figure entity's client animation map and its `scripts.animate` list. */
export interface FigureClientAnimations { animations: Record<'walk' | 'look' | 'sit', string>; animate: Array<string | Record<string, string>> }

export const MINIFIG_CLIENT_ANIMATIONS: FigureClientAnimations = {
  animations: { walk: MINIFIG_ANIMATION_IDS.walk, look: MINIFIG_ANIMATION_IDS.look, sit: MINIFIG_ANIMATION_IDS.sit },
  animate: [{ walk: '!query.is_riding' }, { sit: 'query.is_riding' }, 'look'],
};

/** The same for a mini-doll (`MINIDOLL_GAIT`): its walk and sit bend the one-piece legs at their hinge. */
export const MINIDOLL_CLIENT_ANIMATIONS: FigureClientAnimations = {
  animations: { walk: MINIFIG_ANIMATION_IDS.dollWalk, look: MINIFIG_ANIMATION_IDS.look, sit: MINIFIG_ANIMATION_IDS.dollSit },
  animate: MINIFIG_CLIENT_ANIMATIONS.animate,
};

/** The client animation set for a figure of `system` (a big-fig walks as a minifig: it has two legs). */
export function figureClientAnimations(system: FigureSystem | undefined): FigureClientAnimations {
  return system === 'minidoll' ? MINIDOLL_CLIENT_ANIMATIONS : MINIFIG_CLIENT_ANIMATIONS;
}
