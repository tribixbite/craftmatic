/**
 * craftmatic — Minecraft schematic toolkit
 *
 * Parse, generate, render, and convert .schem files.
 * Works as both a library (import { ... } from 'craftmatic')
 * and a CLI tool (npx craftmatic).
 */

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  BlockState, RGB, Vec3, ItemSlot, BlockEntity, SchematicData, SchematicInfo,
  RoomType, StyleName, StructureType, GenerationOptions,
  RenderMode, PngRenderOptions,
  BlockFace, AtlasUV, BlockFaceMap, BlockStateProperties, RoomBounds,
} from './types/index.js';

// ─── Core: BlockGrid ─────────────────────────────────────────────────────────
export { BlockGrid } from './schem/types.js';

// ─── Schematic parsing & writing ─────────────────────────────────────────────
export { parseSchematic, parseToGrid, schematicToGrid } from './schem/parse.js';
export { writeSchematic, writeSchematicData, gridToSchematic } from './schem/write.js';

// ─── Varint encoding ─────────────────────────────────────────────────────────
export { encodeVarint, decodeVarint, decodeAllVarints } from './schem/varint.js';

// ─── NBT ─────────────────────────────────────────────────────────────────────
export { NBTWriter, TAG } from './nbt/writer.js';
export { parseNBTFile, parseNBTBuffer, readSchemFile } from './nbt/reader.js';

// ─── Block registry & colors ─────────────────────────────────────────────────
export {
  parseBlockState, getBaseId, getBlockName, isAir, isTransparent, isSolidBlock,
  getFacing, getAxis,
} from './blocks/registry.js';
export {
  getBlockColor, getAllBlockColors,
  FURNITURE_BLOCKS, LIGHT_BLOCKS, BED_BLOCKS, DOOR_BLOCKS,
} from './blocks/colors.js';
export { getBlockTextures, getFaceTexture } from './blocks/textures.js';

// ─── Generation ──────────────────────────────────────────────────────────────
export { generateStructure } from './gen/generator.js';
export { getStyle, getStyleNames, STYLES } from './gen/styles.js';
export type { StylePalette } from './gen/styles.js';
export { getRoomGenerator, getRoomTypes } from './gen/rooms.js';
export type { RoomGenerator } from './gen/rooms.js';
export {
  chandelier, tableAndChairs, longDiningTable, bookshelfWall,
  carpetArea, endRodPillar, fireplace, placeBed, sideTable,
} from './gen/furniture.js';
export {
  foundation, floor, exteriorWalls, timberColumns, timberBeams,
  windows, interiorWall, doorway, frontDoor, staircase,
  gabledRoof, chimney, wallTorches, porch,
} from './gen/structures.js';

// ─── 2D Rendering ────────────────────────────────────────────────────────────
export { renderFloorDetail, renderCutawayIso, renderExterior } from './render/png-renderer.js';

// ─── 3D Rendering ────────────────────────────────────────────────────────────
export { buildScene, serializeForViewer } from './render/three-scene.js';
export { startViewerServer, generateViewerHTML } from './render/server.js';
export { exportHTML } from './render/export-html.js';

// ─── Texture Atlas ──────────────────────────────────────────────────────────
export {
  ProceduralAtlas, getDefaultAtlas, initDefaultAtlas,
  getBlockFaceUV, getBlockUVs, buildAtlasForBlocks,
} from './render/texture-atlas.js';

// ─── Conversion ──────────────────────────────────────────────────────────────
export { schemToThree, gridToThree } from './convert/schem-to-three.js';
export { threeToSchem, threeToGrid } from './convert/three-to-schem.js';
