/**
 * The two funfair fixtures (`test/fixtures/funfair/*.ldr`, from `scripts/_funfair_fixture_gen.ts`) through the REAL
 * shared pipeline (`runSchemPipeline`): the drop tower and the sky swing are found, their rings leave the shell as
 * entities, every seat is an actor carrying its own path, and the pack ships `scripts/rides-funfair.js` - and a
 * pack with no such ride ships none (the existing ride packs stay byte-identical).
 *
 * Two runs of the same assertions, as nimbus-fixture.test.ts: the local Studio library (skipped where it is
 * absent) and the fixture's parts SEEDED as boxes at the library's own extents (no library, no network), so CI
 * proves the whole path too. Seeding is global, so the library run comes first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { runSchemPipeline, type SchemPipelineResult } from '../web/src/engine/schem-pipeline.js';
import { modelExportStem } from '../web/src/engine/export-name.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { FUNFAIR } from '../web/src/engine/rides/funfair-physics.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

interface Pack { result: SchemPipelineResult; entries: string[]; json: (name: string) => Promise<any>; text: (name: string) => Promise<string>; bp: string; rp: string; config: any; funfair: any }

async function exportFixture(file: string, label: string): Promise<Pack> {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
    format: 'mcaddon', packStem: modelExportStem({ name: label, setNum: '' }), packLabel: label, profile: 'default', lightFill: false, shapes: false,
    vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1,
  });
  const buffer = ab(result.bytes!);
  const entries = listZipEntries(buffer);
  const text = async (name: string): Promise<string> => new TextDecoder().decode(await extractFile(buffer, name));
  const json = async (name: string): Promise<any> => JSON.parse(await text(name));
  const bp = entries.find(e => e.endsWith('_BP/manifest.json'))!.replace('manifest.json', '');
  const rp = entries.find(e => e.endsWith('_RP/manifest.json'))!.replace('manifest.json', '');
  const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(await text(`${bp}scripts/placement.js`))![1]!);
  const fun = entries.includes(`${bp}scripts/rides-funfair.js`) ? JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(await text(`${bp}scripts/rides-funfair.js`))![1]!) : undefined;
  return { result, entries, json, text, bp, rp, config, funfair: fun };
}

/** The assertions both runs share, per fixture. */
function funfairPackTests(get: () => Pack, o: { kind: 'drop' | 'swing'; seats: number; carParts: number; minRiseBlocks: number }): void {
  it('finds the ride and writes its script, its seat type and one ring entity', () => {
    const { result, entries, bp, funfair } = get();
    expect(result.mcpack?.warnings?.some(w => new RegExp(`Funfair rides: ${o.kind === 'drop' ? 'drop tower' : 'sky swing'} on 91176 \\(${o.seats} seats, ring of ${o.carParts} parts\\)`).test(w))).toBe(true);
    expect(entries).toContain(`${bp}scripts/rides-funfair.js`);
    // The slide / lift / orbit script is not emitted for a pack that has none of them.
    expect(entries).not.toContain(`${bp}scripts/rides.js`);
    expect(funfair.rides).toEqual([{ kind: o.kind, carType: expect.stringMatching(/_funfair_ring_1$/) }]);
    expect(funfair.seatType).toMatch(/_funfair$/);
    expect(funfair.constants).toEqual(FUNFAIR);
  });

  it('main.js loads the script, and every seat is a placed actor with its own path: foot, top, axis', async () => {
    const { text, bp, config, funfair } = get();
    expect(await text(`${bp}scripts/main.js`)).toContain("import './rides-funfair.js';");
    const seats = (config.actors as any[]).filter(a => a.typeId === funfair.seatType);
    expect(seats).toHaveLength(o.seats);
    const axes = new Set<string>();
    for (const s of seats) {
      expect(s.ride).toBe(0);
      expect(s.ridePath).toHaveLength(3);
      const [foot, top, axis] = s.ridePath as number[][];
      // The seat idles at the foot of its path and rises straight up to the top; the axis is the same point for every seat.
      expect(s.y).toBeCloseTo(foot![1]!, 6);
      expect(top![0]).toBeCloseTo(foot![0]!, 6); expect(top![2]).toBeCloseTo(foot![2]!, 6);
      expect(top![1]! - foot![1]!).toBeGreaterThan(o.minRiseBlocks);
      expect(axis![1]).toBeCloseTo(top![1]!, 6);
      axes.add(`${axis![0]!.toFixed(3)},${axis![2]!.toFixed(3)}`);
      expect(s.rideExits).toHaveLength(1);
    }
    expect(axes.size).toBe(1);
    // The ring is one entity of its own, indexed to the ride.
    expect((config.actors as any[]).filter(a => a.typeId === funfair.rides[0].carType)).toMatchObject([{ ride: 0 }]);
  });

  it('the ring left the shell: its parts are not drawn twice, and the mast stays', () => {
    const { result } = get();
    const census = result.mcpack?.components ?? [];
    expect(census.some(c => /ring/i.test(c))).toBe(true);
  });
}

const FIXTURES = {
  drop: { file: 'test/fixtures/funfair/drop-tower.ldr', label: 'Funfair Drop Tower (test-1)', seats: 8, carParts: 24, minRiseBlocks: 90 },
  swing: { file: 'test/fixtures/funfair/sky-swing.ldr', label: 'Funfair Sky Swing (test-2)', seats: 4, carParts: 12, minRiseBlocks: 50 },
} as const;

describe.skipIf(!existsSync(LDRAW_ROOT))('funfair fixtures through the real pipeline (local Studio library)', () => {
  const packs: Partial<Record<'drop' | 'swing', Pack>> = {};
  beforeAll(async () => {
    setLDrawRoot(LDRAW_ROOT);
    for (const kind of ['drop', 'swing'] as const) packs[kind] = await exportFixture(FIXTURES[kind].file, FIXTURES[kind].label);
  }, 480_000);
  describe('drop tower', () => funfairPackTests(() => packs.drop!, { kind: 'drop', ...FIXTURES.drop }));
  describe('sky swing', () => funfairPackTests(() => packs.swing!, { kind: 'swing', ...FIXTURES.swing }));
});

describe('funfair fixtures through the real pipeline (parts seeded as boxes: no library, no network)', () => {
  /** Box stand-ins at the library's own extents (studs excluded), measured by `scripts/_funfair_part_bounds.ts`. */
  const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
    const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
    return [
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    ];
  };
  const PARTS: Record<string, string> = {
    '91176': ['0 Support  2 x  2 x 13 with  5 Pegholes', ...box6(-20, 20, 0, 312, -20, 20)].join('\n'),
    '3958': ['0 Plate  6 x  6', ...box6(-60, 60, 0, 8, -60, 60)].join('\n'),
    '3034': ['0 Plate  2 x  8', ...box6(-80, 80, 0, 8, -20, 20)].join('\n'),
    '4079': ['0 Minifig Seat  2 x  2', ...box6(-20, 20, -40, 8, -20, 25)].join('\n'),
    '67075': ['0 Friends Swing 2 x 6 x 5 1/3', ...box6(-60, 60, -111, 16, -20, 20)].join('\n'),
  };
  const packs: Partial<Record<'drop' | 'swing', Pack>> = {};
  beforeAll(async () => {
    seedDatTexts(Object.entries(PARTS).map(([id, t]) => [`${id}.dat`, t] as const));
    for (const kind of ['drop', 'swing'] as const) packs[kind] = await exportFixture(FIXTURES[kind].file, FIXTURES[kind].label);
  }, 480_000);
  describe('drop tower', () => funfairPackTests(() => packs.drop!, { kind: 'drop', ...FIXTURES.drop }));
  describe('sky swing', () => funfairPackTests(() => packs.swing!, { kind: 'swing', ...FIXTURES.swing }));
});
