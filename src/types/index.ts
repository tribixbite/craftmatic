/** Shared TypeScript types for craftmatic */

/** A Minecraft block state string, e.g. "minecraft:stone_bricks" or "minecraft:oak_stairs[facing=north]" */
export type BlockState = string;

/** RGB color tuple */
export type RGB = [number, number, number];

/** XYZ coordinate tuple */
export type Vec3 = [number, number, number];

/** Block entity item slot */
export interface ItemSlot {
  slot: number;
  id: string;
  count: number;
}

/** Block entity data (chests, barrels, signs, etc.) */
export interface BlockEntity {
  type: string;
  pos: Vec3;
  id: string;
  items?: ItemSlot[];
}

/** Raw schematic data as parsed from .schem files */
export interface SchematicData {
  /** Sponge Schematic format version (typically 2) */
  version: number;
  /** Minecraft data version for block state compatibility */
  dataVersion: number;
  /** Dimensions */
  width: number;
  height: number;
  length: number;
  /** Block state palette: block state string -> numeric ID */
  palette: Map<string, number>;
  /** Varint-encoded block data referencing palette IDs */
  blockData: Uint8Array;
  /** Block entities with position and NBT data */
  blockEntities: BlockEntity[];
  /** World offset for pasting */
  offset: Vec3;
}

/** Metadata summary returned by the info command */
export interface SchematicInfo {
  filename: string;
  version: number;
  dataVersion: number;
  width: number;
  height: number;
  length: number;
  totalBlocks: number;
  nonAirBlocks: number;
  paletteSize: number;
  blockEntityCount: number;
}

/** Room types supported by the generator */
export type RoomType =
  | 'bedroom'
  | 'kitchen'
  | 'dining'
  | 'living'
  | 'bathroom'
  | 'study'
  | 'library'
  | 'vault'
  | 'armory'
  | 'observatory'
  | 'lab'
  | 'gallery'
  | 'throne'
  | 'forge'
  | 'greenhouse'
  | 'foyer'
  | 'captains_quarters'
  | 'cell'
  | 'nave'
  | 'belfry'
  | 'attic'
  | 'basement'
  | 'sunroom'
  | 'closet'
  | 'laundry'
  | 'pantry'
  | 'mudroom';

/** Building style presets */
export type StyleName = 'fantasy' | 'medieval' | 'modern' | 'gothic' | 'rustic'
  | 'steampunk' | 'elven' | 'desert' | 'underwater';

/** Structure types the generator can produce */
export type StructureType = 'house' | 'tower' | 'castle' | 'dungeon' | 'ship'
  | 'cathedral' | 'bridge' | 'windmill' | 'marketplace' | 'village';

/** Generation parameters */
export interface GenerationOptions {
  type: StructureType;
  floors: number;
  style: StyleName;
  rooms?: RoomType[];
  width?: number;
  length?: number;
  seed?: number;
  /** Override wall material (house color) */
  wallOverride?: BlockState;
  /** Override trim/accent material */
  trimOverride?: BlockState;
  /** Override door wood type (e.g. 'spruce', 'dark_oak', 'iron') */
  doorOverride?: string;
}

/** 2D render mode */
export type RenderMode = 'floor' | 'cutaway' | 'exterior';

/** Render options for PNG output */
export interface PngRenderOptions {
  mode: RenderMode;
  /** Story/floor to render (for floor and cutaway modes) */
  story?: number;
  /** Pixels per block (floor mode) or tile size (iso modes) */
  scale?: number;
  /** Output file path */
  output?: string;
  /** Title text overlay */
  title?: string;
}

/** Block face directions for texture mapping */
export type BlockFace = 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west';

/** UV coordinates within the texture atlas */
export interface AtlasUV {
  u: number;
  v: number;
  w: number;
  h: number;
}

/** Per-face texture mapping for a block */
export type BlockFaceMap = Partial<Record<BlockFace, AtlasUV>>;

/** Parsed block state properties */
export interface BlockStateProperties {
  /** Base block name without namespace, e.g. "oak_stairs" */
  name: string;
  /** Full namespaced ID, e.g. "minecraft:oak_stairs" */
  id: string;
  /** Block state properties, e.g. { facing: "north", half: "bottom" } */
  properties: Record<string, string>;
}

/** Room bounds within a building */
export interface RoomBounds {
  x1: number;
  y: number;
  z1: number;
  x2: number;
  z2: number;
  /** Number of interior height blocks */
  height: number;
}
