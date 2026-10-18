import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';

// The minifig moulds as boxes at their real bounds (enough for the rig to compile).
const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
const part = (description: string, b: [number, number, number, number, number, number]): string => [`0 ${description}`, ...box6(...b)].join('\n');
const LIBRARY: Record<string, string> = {
  '973': part('Minifig Torso', [-19, 19, -12, 32, -10, 10]),
  '3626c': part('Minifig Head with Closed Hollow Stud', [-13, 13, 0, 24, -13, 13]),
  '3815': part('Minifig Hips', [-18, 18, -11, 21, -10, 10]),
  '3816': part('Minifig Leg Right', [-19.5, -1.5, -9, 28, -11, 9]),
  '3817': part('Minifig Leg Left', [1.5, 19.5, -9, 28, -11, 9]),
  '3818': part('Minifig Arm Right', [-10, 7, -6.5, 22.44, -13.44, 6.51]),
  '3819': part('Minifig Arm Left', [-7, 10, -6.5, 22.44, -13.44, 6.51]),
  '3820': part('Minifig Hand', [-6, 6, -7.65, 4.61, -15.52, 13]),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });

describe('seated figures', () => {
  it('a figure with a seatIndex rides that seat actor; seats admit figures; the pack ships the sit animation', async () => {
    const grid = new BlockGrid(6, 2, 6);
    for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) grid.set(x, 0, z, 'minecraft:white_concrete');
    const fig = minifigFromSpec({ torso: { part: '973', color: 4 } });
    const pack = await buildPlayableAddon(grid, {
      stem: 'bench', label: 'Bench', partGeometry: provider(), pbr: false, shell: undefined,
      figures: [
        { bricks: fig.bricks, x: 1, y: 1, z: 1, facingLdu: [0, -1] },
        { bricks: fig.bricks, x: 3, y: 1, z: 3, facingLdu: [1, 0], seatIndex: 1 },
      ],
      seats: [
        { x: 2, y: 1.5, z: 2, yaw: 0, label: 'Seat (4079)' },
        { x: 3, y: 1.5, z: 3, yaw: -90, label: 'Seat (4079)' },
      ],
    });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_bench_RP/animations/craftmatic_minifig.animation.json');
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_bench_BP/scripts/placement.js'));
    const actors = JSON.parse(/"actors":(\[.*?\]),"previewPoints"/.exec(placement)![1]!) as Array<{ typeId: string; rideOf?: number }>;
    // Actor order: figures first, then seats.
    expect(actors.map(a => a.typeId)).toEqual(['craftmatic:bench_fig1', 'craftmatic:bench_fig2', 'craftmatic:bench_seat', 'craftmatic:bench_seat']);
    expect(actors[0]!.rideOf).toBeUndefined();
    expect(actors[1]!.rideOf).toBe(3);
    // The runtime is a function's source text; the transpiler may re-quote it.
    expect(placement).toMatch(/getComponent\(["']minecraft:rideable["']\)/);
    expect(placement).toContain('addRider');
    const seat = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_bench_BP/entities/bench_seat.json'))) as { 'minecraft:entity': { components: { 'minecraft:rideable': { family_types: string[] } } } };
    expect(seat['minecraft:entity'].components['minecraft:rideable'].family_types).toEqual(['player', 'craftmatic_figure']);
    expect(pack.components.find(c => c.id === 'bench_fig2')!.provenance).toBe('minifig sitting in the build');
  });
});
