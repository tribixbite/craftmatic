/**
 * A model that IS a vehicle (the audit of 2026-11-15, PROC-19):
 *   - A-01: a whole-model car found from its geometry is sized and seated the same whether its title names a
 *     vehicle or not (a renamed upload, a set number as the label);
 *   - A-02: the moving parts and furniture a whole-model vehicle carries are not silently lost - furniture seats
 *     ride as the vehicle's passenger seats, and every moving part that stays fixed is reported with why;
 *   - "does not generalise" 2: a titled vehicle standing beside its own scenery (a camper van and its picnic)
 *     leaves the scenery out of the vehicle by geometry, not by another title word.
 * Built through the REAL pipeline on box stand-in parts (`seedBoxParts`), so no library and no network are needed.
 */
import { describe, expect, it } from 'vitest';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.js';
import { FIXED_STAMP, box6, seedBoxParts, text, unzipAll } from './pack-profile-support.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.js';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.js';
import { runScenario } from '../web/src/sim/scenario/runner.js';

/** Stand-ins for the parts the bus is built of, beyond `PARTS`: a road wheel, a door leaf and a seat mould. */
const EXTRA = {
  cmwheel: ['0 Wheel 48mm D. x 12mm', ...box6(-24, 24, -24, 24, -6, 6)].join('\n'),
  '60623': ['0 Door  1 x  4 x  6 with 4 Panes and Stud Handle', ...box6(-4, 67, 3, 137, -3, 3)].join('\n'),
  '4079': ['0 Minifig Seat  2 x  2', ...box6(-20, 20, -40, 8, -20, 25)].join('\n'),
  // A playground slide (`isSlideDescription`): ten 16-LDU steps falling 12 each along +z, its base at y 0.
  cmslide: ['0 Slide  2 x 10 x  5 Straight', ...Array.from({ length: 10 }, (_, i) => box6(-20, 20, -120 + i * 12, 0, i * 16, (i + 1) * 16)).flat()].join('\n'),
};

const line = (color: number, x: number, y: number, z: number, part: string): string => `1 ${color} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 ${part}`;
/**
 * A bus 840 LDU long (15.75 blocks at minifig scale, no figure): four wheels, a chassis of plates, a solid body
 * three bricks high, a roof, a door leaf hung on its side and a seat mould on the roof.
 */
const BUS = [
  ...[[-340, -46], [-340, 46], [340, -46], [340, 46]].map(([x, z]) => line(0, x!, -24, z!, 'cmwheel.dat')),
  ...[-360, -240, -120, 0, 120, 240, 360].map(x => line(72, x, -56, 0, '3032.dat')),
  ...[-80, -104, -128].flatMap(y => Array.from({ length: 21 }, (_, k) => -400 + 40 * k).flatMap(x => [-20, 20].map(z => line(14, x, y, z, '3003.dat')))),
  ...[-360, -240, -120, 0, 120, 240, 360].map(x => line(15, x, -136, 0, '3032.dat')),
  line(4, -200, -185, -44, '60623.dat'),
  line(0, 300, -144, 0, '4079.dat'),
];
/** A picnic table standing apart from the bus on the same ground: four two-brick legs and a top. */
const TABLE = [
  ...[-24, -48].flatMap(y => [[680, -20], [720, -20], [680, 20], [720, 20]].map(([x, z]) => line(6, x!, y, z!, '3003.dat'))),
  line(6, 700, -56, 0, '3032.dat'),
];
const BUS_PARTS = BUS.length;

/** The bus with a slide hung on its flank: its top beside the roof, its foot on the ground 160 LDU out (3 blocks). */
const SLIDE_BUS = [...BUS, line(15, 0, 0, 40, 'cmslide.dat')];

async function build(label: string, lines: string[], scale: 'auto' | 'given' = 'auto'): Promise<{ bytes: Uint8Array; files: Map<string, Uint8Array>; warnings: string[]; scale: number | undefined; cue: string | undefined; diag: any }> {
  seedBoxParts(EXTRA);
  const bricks = parseLDrawDocument(lines.join('\n')).bricks;
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
    format: 'mcaddon', packStem: 'BusDemo', packLabel: label, profile: 'default', lightFill: false, shapes: false,
    vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1,
    // The caller planned the scale as `auto` (ui/schem-export.ts, scripts/_playable_ref.ts): the pipeline may size it from the geometry.
    ...(scale === 'auto' ? { addonScaleChoice: 'auto' as const } : {}),
    pipelineStamp: FIXED_STAMP, sourceProvenance: null,
  });
  const files = await unzipAll(result.bytes!);
  const diag = JSON.parse(text(files.get([...files.keys()].find(n => n.endsWith('craftmatic-diagnostics.json'))!)!));
  return { bytes: result.bytes!, files, warnings: result.mcpack?.warnings ?? [], scale: result.mcpack?.scale?.scale, cue: result.mcpack?.scale?.cue, diag };
}
/** The one vehicle entity's behaviour file. */
const vehicle = (files: Map<string, Uint8Array>): any => {
  for (const [name, data] of files) {
    if (!/_BP\/entities\/.*\.json$/.test(name) || /_(board_\d+|seat|manual_seat|preview)\.json$/.test(name)) continue;
    const entity = JSON.parse(text(data));
    if (entity['minecraft:entity']?.components?.['minecraft:rideable']) return entity;
  }
  return undefined;
};
const seatCount = (files: Map<string, Uint8Array>): number => vehicle(files)['minecraft:entity'].components['minecraft:rideable'].seat_count;

describe('a whole-model vehicle is the same vehicle with or without a title (A-01, PROC-19)', () => {
  it('an untitled whole-model bus is sized and seated as its titled build', async () => {
    const titled = await build('Long Bus', BUS);
    const untitled = await build('90001', BUS);
    expect(vehicle(titled.files)).toBeDefined();
    expect(vehicle(untitled.files)).toBeDefined();
    // 15.75 blocks shrunk to a real car's 4.6: 0.29 of minifig scale, both ways.
    expect(titled.scale).toBeCloseTo(0.29, 2);
    expect(untitled.scale).toBeCloseTo(0.29, 2);
    expect(untitled.cue).toBe('vehicle');
    expect(seatCount(untitled.files)).toBe(seatCount(titled.files));
  }, 240_000);
});

describe('what a whole-model vehicle carries (A-02, PROC-19)', () => {
  it('reports every moving part it carries and that it opens on the parked vehicle', async () => {
    const bus = await build('90001', BUS);
    const rows = (bus.diag.interactivity?.rows ?? []) as Array<{ cls: string; part: string; verdict: string; reason?: string; count: number }>;
    const door = rows.find(r => r.cls === 'door' && r.part === '60623');
    expect(door).toMatchObject({ verdict: 'rides', count: 1 });
    expect(door!.reason).toMatch(/opens on .* while it is parked/);
    expect(bus.warnings.some(w => /moving part.* open(s)? on the parked car/.test(w) && /door 60623/.test(w))).toBe(true);
    // One float actor property per part on the vehicle itself (the bone is in the vehicle's own geometry).
    expect(vehicle(bus.files)['minecraft:entity'].description.properties['craftmatic:vpart_0']).toMatchObject({ type: 'float', client_sync: true });
  }, 240_000);

  it('a tap opens the parked bus door, the door closes as the bus drives off and opens again where it parked', async () => {
    const bus = await build('90001', BUS);
    const addon = await readAddon(bus.bytes, 'bus-parts');
    const pack = readCraftmaticPack(addon)!;
    const r = await runScenario({ name: 'bus-parts', steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'vehicleParts' }], invariants: [] },
      [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.steps.filter(s => !s.ok).map(s => s.error)).toEqual([]);
    expect(r.violations.map(v => v.message)).toEqual([]);
    const s = r.state['vehicleParts'] as { parts: number; opened: number; closedWhileMoving: boolean; drove: number; reopenedAfterDrive: boolean; followed: boolean };
    expect(s).toMatchObject({ parts: 1, opened: 1, closedWhileMoving: true, reopenedAfterDrive: true, followed: true });
    expect(s.drove).toBeGreaterThan(1);
  }, 240_000);

  it('a slide on a parked bus is ridden from a tap, refused while it drives, and rides with it to where it parks', async () => {
    // At minifig scale (the scale given): the slide is a child's size.
    const bus = await build('Long Bus', SLIDE_BUS, 'given');
    expect(bus.warnings.some(w => /slide cmslide/.test(w) && /ride it while it is parked/.test(w))).toBe(true);
    const addon = await readAddon(bus.bytes, 'bus-slide');
    const pack = readCraftmaticPack(addon)!;
    const r = await runScenario({ name: 'bus-slide', steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'vehicleSlides' }], invariants: [] },
      [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.steps.filter(s => !s.ok).map(s => s.error)).toEqual([]);
    expect(r.violations.map(v => v.message)).toEqual([]);
    const s = r.state['vehicleSlides'] as { slides: number; rode: number; refusedMoving: boolean; rodeAfterDrive: boolean; drove: number; seatsLeft: number };
    expect(s).toMatchObject({ slides: 1, rode: 1, refusedMoving: true, rodeAfterDrive: true, seatsLeft: 0 });
    expect(s.drove).toBeGreaterThan(1);
  }, 240_000);

  it('a native rotorcraft\'s door opens from a tap while it is parked (TODO vehicle-interactives)', async () => {
    // The same hull titled a helicopter: a native rotorcraft (`vehicleMotionOf`), flown by the device's own controller.
    const heli = await build('Rescue Helicopter', BUS, 'given');
    const rows = (heli.diag.interactivity?.rows ?? []) as Array<{ cls: string; part: string; verdict: string; reason?: string }>;
    expect(rows.find(r => r.cls === 'door' && r.part === '60623')).toMatchObject({ verdict: 'rides' });
    const addon = await readAddon(heli.bytes, 'heli-parts');
    const pack = readCraftmaticPack(addon)!;
    const r = await runScenario({ name: 'heli-parts', steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'vehicleParts' }], invariants: [] },
      [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(r.steps.filter(s => !s.ok).map(s => s.error)).toEqual([]);
    expect(r.violations.map(v => v.message)).toEqual([]);
    // Opened parked, shut while it flew off, opened again where it set down, its drawn leaf where the pick tests it.
    expect(r.state['vehicleParts']).toMatchObject({ parts: 1, opened: 1, closedWhileMoving: true, reopenedAfterDrive: true, followed: true });
    expect((r.state['vehicleParts'] as { drove: number }).drove).toBeGreaterThan(1);
  }, 240_000);

  it('a furniture seat a vehicle carries rides as one of its passenger seats', async () => {
    seedBoxParts(EXTRA);
    const bricks = parseLDrawDocument(BUS.join('\n')).bricks;
    // A plain 2 x 2 brick on the roof stands for brick-built furniture (`discoverSceneActors` finds benches, beds).
    const bench: ParsedBrick = { part: '3003.dat', color: 1, x: -300, y: -160, z: 0 };
    const without = await compileLdrawEntityGeometry('bus', 'car', [...bricks, bench], { quality: 'balanced', vehicleRig: true });
    const withBench = await compileLdrawEntityGeometry('bus', 'car', [...bricks, bench], { quality: 'balanced', vehicleRig: true, extraSeatBricks: new Set([bench]) });
    expect(withBench.passengerSeats.length).toBe(without.passengerSeats.length + 1);
  }, 120_000);
});

describe('a titled vehicle beside its own scenery (generalisation 2, PROC-19)', () => {
  it('leaves a picnic table standing apart out of the titled camper, by geometry', async () => {
    const camper = await build('Camper Van Adventure', [...BUS, ...TABLE]);
    expect(vehicle(camper.files)).toBeDefined();
    expect(camper.warnings.some(w => new RegExp(`${TABLE.length} placements? standing apart from the vehicle`).test(w))).toBe(true);
    // The table is the build's scenery: a shell carries it.
    expect([...camper.files.keys()].some(n => /_BP\/entities\/.*shell.*\.json$/.test(n))).toBe(true);
    // Sized by the vehicle, not the vehicle and its picnic: the same 0.29 as the bus alone.
    expect(camper.scale).toBeCloseTo(0.29, 2);
    expect(BUS_PARTS).toBeGreaterThan(TABLE.length);
  }, 240_000);
});
