/**
 * .schem export round-trip — proves the Minecraft export (the LEGO→Minecraft
 * half of the project) produces a VALID, WorldEdit-compatible Sponge v2
 * schematic, not just "some bytes".
 *
 * The encoder (web/src/viewer/exporter.ts `encodeSchemBytes`) hand-writes NBT;
 * the verifier parses it back with prismarine-nbt (the same spec-correct NBT
 * lib real tools use) via the project's own parser. If dims/palette/every
 * voxel survive the trip, the file is structurally real and openable.
 *
 * Offline + deterministic — no network, no GPU, no DOM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { parseUncompressed } from 'prismarine-nbt';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockGrid } from '../src/schem/types.js';
import { parseToGrid } from '../src/schem/parse.js';
import { encodeSchemBytes } from '../web/src/viewer/exporter.js';
import { describeAccessRecommendation, getAccessRecommendation } from '../web/src/ui/schem-export.js';

// A small grid with several distinct blocks + air gaps, exercising the
// palette, varint block data, and YZX ordering.
function buildGrid(): BlockGrid {
  const g = new BlockGrid(3, 4, 5); // W×H×L
  g.set(0, 0, 0, 'minecraft:red_concrete');
  g.set(2, 0, 4, 'minecraft:blue_concrete');
  g.set(1, 3, 2, 'minecraft:white_concrete');
  g.set(2, 1, 0, 'minecraft:red_concrete'); // reuse a palette entry
  g.set(0, 3, 4, 'minecraft:lime_concrete');
  return g;
}

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'craftmatic-schem-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('encodeSchemBytes → Sponge v2 .schem', () => {
  it('produces gzipped NBT that prismarine-nbt parses with the spec fields', async () => {
    const bytes = encodeSchemBytes(buildGrid());
    expect(bytes[0]).toBe(0x1f); // gzip magic
    expect(bytes[1]).toBe(0x8b);

    const nbt = await parseUncompressed(Buffer.from(gunzipSync(Buffer.from(bytes))), 'big');
    const root = nbt.value as Record<string, { type: string; value: unknown }>;
    // Sponge v2: root compound named "Schematic"; fields are direct children.
    expect(nbt.name).toBe('Schematic');
    expect(root['Version']!.value).toBe(2);
    expect(root['Width']!.value).toBe(3);
    expect(root['Height']!.value).toBe(4);
    expect(root['Length']!.value).toBe(5);
    expect(root['Palette']).toBeDefined();
    expect(root['BlockData']!.type).toBe('byteArray');
    // DataVersion present (consumers reject schematics without it)
    expect(typeof root['DataVersion']!.value).toBe('number');
  });

  it('round-trips dimensions, palette, and every voxel through the parser', async () => {
    const grid = buildGrid();
    const file = join(tmp, 'roundtrip.schem');
    writeFileSync(file, encodeSchemBytes(grid));

    const back = await parseToGrid(file);
    expect([back.width, back.height, back.length]).toEqual([3, 4, 5]);
    expect(back.countNonAir()).toBe(grid.countNonAir());

    // Every cell must match — this is the real proof the YZX block data and
    // palette indices survived.
    for (let y = 0; y < 4; y++)
      for (let z = 0; z < 5; z++)
        for (let x = 0; x < 3; x++)
          expect(back.get(x, y, z)).toBe(grid.get(x, y, z));
  });

  it('handles an empty (all-air) grid without corrupting', async () => {
    const g = new BlockGrid(2, 2, 2);
    const file = join(tmp, 'empty.schem');
    writeFileSync(file, encodeSchemBytes(g));
    const back = await parseToGrid(file);
    expect([back.width, back.height, back.length]).toEqual([2, 2, 2]);
    expect(back.countNonAir()).toBe(0);
  });

  it('handles a >127-entry palette (multi-byte varint indices)', async () => {
    // Forces varint indices past the single-byte boundary, exercising the
    // continuation-bit encoding both ways.
    const g = new BlockGrid(20, 1, 20);
    let n = 0;
    for (let z = 0; z < 20; z++)
      for (let x = 0; x < 20; x++)
        g.set(x, 0, z, `minecraft:block_${n++}`); // 400 distinct states
    const file = join(tmp, 'bigpalette.schem');
    writeFileSync(file, encodeSchemBytes(g));
    const back = await parseToGrid(file);
    expect(back.get(19, 0, 19)).toBe(g.get(19, 0, 19));
    expect(back.countNonAir()).toBe(400);
  });
});

/**
 * The walk-through recommendation as the UI says it (`ui/schem-export.ts`).
 *
 * The measurement itself is the Worker's (engine/bedrock-scene-actors.ts); what
 * is pinned here is the WORDING, because two of its properties are load-bearing:
 * the whole reason is carried (a size that opens the doors and loses the stairs
 * says so), and a display vehicle gets the walk-through answer BESIDE its auto
 * shrink rather than instead of it.
 */
describe('describeAccessRecommendation', () => {
  const tension = 'Door leaves are 0.6x1.3 blocks at 100 %; 400 % makes them 2.2x5.1 (a player needs 1x2; 19/23 clear it). But at 400 % a player reaches only 12 % of the model height, against 96 % at 100 %: the choice is between the doors and the stairs.';

  it('quotes the measured step and the WHOLE reason', () => {
    const line = describeAccessRecommendation({ scale: 4, sizePct: 400, basis: 'door-leaves', reason: tension });
    expect(line).toBe(`Walk-through: 400 % — ${tension}`);
    // Never truncated to the number: the tension is the half the user acts on.
    expect(line).toContain('between the doors and the stairs');
  });

  it('adds "to walk inside" for a vehicle, whose auto shrink is a different question', () => {
    const reason = 'Wall openings are 0.4x0.9 blocks at 100 %; 300 % makes them 1.2x2.6 (a player needs 1x2; 3/7 clear it).';
    expect(describeAccessRecommendation({ scale: 3, sizePct: 300, basis: 'apertures', reason }, 'vehicle'))
      .toBe(`Walk-through: 300 % to walk inside — ${reason}`);
    // Any other cue: the plain wording.
    expect(describeAccessRecommendation({ scale: 3, sizePct: 300, basis: 'apertures', reason }, 'minifig'))
      .toBe(`Walk-through: 300 % — ${reason}`);
  });

  it('says plainly when no size makes the model walkable', () => {
    const reason = 'No doorway or interior floor found: a solid model with nothing to walk through at any size.';
    expect(describeAccessRecommendation({ basis: 'none', reason })).toBe(`Walk-through: no size makes it walkable — ${reason}`);
  });

  it('reports nothing for a model no export has measured', () => {
    expect(getAccessRecommendation('a model that was never exported')).toBeNull();
  });
});
