/**
 * The device's add-on memory ceiling is denominated in CUBOIDS, not packs and
 * not bytes (see `DEVICE_CUBOID_BUDGET`). Three behaviours guard it:
 *   1. every figure is compiled at `high` detail however fine the pack is;
 *   2. the pack's own cuboid total is reported, and warned about when it is a
 *      large share of the device budget;
 *   3. geometry JSON ships minified — a download-size fix that must not be
 *      mistaken for a memory fix, and must not break any consumer that parses
 *      the pack.
 */
import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { DEVICE_CUBOID_BUDGET, buildPlayableAddon, packCuboidBudget } from '../web/src/engine/playable-addon.js';
import { LEGO_ENTITY_QUALITY, clampFigureQuality } from '../web/src/engine/ldraw-part-prototype.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { extractFile } from '../web/src/engine/zip-utils.js';
import { minifigFromSpec } from '../web/src/engine/minifig-rig.js';

// The minifig moulds as boxes at their real bounds — enough for the rig to compile.
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
const ab = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** One figure standing on a small slab, exported at the given quality. */
const figurePack = async (quality: 'balanced' | 'high' | 'ultra') => {
  const grid = new BlockGrid(4, 2, 4);
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) grid.set(x, 0, z, 'minecraft:white_concrete');
  const fig = minifigFromSpec({ torso: { part: '973', color: 4 } });
  const pack = await buildPlayableAddon(grid, {
    stem: 'plinth', label: 'Plinth', partGeometry: provider(), pbr: false, entityQuality: quality,
    figures: [{ bricks: fig.bricks, x: 1, y: 1, z: 1, facingLdu: [0, -1] }],
  });
  const diagnostics = JSON.parse(new TextDecoder().decode(
    await extractFile(ab(pack.bytes), 'Craftmatic_plinth_BP/craftmatic-diagnostics.json'),
  )) as { pack: Record<string, unknown>; entities: Record<string, { cubeCount: number; quality: { microcellLdu: number }; figureQualityClamped?: { requestedMicrocellLdu: number; microcellLdu: number } }> };
  return { pack, diagnostics, figure: diagnostics.entities['plinth_fig1']! };
};

describe('figures are clamped to high detail', () => {
  it('coarsens field by field and leaves an already-coarser request alone', () => {
    expect(clampFigureQuality(LEGO_ENTITY_QUALITY.ultra)).toEqual(LEGO_ENTITY_QUALITY.high);
    expect(clampFigureQuality(LEGO_ENTITY_QUALITY.high)).toEqual(LEGO_ENTITY_QUALITY.high);
    // Anything COARSER than `high` survives untouched: the clamp is a ceiling,
    // not a replacement, so a balanced pack's figures stay balanced.
    expect(clampFigureQuality(LEGO_ENTITY_QUALITY.balanced)).toEqual(LEGO_ENTITY_QUALITY.balanced);
    const coarse = { ...LEGO_ENTITY_QUALITY.balanced, microcellLdu: 8, maxModelCubes: 1024 };
    expect(clampFigureQuality(coarse)).toEqual(coarse);
  });

  it('an ultra pack still compiles its figure at 2 LDU, and says so in the pack and the warnings', async () => {
    const ultra = await figurePack('ultra');
    expect(ultra.figure.quality.microcellLdu).toBe(2);
    expect(ultra.figure.figureQualityClamped).toEqual({ requestedMicrocellLdu: 1, microcellLdu: 2 });
    expect(ultra.pack.warnings.some(w => /1 figure was compiled at 2 LDU rather than the pack's 1 LDU/.test(w))).toBe(true);
    expect(ultra.diagnostics.pack['figuresClampedToBalanced']).toBe(1);
  });

  it('is what makes an ultra figure cost the same as a high one', async () => {
    const [high, ultra] = [await figurePack('high'), await figurePack('ultra')];
    expect(high.figure.figureQualityClamped).toBeUndefined();
    expect(high.pack.warnings.some(w => /figure was compiled at/.test(w))).toBe(false);
    expect(ultra.figure.cubeCount).toBe(high.figure.cubeCount);
  });
});

describe('pack cuboid budget', () => {
  it('reports the share and how many packs fit, and warns only from 10 % of the device budget', () => {
    const small = packCuboidBudget('Roadster', 12_000, 3);
    expect(small.shareOfDeviceBudget).toBeCloseTo(0.046, 3);
    expect(small.packsThatFitTogether).toBe(21);
    expect(small.warning).toBeUndefined();

    const measured = packCuboidBudget('Castle', 82_163, 12);
    expect(measured.warning).toBe(
      'Castle: 82,163 cuboids across 12 entities - 32% of the ~260,000-cuboid budget a phone has for ALL of its add-on packs together'
      + ' (measured on a Pixel 8 Pro at 3.08 kB per cuboid; box-UV geometry has since measured 2.03-2.78 kB, so the real ceiling is likely 290,000-390,000 - not yet confirmed on a device).'
      + ' About 3 packs this size can be active at once; a 4th is likely to crash the world as it loads.',
    );

    // Exactly the measured ceiling: one such pack is the whole device.
    const whole = packCuboidBudget('Everything', DEVICE_CUBOID_BUDGET, 40);
    expect(whole.packsThatFitTogether).toBe(1);
    expect(whole.warning).toContain('About 1 pack this size can be active at once; a 2nd is likely to crash');

    const over = packCuboidBudget('Too big', DEVICE_CUBOID_BUDGET + 1, 40);
    expect(over.warning).toContain('This pack alone is over that budget');
  });

  it('is written into craftmatic-diagnostics.json even when it is far under the warning threshold', async () => {
    const { pack, diagnostics } = await figurePack('balanced');
    const total = Object.values(diagnostics.entities).reduce((n, d) => n + d.cubeCount, 0);
    expect(diagnostics.pack['cuboids']).toBe(total);
    expect(diagnostics.pack['deviceCuboidBudget']).toBe(DEVICE_CUBOID_BUDGET);
    expect(diagnostics.pack['entities']).toBe(Object.keys(diagnostics.entities).length);
    expect(diagnostics.pack['warning']).toBeUndefined();
    expect(pack.warnings.some(w => /cuboid budget/.test(w))).toBe(false);
  });
});

describe('geometry JSON is minified', () => {
  it('ships the geometry on one line and everything else pretty, and both still parse', async () => {
    const { pack } = await figurePack('balanced');
    const buffer = ab(pack.bytes);
    const geo = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_plinth_RP/models/entity/plinth_fig1.geo.json'));
    const manifest = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_plinth_BP/manifest.json'));
    // One trailing newline, no indentation: a `.geo.json` is 98-99 % of a pack.
    expect(geo.trimEnd().includes('\n')).toBe(false);
    expect(geo).not.toContain('  ');
    expect(JSON.parse(geo)['minecraft:geometry'].length).toBeGreaterThan(0);
    // The small, human-read files keep their indentation.
    expect(manifest).toContain('\n  "header"');
    expect(JSON.parse(manifest).header.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});
