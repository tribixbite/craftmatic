/**
 * Scale-invariant grounding: a placed model's lowest cuboid must land on the
 * pin's own plane at EVERY wand size step, not just at 100 %.
 *
 * The wand scales a placement about the pin (`worldPoint`: `anchor + p × f`),
 * so an actor coordinate that is not a measurement inside the model gets
 * multiplied by the size factor. The component actor's Y used to default to a
 * constant 1 block, which is exactly such a coordinate: the Milano 76286 (an
 * aircraft, `has_gravity: false`, so nothing pulls it back down) rose by
 * `(f − 1)` blocks and hung 3 blocks over the grass at 400 % — Pixel 8 Pro,
 * world 919, 2026-09-20,
 * `output/device-919/round-2026-09-20/shots/186-milano400-under.jpg`.
 *
 * The tests below drive the SERIALIZED runtime that ships inside a generated
 * pack (`test/_placement-host.ts`), so they measure the code the device runs.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon, componentSpawnPoint } from '../web/src/engine/playable-addon.js';
import { SIZE_STEPS, encodeColliderRuns } from '../web/src/engine/bedrock-placement-pack.js';
import { extractFile } from '../web/src/engine/zip-utils.js';
import { host } from './_placement-host.js';

const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const jsonOf = async (buffer: ArrayBuffer, name: string): Promise<any> => JSON.parse(new TextDecoder().decode(await extractFile(buffer, name)));

/** The pin the host's player sets with "Pin corner at my feet" (its location floored). */
const PIN = { x: 100, y: 64, z: 200 };
/** Menu indices of the runtime's buttons (`menu()` in bedrock-placement-pack.ts). */
const PIN_AT_FEET = 1, PLACE = 5, SIZE = 10;

/** Lowest cuboid of a compiled geometry, in blocks above the entity's own origin (16 units = 1 block). */
function geometryFloorBlocks(geo: any): number {
  let min = Infinity;
  for (const mesh of geo['minecraft:geometry'] ?? []) for (const bone of mesh.bones ?? []) for (const cube of bone.cubes ?? []) min = Math.min(min, cube.origin[1]);
  return min / 16;
}

/**
 * Pin at the player's feet, cycle the wand to `pct`, place, and return every
 * spawned actor. A fresh host per size keeps the sizes independent.
 */
async function placeAtSize(spec: Parameters<typeof host>[0], pct: number) {
  const h = host(spec);
  await h.open({ selection: PIN_AT_FEET }, { canceled: true });
  const steps = (SIZE_STEPS.indexOf(pct) - SIZE_STEPS.indexOf(100) + SIZE_STEPS.length) % SIZE_STEPS.length;
  for (let i = 0; i < steps; i++) await h.open({ selection: SIZE }, { canceled: true });
  await h.open({ selection: PLACE }, { selection: 0 });
  await h.flush(4000);
  return h;
}

describe('componentSpawnPoint', () => {
  it('stands a whole-model component on the model floor, not a block above it', () => {
    // y = 0 is the plane the structure tiles, the collider grid and the ghost
    // all stand on, so `anchor + y × f` is the pin at every size factor.
    expect(componentSpawnPoint({}, { width: 39, length: 16 })).toEqual({ x: 19.5, y: 0, z: 8 });
  });

  it('keeps a component its own floor height inside a larger scene', () => {
    // A real height in the model: scaling it with the model is correct.
    expect(componentSpawnPoint({ x: 2.25, y: 3, z: 3.5 }, { width: 39, length: 16 })).toEqual({ x: 2.25, y: 3, z: 3.5 });
  });
});

describe('a placed model keeps its ground contact at every size step', () => {
  // A 4×3×2 plane whose fallback geometry stands on its own origin, the shape
  // the Milano's compiled geometry has (`floorY = all.min[1]`, step 6 of
  // compileLdrawEntityGeometry, puts the lowest cuboid at y = 0).
  const planeGrid = (): BlockGrid => { const g = new BlockGrid(4, 3, 2); g.fill(0, 0, 0, 3, 0, 1, 'minecraft:light_blue_concrete'); g.set(1, 1, 1, 'minecraft:gray_concrete'); return g; };

  it('puts the emitted actor on the model floor, so actor Y + geometry floor is zero', async () => {
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), {
      stem: 'Grounded', components: [{ id: 'ship', label: 'Ship', kind: 'plane', grid: planeGrid(), provenance: 'test source' }],
    });
    const buffer = ab(result.bytes);
    const script = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_grounded_BP/scripts/placement.js'));
    const config = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(script)![1]!);
    const actor = config.actors.find((a: { typeId: string }) => a.typeId === 'craftmatic:grounded_ship')!;
    const floor = geometryFloorBlocks(await jsonOf(buffer, 'Craftmatic_grounded_RP/models/entity/grounded_ship.geo.json'));
    expect(floor).toBe(0);
    // The invariant: the entity's lowest cuboid sits on the anchor plane, so
    // `(actor.y + floor) × f` is 0 for every size factor. A constant lift here
    // (the old default of 1) is what the size factor multiplied.
    expect(actor.y + floor).toBe(0);
  });

  it('spawns a floor-at-origin vehicle exactly on the pin at 25 %…400 %', async () => {
    const result = await buildPlayableAddon(new BlockGrid(1, 1, 1), {
      stem: 'Grounded', components: [{ id: 'ship', label: 'Ship', kind: 'plane', grid: planeGrid(), provenance: 'test source' }],
    });
    const buffer = ab(result.bytes);
    const script = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_grounded_BP/scripts/placement.js'));
    const config = JSON.parse(/const CONFIG = (\{[\s\S]*?\});\n/.exec(script)![1]!);
    const floor = geometryFloorBlocks(await jsonOf(buffer, 'Craftmatic_grounded_RP/models/entity/grounded_ship.geo.json'));
    const contact: Record<number, number> = {};
    for (const pct of SIZE_STEPS) {
      const h = await placeAtSize({ stem: config.id, label: config.label, width: config.width, height: config.height, length: config.length,
        tiles: config.tiles, actors: config.actors, settleTicks: 1, finalHoldTicks: 1 }, pct);
      const ship = h.spawned.find(s => s.typeId === 'craftmatic:grounded_ship')!;
      expect(ship.entity.events).toEqual(pct === 100 ? [] : [`craftmatic:size_${pct}`]);
      contact[pct] = ship.at.y + floor * (pct / 100);
    }
    expect(contact).toEqual(Object.fromEntries(SIZE_STEPS.map(pct => [pct, PIN.y])));
  });

  it('spawns a shell whose lowest cuboid is h blocks BELOW its origin on the pin at every size', async () => {
    // `originAboveModel` (a building shell, lit from open sky above its roof)
    // authors the geometry `h` blocks under the entity origin and spawns the
    // actor `h` higher, so the two cancel at 100 % — and, because both are
    // model-relative heights, at every other factor too.
    const h = 6;
    const spec = { stem: 'shell', label: 'Shell', width: 8, height: 6, length: 8, tiles: [],
      actors: [{ typeId: 'craftmatic:shell_bricks', label: 'Shell bricks', x: 4, y: h, z: 4 }],
      settleTicks: 1, finalHoldTicks: 1 };
    for (const pct of SIZE_STEPS) {
      const run = await placeAtSize(spec, pct);
      const shell = run.spawned.find(s => s.typeId === 'craftmatic:shell_bricks')!;
      // Lowest cuboid = origin − h blocks, both scaled by the size factor.
      expect(shell.at.y - h * (pct / 100)).toBe(PIN.y);
    }
  });

  it('lays the collider grid on the pin plane at 400 % too', async () => {
    // The other half of the grounding: the walkable blocks a brick-accurate
    // building stands on are anchored to the pin, not scaled away from it.
    const g = new BlockGrid(2, 2, 2);
    for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) { g.set(x, 0, z, 'craftmatic:collider[lo=0,hi=16]'); g.set(x, 1, z, 'craftmatic:collider[lo=0,hi=16]'); }
    const runs = encodeColliderRuns(g, 'craftmatic:collider');
    const run = await placeAtSize({ stem: 'walk', label: 'Walk', width: 2, height: 2, length: 2,
      tiles: [{ identifier: 'craftmatic:t0', dx: 0, dy: 0, dz: 0, width: 2, height: 2, length: 2, nonAir: 8 }], actors: [],
      colliders: { width: 2, height: 2, length: 2, block: 'craftmatic:collider', loState: 'craftmatic:lo', hiState: 'craftmatic:hi', runs: runs.runs, keptCells: 0 },
      settleTicks: 1, finalHoldTicks: 1 }, 400);
    const rows = run.set.map(s => s.pos.y);
    expect(Math.min(...rows)).toBe(PIN.y);
    // 2 cells × 4 = 8 world rows, all full: the grid grows UP from the pin.
    expect(Math.max(...rows)).toBe(PIN.y + 7);
  });
});
