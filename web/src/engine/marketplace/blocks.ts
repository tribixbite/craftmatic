/**
 * Our own brick blocks (M03, BIZ-23; plan A 7.3).
 *
 * The dev pack gives its building scenery the studded look by OVERWRITING vanilla `concrete_<colour>.png`, which
 * restyles every concrete block in the player's world (a Marketplace blocker). A profile pack with
 * `flags.brickBlocks` ships these blocks instead: `<ns>:brick_<colour>` (a full cube) and `<ns>:plate_<colour>` (a
 * third of a cube, the LEGO plate/brick height ratio 8:24), each textured with our own swatches under
 * `textures/blocks/craftmatic_brick_<colour>[_top].png`. The namespace rewriter (X-03) moves those under
 * `textures/blocks/<creator>/<pack>/` and renames the ids, like every other file of the dev pack.
 *
 * Neither block has states, so each costs exactly one permutation (34 in all, against the 10,000 limit).
 * Pure data: the pack writer (`playable-addon.ts`) places the files.
 */
import { CONCRETE_COLORS, generateStudBlockPng } from '../lego-resource-pack.js';

/** The block kinds: a full-height brick and a plate (one third of a brick). */
export const BRICK_BLOCK_KINDS = ['brick', 'plate'] as const;
export type BrickBlockKind = typeof BRICK_BLOCK_KINDS[number];

/** The colours a brick block comes in: the swatch palette the dev pack's concrete overrides use. */
export const BRICK_BLOCK_COLOURS: readonly string[] = Object.keys(CONCRETE_COLORS);

/**
 * The vanilla texture paths the dev pack overwrites (`textures/blocks/concrete_<colour>`): a Marketplace pack
 * must ship no file at any of them.
 */
export const VANILLA_CONCRETE_TEXTURE_PATHS: readonly string[] = BRICK_BLOCK_COLOURS.map(c => `textures/blocks/concrete_${c}`);

/** A plate is this fraction of a block tall: LEGO plate 8 LDU over brick 24 LDU. */
export const PLATE_HEIGHT_FRACTION = 8 / 24;

/** Block id of a colour in a namespace: `<ns>:brick_<colour>` or `<ns>:plate_<colour>`. */
export const brickBlockId = (namespace: string, colour: string, kind: BrickBlockKind): string => `${namespace}:${kind}_${colour}`;

/** The geometry id of the plate (a custom block shape; the brick uses the engine's full block). */
export const plateGeometryId = (namespace: string): string => `geometry.${namespace}.plate_block`;

/** Terrain-atlas keys of a colour's two swatches: the side (a plain face) and the top (studded). */
const sideKey = (namespace: string, colour: string): string => `${namespace}_brick_${colour}`;
const topKey = (namespace: string, colour: string): string => `${sideKey(namespace, colour)}_top`;

/**
 * `terrain_texture.json` `texture_data` entries of every brick block colour, key -> `{ textures }`
 * (a path without extension, as the atlas expects).
 */
export function brickBlockTextures(namespace: string): Record<string, { textures: string }> {
  const out: Record<string, { textures: string }> = {};
  for (const colour of BRICK_BLOCK_COLOURS) {
    for (const key of [sideKey(namespace, colour), topKey(namespace, colour)]) out[key] = { textures: `textures/blocks/${key}` };
  }
  return out;
}

/** The swatch PNG files (path -> bytes) of every colour: plain sides, studded top. */
export function brickBlockTextureFiles(namespace: string): Array<{ path: string; data: Uint8Array }> {
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const [colour, [r, g, b]] of Object.entries(CONCRETE_COLORS)) {
    out.push({ path: `textures/blocks/${sideKey(namespace, colour)}.png`, data: generateStudBlockPng(r, g, b, false) });
    out.push({ path: `textures/blocks/${topKey(namespace, colour)}.png`, data: generateStudBlockPng(r, g, b, true) });
  }
  return out;
}

/** A plate's collision box in Bedrock's pixel frame (origin from the block's bottom centre, 16 px per block). */
const PLATE_PX = 16 * PLATE_HEIGHT_FRACTION;

/**
 * The behaviour-pack definition of one brick block. A brick is the engine's full block; a plate declares
 * {@link plateGeometry} and a matching collision / selection box. Studded top (`up`), plain sides and bottom.
 */
export function brickBlockDefinition(namespace: string, colour: string, kind: BrickBlockKind): unknown {
  const material = {
    '*': { texture: sideKey(namespace, colour), render_method: 'opaque' },
    up: { texture: topKey(namespace, colour), render_method: 'opaque' },
  };
  const plate = kind === 'plate';
  return {
    format_version: '1.21.40',
    'minecraft:block': {
      description: {
        identifier: brickBlockId(namespace, colour, kind),
        menu_category: { category: 'construction', group: 'itemGroup.name.concrete' },
      },
      components: {
        'minecraft:geometry': plate ? plateGeometryId(namespace) : 'minecraft:geometry.full_block',
        'minecraft:material_instances': material,
        ...(plate ? {
          'minecraft:collision_box': { origin: [-8, 0, -8], size: [16, PLATE_PX, 16] },
          'minecraft:selection_box': { origin: [-8, 0, -8], size: [16, PLATE_PX, 16] },
        } : {}),
        'minecraft:destructible_by_mining': { seconds_to_destroy: 1 },
        'minecraft:destructible_by_explosion': { explosion_resistance: 3 },
        'minecraft:friction': 0.6,
        'minecraft:map_color': `#${CONCRETE_COLORS[colour]!.map(v => v.toString(16).padStart(2, '0')).join('')}`,
      },
    },
  };
}

/**
 * The plate's block geometry (`models/blocks/<ns>_plate.geo.json`): one cube a third of a block tall. Per-face UVs
 * so the 16 x 16 swatch maps onto the top and the plain side texture is cropped, not stretched, on the sides.
 */
export function plateGeometry(namespace: string): unknown {
  const side = { uv: [0, 0], uv_size: [16, PLATE_PX] };
  const flat = { uv: [0, 0], uv_size: [16, 16] };
  return {
    format_version: '1.21.0',
    'minecraft:geometry': [{
      description: { identifier: plateGeometryId(namespace), texture_width: 16, texture_height: 16 },
      bones: [{
        name: 'plate', pivot: [0, 0, 0],
        cubes: [{ origin: [-8, 0, -8], size: [16, PLATE_PX, 16], uv: { north: side, south: side, east: side, west: side, up: flat, down: flat } }],
      }],
    }],
  };
}

/** `en_US.lang` lines: a block's name (`tile.<id>.name`), `Red Brick Block`, `Light Gray Plate Block`. */
export function brickBlockLangLines(namespace: string): string[] {
  const title = (c: string): string => c.split('_').map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  return BRICK_BLOCK_COLOURS.flatMap(c => BRICK_BLOCK_KINDS.map(k => `tile.${brickBlockId(namespace, c, k)}.name=${title(c)} ${k === 'brick' ? 'Brick' : 'Plate'} Block`));
}

/**
 * A grid palette (block-state strings) with every vanilla dyed concrete respelled as this pack's brick block of the
 * same colour: `minecraft:red_concrete` -> `<ns>:brick_red` (T02-fix, BIZ-26; plan A 7.3). A coloured-block export
 * writes its structure from the grid's palette, so without this a `brickBlocks` pack declares its 32 blocks and the
 * placement still writes the vanilla concrete whose texture the pack is no longer allowed to override. Entries that
 * are not one of the swatch colours pass through; the order (the palette indices) is kept.
 */
export function brickBlockPalette(palette: readonly string[], namespace: string): string[] {
  const colours = new Set(BRICK_BLOCK_COLOURS);
  return palette.map(entry => {
    const m = /^minecraft:([a-z_]+)_concrete$/.exec(entry);
    return m && colours.has(m[1]!) ? brickBlockId(namespace, m[1]!, 'brick') : entry;
  });
}
