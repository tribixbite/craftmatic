/**
 * The pinball add-on runtime (bedrock-pinball.ts), run as the device runs it:
 * the serialised script evaluated with mocked `world` and `system`.
 */
import { describe, it, expect, vi } from 'vitest';
import { buttonAssets, consoleAssets, pinballPropBehavior, pinballScript, rotationBetween, flipperRig, type PinballRuntimeConfig } from '../web/src/engine/bedrock-pinball.js';
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

function config(): PinballRuntimeConfig {
  const sim = boxSim();
  return {
    family: 'craftmatic_pinball', consoleType: 'craftmatic:con', ballType: 'craftmatic:ball', flipperTypes: ['craftmatic:fl', 'craftmatic:fr'],
    buttonType: 'craftmatic:zone', buttonFamily: 'craftmatic_pinball_button', zone: { width: 1.9, height: 6, near: 0.45, below: 3.8 },
    sim,
    // 1 LDU = 0.01 model blocks, u along +z, w along +x, h up.
    map: { p0: [0, 0, 0], u: [0, 0, 0.01], w: [0.01, 0, 0], n: [0, 0.01, 0] },
    ballH: 24, ballOffset: [0, -0.1, 0],
    restAngles: sim.flippers.map(f => f.restAngle), spinSign: 1,
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
    const e: any = {
      typeId, id: typeId, location: { ...at }, removed: false,
      getDynamicProperty: (k: string) => dyn[k], setDynamicProperty: vi.fn((k: string, v: unknown) => { dyn[k] = v; }),
      teleport: vi.fn((p: any) => { e.location = p; }),
      tryTeleport: vi.fn((p: any) => { e.location = p; return true; }),
      getRotation: () => ({ x: 0, y: 180 }),
      setProperty: vi.fn(),
      getComponent: vi.fn(),
      remove: vi.fn(() => { e.removed = true; }),
    };
    return e;
  };
  const home = { x: 102, y: 64, z: 209 };
  const con = mk(cfg.consoleType, home), ball = mk(cfg.ballType), fl = mk(cfg.flipperTypes[0]!), fr = mk(cfg.flipperTypes[1]!);
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
    // The rider's head: the seat's yaw (+ the engine's offset) until a script
    // turns it with setRotation.
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
  const dim = {
    id: 'minecraft:overworld',
    getEntities: (q: any) => (q?.families?.[0] === cfg.buttonFamily ? spawned.filter(e => !e.removed) : [con, ball, fl, fr]),
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
  const script = pinballScript(cfg).replace(/^import .*;\n/, '');
  new Function('world', 'system', script)(world, system);
  const eyeX = origin.x + 2;
  // Facing -z, a player's left is -x.
  const zone = (side: 'left' | 'right') => spawned.find(e => !e.removed && Math.sign(e.location.x - eyeX) === (side === 'left' ? -1 : 1));
  return {
    cfg, origin, home, con, ball, fl, fr, player, input, dim, spawned, zone,
    hit: (side: 'left' | 'right', by: any = player) => hit({ damagingEntity: by, hitEntity: zone(side) }),
    press: (side: 'left' | 'right') => { const ev: any = { player, target: zone(side), cancel: false }; interact(ev); return ev; },
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

const flipOf = (e: any): number => Math.abs((e.setProperty.mock.calls.at(-1)?.[1] as number | undefined) ?? 0);
const neverRaised = (e: any): boolean => e.setProperty.mock.calls.every((c: unknown[]) => Math.abs(c[1] as number) < 1e-9);

describe('pinball runtime (host simulation)', () => {
  it('parks the ball on the plunger in world space, from the placement frame', () => {
    const h = harness();
    h.run(1);
    const p = h.ball.teleport.mock.calls.at(-1)![0];
    // serve (u 600, w 370, h 24) -> model (3.70, 0.24 - 0.1, 6.00) + origin
    expect(p.x).toBeCloseTo(103.7, 5);
    expect(p.y).toBeCloseTo(64.14, 5);
    expect(p.z).toBeCloseTo(206.0, 5);
  });

  it("seating lifts the rider's HEAD to the eye, facing up the table, with the camera just ahead of it", () => {
    const h = seated();
    const eye = { x: h.origin.x + 2, y: h.origin.y + 5, z: h.origin.z + 10 };
    const head = h.player.getHeadLocation();
    expect(Math.hypot(head.x - eye.x, head.y - eye.y, head.z - eye.z)).toBeLessThan(0.08);
    // Facing -z (up the table) is yaw 180.
    const rot = h.con.tryTeleport.mock.calls.at(-1)![1].rotation;
    expect(Math.abs(Math.abs(rot.y) - 180)).toBeLessThan(1e-6);
    // Free camera (the default): set on boarding, then once more from the
    // measured head when seated, just ahead of it and looking down the table.
    expect(h.player.camera.setCamera).toHaveBeenCalledTimes(2);
    const [preset, opts] = h.player.camera.setCamera.mock.calls.at(-1)!;
    expect(preset).toBe('minecraft:free');
    expect(opts.location.z).toBeCloseTo(eye.z - 0.3, 6);
    expect(opts.facingLocation.x).toBeCloseTo(h.origin.x + 2, 6);
    expect(opts.facingLocation.y).toBeCloseTo(h.origin.y, 6);
    expect(opts.facingLocation.z).toBeCloseTo(h.origin.z + 3, 6);
    // The rider faces up the table with head turning locked (the pick ray's heading).
    expect(Math.abs(Math.abs(h.player.setRotation.mock.calls.at(-1)![0].y) - 180)).toBeLessThan(1e-6);
    expect(h.player.inputPermissions.setPermissionCategory).toHaveBeenCalledWith(1, false);
    // Hotbar parked on the middle slot; the seated tag set.
    expect(h.player.selectedSlotIndex).toBe(4);
    expect(h.player.tags.has('craftmatic_pinball')).toBe(true);
  });

  it('view "first" turns the head down the table and locks head turning, with no camera', () => {
    // Device run 5 (6ba8b924): the phone applied the yaw but NOT the pitch, so
    // first person looked at the horizon; kept only as a tuning option.
    const h = harness();
    h.run(1);
    h.tune('{"view":"first"}');
    h.sit(); h.run(12);
    expect(h.player.camera.setCamera).not.toHaveBeenCalled();
    const r = h.player.setRotation.mock.calls.at(-1)![0];
    expect(r.x).toBeCloseTo(Math.atan2(5, 7) * 180 / Math.PI, 6);
    expect(Math.abs(Math.abs(r.y) - 180)).toBeLessThan(1e-6);
    expect(h.player.inputPermissions.setPermissionCategory).toHaveBeenCalledWith(1, false);
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

  it('turns the RIDER (not the seat) to face up the table, and hangs zones and camera from the measured head', () => {
    // An engine that seats the head 0.05 to the side of the pad (always) and
    // turns the rider 12 degrees from the seat's yaw.
    const h = harness({ headSide: 0.05, yawOffset: 12 });
    h.run(1); h.sit(); h.run(16);
    const head = h.player.getHeadLocation();
    // Facing up the table (-z) is yaw 180: the rider ends within 1.5 degrees of it.
    const yaw = ((h.player.getRotation().y % 360) + 360) % 360;
    expect(Math.abs(yaw - 180)).toBeLessThan(1.5 + 1e-9);
    // The seat is SET to face up the table, never chased (device run 6: chasing
    // the rider's trailing yaw orbited the seat and camera without end).
    for (const c of h.con.tryTeleport.mock.calls) expect(Math.abs(Math.abs(c[1].rotation.y) - 180)).toBeLessThan(1e-6);
    // The camera hangs from the measured head.
    expect(h.player.camera.setCamera.mock.calls.at(-1)![1].location.x).toBeCloseTo(head.x, 1);
    // The split between the zones lies on the head's own centre line.
    const l = h.spawned[0]!.location, r = h.spawned[1]!.location;
    expect((l.x + r.x) / 2).toBeCloseTo(head.x, 1);
  });

  it("spawns one zone each side in front of the head, the left one on the player's left", () => {
    const h = seated();
    expect(h.spawned.length).toBe(2);
    const eye = { x: h.origin.x + 2, y: h.origin.y + 5, z: h.origin.z + 10 };
    for (const side of ['left', 'right'] as const) {
      const z = h.zone(side)!.location;
      expect(z.z).toBeCloseTo(eye.z - (0.45 + 0.95), 6); // ahead by near + width / 2
      expect(Math.abs(z.x - eye.x)).toBeCloseTo(0.95, 6); // beside by width / 2
      expect(z.y).toBeCloseTo(eye.y - 3.8, 6);
    }
  });

  it('a tap on the left zone raises only the left flipper, for a moment; a long press on the right is cancelled and flips the right', () => {
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

  it('a tap from another player does nothing', () => {
    const h = seated();
    h.hit('left', { id: 'p2', typeId: 'minecraft:player' }); h.run(4);
    expect(neverRaised(h.fl)).toBe(true);
  });

  it('a tap while the ball waits charges and fires the plunger', () => {
    const h = seated();
    const z0 = h.ball.teleport.mock.calls.at(-1)![0].z;
    h.hit('right'); h.run(24);
    expect(h.ball.teleport.mock.calls.at(-1)![0].z).toBeLessThan(z0 - 0.5); // up the table (-z)
    expect(h.dim.playSound.mock.calls.some((c: unknown[]) => c[0] === 'random.bow')).toBe(true);
  });

  it('standing up clears the camera, sets the player down behind the pad, removes the zones and brings the pad home', () => {
    const h = seated();
    h.stand(); h.run(1);
    expect(h.player.camera.clear).toHaveBeenCalled();
    expect(h.player.inputPermissions.setPermissionCategory).toHaveBeenLastCalledWith(1, true);
    expect(h.player.selectedSlotIndex).toBe(0); // the slot the player had
    expect(h.player.tags.has('craftmatic_pinball')).toBe(false);
    expect(h.player.addEffect.mock.calls.some((c: unknown[]) => c[0] === 'slow_falling')).toBe(true);
    // Invisible while seated (the free camera draws the player), visible again after.
    expect(h.player.addEffect.mock.calls.some((c: unknown[]) => c[0] === 'invisibility')).toBe(true);
    expect(h.player.removeEffect).toHaveBeenCalledWith('invisibility');
    const to = h.player.teleport.mock.calls[0]![0];
    expect(to.z).toBeCloseTo(h.home.z + 1.6, 6); // away from the table (+z)
    expect(h.spawned.every(e => e.removed)).toBe(true);
    expect(h.con.location).toEqual(h.home);
  });

  it('pulling the stick back charges the plunger and releasing launches', () => {
    const h = seated();
    h.input.y = -1; h.run(10);
    h.input.y = 0; h.run(1);
    const z0 = h.ball.teleport.mock.calls.at(-1)![0].z;
    h.run(4);
    expect(h.ball.teleport.mock.calls.at(-1)![0].z).toBeLessThan(z0);
  });

  it('a left strafe raises only the left flipper; forward raises both', () => {
    const h = seated();
    h.input.x = 1; h.run(4);
    expect(h.fl.setProperty.mock.calls.at(-1)?.[0]).toBe('craftmatic:flip');
    expect(flipOf(h.fl)).toBeGreaterThan(30);
    expect(neverRaised(h.fr)).toBe(true);
    h.input.x = 0; h.input.y = 1; h.run(4);
    expect(flipOf(h.fr)).toBeGreaterThan(30);
  });

  it('a /scriptevent retunes the zones live: anchor and offsets, {} restores the defaults', () => {
    const h = harness({ headSide: 0.05 });
    h.run(1); h.sit(); h.run(16);
    const before = h.zone('left')!.location;
    h.tune('{"anchor":"eye","fwd":-1,"up":0.5}'); h.run(1);
    const eye = { x: h.origin.x + 2, y: h.origin.y + 5, z: h.origin.z + 10 };
    const moved = h.spawned[0]!.location;
    expect(moved.z).toBeCloseTo(eye.z - (0.45 + 0.95 - 1), 6); // 1 block nearer (+z) than the default
    expect(moved.y).toBeCloseTo(eye.y - 3.8 + 0.5, 6);
    h.tune('{}'); h.run(1);
    expect(h.spawned[0]!.location.z).toBeCloseTo(before.z, 6);
  });

  it('removes zones no game owns (left over from a script reload)', () => {
    const h = harness();
    const stray: any = { id: 'stray', typeId: 'craftmatic:zone', location: { x: 0, y: 0, z: 0 }, removed: false, remove: vi.fn() };
    h.spawned.push(stray);
    h.run(40);
    expect(stray.remove).toHaveBeenCalled();
  });
});

describe('pinball entity definitions', () => {
  it('declare no component format 1.26.30 dropped (the whole entity would fail to load)', () => {
    // Device 2026-09-24: `minecraft:pushable` made the flippers, ball and tap
    // zones "not a valid entity type"; the table never moved.
    const defs = [pinballPropBehavior('craftmatic:p', { width: 0.5, height: 0.3 }), buttonAssets('craftmatic:z').behavior, consoleAssets('craftmatic:c').behavior];
    for (const d of defs) {
      const e = (d as any)['minecraft:entity'];
      for (const comps of [e.components, ...Object.values(e.component_groups ?? {})]) expect(comps).not.toHaveProperty(['minecraft:pushable']);
    }
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
