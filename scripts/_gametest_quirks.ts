/**
 * A standalone GameTest probe pack that MEASURES three Bedrock rules the
 * headless simulator had only assumed (web/src/sim/quirks/registry.ts):
 *
 *   - `teleport-into-floor`: a simulated player (and a player-sized mob for
 *     reference) is teleported 0.1 / 0.2 / 0.34 / 0.5 blocks INTO a full
 *     block, a bottom slab, the full `craftmatic:collider`, a half-height
 *     collider and a collider wall form (`craftmatic:collider_w2`, a band
 *     half a block thick), centred on a 3 x 3 pad, on the edge of a single
 *     block with open air beside it, and (the wall form) overlapping the band
 *     sideways. Its position is read every tick for 40 ticks, with its health.
 *     `CMGT QTP {json}` per subject.
 *   - `dismount-free-spot`: a simulated player rides the pack's own moulded
 *     seat entity (`seatBehavior`, the rider 0.3 under the seat) surrounded
 *     by stone on various sides, under a block, and sunk 0.1 / 0.3 into the
 *     floor; it is dismounted by `Rideable.ejectRider` (what the runtimes
 *     call), by `isSneaking = true` (the sneak) and by `/ride @s stop_riding`,
 *     and its position is read every tick for 30 ticks. `CMGT QDM {json}`.
 *   - reach: `SimulatedPlayer.attack()` (a raycast from the head, the route a
 *     touch tap takes: it raises `entityHitEntity`) and `interact()` (the
 *     hold: it mounts a seat) against a small entity moved away 0.25 block at
 *     a time, in Survival and Creative, at floor and at eye height.
 *     `attackEntity` is documented as reach-free; one far sample confirms it.
 *     `CMGT QREACH {json}`.
 *
 * Every test ends with `CMGT QUIRK_DONE {"test": ...}`. The pack is NOT a
 * model pack: it defines the collider blocks (`colliderBlockDefinition`), the
 * moulded seat (`seatBehavior`), a small tap target and a player-sized dummy,
 * so it must be the ONLY behaviour pack bound in `cmgametest` (the collider
 * ids would clash with a model pack's).
 *
 * Usage: bun scripts/_gametest_quirks.ts [--out=output/gametest-quirks-0930]
 * Then run it on the Pixel with output/gametest-quirks-0930/_run_quirks.py.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createZip } from '../web/src/engine/zip-utils.ts';
import { GT_GAMETEST_VERSION, buildArenaStructure } from '../web/src/engine/gametest-pack.ts';
import { packVersionAt } from '../web/src/engine/pipeline-version.ts';
import { deterministicUuid } from '../web/src/engine/mcpack.ts';
import { COLLIDER_BLOCK_IDS, COLLIDER_TERRAIN_TEXTURE, colliderBlockDefinition, colliderBlockFile } from '../web/src/engine/bedrock-building-shell.ts';
import { seatBehavior, transparentPng } from '../web/src/engine/playable-addon.ts';

/** Test namespace/tag and the arena structure's name. */
const NS = 'craftmatic_gtq';
/** Arena: 48 x 48 of smooth stone, 10 high (cells 6 blocks apart; see the runtime). */
const ARENA = { width: 48, height: 8, length: 48 } as const;
/** The collider forms the probe places: the full collider and the half-block x wall band. */
const PROBE_COLLIDERS = ['craftmatic:collider', 'craftmatic:collider_w2'] as const;

/**
 * The tests, serialised into the pack with `.toString()` (no outside
 * references: `mc`/`gt` are handed in).
 */
function quirkRuntime(mods: { mc: any; gt: any }, ns: string): void {
  const { mc, gt } = mods;
  const { world, system } = mc;
  const log = (tag: string, data: unknown): void => { console.warn(`CMGT ${tag} ${JSON.stringify(data)}`); };
  // The content log is block-buffered: pad so the lines above reach the file.
  const flush = (): void => { const pad = 'x'.repeat(1000); for (let i = 0; i < 18; i++) console.warn(`CMGT_PAD ${i} ${pad}`); };
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  const SURVIVAL = mc.GameMode.Survival ?? mc.GameMode.survival;
  const CREATIVE = mc.GameMode.Creative ?? mc.GameMode.creative;
  const CELL = 6;
  const cellOf = (i: number): { cx: number; cz: number } => ({ cx: 4 + (i % 7) * CELL, cz: 4 + Math.floor(i / 7) * CELL });
  const collider = (id: string, lo: number, hi: number): any => mc.BlockPermutation.resolve(id, { 'craftmatic:lo': lo, 'craftmatic:hi': hi });
  const MATERIALS: Record<string, { top: number; perm: () => any }> = {
    stone: { top: 1, perm: () => mc.BlockPermutation.resolve('minecraft:stone') },
    slab: { top: 0.5, perm: () => mc.BlockPermutation.resolve('minecraft:smooth_stone_slab') },
    colliderFull: { top: 1, perm: () => collider('craftmatic:collider', 0, 16) },
    colliderHalf: { top: 0.5, perm: () => collider('craftmatic:collider', 0, 8) },
    colliderW2: { top: 1, perm: () => collider('craftmatic:collider_w2', 0, 16) },
  };
  const riding = (e: any): any => { try { return e.getComponent('minecraft:riding')?.entityRidingOn; } catch { return undefined; } };
  const health = (e: any): number | null => { try { return r3(e.getComponent('minecraft:health')?.currentValue); } catch { return null; } };
  /** The smooth-stone floor's relative y (a structure's layer 0 lands at relative y 1). */
  const floorY = (test: any): number => {
    for (let ry = -3; ry <= 3; ry++) { try { if (test.getBlock({ x: 2, y: ry, z: 2 })?.typeId === 'minecraft:smooth_stone') return ry; } catch { /* outside */ } }
    return 0;
  };
  const rel = (test: any, e: any): { x: number; y: number; z: number } => test.relativeLocation(e.location);
  const spawnSim = async (test: any, at: any, name: string, mode: any): Promise<any> => test.spawnSimulatedPlayer(at, name, mode);

  // ── teleport-into-floor ────────────────────────────────────────────────
  gt.registerAsync(ns, 'quirk_tp', async (test: any) => {
    try {
      const fy = floorY(test);
      const S = fy + 1; // floor top, relative
      const dim = test.getDimension();
      log('QTP_FRAME', { fy, origin: test.worldBlockLocation({ x: 0, y: 0, z: 0 }), xAxis: test.worldBlockLocation({ x: 1, y: 0, z: 0 }), zAxis: test.worldBlockLocation({ x: 0, y: 0, z: 1 }) });
      const DEPTHS = [0.1, 0.2, 0.34, 0.5];
      const cases: any[] = [];
      for (const mat of ['stone', 'slab', 'colliderFull', 'colliderHalf']) for (const d of DEPTHS) cases.push({ layout: 'wide', mat, d, method: 'script', who: 'player' });
      for (const mat of ['stone', 'slab', 'colliderHalf']) for (const d of DEPTHS) cases.push({ layout: 'edge', mat, d, method: 'script', who: 'player' });
      for (const mat of ['stone', 'slab', 'colliderFull', 'colliderHalf']) cases.push({ layout: 'wide', mat, d: 0.34, method: 'cmd', who: 'player' });
      for (const d of DEPTHS) cases.push({ layout: 'wall', mat: 'colliderW2', d, method: 'script', who: 'player' });
      for (const mat of ['stone', 'slab']) cases.push({ layout: 'wide', mat, d: 0.34, method: 'script', who: 'dummy' });
      // Lay every subject's blocks first.
      cases.forEach((c, i) => {
        const { cx, cz } = cellOf(i);
        c.id = i; c.cell = [cx, cz];
        const m = MATERIALS[c.mat]!;
        if (c.layout === 'wide') for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) test.setBlockPermutation(m.perm(), { x: cx + dx, y: S, z: cz + dz });
        if (c.layout === 'edge') test.setBlockPermutation(m.perm(), { x: cx, y: S, z: cz });
        if (c.layout === 'wall') for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) test.setBlockPermutation(m.perm(), { x: cx, y: S + dy, z: cz + dz });
        // Where it is teleported to (relative): feet d under the top, or (wall) overlapping the band by d.
        c.target = c.layout === 'wide' ? { x: cx + 0.5, y: S + m.top - c.d, z: cz + 0.5 }
          : c.layout === 'edge' ? { x: cx + 1.0, y: S + m.top - c.d, z: cz + 0.5 }
            : { x: cx + 0.5 + 0.3 - c.d, y: S, z: cz + 0.5 };
        try { const b = test.getBlock({ x: cx, y: S, z: cz }); c.block = { type: b?.typeId, states: b?.permutation?.getAllStates?.() }; } catch (err) { c.block = String(err); }
      });
      await test.idle(5);
      // Spawn every subject on free floor beside its pad.
      for (const c of cases) {
        const [cx, cz] = c.cell;
        const stand = { x: cx + 2, y: S, z: cz + 2 };
        if (c.who === 'player') c.e = await spawnSim(test, stand, `cmtp_${c.id}`, SURVIVAL);
        else c.e = dim.spawnEntity('craftmatic:gtq_dummy', test.worldLocation({ x: cx + 2.5, y: S, z: cz + 2.5 }));
      }
      await test.idle(30);
      // Teleport all in one tick, then read every tick.
      for (const c of cases) {
        const w = test.worldLocation(c.target);
        c.health0 = health(c.e);
        if (c.method === 'cmd') {
          try { c.cmd = c.e.runCommand(`tp @s ${w.x.toFixed(4)} ${w.y.toFixed(4)} ${w.z.toFixed(4)}`)?.successCount; } catch (err) { c.cmd = String(err); }
        } else c.e.teleport(w);
        c.samples = [];
      }
      for (let t = 0; t <= 40; t++) {
        for (const c of cases) {
          try {
            const p = rel(test, c.e);
            const s = [t, r3(p.x - c.target.x), r3(p.y - c.target.y), r3(p.z - c.target.z)];
            const last = c.samples[c.samples.length - 1];
            if (!last || last[1] !== s[1] || last[2] !== s[2] || last[3] !== s[3] || t === 40) c.samples.push(s);
          } catch (err) { if (!c.err) c.err = `t${t}: ${String(err)}`; }
        }
        if (t < 40) await test.idle(1);
      }
      for (const c of cases) {
        let onGround: unknown = null;
        try { onGround = c.e.isOnGround; } catch { /* gone */ }
        log('QTP', { id: c.id, layout: c.layout, mat: c.mat, d: c.d, method: c.method, who: c.who, top: MATERIALS[c.mat]!.top, cmd: c.cmd, block: c.block, health0: c.health0, health1: health(c.e), onGround, err: c.err, samples: c.samples });
      }
      flush();
      for (const c of cases) { try { if (c.who === 'player') test.removeSimulatedPlayer(c.e); else c.e.remove(); } catch { /* gone */ } }
    } catch (err) { log('QTP_ERROR', { error: String(err), stack: (err as any)?.stack }); }
    log('QUIRK_DONE', { test: 'quirk_tp' });
    flush();
    test.succeed();
  }).structureName(`${ns}:arena`).maxTicks(2400).tag(ns);

  // ── dismount-free-spot ─────────────────────────────────────────────────
  gt.registerAsync(ns, 'quirk_dismount', async (test: any) => {
    try {
      const fy = floorY(test);
      const S = fy + 1;
      const dim = test.getDimension();
      const stone = mc.BlockPermutation.resolve('minecraft:stone');
      const air = mc.BlockPermutation.resolve('minecraft:air');
      // Blocks around the seat cell (cx, cz): feet and head level, relative offsets.
      const SIDES: Record<string, number[][]> = { px: [[1, 0]], nx: [[-1, 0]], pz: [[0, 1]], nz: [[0, -1]] };
      const RING8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      const CONFIGS: Array<{ name: string; walls: number[][]; head?: boolean; seatH: number; yaw?: number }> = [
        { name: 'open', walls: [], seatH: 0.3 },
        { name: 'px', walls: SIDES.px!, seatH: 0.3 },
        { name: 'nx', walls: SIDES.nx!, seatH: 0.3 },
        { name: 'pz', walls: SIDES.pz!, seatH: 0.3 },
        { name: 'nz', walls: SIDES.nz!, seatH: 0.3 },
        { name: 'x2', walls: [[1, 0], [-1, 0]], seatH: 0.3 },
        { name: 'x2pz', walls: [[1, 0], [-1, 0], [0, 1]], seatH: 0.3 },
        { name: 'ring4', walls: [[1, 0], [-1, 0], [0, 1], [0, -1]], seatH: 0.3 },
        { name: 'ring8', walls: RING8, seatH: 0.3 },
        { name: 'head', walls: [], head: true, seatH: 0.3 },
        { name: 'headRing4', walls: [[1, 0], [-1, 0], [0, 1], [0, -1]], head: true, seatH: 0.3 },
        { name: 'sunk03', walls: [], seatH: 0 },
        { name: 'sunk01', walls: [], seatH: 0.2 },
        { name: 'sunk03ring8', walls: RING8, seatH: 0 },
      ];
      const METHODS = ['eject', 'sneak', 'cmd'];
      const rows: any[] = [];
      let idx = 0;
      for (const method of METHODS) {
        const cases: any[] = CONFIGS.map(c => ({ ...c, method }));
        if (method === 'eject') cases.push({ ...CONFIGS[1]!, name: 'px_yaw90', yaw: 90, method }, { ...CONFIGS[3]!, name: 'pz_yaw90', yaw: 90, method });
        for (const c of cases) {
          const { cx, cz } = cellOf(idx++);
          c.cell = [cx, cz];
          // Clear the cell's 3 x 3 x 3 first (the cells are not reused, but be explicit).
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = 0; dy <= 2; dy++) test.setBlockPermutation(air, { x: cx + dx, y: S + dy, z: cz + dz });
          for (const [dx, dz] of c.walls) for (let dy = 0; dy <= 1; dy++) test.setBlockPermutation(stone, { x: cx + dx!, y: S + dy, z: cz + dz! });
          if (c.head) test.setBlockPermutation(stone, { x: cx, y: S + 1, z: cz });
          c.seatAt = { x: cx + 0.5, y: S + c.seatH, z: cz + 0.5 };
          c.seat = dim.spawnEntity('craftmatic:gtq_seat', test.worldLocation(c.seatAt));
          try { c.seat.setRotation({ x: 0, y: c.yaw ?? 0 }); } catch (err) { c.rotErr = String(err); }
          c.sim = await spawnSim(test, { x: cx + 2, y: S, z: cz + 2 }, `cmdm_${idx}`, SURVIVAL);
        }
        await test.idle(20);
        for (const c of cases) {
          c.mount = [];
          for (let k = 0; k < 5 && riding(c.sim)?.id !== c.seat.id; k++) {
            try { c.mount.push(c.seat.getComponent('minecraft:rideable').addRider(c.sim)); } catch (err) { c.mount.push(String(err)); }
            await test.idle(4);
          }
        }
        await test.idle(20);
        for (const c of cases) {
          try {
            const p = rel(test, c.sim);
            const h = test.relativeLocation(c.sim.getHeadLocation());
            c.seated = { riding: riding(c.sim)?.id === c.seat.id, at: [r3(p.x - c.seatAt.x), r3(p.y - S), r3(p.z - c.seatAt.z)], eyeOverSeatPos: r3(h.y - (c.seatAt.y - 0.3)), rot: c.sim.getRotation(), seatRot: c.seat.getRotation() };
          } catch (err) { c.seated = String(err); }
        }
        // Dismount all in one tick.
        for (const c of cases) {
          try {
            if (method === 'eject') c.seat.getComponent('minecraft:rideable').ejectRider(c.sim);
            else if (method === 'sneak') c.sim.isSneaking = true;
            else c.cmd = c.sim.runCommand('ride @s stop_riding')?.successCount;
          } catch (err) { c.dmErr = String(err); }
          c.samples = [];
          c.offAt = null;
        }
        for (let t = 0; t <= 30; t++) {
          for (const c of cases) {
            try {
              if (c.offAt === null && riding(c.sim)?.id !== c.seat.id) c.offAt = t;
              const p = rel(test, c.sim);
              const s = [t, r3(p.x - c.seatAt.x), r3(p.y - S), r3(p.z - c.seatAt.z)];
              const last = c.samples[c.samples.length - 1];
              if (!last || last[1] !== s[1] || last[2] !== s[2] || last[3] !== s[3] || t === 30) c.samples.push(s);
            } catch (err) { if (!c.err) c.err = `t${t}: ${String(err)}`; }
          }
          if (method === 'sneak' && t === 10) for (const c of cases) { try { c.sim.isSneaking = false; } catch { /* gone */ } }
          if (t < 30) await test.idle(1);
        }
        for (const c of cases) {
          const row = { name: c.name, method, walls: c.walls, head: !!c.head, seatH: c.seatH, yaw: c.yaw ?? 0, mount: c.mount, seated: c.seated, cmd: c.cmd, dmErr: c.dmErr, rotErr: c.rotErr, offAt: c.offAt, stillRiding: riding(c.sim)?.id === c.seat.id, health: health(c.sim), err: c.err, samples: c.samples };
          rows.push(row);
          log('QDM', row);
        }
        flush();
        for (const c of cases) { try { test.removeSimulatedPlayer(c.sim); } catch { /* gone */ } try { c.seat.remove(); } catch { /* gone */ } }
        await test.idle(10);
      }
    } catch (err) { log('QDM_ERROR', { error: String(err), stack: (err as any)?.stack }); }
    log('QUIRK_DONE', { test: 'quirk_dismount' });
    flush();
    test.succeed();
  }).structureName(`${ns}:arena`).maxTicks(3000).tag(ns);

  // ── reach of attack() / interact() ─────────────────────────────────────
  const hits: Array<{ tick: number; by: string; hit: string; id: string }> = [];
  world.afterEvents.entityHitEntity.subscribe((ev: any) => {
    try { hits.push({ tick: system.currentTick, by: String(ev.damagingEntity?.name ?? ev.damagingEntity?.typeId), hit: String(ev.hitEntity?.typeId), id: String(ev.hitEntity?.id) }); } catch { /* invalid */ }
  });
  gt.registerAsync(ns, 'quirk_reach', async (test: any) => {
    try {
      const fy = floorY(test);
      const S = fy + 1;
      const dim = test.getDimension();
      const stand = { x: 4.5, y: S, z: 4.5 };
      const target = dim.spawnEntity('craftmatic:gtq_target', test.worldLocation({ x: 40.5, y: S, z: 40.5 }));
      const seat = dim.spawnEntity('craftmatic:gtq_seat', test.worldLocation({ x: 42.5, y: S, z: 40.5 }));
      const park = (e: any, x: number): void => e.teleport(test.worldLocation({ x, y: S, z: 40.5 }));
      const DISTANCES: number[] = [];
      for (let d = 1.5; d <= 8.0001; d += 0.25) DISTANCES.push(Math.round(d * 100) / 100);
      for (const [modeName, mode] of [['survival', SURVIVAL], ['creative', CREATIVE]] as Array<[string, any]>) {
        const sim = await spawnSim(test, { x: 4, y: S, z: 4 }, `cmrc_${modeName}`, mode);
        await test.idle(20);
        sim.teleport(test.worldLocation(stand), { rotation: { x: 0, y: 0 } });
        await test.idle(5);
        const eye = test.relativeLocation(sim.getHeadLocation());
        const rows: any[] = [];
        for (const height of ['floor', 'eye']) {
          // floor: the box (0.5 x 0.5) stands on the floor; eye: its centre is at eye height.
          const boxY = height === 'floor' ? S : eye.y - 0.25;
          for (const D of DISTANCES) {
            const at = { x: stand.x, y: boxY, z: stand.z + D };
            // Nearest point of the 0.5 x 0.5 x 0.5 box to the eye (the ray's shortest path).
            const ny = Math.min(Math.max(eye.y, boxY), boxY + 0.5);
            const nz = Math.min(Math.max(eye.z, at.z - 0.25), at.z + 0.25);
            const eyeToBox = r3(Math.hypot(eye.x - at.x, eye.y - ny, eye.z - nz));
            // attack(): the tap route.
            target.teleport(test.worldLocation(at));
            sim.teleport(test.worldLocation(stand));
            await test.idle(2);
            sim.lookAtEntity(target);
            await test.idle(4);
            const n0 = hits.length;
            let attack: unknown;
            try { attack = sim.attack(); } catch (err) { attack = String(err); }
            await test.idle(3);
            const hit = hits.slice(n0).some(h => h.by === sim.name && h.id === target.id);
            park(target, 40.5);
            // interact(): the hold route; it mounts the seat when it reaches it.
            seat.teleport(test.worldLocation(at));
            await test.idle(2);
            sim.lookAtEntity(seat);
            await test.idle(4);
            let interact: unknown;
            try { interact = sim.interact(); } catch (err) { interact = String(err); }
            await test.idle(4);
            const mounted = riding(sim)?.id === seat.id;
            if (mounted) { try { seat.getComponent('minecraft:rideable').ejectRider(sim); } catch { /* none */ } await test.idle(3); }
            park(seat, 42.5);
            rows.push([height, D, eyeToBox, attack, hit, interact, mounted]);
          }
        }
        // attackEntity is documented as reach-free: one far sample.
        target.teleport(test.worldLocation({ x: stand.x, y: S, z: stand.z + 20 }));
        await test.idle(3);
        const n0 = hits.length;
        let far: unknown;
        try { far = sim.attackEntity(target); } catch (err) { far = String(err); }
        await test.idle(3);
        const farHit = hits.slice(n0).some(h => h.by === sim.name && h.id === target.id);
        park(target, 40.5);
        log('QREACH', { mode: modeName, eye: { y: r3(eye.y - S) }, cols: ['height', 'D', 'eyeToBox', 'attack', 'hit', 'interact', 'mounted'], rows, attackEntityAt20: { returned: far, hit: farHit } });
        flush();
        try { test.removeSimulatedPlayer(sim); } catch { /* gone */ }
        await test.idle(10);
      }
      try { target.remove(); seat.remove(); } catch { /* gone */ }
    } catch (err) { log('QREACH_ERROR', { error: String(err), stack: (err as any)?.stack }); }
    log('QUIRK_DONE', { test: 'quirk_reach' });
    flush();
    test.succeed();
  }).structureName(`${ns}:arena`).maxTicks(12000).tag(ns);

  let started = false;
  world.afterEvents.playerSpawn.subscribe((ev: any) => {
    if (started || !ev.initialSpawn || /^cm(tp|dm|rc)_/.test(String(ev.player?.name))) return;
    started = true;
    system.runTimeout(() => {
      for (const cmd of ['gametest clearall', `gametest runset ${ns}`]) {
        try { const r = ev.player.runCommand(cmd); log('RUN', { cmd, successCount: r?.successCount }); } catch (err) { log('RUN', { cmd, error: String(err) }); }
      }
    }, 200);
  });
  log('READY', { probe: 'quirks' });
  flush();
}

/** A player-sized mob with ordinary physics (no AI), the non-player reference for the teleport probe. */
function dummyBehavior(): unknown {
  return { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 'craftmatic:gtq_dummy', is_spawnable: false, is_summonable: true }, components: {
    'minecraft:type_family': { family: ['craftmatic_gtq'] },
    'minecraft:collision_box': { width: 0.6, height: 1.8 },
    'minecraft:physics': {},
    'minecraft:pushable_by_block': {},
    'minecraft:health': { value: 20, max: 20 },
    'minecraft:movement': { value: 0 },
  } } };
}

/** The small tap target: a 0.5 box, no gravity, no collision, unhurt (like a seat, not rideable). */
function targetBehavior(): unknown {
  return { format_version: '1.26.30', 'minecraft:entity': { description: { identifier: 'craftmatic:gtq_target', is_spawnable: false, is_summonable: true }, components: {
    'minecraft:type_family': { family: ['craftmatic_gtq'] },
    'minecraft:collision_box': { width: 0.5, height: 0.5 },
    'minecraft:physics': { has_gravity: false, has_collision: false },
    'minecraft:health': { value: 20, max: 20 },
    'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
  } } };
}

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = resolve(flag('out') ?? 'output/gametest-quirks-0930');
mkdirSync(outDir, { recursive: true });
// The commit the probe was built from, so the pack on the phone is identifiable (+dirty when the tree was not clean).
const stamp = execSync('git rev-parse --short=8 HEAD').toString().trim() + (execSync('git status --porcelain -uno').toString().trim() ? '+dirty' : '');
const version = packVersionAt();
const enc = new TextEncoder();
const json = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v, null, 2) + '\n');
const uid = (k: string): string => deterministicUuid(`${NS}.probe:${k}`);
const bpUuid = uid('bp');
const rpUuid = uid('rp');
const label = `Craftmatic quirk probe ${stamp}`;
const bp = 'craftmatic_quirk_probe_bp/';
const rp = 'craftmatic_quirk_probe_rp/';
const colliderVariants = PROBE_COLLIDERS.map(id => COLLIDER_BLOCK_IDS.indexOf(id));
if (colliderVariants.some(v => v < 0)) throw new Error(`collider ids not in the kit: ${PROBE_COLLIDERS.join(', ')}`);
const script = `import * as mc from "@minecraft/server";\nimport * as gt from "@minecraft/server-gametest";\n(${quirkRuntime.toString()})({ mc, gt }, ${JSON.stringify(NS)});\n`;
const files: Array<{ name: string; data: Uint8Array }> = [
  { name: `${bp}manifest.json`, data: json({ format_version: 2, header: { name: `${label} [GameTest]`, description: 'Measures teleport-into-floor, dismount spot and tap reach (scripts/_gametest_quirks.ts).', uuid: bpUuid, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'data', uuid: uid('bp.data'), version }, { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: uid('bp.script'), version }], dependencies: [{ uuid: rpUuid, version }, { module_name: '@minecraft/server', version: '2.9.0' }, { module_name: '@minecraft/server-gametest', version: GT_GAMETEST_VERSION }] }) },
  { name: `${bp}scripts/main.js`, data: enc.encode(script) },
  { name: `${bp}structures/${NS}/arena.mcstructure`, data: buildArenaStructure(ARENA) },
  { name: `${bp}entities/gtq_seat.json`, data: json(seatBehavior('gtq_seat')) },
  { name: `${bp}entities/gtq_dummy.json`, data: json(dummyBehavior()) },
  { name: `${bp}entities/gtq_target.json`, data: json(targetBehavior()) },
  ...colliderVariants.map(v => ({ name: `${bp}blocks/${colliderBlockFile(v)}`, data: json(colliderBlockDefinition(v)) })),
  { name: `${rp}manifest.json`, data: json({ format_version: 2, header: { name: label, description: 'Quirk probe resources.', uuid: rpUuid, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'resources', uuid: uid('rp.res'), version }] }) },
  { name: `${rp}blocks.json`, data: json({ format_version: '1.21.40', ...Object.fromEntries(PROBE_COLLIDERS.map(id => [id, { sound: 'stone' }])) }) },
  { name: `${rp}textures/terrain_texture.json`, data: json({ resource_pack_name: 'craftmatic_quirk_probe', texture_name: 'atlas.terrain', padding: 8, num_mip_levels: 4, texture_data: COLLIDER_TERRAIN_TEXTURE }) },
  { name: `${rp}textures/blocks/craftmatic_collider.png`, data: transparentPng() },
];
const out = join(outDir, 'craftmatic-quirk-probe.mcaddon');
writeFileSync(out, await createZip(files));
console.log(`probe ${out}\nstamp ${stamp} version ${version.join('.')} bp ${bpUuid} rp ${rpUuid}`);
