/**
 * The pinball add-on runtime (bedrock-pinball.ts), run as the device runs it:
 * the serialised script evaluated with mocked `world` and `system`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  consoleAssets, fitPinballZone, pinballPropBehavior, pinballScript, pinballZoneTexture, rotationBetween, flipperRig, moveRig,
  ballAnimation, plungerAnimation, zoneAssets, BALL_INITIALIZE, BALL_PRE_ANIMATION, type PinballRuntimeConfig,
} from '../web/src/engine/bedrock-pinball.js';
import type { PinballSimTable } from '../web/src/engine/pinball-physics.js';

function boxSim(): PinballSimTable {
  const cell = 4, rows = 220, cols = 100;
  const sdf2: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const u = (r + 0.5) * cell, w = (c + 0.5) * cell;
    sdf2.push(Math.round(Math.max(-40, Math.min(400, Math.min(u, w, 400 - w, u < 740 ? 800 - u : Infinity))) * 2));
  }
  return {
    u0: 0, w0: 0, cell, rows, cols, sdf2, ballRadius: 24,
    flippers: [
      { side: 'left', pivot: [700, 100], length: 100, pivotRadius: 20, tipRadius: 12, restAngle: Math.atan2(33, 100), activeAngle: Math.atan2(-33, 100) },
      { side: 'right', pivot: [700, 300], length: 100, pivotRadius: 20, tipRadius: 12, restAngle: Math.atan2(33, -100), activeAngle: Math.atan2(-33, -100) },
    ],
    bumpers: [{ centre: [250, 200], radius: 30 }],
    launch: [600, 370], launchDir: [-1, 0], drainU: 780, drainSpan: [80, 320],
  };
}

const BOX = { width: 0.3, height: 0.15 };

function config(): PinballRuntimeConfig {
  const sim = boxSim();
  return {
    family: 'craftmatic_pinball', consoleType: 'craftmatic:con', ballType: 'craftmatic:ball', flipperTypes: ['craftmatic:fl', 'craftmatic:fr'],
    plungerType: 'craftmatic:plunger', buttonType: 'craftmatic:zone', plungerButtonType: 'craftmatic:pzone',
    pickType: 'craftmatic:pick', plungerPickType: 'craftmatic:ppick', buttonFamily: 'craftmatic_pinball_button',
    zones: {
      reach: 1.2,
      specs: [
        { role: 'left', rect: [650, 740, 60, 195], h: 12 },
        { role: 'right', rect: [650, 740, 205, 340], h: 12 },
        { role: 'plunger', rect: [570, 700, 345, 395], h: 12 },
      ],
      flipperBox: BOX, plungerBox: BOX, pickFlipperBox: BOX, pickPlungerBox: BOX,
    },
    sim,
    // 1 LDU = 0.01 model blocks, u along +z, w along +x, h up.
    map: { p0: [0, 0, 0], u: [0, 0, 0.01], w: [0.01, 0, 0], n: [0, 0.01, 0] },
    ballH: 24, ballOffset: [0, -0.1, 0],
    restAngles: sim.flippers.map(f => f.restAngle), spinSign: 1,
    plungerStroke: 40, ballMode: 'animate', axisSigns: [1, -1],
    // The eye stands off the table's +z end, looking up it (-z).
    cameraEye: [2, 5, 10], cameraLook: [2, 0, 3], consoleHome: [2, 0, 9], consoleYaw: 180, label: 'Test table',
  };
}

/** The seated head sits this far above the pad's position (the engine's seat offset + sitting eye). */
const HEAD_ABOVE_SEAT = 1.35;

function harness(engine: { headSide?: number; yawOffset?: number } = {}) {
  const cfg = config();
  const origin = { x: 100, y: 64, z: 200 };
  const props: Record<string, unknown> = { 'craftmatic:pinball_origin': origin, 'craftmatic:pinball_rotation': 0, 'craftmatic:pinball_scale': 1 };
  const mk = (typeId: string, at = { x: 0, y: 0, z: 0 }) => {
    const dyn: Record<string, unknown> = { ...props };
    const actorProps: Record<string, number> = {};
    const e: any = {
      typeId, id: typeId, location: { ...at }, removed: false, actorProps,
      getDynamicProperty: vi.fn((k: string) => dyn[k]), setDynamicProperty: vi.fn((k: string, v: unknown) => { dyn[k] = v; }),
      teleport: vi.fn((p: any) => { e.location = p; }),
      tryTeleport: vi.fn((p: any) => { e.location = p; return true; }),
      getRotation: () => ({ x: 0, y: 180 }),
      setProperty: vi.fn((k: string, v: number) => { actorProps[k] = v; }),
      getComponent: vi.fn(),
      isValid: () => !e.removed,
      remove: vi.fn(() => { e.removed = true; }),
    };
    return e;
  };
  const home = { x: 102, y: 64, z: 209 };
  const con = mk(cfg.consoleType, home), ball = mk(cfg.ballType), fl = mk(cfg.flipperTypes[0]!), fr = mk(cfg.flipperTypes[1]!), plunger = mk(cfg.plungerType!);
  let riders: any[] = [];
  con.getComponent.mockImplementation((name: string) => name === 'minecraft:rideable' ? { getRiders: () => riders } : undefined);
  const input = { x: 0, y: 0, jump: false };
  const player: any = {
    typeId: 'minecraft:player', id: 'p1',
    inputInfo: { getMovementVector: () => ({ x: input.x, y: input.y }), getButtonState: () => (input.jump ? 'Pressed' : 'Released') },
    isJumping: false,
    // The rider rides the pad: its head follows the pad's position.
    // `headSide` shifts the head along +x whatever the seat does, and
    // `yawOffset` turns the rider from the seat's yaw: the engine's pose, which
    // the runtime must measure rather than assume.
    getHeadLocation: () => ({ x: con.location.x + (engine.headSide ?? 0), y: con.location.y + HEAD_ABOVE_SEAT, z: con.location.z }),
    head: undefined as { x: number; y: number } | undefined,
    getRotation(): { x: number; y: number } {
      return this.head ?? { x: 0, y: (con.tryTeleport.mock.calls.at(-1)?.[1]?.rotation?.y ?? 180) + (engine.yawOffset ?? 0) };
    },
    setRotation: vi.fn(function (this: any, r: { x: number; y: number }) { this.head = { ...r }; }),
    inputPermissions: { setPermissionCategory: vi.fn() },
    selectedSlotIndex: 0,
    tags: new Set<string>(),
    addTag(t: string) { this.tags.add(t); return true; },
    removeTag(t: string) { return this.tags.delete(t); },
    camera: { setCamera: vi.fn(), clear: vi.fn() },
    onScreenDisplay: { setActionBar: vi.fn() },
    addEffect: vi.fn(),
    removeEffect: vi.fn(),
    teleport: vi.fn(),
  };
  let tick: () => void = () => {};
  const spawned: any[] = [];
  let hit: (ev: any) => void = () => {};
  let interact: (ev: any) => void = () => {};
  const getEntities = vi.fn((q: any) => (q?.families?.[0] === cfg.buttonFamily ? spawned.filter(e => !e.removed) : [con, ball, fl, fr, plunger]));
  const dim = {
    id: 'minecraft:overworld',
    getEntities,
    spawnEntity: vi.fn((typeId: string, at: any) => {
      const e = mk(typeId, at);
      e.id = `zone${spawned.length}`;
      spawned.push(e);
      return e;
    }),
    playSound: vi.fn(),
  };
  const world = {
    getDimension: (name: string) => (name === 'overworld' ? dim : { getEntities: () => [] }),
    getPlayers: (q?: any) => (q?.tags ? [player].filter(pl => q.tags.every((t: string) => pl.tags.has(t))) : []),
    afterEvents: { entityHitEntity: { subscribe: (cb: any) => { hit = cb; } } },
    beforeEvents: { playerInteractWithEntity: { subscribe: (cb: any) => { interact = cb; } } },
  };
  let scriptEvent: (ev: any) => void = () => {};
  const system = { runInterval: (cb: () => void) => { tick = cb; }, afterEvents: { scriptEventReceive: { subscribe: (cb: any) => { scriptEvent = cb; } } } };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const script = pinballScript(cfg).replace(/^import .*;\n/, '');
  new Function('world', 'system', script)(world, system);
  const live = () => spawned.filter(e => !e.removed);
  /** The tap targets in spawn order: left, right, plunger (probes follow). */
  const zone = (role: 'left' | 'right' | 'plunger') => {
    const z = live().filter(e => e.typeId === cfg.buttonType);
    return role === 'plunger' ? live().find(e => e.typeId === cfg.plungerButtonType) : z[role === 'left' ? 0 : 1];
  };
  /** The invisible pick boxes, same order. */
  const pick = (role: 'left' | 'right' | 'plunger') => {
    const z = live().filter(e => e.typeId === cfg.pickType);
    return role === 'plunger' ? live().find(e => e.typeId === cfg.plungerPickType) : z[role === 'left' ? 0 : 1];
  };
  return {
    cfg, origin, home, con, ball, fl, fr, plunger, player, input, dim, spawned, zone, pick, warn, getEntities,
    hit: (role: 'left' | 'right' | 'plunger', by: any = player) => hit({ damagingEntity: by, hitEntity: zone(role) }),
    hitEntity: (e: any) => hit({ damagingEntity: player, hitEntity: e }),
    hitPick: (role: 'left' | 'right' | 'plunger') => hit({ damagingEntity: player, hitEntity: pick(role) }),
    press: (role: 'left' | 'right' | 'plunger') => { const ev: any = { player, target: zone(role), cancel: false }; interact(ev); return ev; },
    tune: (message: string) => scriptEvent({ id: 'craftmatic:pinball', message }),
    sit: () => { riders = [player]; }, stand: () => { riders = []; },
    run: (n: number) => { for (let i = 0; i < n; i++) tick(); },
  };
}

/** Seat a player and let the pad lift them. */
function seated() {
  const h = harness();
  h.run(1); // empty: the pad records its home
  h.sit();
  h.run(12);
  return h;
}

const flipOf = (e: any): number => Math.abs((e.setProperty.mock.calls.filter((c: unknown[]) => c[0] === 'craftmatic:flip').at(-1)?.[1] as number | undefined) ?? 0);
const neverRaised = (e: any): boolean => e.setProperty.mock.calls.filter((c: unknown[]) => c[0] === 'craftmatic:flip').every((c: unknown[]) => Math.abs(c[1] as number) < 1e-9);
const launched = (h: ReturnType<typeof harness>): boolean => h.dim.playSound.mock.calls.some((c: unknown[]) => c[0] === 'random.bow');
/** Does the ray from `o` toward `p` cross the entity box standing at `at` (bottom centre)? */
const rayHits = (o: any, p: number[], at: any, box: { width: number; height: number }): boolean => {
  const d = [p[0]! - o.x, p[1]! - o.y, p[2]! - o.z];
  const lo = [at.x - box.width / 2, at.y, at.z - box.width / 2], hi = [at.x + box.width / 2, at.y + box.height, at.z + box.width / 2];
  const oo = [o.x, o.y, o.z];
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) { if (oo[k]! < lo[k]! || oo[k]! > hi[k]!) return false; continue; }
    let a = (lo[k]! - oo[k]!) / d[k]!, b = (hi[k]! - oo[k]!) / d[k]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
};

describe('pinball runtime (host simulation)', () => {
  it('draws the ball by properties: the entity stays on the serve point, the offset and velocity travel as actor properties', () => {
    const h = seated();
    // serve (u 600, w 370, h 24) -> model (3.70, 0.24 - 0.1, 6.00) + origin
    const p = h.ball.teleport.mock.calls.at(-1)![0];
    expect(p.x).toBeCloseTo(103.7, 5); expect(p.y).toBeCloseTo(64.14, 5); expect(p.z).toBeCloseTo(206.0, 5);
    expect(h.ball.actorProps['craftmatic:bu']).toBe(0);
    expect(h.ball.actorProps['craftmatic:sx']).toBe(1);
    expect(h.ball.actorProps['craftmatic:sz']).toBe(-1);
    const teleports = h.ball.teleport.mock.calls.length;
    h.input.y = -1; h.run(10); h.input.y = 0; h.run(6);
    expect(launched(h)).toBe(true);
    // Up the table is -u: the offset falls, the velocity is negative, and the
    // update counter moved; the entity itself did not teleport every tick.
    expect(h.ball.actorProps['craftmatic:bu']).toBeLessThan(-50);
    expect(h.ball.actorProps['craftmatic:bvu']).toBeLessThan(0);
    expect(h.ball.actorProps['craftmatic:seq']).toBeGreaterThan(3);
    expect(h.ball.teleport.mock.calls.length - teleports).toBeLessThanOrEqual(1);
  });

  it('{"ball":"teleport"} moves the entity every tick instead, with the properties at zero', () => {
    const h = seated();
    h.tune('{"ball":"teleport"}');
    h.input.y = -1; h.run(10); h.input.y = 0; h.run(1);
    const z0 = h.ball.teleport.mock.calls.at(-1)![0].z;
    h.run(4);
    expect(h.ball.teleport.mock.calls.at(-1)![0].z).toBeLessThan(z0); // up the table (-z)
    expect(h.ball.actorProps['craftmatic:bu']).toBe(0);
    expect(h.ball.actorProps['craftmatic:bvu']).toBe(0);
  });

  it("seating lifts the rider's HEAD to the eye, facing up the table, with the camera ON the head", () => {
    const h = seated();
    const eye = { x: h.origin.x + 2, y: h.origin.y + 5, z: h.origin.z + 10 };
    const head = h.player.getHeadLocation();
    expect(Math.hypot(head.x - eye.x, head.y - eye.y, head.z - eye.z)).toBeLessThan(0.08);
    const rot = h.con.tryTeleport.mock.calls.at(-1)![1].rotation;
    expect(Math.abs(Math.abs(rot.y) - 180)).toBeLessThan(1e-6);
    // Free camera: set on boarding, then from the measured head when seated.
    // It sits ON the head, so the picture and the tap ray start together.
    expect(h.player.camera.setCamera).toHaveBeenCalledTimes(2);
    const [preset, opts] = h.player.camera.setCamera.mock.calls.at(-1)!;
    expect(preset).toBe('minecraft:free');
    expect(opts.location.x).toBeCloseTo(head.x, 6); expect(opts.location.y).toBeCloseTo(head.y, 6); expect(opts.location.z).toBeCloseTo(head.z, 6);
    expect(opts.facingLocation.x).toBeCloseTo(h.origin.x + 2, 6);
    expect(opts.facingLocation.y).toBeCloseTo(h.origin.y, 6);
    expect(opts.facingLocation.z).toBeCloseTo(h.origin.z + 3, 6);
    expect(Math.abs(Math.abs(h.player.setRotation.mock.calls.at(-1)![0].y) - 180)).toBeLessThan(1e-6);
    expect(h.player.inputPermissions.setPermissionCategory).toHaveBeenCalledWith(1, false);
    expect(h.player.selectedSlotIndex).toBe(4);
    expect(h.player.tags.has('craftmatic_pinball')).toBe(true);
  });

  it('view "first" turns the head down the table and locks head turning, with no camera', () => {
    const h = harness();
    h.run(1);
    h.tune('{"view":"first"}');
    h.sit(); h.run(12);
    expect(h.player.camera.setCamera).not.toHaveBeenCalled();
    const r = h.player.setRotation.mock.calls.at(-1)![0];
    expect(r.x).toBeCloseTo(Math.atan2(5, 7) * 180 / Math.PI, 6);
    expect(Math.abs(Math.abs(r.y) - 180)).toBeLessThan(1e-6);
  });

  it('puts a target ON each flipper and on the plunger: the line of sight to each part crosses its own box, within reach', () => {
    const h = seated();
    const head = h.player.getHeadLocation();
    const w = (p: number[]): number[] => [h.origin.x + p[0]!, h.origin.y + p[1]!, h.origin.z + p[2]!];
    const plane = (u: number, ww: number, hh: number): number[] => w([ww * 0.01, hh * 0.01, u * 0.01]);
    // Pivot-to-tip midpoints of the resting flippers, and the waiting ball.
    const leftMid = plane(700 + 16, 150, 12), rightMid = plane(700 + 16, 250, 12), serve = plane(600, 370, 12);
    const L = h.zone('left')!.location, R = h.zone('right')!.location, P = h.zone('plunger')!.location;
    expect(rayHits(head, leftMid, L, BOX)).toBe(true);
    expect(rayHits(head, rightMid, R, BOX)).toBe(true);
    expect(rayHits(head, serve, P, BOX)).toBe(true);
    expect(rayHits(head, leftMid, R, BOX)).toBe(false);
    expect(rayHits(head, rightMid, L, BOX)).toBe(false);
    for (const z of [L, R, P]) expect(Math.hypot(z.x - head.x, z.y + BOX.height / 2 - head.y, z.z - head.z)).toBeCloseTo(1.2, 1);
  });

  it('a tap on a hotbar slot left / right of the middle works that flipper, and the hotbar is parked again', () => {
    const h = seated();
    h.player.selectedSlotIndex = 1; h.run(4);
    expect(flipOf(h.fl)).toBeGreaterThan(30);
    expect(neverRaised(h.fr)).toBe(true);
    expect(h.player.selectedSlotIndex).toBe(4);
    h.run(20);
    h.player.selectedSlotIndex = 7; h.run(4);
    expect(flipOf(h.fr)).toBeGreaterThan(30);
  });

  it('turns the RIDER (not the seat) to face up the table, and hangs targets and camera from the measured head', () => {
    const h = harness({ headSide: 0.05, yawOffset: 12 });
    h.run(1); h.sit(); h.run(16);
    const head = h.player.getHeadLocation();
    const yaw = ((h.player.getRotation().y % 360) + 360) % 360;
    expect(Math.abs(yaw - 180)).toBeLessThan(1.5 + 1e-9);
    for (const c of h.con.tryTeleport.mock.calls) expect(Math.abs(Math.abs(c[1].rotation.y) - 180)).toBeLessThan(1e-6);
    expect(h.player.camera.setCamera.mock.calls.at(-1)![1].location.x).toBeCloseTo(head.x, 6);
    // The targets straddle the table's centre line as seen from the measured head.
    const l = h.zone('left')!.location, r = h.zone('right')!.location;
    expect(l.x).toBeLessThan(head.x); expect(r.x).toBeGreaterThan(head.x);
  });

  it('a tap on the left target raises only the left flipper, for a moment; a long press on the right is cancelled and flips the right', () => {
    const h = seated();
    h.hit('left'); h.run(4);
    expect(flipOf(h.fl)).toBeGreaterThan(30);
    expect(neverRaised(h.fr)).toBe(true);
    h.run(20);
    expect(flipOf(h.fl)).toBeLessThan(1);
    const ev = h.press('right'); h.run(4);
    expect(ev.cancel).toBe(true);
    expect(flipOf(h.fr)).toBeGreaterThan(30);
  });

  it('a flipper tap while the ball waits does NOT launch it (the plunger does)', () => {
    const h = seated();
    h.hit('left'); h.hit('right'); h.run(30);
    expect(launched(h)).toBe(false);
  });

  it('a tap from another player does nothing', () => {
    const h = seated();
    h.hit('left', { id: 'p2', typeId: 'minecraft:player' }); h.run(4);
    expect(neverRaised(h.fl)).toBe(true);
  });

  it('the plunger: a tap takes hold and draws it back over time, a second tap lets go; the shot is as strong as the pull', () => {
    const shot = (holdTicks: number): { pull: number; vu: number } => {
      const h = seated();
      h.tune('{"ball":"teleport"}');
      h.hit('plunger'); h.run(holdTicks);
      const pull = h.plunger.actorProps['craftmatic:pull']!;
      expect(launched(h)).toBe(false);
      h.hit('plunger'); h.run(2);
      expect(launched(h)).toBe(true);
      expect(h.plunger.actorProps['craftmatic:pull']).toBe(0);
      const a = h.ball.teleport.mock.calls.at(-2)![0].z, b = h.ball.teleport.mock.calls.at(-1)![0].z;
      return { pull, vu: (b - a) / 0.05 / 0.01 };
    };
    const weak = shot(10), strong = shot(30);
    expect(weak.pull).toBeCloseTo(10 / 24, 1);
    expect(strong.pull).toBe(1);
    expect(strong.vu).toBeLessThan(weak.vu); // faster up the table (-u)
  });

  it('a held finger that repeats the event pulls while it is down and fires when it lifts', () => {
    const h = seated();
    for (let t = 0; t < 20; t++) { if (t % 4 === 0) h.hit('plunger'); h.run(1); }
    expect(launched(h)).toBe(false);
    expect(h.plunger.actorProps['craftmatic:pull']).toBeGreaterThan(0.6);
    h.run(10); // no more events: the finger is up
    expect(launched(h)).toBe(true);
  });

  it('pulling the stick back draws the plunger as far as it is pulled, and letting go fires', () => {
    const h = seated();
    h.input.y = -0.5; h.run(10);
    const half = h.plunger.actorProps['craftmatic:pull']!;
    expect(half).toBeGreaterThan(0.4); expect(half).toBeLessThan(0.6);
    h.input.y = -1; h.run(10);
    expect(h.plunger.actorProps['craftmatic:pull']).toBeCloseTo(1, 9);
    h.input.y = 0; h.run(2);
    expect(launched(h)).toBe(true);
  });

  it('standing up clears the camera, sets the player down behind the pad, removes the targets and brings the pad home', () => {
    const h = seated();
    h.stand(); h.run(1);
    expect(h.player.camera.clear).toHaveBeenCalled();
    expect(h.player.inputPermissions.setPermissionCategory).toHaveBeenLastCalledWith(1, true);
    expect(h.player.selectedSlotIndex).toBe(0);
    expect(h.player.tags.has('craftmatic_pinball')).toBe(false);
    expect(h.player.addEffect.mock.calls.some((c: unknown[]) => c[0] === 'slow_falling')).toBe(true);
    expect(h.player.addEffect.mock.calls.some((c: unknown[]) => c[0] === 'invisibility')).toBe(true);
    expect(h.player.removeEffect).toHaveBeenCalledWith('invisibility');
    const to = h.player.teleport.mock.calls[0]![0];
    expect(to.z).toBeCloseTo(h.home.z + 1.6, 6);
    expect(h.spawned.every(e => e.removed)).toBe(true);
    expect(h.con.location).toEqual(h.home);
  });

  it('a flipper resting near 180 degrees swings the short way (never a half-turn), mirror of the left', () => {
    const h = seated();
    h.input.x = -1; h.run(8);
    for (const c of h.fr.setProperty.mock.calls) expect(Math.abs(c[1] as number)).toBeLessThan(90);
    expect(flipOf(h.fr)).toBeGreaterThan(30);
    h.input.x = 0; h.input.y = 1; h.run(8);
    const l = h.fl.setProperty.mock.calls.at(-1)![1] as number, r = h.fr.setProperty.mock.calls.at(-1)![1] as number;
    // Mirror images: equal swings of opposite sense.
    expect(l).toBeCloseTo(-r, 6);
  });

  it('a left strafe raises only the left flipper; forward raises both', () => {
    const h = seated();
    h.input.x = 1; h.run(4);
    expect(flipOf(h.fl)).toBeGreaterThan(30);
    expect(neverRaised(h.fr)).toBe(true);
    h.input.x = 0; h.input.y = 1; h.run(4);
    expect(flipOf(h.fr)).toBeGreaterThan(30);
  });

  it('a /scriptevent moves the pick boxes live (never the outlines), and {} restores them', () => {
    const h = seated();
    const before = { ...h.pick('left')!.location }, outline = { ...h.zone('left')!.location };
    h.tune('{"fwd":-1,"up":0.5}'); h.run(1);
    const moved = h.pick('left')!.location;
    expect(moved.z).toBeCloseTo(before.z + 1, 6); // 1 block nearer (+z)
    expect(moved.y).toBeCloseTo(before.y + 0.5, 6);
    expect(h.zone('left')!.location).toEqual(outline);
    h.tune('{}'); h.run(1);
    expect(h.pick('left')!.location.z).toBeCloseTo(before.z, 6);
  });

  it("puts each PICK box on the player's own (level) view ray through the part's screen position, following the rider's pitch", () => {
    const h = seated();
    // The rider reports pitch atan2(5, 7) (setRotation's); a level view at that
    // pitch sees the waiting ball's screen spot along a different ray than the camera.
    const head = h.player.getHeadLocation();
    const w = (p: number[]): number[] => [h.origin.x + p[0]!, h.origin.y + p[1]!, h.origin.z + p[2]!];
    const leftMid = w([150 * 0.01, 12 * 0.01, 716 * 0.01]);
    const cam = h.player.camera.setCamera.mock.calls.at(-1)![1];
    const pitch = h.player.getRotation().x;
    const fit = fitPinballZone([head.x, head.y, head.z], [cam.location.x, cam.location.y, cam.location.z], [cam.facingLocation.x, cam.facingLocation.y, cam.facingLocation.z], [leftMid], 1.2, 'level', pitch);
    const at = h.pick('left')!.location;
    expect(rayHits(head, [head.x + (fit.centre[0]! - head.x) * 3, head.y + (fit.centre[1]! - head.y) * 3, head.z + (fit.centre[2]! - head.z) * 3], at, BOX)).toBe(true);
    // A tap on a pick box works its flipper.
    h.hitPick('left'); h.run(3);
    expect(flipOf(h.fl)).toBeGreaterThan(30);
    // A new pitch moves the pick boxes (within 20 ticks), not the outlines.
    const outline = { ...h.zone('left')!.location }, pick0 = { ...at };
    h.player.head = { x: 10, y: 180 };
    h.run(21);
    expect(h.pick('left')!.location.y).not.toBeCloseTo(pick0.y, 3);
    expect(h.zone('left')!.location).toEqual(outline);
  });

  it('a probe spawns targets along given directions and logs which one a tap hits', () => {
    const h = seated();
    h.tune('{"probe":[[0,60],[0,75]],"d":1.5}'); h.run(1);
    const probes = h.spawned.filter(e => !e.removed).slice(6);
    expect(probes.length).toBe(2);
    const head = h.player.getHeadLocation();
    // 75 degrees down, 1.5 blocks out along the seated heading (-z).
    const c = probes[1]!.location;
    expect(c.y + BOX.height / 2).toBeCloseTo(head.y - Math.sin(75 * Math.PI / 180) * 1.5, 6);
    expect(c.z).toBeCloseTo(head.z - Math.cos(75 * Math.PI / 180) * 1.5, 6);
    h.warn.mockClear();
    h.hitEntity(probes[1]); h.run(1);
    expect(h.warn.mock.calls.some(w => /probe 1 \(yaw 0, pitch 75\)/.test(String(w[0])))).toBe(true);
    h.tune('{}'); h.run(1);
    expect(probes.every(e => e.removed)).toBe(true);
  });

  it('logs script time every 100 ticks when {"perf":1} is on, and scans the world only every 20 ticks', () => {
    const h = seated();
    h.getEntities.mockClear();
    h.tune('{"perf":1}');
    h.run(200);
    expect(h.warn.mock.calls.some(c => String(c[0]).startsWith('[pinball-perf]'))).toBe(true);
    const actorScans = h.getEntities.mock.calls.filter(c => c[0]?.families?.[0] === 'craftmatic_pinball').length;
    expect(actorScans).toBeLessThanOrEqual(11);
  });

  it('removes targets no game owns (left over from a script reload)', () => {
    const h = harness();
    const stray: any = { id: 'stray', typeId: 'craftmatic:zone', location: { x: 0, y: 0, z: 0 }, removed: false, remove: vi.fn() };
    h.spawned.push(stray);
    h.run(40);
    expect(stray.remove).toHaveBeenCalled();
  });
});

describe('fitPinballZone', () => {
  it('puts the box on the rays from the origin toward the targets, `reach` along them', () => {
    const fit = fitPinballZone([0, 10, 0], [0, 10, 0], [0, 0, -5], [[0, 0, -5], [1, 0, -5]], 2, 'camera', 0);
    const d0 = [0, -10, -5].map(v => v / Math.hypot(10, 5));
    expect(fit.lo[1]).toBeCloseTo(10 + d0[1]! * 2, 6);
    expect(fit.hi[0]).toBeGreaterThan(fit.lo[0]!);
  });

  it('the "level" model maps a screen position through the player\'s own pitch', () => {
    // A target dead ahead of the camera, a level player: the ray is horizontal.
    const fit = fitPinballZone([0, 10, 0], [0, 10, 0], [0, 0, -5], [[0, 0, -5]], 2, 'level', 0);
    expect(fit.centre[1]).toBeCloseTo(10, 6);
    expect(fit.centre[2]).toBeCloseTo(-2, 6);
  });
});

describe('pinball entity definitions', () => {
  it('declare no component format 1.26.30 dropped (the whole entity would fail to load)', () => {
    const defs = [pinballPropBehavior('craftmatic:p', { width: 0.5, height: 0.3 }), zoneAssets('craftmatic:z', BOX, 'flipper').behavior, consoleAssets('craftmatic:c').behavior];
    for (const d of defs) {
      const e = (d as any)['minecraft:entity'];
      for (const comps of [e.components, ...Object.values(e.component_groups ?? {})]) expect(comps).not.toHaveProperty(['minecraft:pushable']);
    }
  });

  it('a tap target is a real cube (the client picks only what it renders) the size of its pick box, outlined on top only', () => {
    const z = zoneAssets('craftmatic:z', { width: 0.25, height: 0.125 }, 'plunger') as any;
    expect(z.behavior['minecraft:entity'].components['minecraft:collision_box']).toEqual({ width: 0.25, height: 0.125 });
    const cube = z.geometry['minecraft:geometry'][0].bones[0].cubes[0];
    expect(cube.size).toEqual([4, 2, 4]);
    expect(cube.uv.up.uv).toEqual([0, 16]);
    for (const f of ['north', 'south', 'east', 'west', 'down']) expect(cube.uv[f].uv).toEqual([16, 0]);
    expect(z.client['minecraft:client_entity'].description.materials.default).toBe('entity_alphablend');
    const tex = pinballZoneTexture();
    const alpha = (x: number, y: number): number => tex.rgba[(y * tex.width + x) * 4 + 3]!;
    expect(alpha(20, 5)).toBe(0); // the transparent tile
    expect(alpha(0, 0)).toBeGreaterThan(150); // a frame corner
    expect(alpha(8, 8)).toBeLessThan(40); // faint fill
  });

  it('declares every Molang variable the ball reads before it is read (the device logs each unknown one every frame)', () => {
    const map = { p0: [0, 0, 0] as [number, number, number], u: [0, 0, 0.01] as [number, number, number], w: [0.01, 0, 0] as [number, number, number], n: [0, 0.01, 0] as [number, number, number] };
    const text = JSON.stringify([BALL_PRE_ANIMATION, ballAnimation('craftmatic:b', map).file]);
    const read = new Set([...text.matchAll(/(?:^|[^a-z_])v\.([a-z_0-9]+)/g)].map(m => m[1]));
    const declared = new Set(BALL_INITIALIZE.map(l => /^v\.([a-z_0-9]+) =/.exec(l)![1]));
    for (const v of read) expect(declared.has(v), `v.${v}`).toBe(true);
  });

  it('the ball and plunger animations translate one bone along the plane, X and Z through the sign properties', () => {
    const map = { p0: [0, 0, 0] as [number, number, number], u: [0, 0, 0.01] as [number, number, number], w: [0.01, 0, 0] as [number, number, number], n: [0, 0.01, 0] as [number, number, number] };
    const b = ballAnimation('craftmatic:b', map).file as any;
    const pos = Object.values(b.animations)[0] as any;
    expect(Object.keys(pos.bones)).toEqual(['pb_move']);
    const [x, y, z] = pos.bones.pb_move.position as string[];
    expect(x).toContain("q.property('craftmatic:sx')");
    expect(z).toContain("q.property('craftmatic:sz')");
    expect(z).toContain('0.16 *'); // 16 px per block x 0.01 block per LDU along u
    expect(y).not.toContain('property(\'craftmatic:s');
    const p = Object.values((plungerAnimation('craftmatic:p', map, 40).file as any).animations)[0] as any;
    expect(p.bones.pb_move.position[2]).toContain("q.property('craftmatic:pull') * 40");
    expect(moveRig(3, [1, 2, 3]).boneOf).toEqual(['pb_move', 'pb_move', 'pb_move']);
  });
});

describe('flipper rig', () => {
  it('tilt carries LDraw up onto the playfield normal and un-tilt undoes it', () => {
    const n: [number, number, number] = [0, -0.989, -0.147];
    const len = Math.hypot(...n);
    const N = n.map(v => v / len) as [number, number, number];
    const R = rotationBetween([0, -1, 0], N);
    const up = [R[1]!, R[4]!, R[7]!].map(v => -v);
    expect(up[0]).toBeCloseTo(N[0], 9); expect(up[1]).toBeCloseTo(N[1], 9); expect(up[2]).toBeCloseTo(N[2], 9);
    const rig = flipperRig(3, [1, 2, 3], N);
    expect(rig.bones.map(b => b.name)).toEqual(['pb_tilt', 'pb_spin', 'pb_untilt']);
    expect(rig.boneOf).toEqual(['pb_untilt', 'pb_untilt', 'pb_untilt']);
    const T = rig.bones[0]!.rotation!, Ti = rig.bones[2]!.rotation!;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const v = T[i * 3]! * Ti[j]! + T[i * 3 + 1]! * Ti[3 + j]! + T[i * 3 + 2]! * Ti[6 + j]!;
      expect(v).toBeCloseTo(i === j ? 1 : 0, 9);
    }
  });
});
