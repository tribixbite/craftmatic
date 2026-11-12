/**
 * The funfair rides' runtime (BIZ-20): the DROP TOWER and the SKY SWING, serialised into
 * `scripts/rides-funfair.js` (`funfairScript`).
 *
 * WHY A MODULE OF ITS OWN. `scripts/rides.js` (bedrock-rides.ts) carries the slide, the lift and the orbit and
 * is frozen by the pack contract: a pack with only those rides must stay byte-identical, so a new ride kind
 * cannot change its text. This module is the SAME mechanism - an invisible rideable seat carried by
 * `tryTeleport` along points the placement wrote in WORLD coordinates (`PlacementActor.ridePath`, turned and
 * sized by the placement), a tap that boards (`entityHitEntity`), a set-down through `colliderBodyProbe` -
 * with the one thing the old loop lacks: a speed that is a function of TIME (`funfairKit`, funfair-physics.ts)
 * instead of a constant or a slide's ramp. It is emitted only for a pack that has such a ride.
 * TODO(rides-merge): fold both loops into one the next time `rides.js` is changed on purpose.
 *
 * EVERY RIDER ON THEIR OWN SEAT. A ride has one seat per rider; each seat entity carries its own path
 * (`craftmatic:ride_path`: foot, top, axis at the top). Seats that share an axis are one GROUP: they depart
 * together, and the one clock (`tick - startedAt`) gives every seat its own position from its own path - a
 * drop's seats rise and fall in their own columns, a swing's turn about the shared axis, each at its own azimuth.
 * A ride's body (the ring: `carType`) is moved with the group, a swing's turning with the ring.
 *
 * LIFE OF A GROUP. A rider sits (a tap, a hold or `/ride`) -> BOARDING: `BOARD_S` seconds for more riders
 * (`BOARD_FULL_S` once every seat is taken); nobody left aboard cancels it -> the trip, the profile's phases
 * -> at the end every rider is set down outside the ring beside the seat's foot (the seat's exit point through
 * the collider probe) and the seats and the ring go back to the foot. A rider who steps off mid-trip is put back
 * (a drop's 100-block fall is never a rider's choice). The camera is the rider's own first person: no script camera.
 */

import { ESCAPE_OPTIONS, colliderBodyProbe, colliderFormKit, type ColliderBodyProbe, type EscapeOptions } from '../collider-form.js';
import { COLLIDER_HI_STATE, COLLIDER_LO_STATE } from '../bedrock-building-shell.js';
import { funfairKit, type FunfairConstants, type FunfairKit, type Trip } from './funfair-physics.js';

export type FunfairRideKind = 'drop' | 'swing';

export interface FunfairRuntimeConfig {
  /** The collider blocks' two state names where the pack does not use the dev pack's `lo`/`hi` (M03's compact spelling). */
  colliderStates?: { lo: string; hi: string } | undefined;
  /** The invisible rideable seat type every funfair rider sits on (one entity per rider). */
  seatType: string;
  /** Per ride (the placement writes the index on every seat and on the ring): its kind and the ring's entity type. */
  rides: Array<{ kind: FunfairRideKind; carType?: string }>;
  constants: FunfairConstants;
  /** The set-down's last resort (`ColliderBodyProbe.escape`); `funfairScript` fills `ESCAPE_OPTIONS` where a config lacks it. */
  escape?: EscapeOptions;
}

declare const world: any;
declare const system: any;

/**
 * Serialised whole into `scripts/rides-funfair.js`: it may use only its arguments and the Script API globals.
 */
function funfairRuntime(config: FunfairRuntimeConfig, kit: FunfairKit, body?: ColliderBodyProbe): void {
  const C = config.constants;
  const K = { index: 'craftmatic:ride', path: 'craftmatic:ride_path', exits: 'craftmatic:ride_exits', scale: 'craftmatic:ride_scale', home: 'craftmatic:fun_home' };
  type P = { x: number; y: number; z: number };
  interface Member { seat: any; foot: P; top: P; axis: P; exit: P | undefined; r0: number; phi0: number; riders: any[] }
  interface Group {
    index: number; kind: string; f: number; members: Member[]; trip: Trip;
    state: 'boarding' | 'running'; departAt: number; startedAt: number;
    car?: any; carStart?: P; carYaw?: number; carOnAxis: boolean;
  }
  const groups = new Set<Group>();
  const seatGroup = new Map<string, Group>();
  const read = (e: any, key: string): any => { try { return e.getDynamicProperty(key); } catch { return undefined; } };
  const parse = (s: any): P[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
  const validOf = (e: any): boolean => { try { return typeof e.isValid === 'function' ? e.isValid() : e.isValid; } catch { return false; } };
  const ridersOf = (e: any): any[] => { try { return e.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch { return []; } };
  const say = (p: any, s: string): void => { try { p.onScreenDisplay.setActionBar(s); } catch { /* left */ } };
  /** Bedrock yaw (degrees) of a horizontal direction: +X turns toward +Z, as bedrock-rides.ts. */
  const yawOf = (dx: number, dz: number): number => (Math.hypot(dx, dz) > 1e-9 ? Math.atan2(-dx, dz) * 180 / Math.PI : 0);
  const dimsOf = (): any[] => {
    const dims = new Map<string, any>();
    try { dims.set('overworld', world.getDimension('overworld')); } catch { /* none */ }
    try { for (const p of world.getAllPlayers()) if (p) dims.set(p.dimension.id, p.dimension); } catch { /* none */ }
    return [...dims.values()];
  };

  /** A seat's own path, read off it: foot, top, axis (at the top); null when it was not written. */
  const memberOf = (seat: any): Member | null => {
    const pts = parse(read(seat, K.path));
    if (pts.length < 3) return null;
    const [foot, top, axis] = [pts[0]!, pts[1]!, pts[2]!];
    return { seat, foot, top, axis, exit: parse(read(seat, K.exits))[0], r0: Math.hypot(foot.x - axis.x, foot.z - axis.z), phi0: Math.atan2(foot.z - axis.z, foot.x - axis.x), riders: [] };
  };

  /** The group a seated seat belongs to: every free seat of its ride on the same axis. */
  const formGroup = (seat: any): Group | undefined => {
    const index = read(seat, K.index);
    const ride = typeof index === 'number' ? config.rides[index] : undefined;
    const lead = memberOf(seat);
    if (!ride || !lead) return undefined;
    const f = typeof read(seat, K.scale) === 'number' ? read(seat, K.scale) : 1;
    let near: any[] = [];
    try { near = seat.dimension.getEntities({ type: config.seatType, location: seat.location, maxDistance: 2 * lead.r0 + 2 * f }); } catch { near = [seat]; }
    const members: Member[] = [];
    for (const s of near) {
      if (seatGroup.has(s.id) || read(s, K.index) !== index) continue;
      const m = s.id === seat.id ? lead : memberOf(s);
      if (m && Math.hypot(m.axis.x - lead.axis.x, m.axis.z - lead.axis.z) <= C.GROUP_AXIS_TOL_BLOCKS * f) members.push(m);
    }
    if (!members.some(m => m.seat.id === seat.id)) members.push(lead);
    const height = lead.top.y - lead.foot.y;
    if (!(height > 0)) return undefined;
    const trip = ride.kind === 'drop' ? kit.drop(height, f) : kit.swing(height, lead.r0, f);
    let car: any, carStart: P | undefined, carYaw: number | undefined;
    if (ride.carType) {
      try {
        const cars = seat.dimension.getEntities({ type: ride.carType, location: { x: lead.axis.x, y: lead.foot.y, z: lead.axis.z }, maxDistance: height + 2 * lead.r0 + 8 * f });
        car = cars.find((e: any) => read(e, K.index) === index) ?? cars[0];
        if (car) { carStart = { x: car.location.x, y: car.location.y, z: car.location.z }; carYaw = car.getRotation().y; }
      } catch { car = undefined; }
    }
    const group: Group = {
      index, kind: ride.kind, f, members, trip, state: 'boarding', departAt: system.currentTick + Math.round(C.BOARD_S * 20), startedAt: 0,
      carOnAxis: !!carStart && Math.hypot(carStart.x - lead.axis.x, carStart.z - lead.axis.z) <= 0.75 * f,
      ...(car ? { car } : {}), ...(carStart ? { carStart } : {}), ...(carYaw !== undefined ? { carYaw } : {}),
    };
    groups.add(group);
    for (const m of members) seatGroup.set(m.seat.id, group);
    return group;
  };

  const disband = (g: Group): void => {
    groups.delete(g);
    for (const m of g.members) seatGroup.delete(m.seat.id);
  };

  /** A member's seat pose `t` seconds into the trip: its place and the way it faces. */
  const poseOf = (g: Group, m: Member, t: number): { p: P; yaw: number } => {
    const s = g.trip.at(t);
    if (g.kind === 'drop') return { p: { x: m.foot.x, y: m.foot.y + s.rise, z: m.foot.z }, yaw: yawOf(m.foot.x - m.axis.x, m.foot.z - m.axis.z) };
    const phi = m.phi0 + s.turn, radius = m.r0 + s.out;
    return { p: { x: m.axis.x + radius * Math.cos(phi), y: m.foot.y + s.rise - s.sag, z: m.axis.z + radius * Math.sin(phi) }, yaw: yawOf(-Math.sin(phi), Math.cos(phi)) };
  };
  /** The ring's pose: it rises with the seats and a swing's turns with them. */
  const moveCar = (g: Group, t: number): void => {
    if (!g.car || !g.carStart) return;
    const s = g.trip.at(t);
    const rotation = g.kind === 'swing' && g.carOnAxis ? { rotation: { x: 0, y: (g.carYaw ?? 0) + s.turn * 180 / Math.PI } } : {};
    try { g.car.tryTeleport({ x: g.carStart.x, y: g.carStart.y + s.rise, z: g.carStart.z }, { keepVelocity: false, checkForBlocks: false, ...rotation }); } catch { /* unloaded: hold */ }
  };
  const setHome = (g: Group, on: boolean): void => {
    if (!g.car || !g.carStart) return;
    try { g.car.setDynamicProperty(K.home, on ? JSON.stringify({ ...g.carStart, yaw: g.carYaw ?? 0 }) : undefined); } catch { /* gone */ }
  };

  /** Where a rider is set down: the planned exit lifted out of what it sits in, else the nearest free standing spot on a walkable route. */
  const setDown = (g: Group, m: Member, players: any[]): void => {
    const exit = m.exit ?? { x: m.foot.x + (m.foot.x - m.axis.x), y: m.foot.y, z: m.foot.z + (m.foot.z - m.axis.z) };
    const planned = { x: exit.x, y: exit.y + C.SETDOWN_LIFT_BLOCKS, z: exit.z };
    let at = planned;
    if (body) {
      const dim = m.seat.dimension;
      try { at = body.settle(dim, planned, C.SETDOWN_REACH_BLOCKS * Math.max(1, g.f), C.SETDOWN_DROP_BLOCKS, q => body.routeClear(dim, planned, q, C.SETDOWN_DROP_BLOCKS)); } catch { at = planned; }
      if (at === planned && config.escape) { try { at = body.escape(dim, planned, { ...config.escape, seedReach: config.escape.seedReach * Math.max(1, g.f) })?.at ?? planned; } catch { at = planned; } }
    }
    for (const r of players) { try { r.teleport(at, { keepVelocity: false }); } catch { /* left */ } }
  };

  const finish = (g: Group): void => {
    for (const m of g.members) {
      if (!validOf(m.seat)) continue;
      const riders = [...new Set([...ridersOf(m.seat), ...m.riders])].filter(r => { try { return r?.isValid === undefined || (typeof r.isValid === 'function' ? r.isValid() : r.isValid); } catch { return false; } });
      try { m.seat.getComponent('minecraft:rideable')?.ejectRiders?.(); } catch { /* gone */ }
      try { m.seat.tryTeleport(m.foot, { keepVelocity: false, checkForBlocks: false }); } catch { /* unloaded */ }
      setDown(g, m, riders);
    }
    if (g.car && g.carStart) { try { g.car.tryTeleport(g.carStart, { keepVelocity: false, checkForBlocks: false, rotation: { x: 0, y: g.carYaw ?? 0 } }); } catch { /* unloaded */ } }
    setHome(g, false);
    disband(g);
  };

  const step = (g: Group, tick: number): void => {
    g.members = g.members.filter(m => validOf(m.seat));
    if (!g.members.length) { disband(g); return; }
    if (g.state === 'boarding') {
      const aboard = g.members.filter(m => ridersOf(m.seat).length);
      if (!aboard.length) { disband(g); return; } // everyone got off: the ride stays idle
      if (aboard.length === g.members.length) g.departAt = Math.min(g.departAt, tick + Math.round(C.BOARD_FULL_S * 20));
      if (tick < g.departAt) {
        if ((g.departAt - tick) % 20 === 0) for (const m of aboard) for (const r of ridersOf(m.seat)) say(r, `Ride starts in ${Math.ceil((g.departAt - tick) / 20)}`);
        return;
      }
      g.state = 'running'; g.startedAt = tick;
      for (const m of g.members) m.riders = ridersOf(m.seat).filter((r: any) => r?.typeId === 'minecraft:player');
      setHome(g, true);
      for (const m of g.members) for (const r of m.riders) say(r, g.kind === 'drop' ? 'Hold on' : 'Hold on tight');
    }
    const t = (tick - g.startedAt) / 20;
    if (t >= g.trip.duration) { finish(g); return; }
    for (const m of g.members) {
      const { p, yaw } = poseOf(g, m, t);
      try { m.seat.tryTeleport(p, { keepVelocity: false, checkForBlocks: false, rotation: { x: 0, y: yaw } }); } catch { /* unloaded: hold */ }
      // A rider who stepped off mid-trip is put back on their own seat.
      if ((tick - g.startedAt) % C.KEEP_ABOARD_TICKS === 0) {
        for (const r of m.riders) {
          let riding: any;
          try { riding = r.getComponent('minecraft:riding')?.entityRidingOn; } catch { riding = undefined; }
          if (riding && riding.id === m.seat.id) continue;
          try { r.teleport(p, { keepVelocity: false }); m.seat.getComponent('minecraft:rideable')?.addRider?.(r); } catch { /* next time */ }
        }
      }
    }
    moveCar(g, t);
  };

  /** Idle seats (and rings) left off their foot, a reload's leavings: back to the foot. */
  const sweepHome = (): void => {
    for (const dim of dimsOf()) {
      let seats: any[] = [];
      try { seats = dim.getEntities({ type: config.seatType }); } catch { continue; }
      for (const seat of seats) {
        if (seatGroup.has(seat.id) || ridersOf(seat).length) continue;
        const m = memberOf(seat);
        if (!m) continue;
        const f = typeof read(seat, K.scale) === 'number' ? read(seat, K.scale) : 1;
        if (Math.hypot(seat.location.x - m.foot.x, seat.location.y - m.foot.y, seat.location.z - m.foot.z) > 0.5 * f) { try { seat.tryTeleport(m.foot, { keepVelocity: false, checkForBlocks: false }); } catch { /* unloaded */ } }
      }
      config.rides.forEach(ride => {
        if (!ride.carType) return;
        let cars: any[] = [];
        try { cars = dim.getEntities({ type: ride.carType }); } catch { return; }
        for (const car of cars) {
          const home = parse(`[${read(car, K.home) ?? ''}]`)[0] as (P & { yaw?: number }) | undefined;
          if (!home || [...groups].some(g => g.car?.id === car.id)) continue;
          try { car.tryTeleport(home, { keepVelocity: false, checkForBlocks: false, rotation: { x: 0, y: home.yaw ?? 0 } }); car.setDynamicProperty(K.home, undefined); } catch { /* unloaded */ }
        }
      });
    }
  };

  system.runInterval(() => {
    const tick = system.currentTick;
    if (tick % C.POLL_TICKS === 0) {
      // New riders: anyone sitting on a funfair seat that is not in a group yet.
      for (const p of world.getAllPlayers()) {
        let seat: any;
        try { seat = p.getComponent('minecraft:riding')?.entityRidingOn; } catch { seat = undefined; }
        if (!seat || seat.typeId !== config.seatType || seatGroup.has(seat.id)) continue;
        const g = formGroup(seat);
        if (g) say(p, `Ride starts in ${Math.ceil(C.BOARD_S)}`);
      }
    }
    if (!groups.size && tick % C.HOME_TICKS === 1) sweepHome();
    for (const g of [...groups]) step(g, tick);
  }, 1);

  // A tap boards a ride (a touch tap is a HIT; only a press held ~0.5 s is the interact): the seat itself, or the
  // ring a child can see - then the nearest free seat of that ring to the child.
  const carRide = new Map<string, number>();
  config.rides.forEach((r, i) => { if (r.carType) carRide.set(r.carType, i); });
  const board = (player: any, target: any): void => {
    if (!player || player.typeId !== 'minecraft:player' || !target) return;
    let seat: any;
    if (target.typeId === config.seatType) seat = target;
    else {
      if (!carRide.has(target.typeId)) return;
      const index = typeof read(target, K.index) === 'number' ? read(target, K.index) : carRide.get(target.typeId);
      let seats: any[] = [];
      try { seats = target.dimension.getEntities({ type: config.seatType, location: target.location, maxDistance: 80 }); } catch { return; }
      const d = (s: any): number => Math.hypot(s.location.x - player.location.x, s.location.y - player.location.y, s.location.z - player.location.z);
      seat = seats.filter((s: any) => read(s, K.index) === index && !ridersOf(s).length && seatGroup.get(s.id)?.state !== 'running').sort((a: any, b: any) => d(a) - d(b))[0];
    }
    if (!seat || seatGroup.get(seat.id)?.state === 'running' || ridersOf(seat).length) return;
    let rideable: any;
    try { rideable = seat.getComponent('minecraft:rideable'); } catch { return; }
    let ok = false;
    try { ok = !!rideable?.addRider?.(player); } catch { ok = false; }
    if (!ok) {
      const l = seat.location;
      try { player.runCommand(`ride @s start_riding @e[type=${config.seatType},c=1,x=${l.x},y=${l.y},z=${l.z},r=1]`); } catch { /* left */ }
    }
  };
  try { world.afterEvents?.playerInteractWithEntity?.subscribe?.((ev: any) => board(ev.player, ev.target)); } catch { /* not in this API */ }
  try { world.afterEvents?.entityHitEntity?.subscribe?.((ev: any) => board(ev.damagingEntity, ev.hitEntity)); } catch { /* not in this API */ }
}

/** `scripts/rides-funfair.js`: the config, the physics kit and the runtime. */
export function funfairScript(config: FunfairRuntimeConfig): string {
  const shipped: FunfairRuntimeConfig = { ...config, escape: config.escape ?? ESCAPE_OPTIONS };
  const states = config.colliderStates ?? { lo: COLLIDER_LO_STATE, hi: COLLIDER_HI_STATE };
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(shipped)};\n(${funfairRuntime.toString()})(CONFIG, (${funfairKit.toString()})(CONFIG.constants), (${colliderBodyProbe.toString()})((${colliderFormKit.toString()})(), ${JSON.stringify(states.lo)}, ${JSON.stringify(states.hi)}));\n`;
}
