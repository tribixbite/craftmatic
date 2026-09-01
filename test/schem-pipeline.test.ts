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
 * (The bricks source needs the LDraw parts library, so it's covered by the
 * scripted 21063 reference export instead — see scripts/_schem_ref.ts.)
 */

import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { parseUncompressed } from 'prismarine-nbt';
import { BlockGrid } from '../src/schem/types.js';
import { encodeSchemBytes, encodeLitematicBytes } from '../web/src/engine/schem-encode.js';
import { runSchemPipeline, type GridSource } from '../web/src/engine/schem-pipeline.js';
import { DEFAULT_SCHEM_SETTINGS } from '../web/src/engine/schem-settings.js';

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
      profile: DEFAULT_SCHEM_SETTINGS.profile, lightFill: DEFAULT_SCHEM_SETTINGS.lightFill,
    });
    expect(r.lights).toBe(0);
    expect(r.bytes).toEqual(direct);
  });

  it('does the same for .litematic', async () => {
    const g = hollowBox();
    // Fixed timestamp: the litematic header embeds "now" otherwise.
    const direct = encodeLitematicBytes(g, 1_700_000_000);
    const r = await runSchemPipeline({
      source: asSource(g), format: 'litematic', profile: 'default', lightFill: false,
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
      source: asSource(g), format: 'schem', profile: 'default', lightFill: false,
    });
    expect(r.nonAir).toBe(before);
    expect(r.grid.get(2, 2, 2)).toBe('minecraft:air');
  });

  it('lights enclosed interiors when the option is ON (and only then)', async () => {
    const g = hollowBox();
    const off = await runSchemPipeline({
      source: asSource(g), format: 'schem', profile: 'default', lightFill: false,
    });
    const on = await runSchemPipeline({
      source: asSource(g), format: 'schem', profile: 'default', lightFill: true,
    });

    expect(off.lights).toBe(0);
    expect(on.lights).toBeGreaterThan(0);
    expect(on.nonAir).toBe(off.nonAir + on.lights);
    expect(on.bytes).not.toEqual(off.bytes);
    expect(await paletteOf(off.bytes!)).not.toContain('minecraft:glowstone');
    expect(await paletteOf(on.bytes!)).toContain('minecraft:glowstone');
  });

  it('returns the grid (and no bytes) for the build-guide format', async () => {
    const g = hollowBox();
    const r = await runSchemPipeline({
      source: asSource(g), format: 'guide', profile: 'default', lightFill: false,
    });
    expect(r.bytes).toBeUndefined();
    expect(r.grid.width).toBe(g.width);
    expect(r.nonAir).toBe(g.countNonAir());
  });

  it('reports progress phases to its callback', async () => {
    const phases: string[] = [];
    await runSchemPipeline(
      { source: asSource(hollowBox()), format: 'schem', profile: 'default', lightFill: true },
      (phase) => phases.push(phase),
    );
    expect(phases).toContain('lighting enclosed interiors');
    expect(phases).toContain('writing NBT');
  });
});
