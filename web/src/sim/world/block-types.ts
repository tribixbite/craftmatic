/**
 * What a block IS to the engine: its collision boxes, whether a tap's ray can
 * select it, whether it is air or liquid, and its friction - for every
 * permutation (type + states).
 *
 * Custom blocks come from the behaviour packs' `blocks/*.json`, read as the
 * game reads them: the base `components`, then every `permutations[]` entry
 * whose Molang `condition` holds over the states, in order, each overriding
 * the components it names. `minecraft:collision_box` / `selection_box` are
 * `true` (a full cube), `false` (none) or `{ origin, size }` in pixels with
 * the origin's x/z measured from the block's centre and y from its bottom.
 *
 * Vanilla blocks come from a small table of the shapes the simulator meets:
 * the flat world's terrain, the lights and doors the runtimes set, water for
 * a boat's pool. Anything the table does not name is a full, selectable cube
 * and is COUNTED (`unknownVanilla`), so a report can say which vanilla shapes
 * were guessed.
 */

import { compileCondition, type Condition } from './molang.js';
import type { Box } from '../core/vec.js';

/** A block's states. Bedrock stores booleans as bytes in NBT; both forms are accepted. */
export type BlockStates = Record<string, string | number | boolean>;

/** A permutation's physical shape, boxes in block units relative to the block's minimum corner. */
export interface BlockShape {
  collision: readonly Box[];
  /** Boxes a ray can select; empty = the ray passes (`selection_box: false`). */
  selection: readonly Box[];
  isAir: boolean;
  isLiquid: boolean;
  friction: number;
}

const FULL: Box = { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
const NONE: readonly Box[] = [];
const AIR_SHAPE: BlockShape = { collision: NONE, selection: NONE, isAir: true, isLiquid: false, friction: 0.6 };
const SOLID_SHAPE: BlockShape = { collision: [FULL], selection: [FULL], isAir: false, isLiquid: false, friction: 0.6 };

/**
 * A pixel box (`origin` x/z from the centre, y from the bottom) as block-unit
 * boxes: `true` a full cube, `false` none, one `{ origin, size }`, or an ARRAY
 * of them (the clearance forms' floor + wall; Bedrock takes several boxes).
 * Undefined when the value is none of these.
 */
function pixelBox(v: unknown): Box[] | undefined {
  if (v === true) return [FULL];
  if (v === false) return [];
  if (Array.isArray(v)) {
    const out: Box[] = [];
    for (const one of v) { const b = pixelBox(one); if (!b) return undefined; out.push(...b); }
    return out;
  }
  if (v && typeof v === 'object' && Array.isArray((v as { origin?: unknown }).origin) && Array.isArray((v as { size?: unknown }).size)) {
    const o = (v as { origin: number[] }).origin, s = (v as { size: number[] }).size;
    // The device MIRRORS x (quirk `block-collision-x-mirrored`, Pixel GameTest 2026-09-30):
    // a box declared at origin x o, size s stands on world x [8 - o - s, 8 - o] pixels.
    const x0 = (8 - o[0]! - s[0]!) / 16, y0 = o[1]! / 16, z0 = (o[2]! + 8) / 16;
    return [{ x0, y0, z0, x1: x0 + s[0]! / 16, y1: y0 + s[1]! / 16, z1: z0 + s[2]! / 16 }];
  }
  return undefined;
}

interface CustomBlock {
  id: string;
  base: Record<string, unknown>;
  permutations: Array<{ condition: Condition; components: Record<string, unknown> }>;
  /** Declared states and their allowed values (for `BlockPermutation.resolve` validation). */
  states: Map<string, Array<string | number | boolean> | { min: number; max: number }>;
}

/** The engine's block registry: custom blocks from the packs, a vanilla table for the rest. */
export class BlockTypes {
  private readonly custom = new Map<string, CustomBlock>();
  private readonly shapes = new Map<string, BlockShape>();
  /** Vanilla ids the table did not know, with how often their shape was asked for (each was treated as a full cube). */
  readonly unknownVanilla = new Map<string, number>();
  /** Problems met while reading block files (a bad condition, bad JSON). */
  readonly loadErrors: string[] = [];

  /** Register a behaviour pack's `blocks/*.json` definition. */
  addDefinition(path: string, json: unknown): void {
    const b = (json as { 'minecraft:block'?: Record<string, unknown> })?.['minecraft:block'];
    const description = b?.['description'] as { identifier?: string; states?: Record<string, unknown> } | undefined;
    if (!b || !description?.identifier) { this.loadErrors.push(`${path}: no minecraft:block description`); return; }
    const permutations: CustomBlock['permutations'] = [];
    for (const p of (b['permutations'] as Array<{ condition?: string; components?: Record<string, unknown> }> | undefined) ?? []) {
      try { permutations.push({ condition: compileCondition(String(p.condition ?? 'false')), components: p.components ?? {} }); }
      catch (e) { this.loadErrors.push(`${path}: ${(e as Error).message}`); }
    }
    const states = new Map<string, Array<string | number | boolean> | { min: number; max: number }>();
    for (const [k, v] of Object.entries(description.states ?? {})) {
      if (Array.isArray(v)) states.set(k, v as Array<string | number | boolean>);
      else if (v && typeof v === 'object' && 'values' in v) {
        const values = (v as { values: unknown }).values;
        if (Array.isArray(values)) states.set(k, values as Array<string | number | boolean>);
        else if (values && typeof values === 'object') states.set(k, { min: Number((values as { min: number }).min), max: Number((values as { max: number }).max) });
      }
    }
    this.custom.set(description.identifier, { id: description.identifier, base: (b['components'] as Record<string, unknown>) ?? {}, permutations, states });
  }

  /** Whether a pack defines this block. */
  isCustom(typeId: string): boolean { return this.custom.has(typeId); }

  /** Whether the type exists at all (a custom definition, or a vanilla id). */
  exists(typeId: string): boolean { return this.custom.has(typeId) || typeId.startsWith('minecraft:'); }

  /** The declared states of a custom block (undefined for vanilla). */
  declaredStates(typeId: string): CustomBlock['states'] | undefined { return this.custom.get(typeId)?.states; }

  /** The shape of a permutation, memoised. */
  shape(typeId: string, states: BlockStates): BlockShape {
    const key = permutationKey(typeId, states);
    let s = this.shapes.get(key);
    if (!s) this.shapes.set(key, s = this.computeShape(typeId, states));
    return s;
  }

  private computeShape(typeId: string, states: BlockStates): BlockShape {
    const c = this.custom.get(typeId);
    if (c) {
      const comps: Record<string, unknown> = { ...c.base };
      for (const p of c.permutations) {
        let hit = false;
        try { hit = Boolean(p.condition(states)); } catch { hit = false; }
        if (hit) Object.assign(comps, p.components);
      }
      const collision = pixelBox(comps['minecraft:collision_box']) ?? [FULL];
      const selection = pixelBox(comps['minecraft:selection_box']) ?? [FULL];
      const friction = typeof comps['minecraft:friction'] === 'number' ? comps['minecraft:friction'] as number : 0.6;
      return { collision, selection, isAir: false, isLiquid: false, friction };
    }
    return this.vanillaShape(typeId, states);
  }

  /**
   * The vanilla shapes the simulator meets. A door's panel follows Bedrock's
   * legacy `direction` (0 south-facing... the panel on the hinge wall) - see
   * the TODO below.
   */
  private vanillaShape(typeId: string, states: BlockStates): BlockShape {
    const id = typeId.replace(/^minecraft:/, '');
    if (id === 'air' || id === 'structure_void' || id.startsWith('light_block') || id === 'cave_air' || id === 'void_air') return AIR_SHAPE;
    if (/^(flowing_)?(water|lava)$/.test(id)) return { collision: NONE, selection: NONE, isAir: false, isLiquid: true, friction: 0.6 };
    if (/(^|_)(short_grass|tall_grass|fern|flower|poppy|dandelion|sapling|torch|vine|rail|lever|button|redstone_wire|deadbush|seagrass|kelp)/.test(id) || id === 'grass') return { collision: NONE, selection: [FULL], isAir: false, isLiquid: false, friction: 0.6 };
    if (/_carpet$|^carpet$/.test(id)) return { collision: [{ ...FULL, y1: 1 / 16 }], selection: [{ ...FULL, y1: 1 / 16 }], isAir: false, isLiquid: false, friction: 0.6 };
    if (/_slab$/.test(id) && !/double/.test(id)) {
      const top = states['minecraft:vertical_half'] === 'top' || states['top_slot_bit'] === 1 || states['top_slot_bit'] === true;
      const b = top ? { ...FULL, y0: 0.5 } : { ...FULL, y1: 0.5 };
      return { collision: [b], selection: [b], isAir: false, isLiquid: false, friction: 0.6 };
    }
    if (/_door$/.test(id) && !/trapdoor$/.test(id)) {
      const panel = doorPanel(states);
      return { collision: [panel], selection: [panel], isAir: false, isLiquid: false, friction: 0.6 };
    }
    if (/_stairs$/.test(id)) {
      const boxes = stairBoxes(states);
      return { collision: boxes, selection: boxes, isAir: false, isLiquid: false, friction: 0.6 };
    }
    if (!/^(grass_block|dirt|bedrock|stone|glass|barrier|planks|oak_planks|cobblestone|sand|gravel|redstone_lamp|lit_redstone_lamp|concrete|wool|.*_concrete|.*_wool|.*_planks|.*_log|.*_block)$/.test(id)) {
      this.unknownVanilla.set(typeId, (this.unknownVanilla.get(typeId) ?? 0) + 1);
    }
    return SOLID_SHAPE;
  }
}

/** A door's facing (`minecraft:cardinal_direction`, or the legacy `direction` int in the exporter's order: south 0, west 1, north 2, east 3; bedrock-blocks.ts). */
function doorFacing(states: BlockStates): 'south' | 'west' | 'north' | 'east' {
  const c = states['minecraft:cardinal_direction'];
  if (c === 'south' || c === 'west' || c === 'north' || c === 'east') return c;
  return (['south', 'west', 'north', 'east'] as const)[((Number(states['direction'] ?? 0) % 4) + 4) % 4]!;
}

/**
 * A vanilla door's panel, 3/16 thick (quirk `vanilla-door-shape`, ASSUMED): Java's `DoorBlock.getShape` table read
 * through Bedrock's states - a door FACING f (the way the player faced placing it; "a door facing east occupies the
 * west part of its block when closed", minecraft.wiki "Door", Bedrock block states) stands closed on the side
 * opposite f; open, it swings to the side its hinge (`door_hinge_bit`: false left, true right, seen facing the same
 * way) puts it. Not measured on a Bedrock device: the runtime's vanilla doors exist only above the wand's measured
 * door step (DOOR-02).
 */
export function doorPanel(states: BlockStates): Box {
  const t = 3 / 16;
  const south = { ...FULL, z1: t }, north = { ...FULL, z0: 1 - t }, west = { ...FULL, x0: 1 - t }, east = { ...FULL, x1: t };
  const open = states['open_bit'] === 1 || states['open_bit'] === true;
  const right = states['door_hinge_bit'] === 1 || states['door_hinge_bit'] === true;
  switch (doorFacing(states)) {
    case 'east': return !open ? east : right ? north : south;
    case 'south': return !open ? south : right ? east : west;
    case 'west': return !open ? west : right ? south : north;
    case 'north': return !open ? north : right ? west : east;
  }
}

/**
 * A straight stair's boxes (quirk `vanilla-door-shape` covers the same ASSUMED reading): the bottom half, and the top
 * half on the side it FACES (`weirdo_direction` in the exporter's order: east 0, west 1, south 2, north 3), both
 * mirrored when `upside_down_bit`. Corner stairs (Java's `shape` inner/outer, computed from the neighbours) are not
 * modelled: a corner reads as a straight stair (`TODO(sim-vanilla)`).
 */
export function stairBoxes(states: BlockStates): Box[] {
  const up = states['upside_down_bit'] === 1 || states['upside_down_bit'] === true;
  const base: Box = up ? { ...FULL, y0: 0.5 } : { ...FULL, y1: 0.5 };
  const half: Box = up ? { ...FULL, y1: 0.5 } : { ...FULL, y0: 0.5 };
  const d = ((Number(states['weirdo_direction'] ?? 0) % 4) + 4) % 4;
  const step = d === 0 ? { ...half, x0: 0.5 } : d === 1 ? { ...half, x1: 0.5 } : d === 2 ? { ...half, z0: 0.5 } : { ...half, z1: 0.5 };
  return [base, step];
}

/** A permutation's stable key: the type and its states sorted by name. */
export function permutationKey(typeId: string, states: BlockStates): string {
  const keys = Object.keys(states);
  if (!keys.length) return typeId;
  keys.sort();
  return `${typeId}[${keys.map(k => `${k}=${String(states[k])}`).join(',')}]`;
}
