/**
 * Flyer mounts (engine/bedrock-flyer.ts, the `orbit` ride of
 * engine/bedrock-rides.ts, the `flyer` motion of engine/bedrock-vehicle.ts):
 * the detector on a fake scene of box parts, the orbit path's shape, and the
 * three serialised runtimes on fake worlds - the orbit that carries a figure,
 * the summon-and-fade of the player's clouds, and the client bob.
 */
import { describe, expect, it } from 'vitest';
import { FLYER, _flyerRuntimeForTests, findMounts, flyerScript, modelBoxLdu, orbitPathLdu, type FlyerRuntimeConfig } from '../web/src/engine/bedrock-flyer.js';
import { RIDE, _ridesRuntimeForTests, ridesScript } from '../web/src/engine/bedrock-rides.js';
import { FLYER_BOB, VEHICLE_BODY_MOTION, vehicleClientAnimation } from '../web/src/engine/bedrock-vehicle.js';
import { SET_CANON } from '../web/src/engine/set-canon.js';
import type { SceneFigure } from '../web/src/engine/bedrock-scene-actors.js';
import type { LdrawPartMesh, LdrawTriangle, Vec3 } from '../web/src/engine/ldraw-part-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const brick = (part: string, color: number, x: number, y: number, z: number, rot: number[] = I): ParsedBrick => ({ part, color, x, y, z, rot });

/** A mesh of one axis-aligned box (two triangles per face), LDraw frame, origin at the top like the library's bricks. */
function boxMesh(partId: string, description: string, min: Vec3, max: Vec3): LdrawPartMesh {
  const triangles: LdrawTriangle[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => { triangles.push({ a, b, c, color: 16 }, { a, b: c, c: d, color: 16 }); };
  const [n, x] = [min, max];
  quad([n[0], n[1], n[2]], [x[0], n[1], n[2]], [x[0], n[1], x[2]], [n[0], n[1], x[2]]);
  quad([n[0], x[1], n[2]], [x[0], x[1], n[2]], [x[0], x[1], x[2]], [n[0], x[1], x[2]]);
  quad([n[0], n[1], n[2]], [x[0], n[1], n[2]], [x[0], x[1], n[2]], [n[0], x[1], n[2]]);
  quad([n[0], n[1], x[2]], [x[0], n[1], x[2]], [x[0], x[1], x[2]], [n[0], x[1], x[2]]);
  quad([n[0], n[1], n[2]], [n[0], n[1], x[2]], [n[0], x[1], x[2]], [n[0], x[1], n[2]]);
  quad([x[0], n[1], n[2]], [x[0], n[1], x[2]], [x[0], x[1], x[2]], [x[0], x[1], n[2]]);
  return { partId, resolvedAs: partId, triangles, studs: [], bounds: { min, max }, unresolvedRefs: [], description } as LdrawPartMesh;
}

const MESHES = new Map<string, LdrawPartMesh>([
  ['3003.dat', boxMesh('3003', 'Brick  2 x  2', [-20, 0, -20], [20, 24, 20])],
  ['3024.dat', boxMesh('3024', 'Plate  1 x  1', [-10, 0, -10], [10, 8, 10])],
  ['973.dat', boxMesh('973', 'Minifig Torso', [-19, -12, -10], [19, 32, 10])],
  ['30374.dat', boxMesh('30374', 'Bar  4L Lightsaber Blade', [-4, 0, -4], [4, 100, 4])],
]);
const Y_TO_X = [0, 1, 0, -1, 0, 0, 0, 0, 1];
const GREY = 72, YELLOW = 14, ORANGE = 25, TRANS_CLEAR = 47;
const CLOUD_X = 200, CLOUD_TOP = -208;

/**
 * A scene like the Nimbus fixture: a 3 x 3 x 17 pillar of grey bricks (153),
 * a 20-part yellow cloud two studs off its flank at `CLOUD_X`, a minifig torso
 * standing on the cloud, and a 100-LDU clear bar joining pillar and cloud.
 */
function scene(options: { barColour?: number; cloudGrey?: number; figureOn?: 'cloud' | 'pillar' | 'air' | 'none' } = {}) {
  const bricks: ParsedBrick[] = [];
  for (let k = 0; k < 17; k++) for (const x of [-40, 0, 40]) for (const z of [-40, 0, 40]) bricks.push(brick('3003.dat', GREY, x, -24 - 24 * k, z));
  const cloud: ParsedBrick[] = [];
  for (const ix of [-30, -10, 10, 30]) for (const iz of [-30, -10, 10, 30]) cloud.push(brick('3024.dat', YELLOW, CLOUD_X + ix, -200, iz));
  for (const ix of [-10, 10]) for (const iz of [-10, 10]) cloud.push(brick('3024.dat', YELLOW, CLOUD_X + ix, CLOUD_TOP, iz));
  cloud.slice(0, options.cloudGrey ?? 0).forEach(b => { b.color = GREY; });
  bricks.push(...cloud);
  bricks.push(brick('30374.dat', options.barColour ?? TRANS_CLEAR, 60, -196, 0, Y_TO_X)); // x 60..160
  const figures: SceneFigure[] = [];
  const where = options.figureOn ?? 'cloud';
  if (where !== 'none') {
    const floor = where === 'cloud' ? CLOUD_TOP : where === 'pillar' ? -24 * 17 : -400;
    const x = where === 'cloud' ? CLOUD_X : where === 'air' ? 400 : 0; // 'air': off every part's footprint
    const torso = brick('973.dat', ORANGE, x, floor - 72, 0);
    bricks.push(torso);
    figures.push({ bricks: [torso], centreLdu: [x, floor - 48, 0], floorLdu: floor, facingLdu: [0, -1], tiltDeg: 0, seated: false });
  }
  return { bricks, figures, cloud };
}
const CANON = SET_CANON['11390']!.mounts!;

describe('findMounts', () => {
  it('finds the cloud under the figure: 20 parts, all cloud colours, its top under the soles', () => {
    const s = scene();
    const r = findMounts(s.bricks, MESHES, s.figures, CANON);
    expect(r.missing).toEqual([]);
    expect(r.mounts).toHaveLength(1);
    const m = r.mounts[0]!;
    expect(m.bricks).toHaveLength(20);
    expect(new Set(m.bricks)).toEqual(new Set(s.cloud));
    expect(m.colourShare).toBe(1);
    expect(m.figure).toBe(s.figures[0]);
    expect(m.topLdu).toEqual([CLOUD_X, CLOUD_TOP, 0]);
    expect(m.canon.style).toBe('cloud');
  });

  it('a translucent bar between the cloud and the model does not join them; an opaque one does, and the cloud is then the model', () => {
    const joined = scene({ barColour: YELLOW });
    const r = findMounts(joined.bricks, MESHES, joined.figures, CANON);
    expect(r.mounts).toEqual([]);
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]!.reason).toMatch(/over 80|largest/);
  });

  it('a cluster of the wrong colours is not the mount, and the report says how far off it is', () => {
    const s = scene({ cloudGrey: 12 });
    const r = findMounts(s.bricks, MESHES, s.figures, CANON);
    expect(r.mounts).toEqual([]);
    expect(r.missing[0]!.reason).toMatch(/40 percent .* cloud colours/);
  });

  it('a figure on the model itself, in the air, or no figure at all: nothing found, each with its reason', () => {
    expect(findMounts(scene({ figureOn: 'pillar' }).bricks, MESHES, scene({ figureOn: 'pillar' }).figures, CANON).missing[0]!.reason).toMatch(/153 parts \(over 80\)/);
    expect(findMounts(scene({ figureOn: 'air' }).bricks, MESHES, scene({ figureOn: 'air' }).figures, CANON).missing[0]!.reason).toMatch(/stands on no solid part/);
    expect(findMounts(scene({ figureOn: 'none' }).bricks, MESHES, [], CANON).missing[0]!.reason).toMatch(/no upright figure/);
    expect(findMounts(scene().bricks, MESHES, scene().figures, []).mounts).toEqual([]);
  });

  it('the model box leaves out what is excluded', () => {
    const s = scene();
    const all = modelBoxLdu(s.bricks, MESHES)!;
    const without = modelBoxLdu(s.bricks, MESHES, new Set([...s.cloud, s.figures[0]!.bricks[0]!]))!;
    expect(all.max[0]).toBe(CLOUD_X + 40);
    expect(without.max[0]).toBe(160); // the bar's far end
    expect(without.min[1]).toBe(-24 * 17);
  });
});

describe('orbitPathLdu', () => {
  const box = { min: [-60, -408, -60] as Vec3, max: [60, 0, 60] as Vec3 };
  const path = orbitPathLdu(box, [CLOUD_X, CLOUD_TOP, 0]);
  const r = Math.hypot(60, 60) + FLYER.ORBIT_MARGIN_LDU;

  it('is a closed loop of ORBIT_POINTS points on a circle just outside the footprint diagonal, starting nearest the mount', () => {
    expect(path).toHaveLength(FLYER.ORBIT_POINTS);
    for (const p of path) expect(Math.hypot(p[0], p[2])).toBeCloseTo(r, 6);
    expect(path[0]![0]).toBeCloseTo(r, 6); // the mount is at +x
    expect(path[0]![2]).toBeCloseTo(0, 6);
    const seg = Math.hypot(path[1]![0] - path[0]![0], path[1]![2] - path[0]![2]);
    const close = Math.hypot(path[0]![0] - path[path.length - 1]![0], path[0]![2] - path[path.length - 1]![2]);
    expect(close).toBeCloseTo(seg, 6);
  });

  it('turns one way the whole lap', () => {
    const cross = (k: number): number => { const a = path[k]!, b = path[(k + 1) % path.length]!, c = path[(k + 2) % path.length]!; return (b[0] - a[0]) * (c[2] - b[2]) - (b[2] - a[2]) * (c[0] - b[0]); };
    const sign = Math.sign(cross(0));
    for (let k = 0; k < path.length; k++) expect(Math.sign(cross(k))).toBe(sign);
  });

  it('flies in the upper third, rising and falling ORBIT_BOB_PERIODS times by ORBIT_BOB_LDU', () => {
    const y0 = box.max[1] - FLYER.ORBIT_HEIGHT_FRACTION * (box.max[1] - box.min[1]);
    const ys = path.map(p => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(y0 - FLYER.ORBIT_BOB_LDU, 6);
    expect(Math.max(...ys)).toBeCloseTo(y0 + FLYER.ORBIT_BOB_LDU, 6);
    expect(y0).toBeLessThan(box.max[1] - (box.max[1] - box.min[1]) * 2 / 3); // LDraw y down: above the model's two-thirds line
    // The sine is exactly zero on four of the 64 points; count the sign changes between the others.
    const signs = ys.map(y => Math.abs(y - y0) < 1e-9 ? 0 : Math.sign(y - y0)).filter(s => s !== 0);
    let crossings = 0;
    for (let k = 0; k < signs.length; k++) if (signs[k] !== signs[(k + 1) % signs.length]) crossings++;
    expect(crossings).toBe(FLYER.ORBIT_BOB_PERIODS * 2);
  });
});

describe('the orbit ride runtime', () => {
  /** A fake world: an orbit seat with its path, a cloud car beside it, and one figure of the rider type standing nearby. */
  function world(options: { seated?: boolean } = {}) {
    const path = [{ x: 10, y: 20, z: 0 }, { x: 0, y: 21, z: 10 }, { x: -10, y: 20, z: 0 }, { x: 0, y: 19, z: -10 }];
    const props = new Map<string, unknown>([['craftmatic:ride', 0], ['craftmatic:ride_scale', 1], ['craftmatic:ride_path', JSON.stringify(path)]]);
    const riders: any[] = [];
    const figure: any = { id: 'fig', typeId: 'craftmatic:t_fig1', location: { x: 12, y: 0, z: 0 }, rotation: { x: 0, y: 0 }, riding: false,
      getComponent: (n: string) => n === 'minecraft:riding' && figure.riding ? {} : undefined,
      teleport(p: any) { this.location = { ...p }; }, setRotation(r: any) { this.rotation = { ...r }; } };
    const car: any = { id: 'car', typeId: 'craftmatic:t_car', location: { x: 10, y: 19.5, z: 0.5 }, rotation: { y: 0 },
      getDynamicProperty: (k: string) => k === 'craftmatic:ride' ? 0 : undefined,
      tryTeleport(p: any, o: any) { this.location = { ...p }; if (o?.rotation) this.rotation = { ...o.rotation }; return true; } };
    const seat: any = {
      id: 'seat', typeId: 'craftmatic:t_orbit', isValid: true, location: { ...path[0]! }, rotation: { y: 0 },
      getDynamicProperty: (k: string) => props.get(k), setDynamicProperty: (k: string, v: unknown) => props.set(k, v),
      tryTeleport(p: any, o: any) { this.location = { ...p }; if (o?.rotation) this.rotation = { ...o.rotation }; return true; },
      getComponent: (n: string) => n === 'minecraft:rideable' ? { getRiders: () => riders, addRider: (e: any) => { if (riders.length) return false; riders.push(e); e.riding = true; return true; } } : undefined,
    };
    const dim: any = { id: 'overworld', getEntities: (q: any) => (q.type === 'craftmatic:t_orbit' ? [seat] : q.type === 'craftmatic:t_car' ? [car] : q.type === 'craftmatic:t_fig1' ? [figure] : []) };
    seat.dimension = dim; car.dimension = dim; figure.dimension = dim;
    if (options.seated) { riders.push(figure); figure.riding = true; }
    let tick = 0; let loop: () => void = () => {};
    (globalThis as any).world = { getAllPlayers: () => [], getDimension: () => dim };
    (globalThis as any).system = { get currentTick() { return tick; }, runInterval: (f: () => void) => { loop = f; } };
    _ridesRuntimeForTests({ seatType: 'craftmatic:t_ride', rides: [{ kind: 'orbit', carType: 'craftmatic:t_car', seatType: 'craftmatic:t_orbit', riderType: 'craftmatic:t_fig1' }], constants: RIDE });
    return { seat, car, figure, riders, path, run: (n: number) => { for (let i = 0; i < n; i++) { tick++; loop(); } } };
  }

  it('starts by itself, carries the cloud at its offset, faces along the loop and wraps round', () => {
    const w = world({ seated: true });
    w.run(RIDE.ORBIT_ADOPT_TICKS + 2);
    const start = w.seat.location;
    expect(Math.hypot(start.x - 10, start.z)).toBeGreaterThan(0.05); // moving
    expect(w.car.location.y - w.seat.location.y).toBeCloseTo(-0.5, 6);
    expect(w.car.location.z - w.seat.location.z).toBeCloseTo(0.5, 6);
    expect(w.figure.rotation.y).toBeCloseTo(w.seat.rotation.y, 6);
    // The diamond's lap is ~57 blocks at 3 blocks/s: after 30 s it has wrapped and is still on the loop (7.07 at a mid-edge, 10 at a corner).
    w.run(600);
    expect(Math.hypot(w.seat.location.x, w.seat.location.z)).toBeGreaterThan(7);
    expect(Math.hypot(w.seat.location.x, w.seat.location.z)).toBeLessThan(10.1);
  });

  it('puts its figure on the seat when it is off, and a figure a player is holding is not fought for every tick', () => {
    const w = world();
    expect(w.riders).toHaveLength(0);
    w.run(RIDE.ORBIT_ADOPT_TICKS + 2);
    expect(w.riders).toEqual([w.figure]);
    // Teleported up onto the seat (a real rider then rides along; this fake one stays where it was put).
    expect(Math.abs(w.figure.location.y - 20)).toBeLessThan(1.5);
    // Knocked off: put back after ORBIT_RESEAT_TICKS.
    w.riders.length = 0; w.figure.riding = false;
    w.run(2);
    expect(w.riders).toHaveLength(0);
    w.run(RIDE.ORBIT_RESEAT_TICKS + 1);
    expect(w.riders).toEqual([w.figure]);
  });

  it('serialises into a module that names only Script API globals', () => {
    const src = ridesScript({ seatType: 'x:y', rides: [{ kind: 'orbit', carType: 'x:c', seatType: 'x:s', riderType: 'x:f' }], constants: RIDE });
    expect(() => new Function('world', 'system', src.replace(/^import.*\n/, ''))).not.toThrow();
  });
});

describe('the summon-and-fade runtime', () => {
  const CLOUD = 'craftmatic:t_cloud', FIG = 'craftmatic:t_fig1', CAR = 'craftmatic:t_car', SEAT = 'craftmatic:t_orbit';
  function world(options: { sizeFactor?: number } = {}) {
    const clouds: any[] = [];
    const events: Record<string, Array<(ev: any) => void>> = { interact: [], hit: [] };
    const removed: string[] = [];
    let tick = 0; let loop: () => void = () => {}; const timeouts: Array<() => void> = [];
    const seat: any = { id: 'seat', typeId: SEAT, location: { x: 30, y: 20, z: 0 }, getDynamicProperty: (k: string) => k === 'craftmatic:ride_scale' ? options.sizeFactor ?? 1 : undefined };
    const figure: any = { id: 'fig', typeId: FIG, location: { x: 30, y: 20, z: 0 } };
    const car: any = { id: 'car', typeId: CAR, location: { x: 30, y: 19.5, z: 0 } };
    const dim: any = {
      id: 'overworld', particles: 0, sounds: [] as string[],
      getEntities: (q: any) => q.type === CLOUD ? clouds.filter(c => !removed.includes(c.id)) : q.type === SEAT ? [seat] : [],
      spawnParticle() { this.particles++; }, playSound(id: string) { this.sounds.push(id); },
      spawnEntity(type: string, at: any) {
        const props = new Map<string, unknown>();
        const riders: any[] = [];
        const e: any = { id: `cloud${clouds.length + 1}`, typeId: type, location: { ...at }, rotation: { y: 0 }, events: [] as string[], riders, dimension: dim,
          setRotation(r: any) { this.rotation = { ...r }; }, setDynamicProperty: (k: string, v: unknown) => props.set(k, v), getDynamicProperty: (k: string) => props.get(k),
          triggerEvent(name: string) { this.events.push(name); }, remove() { removed.push(this.id); },
          getComponent: (n: string) => n === 'minecraft:rideable' ? { getRiders: () => riders, addRider: (p: any) => { riders.push(p); p.riding = e; return true; }, ejectRiders: () => { for (const p of riders) p.riding = undefined; riders.length = 0; } } : undefined };
        clouds.push(e);
        return e;
      },
    };
    const player: any = { id: 'p1', typeId: 'minecraft:player', location: { x: 0, y: 5, z: 0 }, riding: undefined as any, hud: '', dimension: dim,
      getRotation: () => ({ x: 0, y: 0 }), getComponent: (n: string) => n === 'minecraft:riding' && player.riding ? { entityRidingOn: player.riding } : undefined,
      onScreenDisplay: { setActionBar: (s: string) => { player.hud = s; } } };
    (globalThis as any).world = {
      getAllPlayers: () => [player],
      afterEvents: { playerInteractWithEntity: { subscribe: (f: any) => events.interact!.push(f) }, entityHitEntity: { subscribe: (f: any) => events.hit!.push(f) } },
    };
    (globalThis as any).system = { get currentTick() { return tick; }, runInterval: (f: () => void) => { loop = f; }, runTimeout: (f: () => void) => { timeouts.push(f); } };
    const config: FlyerRuntimeConfig = {
      mounts: [{ cloudType: CLOUD, summonTypes: [FIG, CAR, SEAT], seatType: SEAT, label: 'Nimbus' }],
      sizeEvents: [100, 200].map(pct => ({ pct, event: `craftmatic:size_${pct}` })),
      particle: 'minecraft:test_puff', spawnSound: 'random.pop', fadeSound: 'random.fizz',
      constants: { EMPTY_DESPAWN_TICKS: FLYER.EMPTY_DESPAWN_TICKS, CLOUD_CAP: FLYER.CLOUD_CAP, TAP_COOLDOWN_TICKS: FLYER.TAP_COOLDOWN_TICKS, SPAWN_AHEAD_BLOCKS: FLYER.SPAWN_AHEAD_BLOCKS },
    };
    _flyerRuntimeForTests(config);
    const live = () => clouds.filter(c => !removed.includes(c.id));
    return {
      player, figure, car, seat, dim, live, removed,
      tap: (target: any) => { for (const f of events.interact!) f({ player, target }); },
      hit: (target: any) => { for (const f of events.hit!) f({ damagingEntity: player, hitEntity: target }); },
      run: (n: number) => { for (let i = 0; i < n; i++) { tick++; if (tick % 10 === 0) loop(); while (timeouts.length) timeouts.shift()!(); } },
    };
  }

  it('a tap on the figure summons a cloud ahead of the player, mounts them, puffs and sounds', () => {
    const w = world();
    w.tap(w.figure);
    expect(w.live()).toHaveLength(1);
    const c = w.live()[0]!;
    expect(c.location.z).toBeCloseTo(FLYER.SPAWN_AHEAD_BLOCKS, 6); // yaw 0 faces +z
    expect(c.riders).toEqual([w.player]);
    expect(w.player.riding).toBe(c);
    expect(w.dim.particles).toBeGreaterThan(0);
    expect(w.dim.sounds).toContain('random.pop');
    expect(w.player.hud).toMatch(/Nimbus/);
    expect(c.events).toEqual([]); // 100 %: no size event
  });

  it('a tap on the cloud or its seat, or a hit, summons too; a stranger does not', () => {
    const w = world();
    w.tap(w.car); w.player.riding = undefined; w.run(FLYER.TAP_COOLDOWN_TICKS + 1);
    w.hit(w.seat); w.player.riding = undefined; w.run(FLYER.TAP_COOLDOWN_TICKS + 1);
    w.tap({ id: 'x', typeId: 'minecraft:cow', location: { x: 0, y: 0, z: 0 } });
    expect(w.live()).toHaveLength(2);
  });

  it('a second tap inside the cooldown, or a tap while already aboard a cloud, gives nothing', () => {
    const w = world();
    w.tap(w.figure); w.tap(w.figure);
    expect(w.live()).toHaveLength(1);
    w.run(FLYER.TAP_COOLDOWN_TICKS + 1);
    w.tap(w.figure); // still aboard
    expect(w.live()).toHaveLength(1);
  });

  it('a summoned cloud takes the placed size of the companion seat beside the tapped figure', () => {
    const w = world({ sizeFactor: 2 });
    w.tap(w.figure);
    expect(w.live()[0]!.events).toEqual(['craftmatic:size_200']);
  });

  it('an empty cloud fades after EMPTY_DESPAWN_TICKS, a ridden one never; the fade puffs and sounds', () => {
    const w = world();
    w.tap(w.figure);
    const c = w.live()[0]!;
    w.run(FLYER.EMPTY_DESPAWN_TICKS + 20);
    expect(w.live()).toHaveLength(1); // ridden all along
    c.getComponent('minecraft:rideable').ejectRiders();
    w.run(FLYER.EMPTY_DESPAWN_TICKS - 20);
    expect(w.live()).toHaveLength(1);
    w.run(40);
    expect(w.live()).toHaveLength(0);
    expect(w.dim.sounds).toContain('random.fizz');
  });

  it('at most CLOUD_CAP summoned clouds: the oldest fades when one more is summoned', () => {
    const w = world();
    for (let i = 0; i < FLYER.CLOUD_CAP + 3; i++) {
      w.tap(w.figure);
      w.player.riding = undefined;
      w.run(FLYER.TAP_COOLDOWN_TICKS + 1);
    }
    expect(w.live()).toHaveLength(FLYER.CLOUD_CAP);
    expect(w.removed).toEqual(['cloud1', 'cloud2', 'cloud3']);
  });

  it('serialises into a module that names only Script API globals', () => {
    const src = flyerScript({ mounts: [{ cloudType: 'x:c', summonTypes: ['x:f'], label: 'Cloud' }], sizeEvents: [], particle: 'p', spawnSound: 's', fadeSound: 'f', constants: FLYER });
    expect(src).toMatch(/^import \{ world, system \} from '@minecraft\/server';/);
    expect(() => new Function('world', 'system', src.replace(/^import.*\n/, ''))).not.toThrow();
  });
});

describe('the flyer motion', () => {
  it('banks a little, never dips its nose, and bobs on the body bone by FLYER_BOB', () => {
    expect(VEHICLE_BODY_MOTION.flyer.noseDownPerSpeed).toBe(0);
    expect(VEHICLE_BODY_MOTION.flyer.rollPerYawRate).toBeLessThan(0);
    const anim = vehicleClientAnimation('t_cloud', 'flyer', []);
    const bones = (anim.file as any).animations[anim.id].bones;
    expect(bones.body.position).toEqual([0, 'v.cm_bob', 0]);
    expect(anim.client.initialize).toContain('v.cm_bob = 0.0;');
    expect(anim.client.preAnimation.some(l => l.includes(`q.life_time * ${FLYER_BOB.DEGREES_PER_SECOND}`) && l.includes(`* ${FLYER_BOB.AMPLITUDE_UNITS}`))).toBe(true);
    // A native mount: no scripted attitude properties in the animation.
    expect(anim.client.preAnimation.some(l => l.includes('q.property'))).toBe(false);
    // A rotor keeps its nose dip and no bob.
    const rotor = vehicleClientAnimation('t_heli', 'rotor', []);
    expect((rotor.file as any).animations[rotor.id].bones.body.position).toBeUndefined();
  });
});
