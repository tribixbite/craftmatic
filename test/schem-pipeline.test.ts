/**
 * The shared Minecraft-export pipeline (S4) — grid source, offline.
 *
 * Both tabs run through `runSchemPipeline`. The Upload tab's source is a
 * BlockGrid that ALREADY exists (a parsed .schem/.litematic/mesh), so the
 * pipeline must encode it and nothing else: no re-voxelization, no gap
 * filling, and — with the light-fill option off — bytes identical to calling
 * the encoder directly. That last property is the unit-level half of the S3/S5
 * byte-identity gate.
 *
 * (The bricks source's BLOCK output needs the LDraw parts library, so it's
 * covered by the scripted 21063 reference export instead — see
 * scripts/_schem_ref.ts. Its playable-add-on path, at the bottom of this file,
 * is exercised here against seeded part texts: no library, no network.)
 */

import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { parseUncompressed } from 'prismarine-nbt';
import { BlockGrid } from '../src/schem/types.js';
import { encodeSchemBytes, encodeLitematicBytes } from '../web/src/engine/schem-encode.js';
import { runSchemPipeline, type GridSource, type SchemWorkerFormat, type SchemWorkerInput } from '../web/src/engine/schem-pipeline.js';
import { DEFAULT_SCHEM_SETTINGS } from '../web/src/engine/schem-settings.js';
import { seedDatTexts } from '../web/src/engine/ldraw-geometry.js';
import { sceneFloorPoint, sceneGridPoint } from '../web/src/engine/bedrock-scene-actors.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { bedrockInGameText } from '../web/src/engine/playable-addon.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

/** Hollow stone box (sealed interior) inside a 1-cell air margin. */
function hollowBox(): BlockGrid {
  const n = 10;
  const g = new BlockGrid(n, n, n);
  for (let y = 1; y <= n - 2; y++)
    for (let z = 1; z <= n - 2; z++)
      for (let x = 1; x <= n - 2; x++) g.set(x, y, z, 'minecraft:stone');
  for (let y = 2; y <= n - 3; y++)
    for (let z = 2; z <= n - 3; z++)
      for (let x = 2; x <= n - 3; x++) g.set(x, y, z, 'minecraft:air');
  return g;
}

function asSource(g: BlockGrid): GridSource {
  return {
    kind: 'grid',
    width: g.width, height: g.height, length: g.length,
    data: new Uint16Array(g.rawData),
    palette: g.reversePalette(),
  };
}

async function paletteOf(bytes: Uint8Array): Promise<string[]> {
  const nbt = await parseUncompressed(Buffer.from(gunzipSync(Buffer.from(bytes))), 'big');
  const root = nbt.value as Record<string, { value: unknown }>;
  return Object.keys(root['Palette']!.value as Record<string, unknown>);
}

describe('runSchemPipeline — grid source', () => {
  it('with default settings is byte-identical to encoding the grid directly', async () => {
    const g = hollowBox();
    const direct = encodeSchemBytes(g);
    const r = await runSchemPipeline({
      source: asSource(g), format: 'schem',
      profile: DEFAULT_SCHEM_SETTINGS.profile, lightFill: DEFAULT_SCHEM_SETTINGS.lightFill, shapes: false,
    });
    expect(r.lights).toBe(0);
    expect(r.bytes).toEqual(direct);
  });

  it('does the same for .litematic', async () => {
    const g = hollowBox();
    // Fixed timestamp: the litematic header embeds "now" otherwise.
    const direct = encodeLitematicBytes(g, 1_700_000_000);
    const r = await runSchemPipeline({
      source: asSource(g), format: 'litematic', profile: 'default', lightFill: false, shapes: false,
    });
    // The two embedded TimeCreated/TimeModified longs differ (the pipeline
    // stamps "now"), which perturbs the gzip stream length — compare the
    // UNCOMPRESSED NBT, where those longs are 8 fixed bytes each.
    expect(gunzipSync(Buffer.from(r.bytes!)).length).toBe(gunzipSync(Buffer.from(direct)).length);
    expect(r.nonAir).toBe(g.countNonAir());
  });

  it('does NOT re-voxelize or gap-fill an uploaded grid', async () => {
    // A single air cell fully surrounded by stone: the LEGO path's
    // fillSingleVoxelGaps would close it. An uploaded model must survive as-is.
    const g = new BlockGrid(5, 5, 5);
    for (let y = 1; y <= 3; y++)
      for (let z = 1; z <= 3; z++)
        for (let x = 1; x <= 3; x++) g.set(x, y, z, 'minecraft:stone');
    g.set(2, 2, 2, 'minecraft:air');
    const before = g.countNonAir();
    const r = await runSchemPipeline({
      source: asSource(g), format: 'schem', profile: 'default', lightFill: false, shapes: false,
    });
    expect(r.nonAir).toBe(before);
    expect(r.grid.get(2, 2, 2)).toBe('minecraft:air');
  });

  it('lights enclosed interiors when the option is ON (and only then)', async () => {
    const g = hollowBox();
    const off = await runSchemPipeline({
      source: asSource(g), format: 'schem', profile: 'default', lightFill: false, shapes: false,
    });
    const on = await runSchemPipeline({
      source: asSource(g), format: 'schem', profile: 'default', lightFill: true, shapes: false,
    });

    expect(off.lights).toBe(0);
    expect(on.lights).toBeGreaterThan(0);
    expect(on.nonAir).toBe(off.nonAir + on.lights);
    expect(on.bytes).not.toEqual(off.bytes);
    expect(await paletteOf(off.bytes!)).not.toContain('minecraft:glowstone');
    expect(await paletteOf(on.bytes!)).toContain('minecraft:glowstone');
  });

  it('passes coverage, lamp style and spacing through the shared exporter', async () => {
    const g = new BlockGrid(16, 8, 16);
    for (let x = 1; x < 15; x++) for (let z = 1; z < 15; z++) {
      g.set(x, 1, z, 'minecraft:stone'); g.set(x, 6, z, 'minecraft:stone');
    }
    const base = { source: asSource(g), format: 'guide' as const, profile: 'default', lightFill: true, shapes: false };
    const sealed = await runSchemPipeline(base);
    const dense = await runSchemPipeline({ ...base, lightCoverage: 'covered', lightStyle: 'sea_lantern', lightSpacing: 3 });
    const sparse = await runSchemPipeline({ ...base, lightCoverage: 'covered', lightStyle: 'sea_lantern', lightSpacing: 10 });
    expect(sealed.lights).toBe(0);
    expect(dense.lights).toBeGreaterThan(sparse.lights);
    expect(dense.grid.reversePalette()).toContain('minecraft:sea_lantern');
  });

  it('returns the grid (and no bytes) for the build-guide format', async () => {
    const g = hollowBox();
    const r = await runSchemPipeline({
      source: asSource(g), format: 'guide', profile: 'default', lightFill: false, shapes: false,
    });
    expect(r.bytes).toBeUndefined();
    expect(r.grid.width).toBe(g.width);
    expect(r.nonAir).toBe(g.countNonAir());
  });

  it('reports progress phases to its callback', async () => {
    const phases: string[] = [];
    await runSchemPipeline(
      { source: asSource(hollowBox()), format: 'schem', profile: 'default', lightFill: true, shapes: false },
      (phase) => phases.push(phase),
    );
    expect(phases).toContain('lighting interiors');
    expect(phases).toContain('writing NBT');
  });

  it('exports Java 1.19.4+ block_display entities function', async () => {
    const g = new BlockGrid(3, 2, 2);
    g.set(0, 0, 0, 'minecraft:gold_block');
    g.set(1, 0, 0, 'minecraft:gold_block');
    const r = await runSchemPipeline({
      source: asSource(g),
      format: 'display',
      profile: 'default',
      lightFill: false,
      shapes: false,
      packStem: 'gold_statue',
    });
    expect(r.bytes).toBeDefined();
    const text = new TextDecoder().decode(r.bytes);
    expect(text).toContain('summon block_display');
    expect(text).toContain('gold_statue');
    expect(r.mcpack?.tileCount).toBe(1); // 2 merged blocks
  });
});

/**
 * Bricks source, `.mcaddon`: where the scene's actors stand, and the measured
 * walk-through size the pack carries.
 *
 * Both need real part geometry, so the model is seeded (`seedDatTexts`) exactly
 * as the LEGO tab seeds the Worker — no network, no local library.
 */
describe('runSchemPipeline — bricks source, playable add-on', () => {
  const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
    const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
    return [
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    ];
  };
  /** Library descriptions with stand-in boxes at the moulds' real extents. */
  const PARTS: Record<string, string> = {
    // A BASEPLATE: 8 LDU (one plate) thick, its underside at LDraw y = 0.
    '3029': ['0 Plate  4 x 12', ...box6(-240, 240, -8, 0, -240, 240)].join('\n'),
    '973': ['0 Minifig Torso', ...box6(-19, 19, -12, 32, -10, 10)].join('\n'),
    '3626': ['0 Minifig Head', ...box6(-13, 13, 0, 24, -13, 13)].join('\n'),
    '3815': ['0 Minifig Hips', ...box6(-18, 18, -11, 21, -10, 10)].join('\n'),
    '3816': ['0 Minifig Leg Left', ...box6(-19.5, -1.5, -9, 28, -11, 9)].join('\n'),
    '3817': ['0 Minifig Leg Right', ...box6(1.5, 19.5, -9, 28, -11, 9)].join('\n'),
    // A door LEAF 80 LDU wide and 96 tall: 1.5 × 1.8 blocks at 100 %, so the
    // player's two-block passage needs 150 % — a recommendation that is NOT
    // the exported size, which is the case worth pinning.
    '60623': ['0 Door  1 x  4 x  6 with 4 Panes and Stud Handle', ...box6(0, 80, -96, 0, -3, 3)].join('\n'),
  };
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** A minifig whose FEET are at `footLdu` (its legs reach 64 LDU below the placement origin). */
  const figure = (x: number, z: number, footLdu: number): ParsedBrick[] => {
    const d = footLdu - 64;
    return [
      { part: '3816.dat', color: 25, x, y: 36 + d, z, rot: I }, { part: '3817.dat', color: 25, x, y: 36 + d, z, rot: I },
      { part: '3815.dat', color: 8, x, y: 24 + d, z, rot: I }, { part: '973.dat', color: 25, x, y: -8 + d, z, rot: I },
      { part: '3626.dat', color: 14, x, y: -32 + d, z, rot: I },
    ];
  };
  /**
   * The baseplate is placed a plate BELOW the build origin, so its underside
   * (LDraw y = 8, the model's `groundLdu`) is not on a cell boundary — which is
   * the whole point: the voxelizer's surface pass rounds those 8 LDU into grid
   * row 0, so the grid's row-0 bottom sits a plate ABOVE the pin plane.
   */
  const PLATE_BOTTOM_LDU = 8;
  /** The plate's top surface: where a figure standing ON the baseplate has its feet. */
  const PLATE_TOP_LDU = 0;

  const brickInput = (bricks: ParsedBrick[], format: SchemWorkerFormat): SchemWorkerInput => ({
    source: { kind: 'bricks', bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
    format, profile: 'default', lightFill: false, shapes: false,
    packStem: 'floorfix', packLabel: 'Floor fix',
  });

  async function placementConfig(bytes: Uint8Array): Promise<any> {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const name = listZipEntries(buffer).find(e => e.endsWith('scripts/placement.js'))!;
    const script = new TextDecoder().decode(await extractFile(buffer, name));
    return JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(script)![1]!);
  }

  it('stands a figure on the drawn plate TOP, and one beside the model on the pin plane — not a plate under or over it', async () => {
    seedDatTexts(Object.entries(PARTS).map(([id, t]) => [`${id}.dat`, t] as const));
    const bricks: ParsedBrick[] = [
      { part: '3029.dat', color: 2, x: 0, y: PLATE_BOTTOM_LDU, z: 0, rot: I },
      ...figure(0, 0, PLATE_TOP_LDU),              // figure 1: on the baseplate
      ...figure(400, 0, PLATE_BOTTOM_LDU),         // figure 2: on the ground beside it
    ];
    // The same voxel frame the add-on path derives its actor positions in.
    const guide = await runSchemPipeline(brickInput(bricks, 'guide'));
    const frame = guide.gridOrigin!;
    const r = await runSchemPipeline(brickInput(bricks, 'mcaddon'));
    const config = await placementConfig(r.bytes!);
    const figs = ['figure 1', 'figure 2'].map(n => config.actors.find((a: any) => String(a.label).endsWith(n)));
    expect(figs.every(Boolean), 'both scene figures must become actors').toBe(true);
    const plate = 8 / LDU_PER_BLOCK;

    // What the voxel frame ALONE would have said: its row-0 bottom sits a plate
    // above the model's underside, so feet on that underside land BELOW zero —
    // the chalet's −0.15, one plate under the pin plane the shell and the
    // colliders stand on (and inside the grass at 400 %).
    expect(sceneGridPoint(frame, [0, PLATE_BOTTOM_LDU, 0])[1]).toBeCloseTo(-plate, 6);

    // Measured up from the model's underside instead, the figure beside the
    // model stands exactly on the pin plane: never inside the grass.
    expect(figs[1]!.y).toBeCloseTo(sceneFloorPoint(frame, PLATE_BOTTOM_LDU, [400, PLATE_BOTTOM_LDU, 0])[1], 6);
    expect(figs[1]!.y).toBeCloseTo(0, 6);
    // The one on the baseplate would stand a plate up in that frame (0.15),
    // but the shell and its colliders are laid in the GRID frame
    // (`sceneGridPoint`), where this baseplate is drawn from -0.15 to 0 and
    // lies under the pin plane, so no collider carries it. The export sets the
    // figure down on the surface under its feet (`resolveFigureSpawn`): the
    // ground at 0, which is the drawn plate's top - not 0.15 above it, where
    // it used to fall from at placement.
    expect(sceneFloorPoint(frame, PLATE_BOTTOM_LDU, [0, PLATE_TOP_LDU, 0])[1]).toBeCloseTo(plate, 6);
    expect(figs[0]!.y).toBeCloseTo(sceneGridPoint(frame, [0, PLATE_TOP_LDU, 0])[1], 6);
    expect(figs[0]!.y).toBeCloseTo(0, 6);
  }, 120_000);

  it('measures the walk-through size and carries it to the summary, the diagnostics and the wand', async () => {
    seedDatTexts(Object.entries(PARTS).map(([id, t]) => [`${id}.dat`, t] as const));
    const bricks: ParsedBrick[] = [
      { part: '3029.dat', color: 2, x: 0, y: PLATE_BOTTOM_LDU, z: 0, rot: I },
      { part: '60623.dat', color: 6, x: -40, y: PLATE_TOP_LDU, z: 0, rot: I },
      ...figure(200, 0, PLATE_TOP_LDU),
    ];
    const r = await runSchemPipeline(brickInput(bricks, 'mcaddon'));
    const access = r.mcpack?.access;
    expect(access, 'the pack summary carries the measurement').toBeTruthy();
    // Measured on the model's real door leaf: 1.5 x 1.8 blocks at 100 %, so the
    // first step that clears the player's 1x2 passage is 150 %.
    expect(access!.basis).toBe('door-leaves');
    expect(access!.sizePct).toBe(150);
    expect(access!.doorway?.count).toBe(1);
    expect(access!.reason).toMatch(/150 %/);
    // Said once in the export's warnings, with the reason WHOLE.
    expect(r.mcpack?.warnings).toContain(`Walk-through size: ${access!.reason}`);

    // …written into the pack's own diagnostics…
    const buffer = r.bytes!.buffer.slice(r.bytes!.byteOffset, r.bytes!.byteOffset + r.bytes!.byteLength) as ArrayBuffer;
    const diagName = listZipEntries(buffer).find(e => e.endsWith('/craftmatic-diagnostics.json'))!;
    const diagnostics = JSON.parse(new TextDecoder().decode(await extractFile(buffer, diagName)));
    expect(diagnostics.access).toEqual(access);

    // …and handed to the Brick Wand, which NAMES the step and quotes the reason
    // as Bedrock's form renderer can show it: a bare `%` is deleted there, so
    // the in-game string spells "percent" (`bedrockInGameText`, b3ec0c02); the
    // diagnostics above keep the measured `%`.
    const config = await placementConfig(r.bytes!);
    expect(config.access).toEqual({ sizePct: access!.sizePct, reason: bedrockInGameText(access!.reason) });
    // A recommendation only: nothing resized the export itself.
    expect(config.sizes).toEqual([25, 50, 75, 100, 150, 200, 300, 400]);
  }, 120_000);
});

