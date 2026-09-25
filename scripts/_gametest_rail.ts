/**
 * GameTest variant for a pack with a DRIVEN train (a railway route,
 * `RAIL_TRAIN_PHYSICS`): place the model with its own placement code, seat a
 * simulated player in the lead car with `interactWithEntity`, push its stick
 * forward then back (`moveRelative`), and log how the train's saved arc and
 * speed moved - plus whether the runtime could read the simulated stick at
 * all (`inputInfo.getMovementVector`). One `CMGT TRAIN {json}` line per
 * phase and a `CMGT TRAIN_SUMMARY` line go to the content log.
 *
 * It reuses gametest-pack.ts's variant builders (manifest, placement hook,
 * arena) and ships ONLY this test, so it never collides with another variant
 * of the same pack: bind one variant per run in `cmgametest`.
 *
 * Usage: bun scripts/_gametest_rail.ts <pack.mcaddon> [--out=dir]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createZip, extractMatching } from '../web/src/engine/zip-utils.ts';
import { GT_MARGIN, GT_NAMESPACE, arenaExceeds, arenaSize, buildArenaStructure, patchPlacementForGametest, variantManifest, withGametestImport } from '../web/src/engine/gametest-pack.ts';
import { packVersionAt } from '../web/src/engine/pipeline-version.ts';

interface RailPlan { modelId: string; dims: { width: number; height: number; length: number }; actorTypes: string[]; carTypes: string[] }

/** Serialised into the pack (no imports; `mc`/`gt` are handed in). */
function railGametestRuntime(mods: { mc: any; gt: any }, plan: RailPlan, margin: number): void {
  const { mc, gt } = mods;
  const { world, system } = mc;
  const NS = 'craftmatic_gt';
  const log = (tag: string, data: unknown): void => { console.warn(`CMGT ${tag} ${JSON.stringify(data)}`); };
  const flush = (): void => { const pad = 'x'.repeat(1000); for (let i = 0; i < 18; i++) console.warn(`CMGT_PAD ${i} ${pad}`); };
  const replies = new Map<string, any>();
  system.afterEvents.scriptEventReceive.subscribe((ev: any) => {
    if (ev.id === `${NS}:placed`) { try { const m = JSON.parse(ev.message); replies.set(m.player, m); } catch { /* malformed */ } }
  }, { namespaces: [NS] });
  const gameMode = mc.GameMode.Survival ?? mc.GameMode.survival;
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  gt.registerAsync(NS, `train_${plan.modelId}`, async (test: any) => {
    let fy = 0;
    for (let ry = -3; ry <= 3; ry++) { try { if (test.getBlock({ x: margin, y: ry, z: margin })?.typeId === 'minecraft:smooth_stone') { fy = ry; break; } } catch { /* outside */ } }
    const anchor = test.worldBlockLocation({ x: margin, y: fy + 1, z: margin });
    const name = `cmgt_${Math.floor(Math.random() * 1e6)}`;
    const sim = test.spawnSimulatedPlayer({ x: 1, y: fy + 1, z: 1 }, name, gameMode);
    await test.idle(5);
    system.sendScriptEvent(`${NS}:place`, JSON.stringify({ player: name, x: anchor.x, y: anchor.y, z: anchor.z, rotation: 0, size: 100 }));
    let reply: any;
    for (let t = 0; t < 1200 && !reply; t += 10) { await test.idle(10); reply = replies.get(name); }
    log('TRAIN_PLACED', { reply: reply ?? 'timeout', anchor });
    if (!reply || reply.error) { flush(); test.fail('placement did not complete'); return; }
    await test.idle(40);
    const dim = test.getDimension();
    const centre = { x: anchor.x + plan.dims.width / 2, y: anchor.y, z: anchor.z + plan.dims.length / 2 };
    const reach = Math.max(plan.dims.width, plan.dims.length) + 8;
    const cars = dim.getEntities({ location: centre, maxDistance: reach }).filter((e: any) => plan.carTypes.includes(e.typeId));
    const row: any = { cars: cars.length };
    if (!cars.length) { log('TRAIN', row); flush(); test.fail('no train car found'); return; }
    const arcOf = (e: any): number => Number(e.getDynamicProperty('craftmatic:coaster_distance'));
    const speedOf = (e: any): number => Number(e.getDynamicProperty('craftmatic:coaster_speed'));
    const lead = cars.sort((a: any, b: any) => Number(a.getDynamicProperty('craftmatic:coaster_car')) - Number(b.getDynamicProperty('craftmatic:coaster_car')))[0];
    const riders = (): string[] => { try { return (lead.getComponent('minecraft:rideable')?.getRiders?.() ?? []).map((r: any) => r?.name ?? r?.typeId ?? 'undefined'); } catch (err) { return [`error: ${String(err)}`]; } };
    // Parked before anyone boards: the unattended train must not move.
    const parked0 = arcOf(lead);
    await test.idle(40);
    row.parked = { from: r2(parked0), to: r2(arcOf(lead)) };
    sim.teleport(lead.location, { facingLocation: lead.location });
    await test.idle(4);
    sim.lookAtEntity(lead);
    row.interactReturned = sim.interactWithEntity(lead);
    await test.idle(20);
    if (!riders().includes(sim.name)) { try { row.addRider = lead.getComponent('minecraft:rideable').addRider(sim); } catch (err) { row.addRider = `error: ${String(err)}`; } await test.idle(20); }
    row.riders = riders();
    const phase = async (label: string, forward: number, ticks: number): Promise<any> => {
      const out: any = { label, from: r2(arcOf(lead)), samples: [] as number[][] };
      for (let t = 0; t < ticks; t += 10) {
        if (forward) sim.moveRelative(0, forward); else sim.stopMoving();
        let stick: unknown = null;
        try { stick = sim.inputInfo?.getMovementVector?.(); } catch (err) { stick = `error: ${String(err)}`; }
        if (t === 0) out.stickSeen = stick;
        await test.idle(10);
        out.samples.push([t + 10, r2(arcOf(lead)), r2(speedOf(lead))]);
      }
      sim.stopMoving();
      out.to = r2(arcOf(lead));
      out.maxSpeed = Math.max(0, ...out.samples.map((s: number[]) => s[2]!));
      log('TRAIN', { ...out, samples: out.samples.filter((_: unknown, i: number) => i % 2 === 1) });
      return out;
    };
    const fwd = await phase('stick forward', 1, 100);
    const idle = await phase('stick released', 0, 60);
    const back = await phase('stick back', -1, 140);
    try { lead.getComponent('minecraft:rideable')?.ejectRiders?.(); } catch { /* none */ }
    await test.idle(10);
    const after = await phase('after dismount', 0, 60);
    const moved = (p: any): number => Math.abs(p.to - p.from);
    row.summary = { forward: r2(moved(fwd)), released: r2(moved(idle)), back: r2(moved(back)), afterDismount: r2(moved(after)), forwardMaxSpeed: fwd.maxSpeed, backMaxSpeed: back.maxSpeed, stickSeen: fwd.stickSeen };
    row.pass = row.riders.includes(sim.name) && moved(fwd) > 1 && back.maxSpeed > 1 && moved(after) < 0.5 && Math.abs(row.parked.to - row.parked.from) < 0.01;
    log('TRAIN_SUMMARY', row);
    flush();
    if (row.pass) test.succeed(); else test.fail(`train: ${JSON.stringify(row.summary)}`);
  }).structureName(`${NS}:arena_${plan.modelId}`).maxTicks(3000).tag(NS);
  let started = false;
  world.afterEvents.playerSpawn.subscribe((ev: any) => {
    if (started || !ev.initialSpawn || String(ev.player.name).startsWith('cmgt_')) return;
    started = true;
    system.runTimeout(() => {
      for (const cmd of ['gametest clearall', `gametest runset ${NS}`]) {
        try { const r = ev.player.runCommand(cmd); log('RUN', { cmd, successCount: r?.successCount }); } catch (err) { log('RUN', { cmd, error: String(err) }); }
      }
    }, 200);
  });
  log('READY', { model: plan.modelId, cars: plan.carTypes });
}

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_gametest_rail.ts <pack.mcaddon> [--out=dir]'); process.exit(2); }
const outDir = resolve(flag('out') ?? 'output/gametest');
mkdirSync(outDir, { recursive: true });
const stem = basename(file).replace(/\.mcaddon$/i, '');
const bytes = readFileSync(file);
const entries = await extractMatching(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, () => true);
const text = (name: string): string => new TextDecoder().decode(entries.get(name)!);
const placementName = [...entries.keys()].find(n => /\/scripts\/placement\.js$/.test(n));
if (!placementName) throw new Error(`${file}: no scripts/placement.js`);
const bpFolder = placementName.split('/')[0]!;
const placement = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(text(placementName))![1]!) as { id: string; width: number; height: number; length: number; actors: Array<{ typeId: string }> };
const coasterName = `${bpFolder}/scripts/coaster.js`;
if (!entries.has(coasterName)) throw new Error(`${file}: no scripts/coaster.js (no ride vehicles)`);
const coaster = JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(text(coasterName))![1]!) as { routes: Array<{ physics?: { DRIVER?: unknown }; cars: { slots?: Array<{ type: string }> } }> };
const carTypes = [...new Set(coaster.routes.filter(r => r.physics?.DRIVER).flatMap(r => (r.cars.slots ?? []).map(s => s.type)))];
if (!carTypes.length) throw new Error(`${file}: no driven (railway) route`);
const dims = { width: placement.width, height: placement.height, length: placement.length };
if (arenaExceeds(dims)) throw new Error(`${file}: arena ${JSON.stringify(arenaSize(dims))} exceeds one structure`);
const plan: RailPlan = { modelId: placement.id, dims, actorTypes: placement.actors.map(a => a.typeId), carTypes };
const script = `import * as mc from "@minecraft/server";\nimport * as gt from "@minecraft/server-gametest";\nconst PLAN = ${JSON.stringify(plan)};\n(${railGametestRuntime.toString()})({ mc, gt }, PLAN, ${GT_MARGIN});\n`;
const enc = new TextEncoder();
const version = packVersionAt();
const files: Array<{ name: string; data: Uint8Array }> = [];
for (const [name, data] of entries) {
  if (name.endsWith('/')) continue;
  if (name === `${bpFolder}/manifest.json`) files.push({ name, data: enc.encode(JSON.stringify(variantManifest(JSON.parse(text(name).replace(/^﻿/, '')), version), null, 2) + '\n') });
  else if (name === placementName) files.push({ name, data: enc.encode(patchPlacementForGametest(text(name))) });
  else if (name === `${bpFolder}/scripts/main.js`) files.push({ name, data: enc.encode(withGametestImport(text(name))) });
  else files.push({ name, data: new Uint8Array(data) });
}
files.push({ name: `${bpFolder}/scripts/gametest.js`, data: enc.encode(script) });
files.push({ name: `${bpFolder}/structures/${GT_NAMESPACE}/arena_${plan.modelId}.mcstructure`, data: buildArenaStructure(dims) });
const out = join(outDir, `${stem}-railtest.mcaddon`);
writeFileSync(out, await createZip(files));
console.log(`${placement.id}: driven car types ${carTypes.join(', ')}\nvariant ${out}`);
