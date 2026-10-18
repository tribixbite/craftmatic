/**
 * Per-set canon: the few facts about a LEGO set that cannot be read from its
 * parts or its title, keyed by SET NUMBER.
 *
 * Everything else the playable export knows is inferred - vehicles from wheels
 * and hulls, figures from torsos, doors from leaf moulds, slides and lifts
 * from their moulds and geometry - and stays that way. This table is the ONE
 * place for a hint a set needs that inference cannot supply: which of its
 * small sub-builds is a MOUNT a figure rides (11390's Flying Nimbus, a golden
 * cloud that reads as a heap of yellow slopes to every detector), what it
 * flies like and what its rider does. Later hints (a seat, a facing, a scale)
 * belong here too, as new optional fields of `SetCanon`, never as a regex on
 * the title in a pipeline file (the 76252 / 10300 special cases in
 * playable-components.ts and playable-addon.ts predate this table).
 *
 * A canon entry NAMES a feature; it never keys on part ids or coordinates,
 * because the model file may not exist yet when the entry is written (11390
 * was written 2026-09-29 for a set released 2026-11-01) and a set has many
 * sources (LDR, MPD, LXF, .io) whose ids differ. The detector that finds the
 * feature (`bedrock-flyer.ts` `findMounts`) is generic and its failure is
 * loud: a canon mount none was found for is reported in the export, and the
 * export still succeeds without it.
 *
 * The set number is read from wherever the export gets its name: the LEGO
 * tab's label (`Dragon Ball: Shenron & Goku (11390-1)`), the CLI's `--label`
 * (the same text), the pack stem, or the source provenance's `setNum`.
 */

import colorClasses from './ldraw-color-classes.json' with { type: 'json' };

/** What a mount looks like: decides the colour family the detector wants and the in-game words. */
export type MountStyle = 'cloud';
/** How a mount moves under a player: `flyer` is the free-flying hover mount (bedrock-vehicle.ts `VehicleMotion`). */
export type MountMotion = 'flyer';
/** What the mount's own figure does with it: `orbit` flies a closed loop around the set on its own (bedrock-rides.ts). */
export type CompanionBehaviour = 'orbit';

export interface CanonMount {
  style: MountStyle;
  motion: MountMotion;
  /** The figure standing on the mount keeps it and flies it around the model; absent: the mount is only the player's to summon. */
  companion?: CompanionBehaviour;
  /** The mount's name in the pack (entity names, the export report); default: the style. */
  label?: string;
  /** The HUD word while riding (ASCII, no bare `%`); default: the label upper-cased. */
  hud?: string;
}

export interface SetCanon {
  /** The LEGO set number without its `-1` suffix. */
  setNumber: string;
  /** The set's name, for the reader; nothing keys on it. */
  name: string;
  /** Mounts a figure of the set rides (each is found by `findMounts`, one figure each). */
  mounts?: CanonMount[];
}

/**
 * The table. One entry per set that needs a hint; keep it small and say why.
 *
 * 11390 Dragon Ball: Shenron & Goku (LEGO Icons, 1,764 pieces, 2026-11-01):
 * Shenron coils around a rock pillar on a black stand; Goku rides his Flying
 * Nimbus (Kinto'un), a small brick-built golden cloud. The user's ask: the
 * cloud rideable like a flying carpet, Goku flying around the dragon on his
 * own cloud, and a new cloud for a player who taps him.
 */
export const SET_CANON: Readonly<Record<string, SetCanon>> = {
  '11390': {
    setNumber: '11390', name: 'Dragon Ball: Shenron & Goku',
    mounts: [{ style: 'cloud', motion: 'flyer', companion: 'orbit', label: 'Nimbus', hud: 'NIMBUS' }],
  },
};

/** `... (11390-1)` at the end of a label, as the LEGO tab and the CLI write it. */
const TRAILING_SET = /\((\d{4,7})(?:-\d{1,2})?\)\s*$/;
/** A set number anywhere in a stem or a file name (`11390-1-nimbus`, `11390.ldr`). */
const ANY_SET = /(?:^|[^\d])(\d{4,7})(?:-\d{1,2})?(?=$|[^\d])/;

/**
 * The set number an export is for, from the texts the export carries: the
 * label's trailing `(<set>-1)` first (the tab's own convention), then the
 * provenance's set number, then the first number in the stem or the label.
 * Only a number the canon TABLE knows is returned, so a title with a stray
 * number (`Ecto-1 (10274)`: 10274 is not in the table) never matches by
 * accident; a set the table does not name has no canon.
 */
export function canonSetNumber(label: string | undefined, stem?: string, setNum?: string): string | undefined {
  const candidates: string[] = [];
  const trailing = label ? TRAILING_SET.exec(label) : null;
  if (trailing) candidates.push(trailing[1]!);
  if (setNum) { const m = /^(\d{4,7})/.exec(setNum); if (m) candidates.push(m[1]!); }
  for (const text of [stem, label]) {
    if (!text) continue;
    const m = ANY_SET.exec(text);
    if (m) candidates.push(m[1]!);
  }
  return candidates.find(c => Object.prototype.hasOwnProperty.call(SET_CANON, c));
}

/** The canon for an export, or undefined when the set has none (the common case). */
export function canonFor(label: string | undefined, stem?: string, setNum?: string): SetCanon | undefined {
  const n = canonSetNumber(label, stem, setNum);
  return n ? SET_CANON[n] : undefined;
}

/**
 * The colour family of each mount style, as LDraw colour codes plus a rule
 * for a code the list does not name (a source's own `!COLOUR`, rewritten to a
 * direct `0x2RRGGBB` by the parser). A cloud is the yellows and light oranges
 * (14 Yellow, 191 Bright Light Orange, 18/226 the light yellows, 46 Trans
 * Yellow), white and tan (a cloud's highlights and its underside), and trans
 * clear (a stand it may carry). Whether the real Nimbus is yellow or bright
 * light orange does not matter here: both are in.
 */
export const MOUNT_STYLE_COLOURS: Readonly<Record<MountStyle, { codes: readonly number[]; hue: readonly [number, number]; minSaturation: number; minLightness: number; whites: boolean }>> = {
  cloud: { codes: [14, 191, 18, 226, 15, 19, 46, 47], hue: [35, 65], minSaturation: 0.45, minLightness: 0.4, whites: true },
};

const DIRECT_OPAQUE = 0x2000000, DIRECT_ALPHA = 0x3000000;

/** The sRGB of an LDraw colour code: the LDConfig table, or a direct colour's own bits; null for a code nobody knows. */
export function ldrawColourRgb(code: number): [number, number, number] | null {
  if (code >= DIRECT_OPAQUE && code < DIRECT_OPAQUE + 0x1000000) return [(code >> 16) & 255, (code >> 8) & 255, code & 255];
  if (code >= DIRECT_ALPHA && code < DIRECT_ALPHA + 0x1000000) return [(code >> 16) & 255, (code >> 8) & 255, code & 255];
  const entry = (colorClasses as { colours: Record<string, { rgb: string }> }).colours[String(code)];
  if (!entry) return null;
  const hex = entry.rgb.replace('#', '');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** Whether an LDraw colour code is see-through: the table's alpha, or a direct `0x3RRGGBB`. */
export function ldrawColourTranslucent(code: number): boolean {
  if (code >= DIRECT_ALPHA && code < DIRECT_ALPHA + 0x1000000) return true;
  const entry = (colorClasses as { colours: Record<string, { alpha?: number }> }).colours[String(code)];
  return entry?.alpha !== undefined && entry.alpha < 255;
}

/** Hue (degrees), saturation and lightness (0-1) of an sRGB triple. */
function hsl([r, g, b]: [number, number, number]): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (d < 1e-9) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s, l };
}

/** Whether a placed colour belongs to a mount style's family (see `MOUNT_STYLE_COLOURS`). */
export function isMountColour(style: MountStyle, code: number): boolean {
  const family = MOUNT_STYLE_COLOURS[style];
  if (family.codes.includes(code)) return true;
  const rgb = ldrawColourRgb(code);
  if (!rgb) return false;
  const { h, s, l } = hsl(rgb);
  if (family.whites && s <= 0.12 && l >= 0.85) return true;
  return h >= family.hue[0] && h <= family.hue[1] && s >= family.minSaturation && l >= family.minLightness;
}
