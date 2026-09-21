/**
 * Minifig creator wand — the shared contract between the exporter (which
 * compiles a part LIBRARY into the pack), the in-game runtime (which can only
 * choose among that library, since Bedrock's script API cannot build
 * geometry) and the web builder (which round-trips figure codes).
 *
 * Architecture: `docs/minifig-creator-wand.md`. This module is the typed
 * shared contract implemented by the exporter, generated runtime, and web
 * builder (see the current validation status in the architecture doc).
 *
 * The runtime model: ONE entity type per pack whose whole look is a set of
 * client-synced integer entity properties (a part index and a colour index
 * per slot, a family, a draft flag) read by render controllers through
 * `q.property()`. Bedrock allows 32 properties per entity type; the table
 * below uses 22.
 */

import type { LegoEntityQualityName } from './ldraw-part-prototype.js';

/** The figure families a creator pack can hold; each has its own rig. */
export type CreatorFamily = 'minifig' | 'minidoll';

/**
 * The slots a player edits. A slot maps to ONE part property and ONE colour
 * property; `arms`/`legs`/`hands` are pairs of moulds chosen together.
 * Optional slots (`hair`, `held_*`, `back`) accept part index 0 = none.
 */
export type CreatorSlot =
  | 'head' | 'hair' | 'torso' | 'arms' | 'hands' | 'hips' | 'legs'
  | 'held_right' | 'held_left' | 'back';

export const CREATOR_SLOTS: readonly CreatorSlot[] = [
  'head', 'hair', 'torso', 'arms', 'hands', 'hips', 'legs', 'held_right', 'held_left', 'back',
];

/** Slots whose part index 0 means "nothing worn / held". */
export const OPTIONAL_SLOTS: ReadonlySet<CreatorSlot> = new Set<CreatorSlot>(['hair', 'held_right', 'held_left', 'back']);

/** Entity property that selects a slot's part (an index into the pack's library for that slot). */
export const slotProperty = (slot: CreatorSlot): string => `craftmatic:${slot}`;
/** Entity property that selects a slot's colour (an index into `MINIFIG_CREATOR_COLOURS`). */
export const colourProperty = (slot: CreatorSlot): string => `craftmatic:c_${slot}`;
/** Entity property: 0 = minifig, 1 = mini-doll. */
export const FAMILY_PROPERTY = 'craftmatic:family';
/** Entity property (bool): true while the figure is a player's editable draft, false once placed. */
export const DRAFT_PROPERTY = 'craftmatic:draft';
/** Entity DYNAMIC property (string): the `player.id` who owns the draft / placed the figure. */
export const OWNER_DYNAMIC_PROPERTY = 'craftmatic:owner';
/** Total entity properties the creator entity declares; Bedrock's limit is 32 per type. */
export const CREATOR_PROPERTY_COUNT = CREATOR_SLOTS.length * 2 + 2;

/** Entity events: `release` adds the NPC component group, `npc_off` removes it again for editing in place. */
export const RELEASE_EVENT = 'craftmatic:release';
export const NPC_OFF_EVENT = 'craftmatic:npc_off';
/** The component group that carries every AI/movement component; the base entity declares none of them. */
export const NPC_COMPONENT_GROUP = 'craftmatic:npc';

/**
 * LDraw colour ids the wand exposes, opaque first (the 24 "common" ones lead),
 * translucent and special finishes last so a render controller can pick the
 * blend material with `index >= FIRST_TRANSLUCENT_COLOUR`. Every id has an
 * `LDRAW_COLOR_RGB` entry and a `resolveLdrawEntityMaterial` class.
 */
export const MINIFIG_CREATOR_COLOURS: readonly number[] = [
  // common 24 (page 1)
  0, 15, 4, 1, 2, 14, 19, 71, 72, 70, 25, 27, 5, 26, 22, 28, 308, 320, 321, 322, 323, 191, 226, 484,
  // more solids, then the opaque special finishes (chrome, pearl, flat silver: PBR only)
  85, 84, 378, 379, 3, 6, 7, 8, 10, 11, 13, 17, 18, 20, 29, 73, 383, 297, 179,
  // translucent (blend material from here): trans clear / red / dark blue / yellow, glow-in-dark trans
  47, 36, 33, 46, 294,
];
/** Index of the first colour rendered with the blend material (material class `transparent` / `glow`). */
export const FIRST_TRANSLUCENT_COLOUR = 43;
/** Colours shown on the first page of the colour chooser. */
export const COMMON_COLOUR_COUNT = 24;

/** Buttons per page on part and colour lists (phone landscape without scrolling, plus navigation). */
export const PAGE_SIZE = 8;
/** Colour buttons per "more colours" page. */
export const COLOUR_PAGE_SIZE = 12;
/** Placed creator figures per world before the wand refuses to place another. */
export const MINIFIG_WORLD_CAP = 200;
/** Saved figures per player (each code ≤ ~140 chars against the 32,767-char dynamic-property limit). */
export const SAVED_FIGURE_CAP = 100;
/** Fixed-colour print layers a library part may carry; a part with more is rejected with a diagnostic. */
export const MAX_PRINT_LAYERS = 6;
/** Longest name a figure can carry (becomes its `nameTag`). */
export const MAX_FIGURE_NAME = 24;

/** One part the exporter compiles into a slot's library. */
export interface MinifigLibraryEntry {
  /** LDraw part id without `.dat` (`973pbs`). */
  part: string;
  /** Group shown on the "choose a group" screen; derived from the description by `MINIFIG_GROUP_RULES` unless given. */
  group?: string;
  /** Button label (≤ 40 chars); defaults to the LDraw description. */
  label?: string;
}

/** What the web builder / CLI hands the exporter. */
export interface MinifigLibrarySpec {
  tier: 'starter' | 'standard' | 'large' | 'custom';
  /** Per family, per slot, the ordered entries; index 0 of an optional slot is reserved for "none". */
  slots: Record<CreatorFamily, Partial<Record<CreatorSlot, MinifigLibraryEntry[]>>>;
  /** Exposed colours; defaults to `MINIFIG_CREATOR_COLOURS`. */
  colours?: readonly number[];
  /** Figures shipped read-only in the wand's "Presets" list. */
  presets?: SavedFigure[];
  /** Cuboid budget profile; the figure clamp (`clampFigureQuality`) applies. */
  quality?: LegoEntityQualityName;
}

/** One compiled library entry as the pack ships it. */
export interface CompiledLibraryEntry extends Required<Pick<MinifigLibraryEntry, 'part' | 'group' | 'label'>> {
  /** Geometry id of the colour-16 (slot-tinted) cuboids. */
  mainGeometry: string;
  /** Fixed-colour print layers: geometry id + the LDraw colour it is textured with. */
  printLayers: Array<{ geometry: string; colorId: number }>;
  cuboids: number;
}

/** The library as compiled, plus what was rejected and why (hard rule 4: nothing silent). */
export interface CompiledMinifigLibrary {
  slots: Record<CreatorFamily, Partial<Record<CreatorSlot, CompiledLibraryEntry[]>>>;
  colours: readonly number[];
  /** Geometry id of the empty (bones only) geometry per family, used at index 0 of optional slots. */
  emptyGeometry: Record<CreatorFamily, string>;
  cuboids: number;
  rejected: Array<{ family: CreatorFamily; slot: CreatorSlot; part: string; reason: string }>;
}

/** A saved figure: display name + self-describing code (`FigureCode`). */
export interface SavedFigure { n: string; c: string }

/**
 * The runtime's CONFIG (serialised into `scripts/minifig-wand.js` the way the
 * brick wand's CONFIG is): everything the in-game script needs to browse,
 * name and encode without a part database.
 */
export interface MinifigCreatorConfig {
  id: string;
  label: string;
  itemId: string;
  shortAlias: string;
  figureType: string;
  /** Per family, per slot: `[part, label, group]` in property-index order (index 0 of an optional slot is `['', 'None', '']`). */
  library: Record<CreatorFamily, Partial<Record<CreatorSlot, Array<[part: string, label: string, group: string]>>>>;
  /** `[colorId, name]` in property-index order. */
  colours: Array<[id: number, name: string]>;
  firstTranslucentColour: number;
  /** Default property values per family (the pack's default figure). */
  defaults: Record<CreatorFamily, Record<string, number>>;
  presets: SavedFigure[];
  worldCap: number;
  savedCap: number;
  pageSize: number;
}

/**
 * The figure code, the interchange form between the game and the web builder:
 * `mf1|<m|d>|<slot>=<part>:<colour>|…|n=<name>` with LDraw part and colour IDS,
 * never library indices, so it decodes anywhere. Two-letter slot keys:
 * he ha to ar hd hi le hr hl bk.
 */
export interface FigureCode {
  family: CreatorFamily;
  slots: Partial<Record<CreatorSlot, { part: string; color: number }>>;
  name: string;
}
export const FIGURE_CODE_VERSION = 'mf1';
export const FIGURE_CODE_SLOT_KEYS: Readonly<Record<CreatorSlot, string>> = {
  head: 'he', hair: 'ha', torso: 'to', arms: 'ar', hands: 'hd', hips: 'hi', legs: 'le',
  held_right: 'hr', held_left: 'hl', back: 'bk',
};
