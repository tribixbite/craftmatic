/**
 * The pinball add-on runtime (bedrock-pinball.ts), run as the device runs it:
 * the serialised script evaluated with mocked `world` and `system`.
 */
import { describe, it, expect, vi } from 'vitest';
import { pinballScript, rotationBetween, flipperRig, type PinballRuntimeConfig } from '../web/src/engine/bedrock-pinball.js';
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
    sim,
    // 1 LDU = 0.01 model blocks, u along +z, w along +x, h up.
    map: { p0: [0, 0, 0], u: [0, 0, 0.01], w: [0.01, 0, 0], n: [0, 0.01, 0] },
    ballH: 24, ballOffset: [0, -0.1, 0],
    restAngles: sim.flippers.map(f => f.restAngle), spinSign: 1,
    cameraEye: [2, 5, 10], cameraLook: [2, 0, 3], label: 'Test table',
  };
}

function harness() {
  const cfg = config();
  const origin = { x: 100, y: 64, z: 200 };
  const props: Record<string, unknown> = { 'craftmatic:pinball_origin': origin, 'craftmatic:pinball_rotation': 0, 'craftmatic:pinball_scale': 1 };
  const mk = (typeId: string) => {
    const dyn: Record<string, unknown> = { ...props };
    return {
      typeId, id: typeId, location: { x: 0, y: 0, z: 0 },
      getDynamicProperty: (k: string) => dyn[k], setDynamicProperty: vi.fn((k: string, v: unknown) => { dyn[k] = v; }),
      teleport: vi.fn(function (this: any, p: any) { this.location = p; }),
      setProperty: vi.fn(),
      getComponent: vi.fn(),
    };
  };
  const con = mk(cfg.consoleType), ball = mk(cfg.ballType), fl = mk(cfg.flipperTypes[0]!), fr = mk(cfg.flipperTypes[1]!);
  let riders: any[] = [];
  con.getComponent.mockImplementation((name: string) => name === 'minecraft:rideable' ? { getRiders: () => riders } : undefined);
  const input = { x: 0, y: 0, jump: false };
  const player = {
    typeId: 'minecraft:player', id: 'p1',
    inputInfo: { getMovementVector: () => ({ x: input.x, y: input.y }), getButtonState: () => (input.jump ? 'Pressed' : 'Released') },
    isJumping: false,
    camera: { setCamera: vi.fn(), clear: vi.fn() },
    onScreenDisplay: { setActionBar: vi.fn() },
  };
  let tick: () => void = () => {};
  const dim = { getEntities: () => [con, ball, fl, fr], playSound: vi.fn() };
  const world = { getDimension: (name: string) => (name === 'overworld' ? dim : { getEntities: () => [] }) };
  const system = { runInterval: (cb: () => void) => { tick = cb; } };
  const script = pinballScript(cfg).replace(/^import .*;\n/, '');
  new Function('world', 'system', script)(world, system);
  return { cfg, con, ball, fl, fr, player, input, dim, sit: () => { riders = [player]; }, stand: () => { riders = []; }, run: (n: number) => { for (let i = 0; i < n; i++) tick(); } };
}

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

  it('seating sets the table camera once, Jump charges and launches, standing up clears the camera', () => {
    const h = harness();
    h.sit();
    h.run(2);
    expect(h.player.camera.setCamera).toHaveBeenCalledTimes(1);
    expect(h.player.camera.setCamera.mock.calls[0]![0]).toBe('minecraft:free');
    h.input.jump = true; h.run(10);
    h.input.jump = false; h.run(1);
    const z0 = h.ball.teleport.mock.calls.at(-1)![0].z;
    h.run(4);
    const z1 = h.ball.teleport.mock.calls.at(-1)![0].z;
    expect(z1).toBeLessThan(z0); // fired up the table (-u = -z here)
    expect(h.player.onScreenDisplay.setActionBar).toHaveBeenCalled();
    h.stand(); h.run(1);
    expect(h.player.camera.clear).toHaveBeenCalledTimes(1);
  });

  it('pulling the stick back charges the plunger and releasing launches (no Jump button on a phone seat)', () => {
    const h = harness();
    h.sit();
    h.input.y = -1; h.run(10);
    h.input.y = 0; h.run(1);
    const z0 = h.ball.teleport.mock.calls.at(-1)![0].z;
    h.run(4);
    expect(h.ball.teleport.mock.calls.at(-1)![0].z).toBeLessThan(z0);
  });

  it('a left strafe raises only the left flipper; forward raises both', () => {
    const h = harness();
    h.sit();
    h.input.x = 1; h.run(4);
    const lastL = h.fl.setProperty.mock.calls.at(-1);
    expect(lastL?.[0]).toBe('craftmatic:flip');
    expect(Math.abs(lastL![1] as number)).toBeGreaterThan(30);
    // The right flipper only ever received its initial rest value.
    expect(h.fr.setProperty.mock.calls.every(c => Math.abs(c[1] as number) < 1e-9)).toBe(true);
    h.input.x = 0; h.input.y = 1; h.run(4);
    expect(Math.abs(h.fr.setProperty.mock.calls.at(-1)![1] as number)).toBeGreaterThan(30);
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
