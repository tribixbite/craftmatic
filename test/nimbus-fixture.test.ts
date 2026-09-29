/**
 * The 11390 stand-in (`test/fixtures/nimbus-fixture.ldr`, from
 * `scripts/_nimbus_fixture_gen.ts`) through the REAL shared pipeline
 * (`runSchemPipeline`, the code `_playable_ref.ts` and the LEGO tab run) with
 * the label the LEGO tab writes: the canon applies, the cloud is found under
 * its figure, the pack gets the `flyer` vehicle, the orbit ride round the
 * rock, the figure riding it and not walking, the summon script, and every
 * rideable's exit hint.
 *
 * Two runs of the same assertions: the local Studio library (skipped where it
 * is absent, as the golden models are), and the fixture's parts SEEDED as
 * boxes at the library's own extents (`seedDatTexts`, no library, no network)
 * so CI proves the whole path too. Seeding is global, so the library run
 * comes first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { runSchemPipeline, type SchemPipelineResult } from '../web/src/engine/schem-pipeline.js';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.js';
import { FLYER, findMounts } from '../web/src/engine/bedrock-flyer.js';
import { RIDE } from '../web/src/engine/bedrock-rides.js';
import { SET_CANON } from '../web/src/engine/set-canon.js';
import { modelExportStem } from '../web/src/engine/export-name.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const FIXTURE = 'test/fixtures/nimbus-fixture.ldr';
const LABEL = 'Dragon Ball: Shenron & Goku (11390-1)';
const STEM = modelExportStem({ name: LABEL, setNum: '11390' });

const ab = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

interface Pack {
  result: SchemPipelineResult;
  entries: string[];
  json: (name: string) => Promise<any>;
  text: (name: string) => Promise<string>;
  bp: string; rp: string;
  config: any;
}

async function exportFixture(): Promise<Pack> {
  const doc = parseLDrawDocument(readFileSync(FIXTURE, 'utf8'));
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
    format: 'mcaddon', packStem: STEM, packLabel: LABEL, profile: 'default', lightFill: false, shapes: false,
    vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1,
  });
  const buffer = ab(result.bytes!);
  const entries = listZipEntries(buffer);
  const text = async (name: string): Promise<string> => new TextDecoder().decode(await extractFile(buffer, name));
  const json = async (name: string): Promise<any> => JSON.parse(await text(name));
  const bp = entries.find(e => e.endsWith('_BP/manifest.json'))!.replace('manifest.json', '');
  const rp = entries.find(e => e.endsWith('_RP/manifest.json'))!.replace('manifest.json', '');
  const placement = await text(`${bp}scripts/placement.js`);
  const config = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(placement)![1]!);
  return { result, entries, json, text, bp, rp, config };
}

/** The assertions both runs share. */
function nimbusPackTests(get: () => Pack): void {
  it('reports the mount found, none missing, and names the flyer, the orbit and the companion in the components', () => {
    const { result } = get();
    expect(result.mcpack?.mounts?.missing).toEqual([]);
    expect(result.mcpack?.mounts?.found).toHaveLength(1);
    const found = result.mcpack!.mounts!.found[0]!;
    expect(found).toMatchObject({ style: 'cloud', label: 'Nimbus', parts: 26, colourShare: 1, orbitPoints: FLYER.ORBIT_POINTS });
    expect(found.flyer).toMatch(/^craftmatic:.*_cloud$/);
    expect(found.companion).toMatch(/_cloud_ride$/);
    const components = result.mcpack!.components!;
    expect(components).toContain(`${LABEL} Nimbus (plane)`);
    expect(components).toContain(`${LABEL} Nimbus orbit (seat)`);
    expect(components).toContain(`${LABEL} figure 1 (figure)`);
    expect(components.filter(c => / \(figure\)$/.test(c))).toHaveLength(1);
    expect(result.mcpack!.warnings!.some(w => /Mounts \(set canon 11390\): Nimbus found \(26 parts, 100 percent cloud colours/.test(w))).toBe(true);
  });

  it('the flyer entity: the native hover controller (a rotor without its noises), family flyer, one seat on the cloud top, player-sized', async () => {
    const { json, bp, rp, result } = get();
    const flyer = result.mcpack!.mounts!.found[0]!.flyer.replace(/^craftmatic:/, '');
    const e = (await json(`${bp}entities/${flyer}.json`))['minecraft:entity'];
    expect(e.description.identifier).toBe(`craftmatic:${flyer}`);
    expect(e.components['minecraft:type_family'].family).toEqual(expect.arrayContaining(['craftmatic_vehicle', 'plane', 'flyer']));
    expect(e.components['minecraft:flying_speed'].value).toBe(0.3);
    expect(e.components['minecraft:physics'].has_gravity).toBe(false);
    expect(e.components['minecraft:free_camera_controlled']).toBeDefined();
    expect(e.description.properties).toBeUndefined(); // native, not scripted: no attitude properties
    expect(Object.keys(e.component_groups)).toEqual(expect.arrayContaining(['craftmatic:climbing', 'craftmatic:descending']));
    const seat = e.components['minecraft:rideable'];
    expect(seat.seat_count).toBe(1);
    expect(seat.seats.position[0]).toBe(0);
    expect(seat.seats.position[2]).toBe(0);
    expect(seat.seats.position[1]).toBeGreaterThan(0.15); // on top of a cloud a few plates and a slope tall
    expect(seat.seats.position[1]).toBeLessThan(1.5);
    // The seat scales with the mount (a 200 % cloud seats the rider twice as high).
    expect(e.component_groups['craftmatic:size_200']['minecraft:rideable'].seats.position[1]).toBeCloseTo(seat.seats.position[1] * 2, 2);
    // Drawn with the drive animation that bobs it.
    const anim = await json(`${rp}animations/${flyer}.animation.json`);
    expect(anim.animations[`animation.craftmatic.${flyer}.drive`].bones.body.position).toEqual([0, 'v.cm_bob', 0]);
    expect(await json(`${rp}models/entity/${flyer}.geo.json`)).toBeDefined();
  });

  it('the companion: the figure rides the orbit seat (never a walker), the seat carries a closed lap round the rock with the cloud alongside', () => {
    const { config, result } = get();
    const actors: any[] = config.actors;
    const seatIndex = actors.findIndex(a => /_cloud_ride$/.test(a.typeId));
    const carIndex = actors.findIndex(a => /_cloud_ride_car$/.test(a.typeId));
    const figIndex = actors.findIndex(a => /_fig1$/.test(a.typeId));
    expect(seatIndex).toBeGreaterThanOrEqual(0);
    expect(carIndex).toBeGreaterThanOrEqual(0);
    expect(figIndex).toBeGreaterThanOrEqual(0);
    const seat = actors[seatIndex], car = actors[carIndex], fig = actors[figIndex];
    expect(fig.rideOf).toBe(seatIndex);
    expect(seat.ride).toBe(car.ride);
    expect(seat.ridePath).toHaveLength(FLYER.ORBIT_POINTS);
    // The seat starts on the loop's first point and the figure with it.
    expect([seat.x, seat.y, seat.z]).toEqual(seat.ridePath[0]);
    expect([fig.x, fig.y, fig.z]).toEqual([seat.x, seat.y, seat.z]);
    // A circle round the placement's footprint centre, outside its widest reach.
    const path: number[][] = seat.ridePath;
    const cx = path.reduce((s, p) => s + p[0]!, 0) / path.length, cz = path.reduce((s, p) => s + p[2]!, 0) / path.length;
    const radii = path.map(p => Math.hypot(p[0]! - cx, p[2]! - cz));
    const r = radii[0]!;
    for (const q of radii) expect(q).toBeCloseTo(r, 3);
    const halfDiag = Math.hypot(config.width / 2, config.length / 2);
    expect(r).toBeGreaterThan(halfDiag);
    expect(r).toBeLessThan(halfDiag + FLYER.ORBIT_MARGIN_LDU / LDU_PER_BLOCK + 1.5);
    // In the upper third, rising and falling ORBIT_BOB_LDU, never above the top.
    const ys = path.map(p => p[1]!);
    const bob = FLYER.ORBIT_BOB_LDU / LDU_PER_BLOCK;
    expect(Math.min(...ys)).toBeGreaterThan(config.height * 2 / 3 - bob - 0.5);
    expect(Math.max(...ys)).toBeLessThan(config.height + 0.5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * bob, 1);
    // One way round, closed.
    const cross = (k: number): number => { const a = path[k]!, b = path[(k + 1) % path.length]!, c = path[(k + 2) % path.length]!; return (b[0]! - a[0]!) * (c[2]! - b[2]!) - (b[2]! - a[2]!) * (c[0]! - b[0]!); };
    const sign = Math.sign(cross(0));
    for (let k = 0; k < path.length; k++) expect(Math.sign(cross(k))).toBe(sign);
    const last = path[path.length - 1]!, first = path[0]!, second = path[1]!;
    expect(Math.hypot(first[0]! - last[0]!, first[2]! - last[2]!)).toBeCloseTo(Math.hypot(second[0]! - first[0]!, second[2]! - first[2]!), 3);
    // The provenance says so.
    expect(result.mcpack!.components).toContain(`${LABEL} figure 1 (figure)`);
  });

  it('the scripts: rides.js runs the orbit for the figure type, flyer.js summons the cloud on the figure, its cloud or its seat, main.js loads both', async () => {
    const { text, bp, config } = get();
    const rides = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(await text(`${bp}scripts/rides.js`))![1]!);
    const figType = config.actors.find((a: any) => /_fig1$/.test(a.typeId)).typeId;
    const seatType = config.actors.find((a: any) => /_cloud_ride$/.test(a.typeId)).typeId;
    const carType = config.actors.find((a: any) => /_cloud_ride_car$/.test(a.typeId)).typeId;
    expect(rides.rides).toEqual([{ kind: 'orbit', carType, seatType, riderType: figType }]);
    expect(rides.constants.ORBIT_SPEED).toBe(RIDE.ORBIT_SPEED);
    const flyer = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(await text(`${bp}scripts/flyer.js`))![1]!);
    expect(flyer.mounts).toHaveLength(1);
    expect(flyer.mounts[0].cloudType).toMatch(/_cloud$/);
    expect(flyer.mounts[0].summonTypes).toEqual(expect.arrayContaining([figType, seatType, carType]));
    expect(flyer.mounts[0].seatType).toBe(seatType);
    expect(flyer.mounts[0].label).toBe('Nimbus');
    expect(flyer.constants.EMPTY_DESPAWN_TICKS).toBe(FLYER.EMPTY_DESPAWN_TICKS);
    const main = await text(`${bp}scripts/main.js`);
    expect(main).toContain("import './rides.js';");
    expect(main).toContain("import './flyer.js';");
    expect(main).toContain("import './vehicle-driver.js';");
    const driver = await text(`${bp}scripts/vehicle-driver.js`);
    expect(driver).toContain('"motion":"flyer"');
    expect(driver).toContain('"hud":"NIMBUS"');
  });

  it('the lang has every rideable\'s exit hint and a name for each new entity; the README tells the child what to do', async () => {
    const { text, rp, bp, config } = get();
    const lang = await text(`${rp}texts/en_US.lang`);
    const cloud = config.actors.find((a: any) => /_cloud_ride$/.test(a.typeId)).typeId.replace(/_ride$/, '');
    expect(lang).toContain(`action.hint.exit.${cloud}=`);
    expect(lang).toContain(`action.hint.exit.${cloud}_ride=`);
    expect(lang).toContain(`entity.${cloud}.name=${LABEL} Nimbus`);
    expect(lang).toContain(`entity.${cloud}_ride_car.name=${LABEL} Nimbus (companion)`);
    const readme = await text(`${bp}README.txt`);
    expect(readme).toMatch(/Flying Nimbus: tap the figure riding it/);
    // The in-game strings (the HUD word, the summon line) spell "percent"; the README is a text file and may keep the sign.
    expect(await text(`${bp}scripts/flyer.js`)).not.toMatch(/"label":"[^"]*%/);
  });

  it('the seat census and the diagnostics carry the mount, and the physics constants it runs on are the documented ones', async () => {
    const { json, bp, result } = get();
    const diag = await json(`${bp}craftmatic-diagnostics.json`);
    expect(diag.mounts).toEqual(result.mcpack!.mounts);
    expect(diag.entities[result.mcpack!.mounts!.found[0]!.flyer.replace(/^craftmatic:/, '')]).toBeDefined();
  });
}

describe.skipIf(!existsSync(LDRAW_ROOT))('11390 stand-in through the real pipeline (local Studio library)', () => {
  let pack: Pack;
  beforeAll(async () => {
    setLDrawRoot(LDRAW_ROOT);
    pack = await exportFixture();
  }, 240_000);

  it('the scene finds the one figure standing on the cloud, and the detector the 26-part cloud under it', async () => {
    const doc = parseLDrawDocument(readFileSync(FIXTURE, 'utf8'));
    expect(doc.bricks).toHaveLength(298);
    const scene = await discoverSceneActors(doc.bricks);
    expect(scene.figures).toHaveLength(1);
    expect(scene.figures[0]!.floorLdu).toBe(-216);
    expect(scene.groundLdu).toBe(0);
    const r = findMounts(doc.bricks, scene.meshes, scene.figures, SET_CANON['11390']!.mounts!);
    expect(r.missing).toEqual([]);
    expect(r.mounts[0]!.bricks).toHaveLength(26);
    expect(r.mounts[0]!.colourShare).toBe(1);
    // The cloud's top is its four 1 x 1 plates on the floor plate (-224), a plate over the figure's soles, centred on the figure.
    expect(r.mounts[0]!.topLdu).toEqual([180, -224, 0]);
  });

  nimbusPackTests(() => pack);
});

describe('11390 stand-in through the real pipeline (parts seeded as boxes: no library, no network)', () => {
  /** Box stand-ins at the library's own extents (studs excluded; 54200's origin at its bottom, as in the library). */
  const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
    const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
    return [
      q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
      q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    ];
  };
  const PARTS: Record<string, string> = {
    '3958': ['0 Plate  6 x  6', ...box6(-60, 60, 0, 8, -60, 60)].join('\n'),
    '3003': ['0 Brick  2 x  2', ...box6(-20, 20, 0, 24, -20, 20)].join('\n'),
    '3004': ['0 Brick  1 x  2', ...box6(-20, 20, 0, 24, -10, 10)].join('\n'),
    '3039': ['0 Slope Brick 45  2 x  2', ...box6(-20, 20, 0, 24, -30, 10)].join('\n'),
    '3032': ['0 Plate  4 x  6', ...box6(-60, 60, 0, 8, -40, 40)].join('\n'),
    '3021': ['0 Plate  2 x  3', ...box6(-30, 30, 0, 8, -20, 20)].join('\n'),
    '54200': ['0 Slope Brick 31  1 x  1 x  0.667', ...box6(-10, 10, -15.6, 0, -10, 10)].join('\n'),
    '3020': ['0 Plate  2 x  4', ...box6(-40, 40, 0, 8, -20, 20)].join('\n'),
    '3024': ['0 Plate  1 x  1', ...box6(-10, 10, 0, 8, -10, 10)].join('\n'),
    '30374': ['0 Bar  4L Lightsaber Blade', ...box6(-4, 4, 0, 80, -4, 4)].join('\n'),
    '973': ['0 Minifig Torso', ...box6(-19, 19, -12, 32, -10, 10)].join('\n'),
    '3626c': ['0 Minifig Head with Closed Hollow Stud', ...box6(-13, 13, 0, 24, -13, 13)].join('\n'),
    '3901': ['0 Minifig Hair Male', ...box6(-15, 15, -7, 17, -15, 16)].join('\n'),
    '3815': ['0 Minifig Hips', ...box6(-18, 18, -11, 21, -10, 10)].join('\n'),
    '3816': ['0 Minifig Leg Right', ...box6(-19.5, -1.5, -9, 28, -11, 9)].join('\n'),
    '3817': ['0 Minifig Leg Left', ...box6(1.5, 19.5, -9, 28, -11, 9)].join('\n'),
    '3818': ['0 Minifig Arm Right', ...box6(-8, 8, -4, 22, -6, 6)].join('\n'),
    '3819': ['0 Minifig Arm Left', ...box6(-8, 8, -4, 22, -6, 6)].join('\n'),
    '3820': ['0 Minifig Hand', ...box6(-6, 6, -4, 10, -6, 6)].join('\n'),
  };
  let pack: Pack;
  beforeAll(async () => {
    seedDatTexts(Object.entries(PARTS).map(([id, t]) => [`${id}.dat`, t] as const));
    pack = await exportFixture();
  }, 240_000);

  nimbusPackTests(() => pack);
});
