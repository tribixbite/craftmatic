import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { BlockGrid } from '../src/schem/types';
import { generateCoaster, type CoasterDesign, type CoasterElement, type GeneratedCoaster } from '../web/src/engine/coaster-design';
import { coasterCarAttitude, coasterRuntimeConfig } from '../web/src/engine/bedrock-coaster';
import { buildCoasterTrackPack, coasterRouteFromGenerated, parseCoasterCar, placeGenerated, type OwnCoasterCar } from '../web/src/engine/coaster-pack';
import { isOfficialPartName } from '../web/src/engine/part-source';
import { COASTER_TRACK_MESH } from '../web/src/engine/coaster-track-mesh';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale';
import { worldFaces, type AuditActor } from '../web/src/engine/bedrock-geometry-faces';
import { buildPlayableAddon } from '../web/src/engine/playable-addon';
import { readAddon } from '../web/src/sim/pack/pack';
import { packAppearance } from '../web/src/sim/adapters/craftmatic/drawn';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry';

const sketch = JSON.parse(readFileSync('test/fixtures/coaster/3x-sketch.json', 'utf8')) as CoasterDesign;
const carText = readFileSync('test/fixtures/coaster/own-car.ldr', 'utf8');
const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const HAVE_LIBRARY = existsSync(LDRAW_ROOT);

const limits = { maxSpeedBps: 52, gVertical: [-1, 4.5] as [number, number], gLateral: 1.5, maxJerk: 40 };
const small = (elements: CoasterElement[]): CoasterDesign => ({ name: 'small', elements, heartlineB: 0.8, trains: 1, carsPerTrain: 3, limits, shows: [] });
/** A short closed circuit with a left (positive-angle) turn and a loop, so rails bank and invert. */
const SMALL: CoasterElement[] = [
  { kind: 'station', lengthB: 12 }, { kind: 'chain-lift', riseB: 40, angleDeg: 45, speedBps: 4 },
  { kind: 'drop', fallB: 60, angleDeg: 70 }, { kind: 'loop', radiusB: 8 },
  { kind: 'turn', radiusB: 14, angleDeg: 90, bankDeg: 20 }, { kind: 'block-brake', lengthB: 90, toSpeedBps: 4 },
];

describe('coaster-generated-route', () => {
  let gen: GeneratedCoaster, car: OwnCoasterCar;
  beforeAll(() => { gen = generateCoaster(sketch); car = parseCoasterCar(carText); });

  it("a pack built from a CoasterDesign carries its route with the design's length and ups", () => {
    const route = coasterRouteFromGenerated(gen, sketch, car);
    const runtime = coasterRuntimeConfig('craftmatic:c_coaster_cart', [route]).routes[0]!;
    expect(runtime.path.length).toBeCloseTo(gen.report.lengthB, 6);
    expect(runtime.path.closed).toBe(true);
    expect(runtime.up.length).toBe(gen.ups.length);
    let worst = 0;
    runtime.up.forEach((u, i) => { for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(u[k]! - gen.ups[i]![k]!)); });
    expect(worst).toBeLessThan(1e-9);
    // The design's zones, its platform and its one real lift (the cable lift) travel with the route.
    expect(runtime.zones?.some(z => z.kind === 'launch')).toBe(true);
    expect(runtime.station.start).toBe(0);
    expect(runtime.station.stop).toBe(8);
    expect(runtime.chain).toBeDefined();
    expect(runtime.chain!.end - runtime.chain!.start).toBeGreaterThan(150);
    expect(runtime.cars.count).toBe(6);
    expect(runtime.cars.trains).toBe(2);
    expect(runtime.cars.slots).toHaveLength(12);
  });

  it('a route without explicit ups still infers them, so a source model keeps its config', () => {
    const route = coasterRouteFromGenerated(gen, sketch, car);
    const plain = coasterRuntimeConfig('craftmatic:c_coaster_cart', [{ ...route, ups: undefined, zones: undefined, station: undefined }]).routes[0]!;
    expect('zones' in plain).toBe(false);
    expect(plain.up.length).toBe(gen.ups.length);
  });

  it('explicit ups that are not one per point are refused', () => {
    const route = coasterRouteFromGenerated(gen, sketch, car);
    expect(() => coasterRuntimeConfig('craftmatic:c_coaster_cart', [{ ...route, ups: route.ups!.slice(1) }])).toThrow(/one per route point/);
  });

  it("a design's left turn is a left turn in Bedrock's frame, with no mirror (handedness)", () => {
    // Heading +x (east) with up +y: a positive angle turns T toward `up x T` = -z (north), the rider's LEFT, and
    // Bedrock's yaw (clockwise from above is positive; east -90, north -180) DEcreases.
    for (const [angle, side] of [[90, -1], [-90, 1]] as const) {
      const g = generateCoaster(small([{ kind: 'station', lengthB: 12 }, { kind: 'straight', lengthB: 10 }, { kind: 'turn', radiusB: 12, angleDeg: angle }, { kind: 'straight', lengthB: 10 }]), { validate: false });
      const pts = g.route.points, arc = g.analysis.arc;
      const at = (s: number): number => { let i = 0; while (i < arc.length - 2 && arc[i + 1]! < s) i++; return i; };
      const yawAt = (i: number): number => coasterCarAttitude([0, 1, 2].map(k => pts[i + 1]![k]! - pts[i]![k]!), g.ups[i]!, 0).yaw;
      const turn = g.spans.find(sp => sp.kind === 'turn')!;
      const before = yawAt(at(turn.from + 0.5)), after = yawAt(at(turn.to - 0.5));
      expect(before).toBeCloseTo(-90, 0);
      expect(((after - before + 540) % 360) - 180).toBeCloseTo(angle > 0 ? -90 : 90, 0);
      // The turn carries the track to the -z side (north) for a left turn, the +z side for a right one.
      expect(Math.sign(pts[at(turn.to)]![2])).toBe(side);
    }
  });

  it('every part of the car is an official LDraw part, and none is a LEGO set coaster car', () => {
    const parts = new Set(car.bricks.map(b => b.part.toLowerCase().replace(/\.dat$/, '')));
    expect(parts.size).toBeGreaterThanOrEqual(8);
    for (const part of parts) expect.soft(isOfficialPartName(part), part).toBe(true);
    for (const forbidden of ['26021', '26021c01', '24869', '25059']) expect(parts.has(forbidden)).toBe(false);
    expect(car.wheelbaseLdu).toBe(80);
    expect(car.gaugeLdu).toBe(56);
  });

  it('the track gauge is the wheel spacing of the car and its rail tops sit at the route sample (railTopOffsetB 0)', () => {
    expect(COASTER_TRACK_MESH.railTopOffsetB).toBe(0);
    expect(car.gaugeLdu / LDU_PER_BLOCK).toBeCloseTo(1.05, 9);
    const g = generateCoaster(small(SMALL));
    const track = buildCoasterTrackPack(g, { idPrefix: 'c_probe', car });
    expect(track.warnings).toEqual([]);
    // Station rails: level, heading +x, y = ground (1) after placement: the flat top of the straight bar is the sample.
    const bar = COASTER_TRACK_MESH.railU / 32;
    const [first, second] = [track.rails.find(r => r.rail === 'L' && r.index === 0)!, track.rails.find(r => r.rail === 'R' && r.index === 0)!];
    expect(Math.hypot(first.from[0] - second.from[0], first.from[1] - second.from[1], first.from[2] - second.from[2])).toBeCloseTo(car.gaugeLdu / LDU_PER_BLOCK, 6);
    // The bar's centreline is half a bar under the sample, so the bar's top face IS the sample (y = the platform's block).
    expect(first.from[1]).toBeCloseTo(placeGenerated(g).offset[1] - bar, 6);
  });

  it('the shipped rail chunks stand where the route is: the actor at the un-mirrored root, the geometry solved mirrored in z (mirror)', async () => {
    const g = generateCoaster(small(SMALL));
    const track = buildCoasterTrackPack(g, { idPrefix: 'probe_track', car });
    const grid = new BlockGrid(4, 1, 4); grid.set(0, 0, 0, 'minecraft:stone');
    const pack = await buildPlayableAddon(grid, { stem: 'probe', coasterTrack: { gen: g, car }, label: 'probe' });
    const appearance = packAppearance(await readAddon(pack.bytes));
    const placed = placeGenerated(g);

    /** Largest distance, blocks, from a route sample (strided) to the nearest drawn cube centre when each chunk actor's z is mapped by `z`. */
    const worstGap = (z: (rootZ: number) => number): number => {
      const actors: AuditActor[] = track.actors.map(a => ({ typeId: a.typeId, kind: 'shell', entry: appearance.byType.get(a.typeId)!, at: { x: a.x, y: a.y, z: z(a.z) }, yawDeg: 0 }));
      expect(actors.every(a => a.entry)).toBe(true);
      const centres = new Map<string, { sum: [number, number, number]; n: number }>();
      for (const f of worldFaces(actors)) {
        const key = `${f.actor}:${f.group}:${f.cube}`;
        const c = centres.get(key) ?? { sum: [0, 0, 0], n: 0 };
        for (const p of f.corners) { c.sum[0] += p[0]; c.sum[1] += p[1]; c.sum[2] += p[2]; c.n++; }
        centres.set(key, c);
      }
      const cubes = [...centres.values()].map(c => [c.sum[0] / c.n / 16, c.sum[1] / c.n / 16, c.sum[2] / c.n / 16] as const);
      let worst = 0;
      for (let i = 0; i < placed.points.length; i += 7) {
        const p = placed.points[i]!;
        let best = Infinity;
        for (const c of cubes) best = Math.min(best, Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]));
        worst = Math.max(worst, best);
      }
      return worst;
    };
    // The shipped actor z is already un-mirrored (`-root.z` of the mirrored mesh): every sample has a cube within a rail's reach.
    expect(worstGap(z => z)).toBeLessThan(1.6);
    // Standing the chunks at the mesh's own (mirrored) root would draw the whole course reflected in z.
    expect(worstGap(z => -z)).toBeGreaterThan(5);
  });
});

describe.skipIf(!HAVE_LIBRARY)('coaster-generated-route (library)', () => {
  it('the car datum is the wheel contact plane: its lowest point is at y = 0, on the rail top', async () => {
    setLDrawRoot(LDRAW_ROOT);
    const provider = createPartGeometryProvider();
    const car = parseCoasterCar(carText);
    let lowest = -Infinity, highest = Infinity, wheelBottom = -Infinity;
    for (const b of car.bricks) {
      const mesh = await provider.getPartMesh(b.part);
      expect(mesh, b.part).not.toBeNull();
      const r = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      for (const tri of mesh!.triangles) for (const v of [tri.a, tri.b, tri.c]) {
        const y = r[3]! * v[0]! + r[4]! * v[1]! + r[5]! * v[2]! + b.y;
        lowest = Math.max(lowest, y); highest = Math.min(highest, y);
        if (b.part === '3641.dat') wheelBottom = Math.max(wheelBottom, y);
      }
    }
    // LDraw y is down: the largest y is the lowest point.
    expect(lowest).toBeCloseTo(0, 0);
    expect(wheelBottom).toBeCloseTo(0, 0);
    expect(-highest).toBeGreaterThan(80); // a rider-high tub, not a plate on wheels
  });
});

describe.skipIf(!HAVE_LIBRARY)('coaster-generated-route (simulator)', () => {
  it('a pack built from the 3x sketch places in the simulator and a car completes the full circuit', async () => {
    setLDrawRoot(LDRAW_ROOT);
    const { buildGeneratedCoasterPack } = await import('../web/src/engine/coaster-design-pack');
    const { scenarios } = await import('../scripts/_coaster_generated_scenarios');
    const { runScenario } = await import('../web/src/sim/scenario/runner');
    const { craftmaticHandlers } = await import('../web/src/sim/adapters/craftmatic/child-play');
    const { readCraftmaticPack } = await import('../web/src/sim/adapters/craftmatic/pack-facts');
    const built = await buildGeneratedCoasterPack(sketch, carText);
    expect(built.gen.report.lengthB).toBeGreaterThan(1870);
    const addon = await readAddon(built.result.bytes);
    const pack = readCraftmaticPack(addon)!;
    const [scenario] = scenarios(pack);
    expect(scenario).toBeDefined();
    const result = await runScenario(scenario!, [addon], { handlers: craftmaticHandlers(pack, addon) });
    expect(result.violations.map(v => `${v.invariant}: ${v.message}`)).toEqual([]);
    expect(result.status).toBe('pass');
    const lap = result.state['lap'] as { routeLength: number; covered: number };
    expect(lap.covered).toBeGreaterThan(0.99 * lap.routeLength);
    expect(lap.routeLength).toBeCloseTo(built.gen.report.lengthB, 1);
  }, 240_000);
});
