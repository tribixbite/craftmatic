/**
 * Bedrock block-mapping lint — the gate that stops the Bedrock export exporting
 * holes.
 *
 * The failure this exists for is the one an external Java→Bedrock converter
 * makes: Java ids and Bedrock ids mostly agree, so a mapping table LOOKS fine
 * while silently missing the ~15 that differ. Every one of those becomes air (a
 * hole) or, worse, the wrong material — `minecraft:stone_stairs` exists in BOTH
 * editions and means DIFFERENT blocks. And a Java state name that Bedrock does
 * not have (`facing`, `type`, `half`) makes the whole permutation unresolvable,
 * so the block falls back to its default: every stair faces one way.
 *
 * So this asserts, offline:
 *   • EVERY id `mc-block-registry.json` allows us to emit has a Bedrock mapping
 *     — no gaps, and no silent fallback (`toBedrockBlock` returns null);
 *   • the target ids exist in Mojang's own published Bedrock registry
 *     (`bedrock-block-states.json`, generated from `bedrock-samples`);
 *   • the rename table in the generator and in the module agree, so the two
 *     copies cannot drift;
 *   • the state translations produce the exact names, types and values Bedrock
 *     documents — including the traps (double slab is its own block; Java's
 *     wall "low" is Bedrock's "short"; stairs get an int, not a string).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  toBedrockBlock, toBedrockPalette, parseJavaState, isBedrockBlock, bedrockStateNames,
  JAVA_TO_BEDROCK_ID, WEIRDO_DIRECTION, FACING_DIRECTION,
} from '../web/src/engine/bedrock-blocks.js';
import { knownBlockIds } from '../web/src/engine/palette-lint.js';
import { LDRAW_COLOR_TO_BLOCK } from '../web/src/engine/ldraw-colors.js';
import { STUDIO_COLOR_TO_BLOCK } from '../web/src/engine/studio-colors.js';
import { BLOCK_PROFILES } from '../web/src/engine/block-profiles.js';

describe('coverage — nothing we can emit is unmapped', () => {
  it('every id in the registry maps to a real Bedrock block', () => {
    const gaps: string[] = [];
    for (const id of knownBlockIds()) {
      if (!toBedrockBlock(`minecraft:${id}`)) gaps.push(id);
    }
    expect(gaps).toEqual([]);
    expect(knownBlockIds().size).toBeGreaterThan(300);
  });

  it('every colour-table entry maps (both colour spaces, both profiles)', () => {
    const entries = [
      ...Object.values(LDRAW_COLOR_TO_BLOCK),
      ...Object.values(STUDIO_COLOR_TO_BLOCK),
      ...BLOCK_PROFILES.map(p => p.lightBlock),
      ...BLOCK_PROFILES.flatMap(p => (p.lightElement ? [p.lightElement] : [])),
    ];
    const r = toBedrockPalette(entries);
    expect(r.unmapped).toEqual([]);
    expect(entries.length).toBeGreaterThan(200);
  });

  it('every slab and stair state the shape passes emit maps', () => {
    const entries: string[] = [];
    for (const id of knownBlockIds()) {
      if (id.endsWith('_slab')) {
        for (const type of ['bottom', 'top', 'double']) entries.push(`minecraft:${id}[type=${type}]`);
      }
      if (id.endsWith('_stairs')) {
        for (const facing of ['north', 'south', 'east', 'west']) {
          for (const half of ['bottom', 'top']) {
            entries.push(`minecraft:${id}[facing=${facing},half=${half},shape=straight]`);
          }
        }
      }
    }
    expect(entries.length).toBeGreaterThan(500);
    expect(toBedrockPalette(entries).unmapped).toEqual([]);
  });

  it('reports a gap rather than substituting a block', () => {
    expect(toBedrockBlock('minecraft:definitely_not_a_block')).toBeNull();
    const r = toBedrockPalette(['minecraft:white_concrete', 'minecraft:not_a_block']);
    expect(r.unmapped).toEqual(['minecraft:not_a_block']);
    // The slot is still filled — with air, never with a plausible-looking block
    // that would make the mistake invisible.
    expect(r.blocks[1]!.name).toBe('minecraft:air');
  });
});

describe('the ids that genuinely differ between editions', () => {
  it('renames the Java-only names', () => {
    const cases: Array<[string, string]> = [
      ['minecraft:bricks', 'minecraft:brick_block'],
      ['minecraft:nether_bricks', 'minecraft:nether_brick'],
      ['minecraft:red_nether_bricks', 'minecraft:red_nether_brick'],
      ['minecraft:end_stone_bricks', 'minecraft:end_bricks'],
      ['minecraft:snow_block', 'minecraft:snow'],
      ['minecraft:magma_block', 'minecraft:magma'],
      ['minecraft:slime_block', 'minecraft:slime'],
      ['minecraft:rooted_dirt', 'minecraft:dirt_with_roots'],
      ['minecraft:jack_o_lantern', 'minecraft:lit_pumpkin'],
      ['minecraft:light_gray_glazed_terracotta', 'minecraft:silver_glazed_terracotta'],
      ['minecraft:terracotta', 'minecraft:hardened_clay'],
      ['minecraft:prismarine_brick_stairs', 'minecraft:prismarine_bricks_stairs'],
      ['minecraft:end_stone_brick_stairs', 'minecraft:end_brick_stairs'],
    ];
    for (const [java, bedrock] of cases) {
      expect(toBedrockBlock(java)?.name, java).toBe(bedrock);
    }
  });

  it('does NOT swap the stone/cobblestone stair pair — the most damaging trap', () => {
    // Both names exist in both editions and mean different materials. Bedrock's
    // `stone_stairs` is COBBLESTONE stairs; its stone stairs are
    // `normal_stone_stairs`. Getting this backwards is invisible in-game.
    expect(toBedrockBlock('minecraft:stone_stairs')?.name).toBe('minecraft:normal_stone_stairs');
    expect(toBedrockBlock('minecraft:cobblestone_stairs')?.name).toBe('minecraft:stone_stairs');
    expect(toBedrockBlock('minecraft:stone_slab')?.name).toBe('minecraft:normal_stone_slab');
  });

  it('leaves the (large) majority of ids alone', () => {
    // The flattening did most of the work — asserting this keeps someone from
    // "helpfully" adding renames that are not real.
    const ids = [...knownBlockIds()];
    const renamed = ids.filter(id => JAVA_TO_BEDROCK_ID[id]).length;
    expect(renamed).toBeLessThan(30);
    for (const id of ['white_concrete', 'oak_planks', 'glass', 'glass_pane', 'iron_bars',
                      'glowstone', 'oak_stairs', 'quartz_slab', 'cobblestone_wall', 'oak_fence']) {
      expect(toBedrockBlock(`minecraft:${id}`)?.name).toBe(`minecraft:${id}`);
    }
  });
});

describe('state translation', () => {
  it('covers generated interiors, plants, workstations, containers, and decor', () => {
    const entries = [
      'rose_bush', 'sunflower', 'potted_cornflower', 'peony', 'azalea_leaves[persistent=true]',
      'furnace[facing=north,lit=false]', 'wall_torch[facing=east]', 'chain', 'bookshelf',
      'barrel[facing=up]', 'smoker', 'red_carpet', 'blast_furnace', 'lilac',
      'spruce_trapdoor[facing=south,half=top,open=true]', 'red_wall_banner[facing=south]',
      'crafting_table', 'candle[candles=3,lit=true]', 'campfire[lit=true]',
      'stone_bricks_slab[type=bottom]', 'chest[facing=west]', 'water_cauldron[level=3]',
      'dark_oak_fence_gate[facing=north,open=true]',
      'dark_oak_door[facing=north,half=upper,hinge=right,open=true]', 'end_rod[facing=up]',
      'bell[facing=north]', 'red_bed[part=head,facing=north]', 'armor_stand',
      'oak_wall_sign[facing=north]', 'white_banner[rotation=3]', 'composter[level=3]',
      'cartography_table', 'lectern[facing=north]', 'brewing_stand', 'potted_oxeye_daisy',
    ].map(id => `minecraft:${id}`);
    expect(toBedrockPalette(entries).unmapped).toEqual([]);
    expect(toBedrockBlock('minecraft:dark_oak_door[facing=north,half=upper,hinge=right,open=true]')?.states)
      .toMatchObject({ direction: 2, upper_block_bit: true, door_hinge_bit: true, open_bit: true });
    expect(toBedrockBlock('minecraft:candle[candles=3,lit=true]')?.states)
      .toMatchObject({ candles: 2, lit: true });
    expect(toBedrockBlock('minecraft:water_cauldron[level=3]')?.states)
      .toMatchObject({ cauldron_liquid: 'water', fill_level: 6 });
  });
  it('slabs use minecraft:vertical_half, and a double slab is its own block', () => {
    expect(toBedrockBlock('minecraft:oak_slab[type=bottom]')).toEqual({
      name: 'minecraft:oak_slab', states: { 'minecraft:vertical_half': 'bottom' },
    });
    expect(toBedrockBlock('minecraft:oak_slab[type=top]')).toEqual({
      name: 'minecraft:oak_slab', states: { 'minecraft:vertical_half': 'top' },
    });
    // Bedrock has no `type=double` state — a double slab is a separate id. A
    // converter that ignores this turns a full block into a half block.
    expect(toBedrockBlock('minecraft:oak_slab[type=double]')).toEqual({
      name: 'minecraft:oak_double_slab', states: { 'minecraft:vertical_half': 'bottom' },
    });
    // …and where the word "double" goes is not a rule, it is data.
    expect(toBedrockBlock('minecraft:waxed_cut_copper_slab[type=double]')?.name)
      .toBe('minecraft:waxed_double_cut_copper_slab');
    expect(toBedrockBlock('minecraft:stone_slab[type=double]')?.name)
      .toBe('minecraft:normal_stone_double_slab');
  });

  it('stairs use weirdo_direction (int) + upside_down_bit (bool), and drop `shape`', () => {
    expect(toBedrockBlock('minecraft:oak_stairs[facing=east,half=bottom,shape=straight]')).toEqual({
      name: 'minecraft:oak_stairs', states: { upside_down_bit: false, weirdo_direction: 0 },
    });
    expect(toBedrockBlock('minecraft:oak_stairs[facing=north,half=top,shape=outer_left]')).toEqual({
      name: 'minecraft:oak_stairs', states: { upside_down_bit: true, weirdo_direction: 3 },
    });
    // Bedrock vanilla stairs have no `shape` — it must not leak through, or the
    // permutation is unresolvable.
    expect(Object.keys(toBedrockBlock('minecraft:oak_stairs[shape=inner_left]')!.states).sort())
      .toEqual(['upside_down_bit', 'weirdo_direction']);
  });

  it('maps stair facing by the shared legacy data values', () => {
    expect(WEIRDO_DIRECTION).toEqual({ east: 0, west: 1, south: 2, north: 3 });
    for (const [facing, expected] of Object.entries(WEIRDO_DIRECTION)) {
      expect(toBedrockBlock(`minecraft:stone_brick_stairs[facing=${facing}]`)!.states['weirdo_direction'])
        .toBe(expected);
    }
  });

  it('maps ladder facing to the facing_direction int', () => {
    expect(FACING_DIRECTION).toEqual({ down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 });
    expect(toBedrockBlock('minecraft:ladder[facing=west,waterlogged=false]')).toEqual({
      name: 'minecraft:ladder', states: { facing_direction: 4 },
    });
    // A block with facing_direction and no Java facing must still get a legal
    // HORIZONTAL value — the registry default is 0 (down), which these blocks
    // cannot face.
    expect(toBedrockBlock('minecraft:white_glazed_terracotta')!.states['facing_direction']).toBe(2);
  });

  it('spells a wall connection Bedrock\'s way (Java "low" is "short")', () => {
    const wall = toBedrockBlock('minecraft:cobblestone_wall[north=low,south=tall,east=none,west=low,up=true,waterlogged=false]');
    expect(wall).toEqual({
      name: 'minecraft:cobblestone_wall',
      states: {
        wall_connection_type_north: 'short',
        wall_connection_type_south: 'tall',
        wall_connection_type_east: 'none',
        wall_connection_type_west: 'short',
        wall_post_bit: true,
      },
    });
  });

  it('drops the connection states Bedrock computes itself', () => {
    // Panes, bars and fences carry NO connection states in Bedrock; it derives
    // them from the neighbours when the structure is placed.
    for (const entry of [
      'minecraft:glass_pane[east=true,north=false,south=true,west=false,waterlogged=false]',
      'minecraft:iron_bars[east=true,north=true,south=false,west=false,waterlogged=false]',
      'minecraft:oak_fence[east=true,north=false,south=false,west=true,waterlogged=false]',
    ]) {
      expect(toBedrockBlock(entry)!.states, entry).toEqual({});
    }
  });

  it('translates axis, hanging and fluid level', () => {
    expect(toBedrockBlock('minecraft:oak_log[axis=x]')!.states['pillar_axis']).toBe('x');
    expect(toBedrockBlock('minecraft:lantern[hanging=true,waterlogged=false]')!.states['hanging']).toBe(true);
    expect(toBedrockBlock('minecraft:lantern[hanging=false,waterlogged=false]')!.states['hanging']).toBe(false);
    expect(toBedrockBlock('minecraft:water[level=3]')!.states['liquid_depth']).toBe(3);
  });

  it('keeps leaves from decaying, which the registry default would not', () => {
    // persistent_bit defaults to false in vanilla; leaves placed with no log
    // nearby then decay and the canopy disappears minutes after placement.
    expect(toBedrockBlock('minecraft:oak_leaves')!.states['persistent_bit']).toBe(true);
  });

  it('emits a COMPLETE state set, not just the states we translated', () => {
    // Bedrock matches a permutation; a partial state set relies on its
    // undocumented legacy fallback. Every state the block has must be present.
    for (const id of ['cobblestone_wall', 'oak_stairs', 'oak_slab', 'bone_block', 'oak_leaves', 'water']) {
      const names = bedrockStateNames(id)!;
      const got = Object.keys(toBedrockBlock(`minecraft:${id}`)!.states).sort();
      expect(got, id).toEqual([...names].sort());
    }
  });

  it('gives a stateless block an empty state compound', () => {
    expect(toBedrockBlock('minecraft:white_concrete')).toEqual({
      name: 'minecraft:white_concrete', states: {},
    });
    expect(toBedrockBlock('minecraft:air')).toEqual({ name: 'minecraft:air', states: {} });
  });
});

describe('provenance', () => {
  it('the generated table comes from Mojang and is pinned, not from `main`', () => {
    const data = JSON.parse(readFileSync('web/src/engine/bedrock-block-states.json', 'utf8'));
    expect(data._source).toContain('Mojang/bedrock-samples');
    expect(data._source).toContain('mojang-blocks.json');
    // A floating ref would silently change what we ship.
    expect(data._generatedFrom).toMatch(/@v\d+\.\d+\.\d+\.\d+$/);
    expect(Object.keys(data.blocks).length).toBeGreaterThan(400);
  });

  it('the generator and the module agree on the rename table', () => {
    // Two copies exist (the generator has no build step and cannot import TS).
    // They must not drift, so the values are compared, not eyeballed.
    const src = readFileSync('scripts/gen-bedrock-blocks.mjs', 'utf8');
    const block = src.slice(src.indexOf('const RENAME = {'), src.indexOf('};', src.indexOf('const RENAME = {')));
    for (const [java, bedrock] of Object.entries(JAVA_TO_BEDROCK_ID)) {
      expect(block, `${java} → ${bedrock}`).toContain(`${java}: '${bedrock}'`);
    }
    // And no EXTRA entries in the generator that the module lacks.
    const inScript = [...block.matchAll(/^ {2}([a-z_0-9]+): '([a-z_0-9]+)',$/gm)];
    expect(inScript.length).toBe(Object.keys(JAVA_TO_BEDROCK_ID).length);
  });

  it('every mapping target is a block Mojang actually publishes', () => {
    for (const bedrockId of Object.values(JAVA_TO_BEDROCK_ID)) {
      expect(isBedrockBlock(bedrockId), bedrockId).toBe(true);
    }
  });
});

describe('parseJavaState', () => {
  it('splits an id from its properties', () => {
    expect(parseJavaState('minecraft:oak_stairs[facing=north,half=top]'))
      .toEqual({ id: 'oak_stairs', props: { facing: 'north', half: 'top' } });
    expect(parseJavaState('minecraft:stone')).toEqual({ id: 'stone', props: {} });
    expect(parseJavaState('stone')).toEqual({ id: 'stone', props: {} });
  });
});
