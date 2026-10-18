/**
 * `@minecraft/server-gametest` in the simulator (web/src/sim/script-host/gametest-module.ts)
 * and the device-log replay (web/src/sim/adapters/craftmatic/gametest-replay.ts):
 * the SAME GameTest definitions the Pixel runs, run offline (PACK-08,
 * `TODO(sim-gametest)` closed 2026-10-08).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Simulation } from '../web/src/sim/core/simulation.js';
import { fixtureAddon } from '../web/src/sim/pack/fixture.js';
import { readAddon } from '../web/src/sim/pack/pack.js';
import { runGametest } from '../web/src/sim/script-host/gametest-module.js';
import { compareRows, isQuirkLog, parseCmgt, verdictRows } from '../web/src/sim/adapters/craftmatic/gametest-replay.js';
import { gametestScript, type GametestPlan } from '../web/src/engine/gametest-pack.js';

/** A pack whose `scripts/main.js` registers `body` as one async test `t:probe`. */
function probePack(body: string, extra: Record<string, unknown> = {}): ReturnType<typeof fixtureAddon> {
  const script = `import * as mc from "@minecraft/server";\nimport * as gt from "@minecraft/server-gametest";\n${body}`;
  return fixtureAddon({ name: 'gt', files: { 'scripts/main.js': script, ...extra }, scriptModules: { '@minecraft/server': '2.9.0', '@minecraft/server-gametest': '1.0.0-beta' } });
}

describe('the GameTest module', () => {
  it('registers a test with its builder settings and runs it: a simulated player walks to a test-relative point', async () => {
    const sim = new Simulation();
    sim.loadAddon(probePack(`gt.registerAsync("t", "probe", async (test) => {
  const p = test.spawnSimulatedPlayer({ x: 1.5, y: 1, z: 1.5 }, "cmgt_p", mc.GameMode.Survival);
  await test.idle(5);
  p.moveToLocation({ x: 6.5, y: 1, z: 1.5 });
  await test.idle(60);
  const rel = test.relativeLocation(p.location);
  console.warn("CMGT PROBE " + JSON.stringify({ x: Math.round(rel.x * 10) / 10, mode: p.getGameMode(), stick: p.inputInfo.getMovementVector() }));
  if (rel.x > 6) test.succeed(); else test.fail("walked to " + rel.x);
}).maxTicks(200).tag("t_tag");`));
    const def = sim.gametests.find('t:probe')!;
    expect(def.settings).toMatchObject({ maxTicks: 200, tags: ['t_tag'] });
    const r = await runGametest(sim, def);
    expect(r.status).toBe('pass');
    const line = parseCmgt(r.lines.join('\n'))[0]!;
    // Test-relative movement (as the Pixel measured), the game mode it was spawned in, and a stick that never reaches inputInfo.
    expect(line.data).toMatchObject({ mode: 'Survival', stick: { x: 0, y: 0 } });
    expect(Number(line.data!['x'])).toBeGreaterThan(6);
  });

  it('times out a test that never decides, and fails one that says so', async () => {
    const sim = new Simulation();
    sim.loadAddon(probePack(`gt.registerAsync("t", "slow", async (test) => { await test.idle(500); test.succeed(); }).maxTicks(30);
gt.registerAsync("t", "bad", async (test) => { test.fail("no"); });`));
    expect((await runGametest(sim, sim.gametests.find('t:slow')!)).status).toBe('timeout');
    expect(await runGametest(sim, sim.gametests.find('t:bad')!)).toMatchObject({ status: 'fail', message: 'no' });
  });

  it('a simulated player\'s interactWithEntity mounts a seat but raises nothing on a non-rideable entity; isSneaking is no sneak', async () => {
    const entity = (id: string, components: Record<string, unknown>) => ({ format_version: '1.26.30', 'minecraft:entity': { description: { identifier: id }, components } });
    const sim = new Simulation();
    sim.loadAddon(probePack(`let events = 0;
mc.world.afterEvents.playerInteractWithEntity.subscribe(() => { events++; });
gt.registerAsync("t", "seat", async (test) => {
  const p = test.spawnSimulatedPlayer({ x: 1.5, y: 1, z: 1.5 }, "cmgt_s");
  const leaf = test.spawn("t:leaf", { x: 2.5, y: 1, z: 1.5 });
  const seat = test.spawn("t:seat", { x: 1.5, y: 1, z: 2.5 });
  await test.idle(3);
  const leafReturned = p.interactWithEntity(leaf);
  const leafEvents = events;
  p.interactWithEntity(seat);
  await test.idle(2);
  const riding = !!p.getComponent("minecraft:riding");
  p.isSneaking = true;
  await test.idle(3);
  console.warn("CMGT SEATPROBE " + JSON.stringify({ leafReturned, leafEvents, riding, stillRiding: !!p.getComponent("minecraft:riding"), sneaking: p.isSneaking }));
  test.succeed();
}).maxTicks(100);`, {
      'entities/leaf.json': entity('t:leaf', { 'minecraft:collision_box': { width: 1, height: 1 }, 'minecraft:interact': { interactions: [{ interact_text: 'open' }] } }),
      'entities/seat.json': entity('t:seat', { 'minecraft:collision_box': { width: 1, height: 0.5 }, 'minecraft:rideable': { seat_count: 1, family_types: ['player'], seats: { position: [0, 0.3, 0] } } }),
    }));
    const r = await runGametest(sim, sim.gametests.find('t:seat')!);
    expect(r.status).toBe('pass');
    expect(parseCmgt(r.lines.join('\n'))[0]!.data).toEqual({ leafReturned: true, leafEvents: 0, riding: true, stillRiding: true, sneaking: true });
  });

  it('runs the shipped GameTest runtime itself: the smoke test walks a simulated player on its arena', async () => {
    const plan: GametestPlan = { modelId: 'probe', label: 'Probe', dims: { width: 6, height: 4, length: 6 }, actorTypes: [], angleProperty: 'craftmatic:angle', doorways: [] };
    const sim = new Simulation();
    sim.loadAddon(probePack('', {
      'scripts/main.js': gametestScript(plan),
    }));
    // The arena structure is the variant's (`buildArenaStructure`); without it the smoke test reads its floor from the flat world.
    const def = sim.gametests.find('craftmatic_gt:smoke')!;
    expect(def).toBeDefined();
    const r = await runGametest(sim, def);
    const smoke = parseCmgt(r.lines.join('\n')).find(l => l.tag === 'SMOKE');
    expect(smoke?.data?.['movedHorizontally']).toBeGreaterThan(2);
    expect(r.status).toBe('pass');
  });
});

describe('the device-log replay', () => {
  const device = [
    '21:45:34[Scripting][warning]-CMGT DOOR {"label":"Door 1","angleClosed":0,"closed":{"outcome":"blocked"},"angleAfterInteract":0,"angleAfterAttack":-90,"open":{"outcome":"passed"},"pass":true}',
    '21:45:35[Scripting][warning]-CMGT_PAD 0 xxxx',
    '21:45:36[Scripting][warning]-CMGT QTP {"layout":"wide","mat":"stone","d":0.34,"method":"script","who":"player","samples":[[0,0,0,0],[40,0,-0.34,0]]}',
  ].join('\n');

  it('reads the verdict rows of a content log and compares them field by field', () => {
    const lines = parseCmgt(device);
    expect(lines.map(l => l.tag)).toEqual(['DOOR', 'QTP']);
    expect(isQuirkLog(lines)).toBe(true);
    const rows = verdictRows(lines);
    expect(rows[0]).toEqual({ tag: 'DOOR', key: 'Door 1', fields: { closed: '"blocked"', open: '"passed"', opensBy: 'hit', pass: 'true' } });
    const sim = verdictRows(parseCmgt(device.replace('"angleAfterInteract":0', '"angleAfterInteract":-90')));
    const diffs = compareRows(rows, sim);
    expect(diffs.filter(d => !d.match).map(d => `${d.key}.${d.field}`)).toEqual(['Door 1.opensBy']);
    expect(compareRows(rows, [])[0]!.sim).toBe('missing');
  });

  const run5 = 'C:/git/craftmatic/output/gametest/41732-run5';
  it.skipIf(!existsSync(`${run5}/41732-downtown-gametest.mcaddon`))('re-derives every verdict of the Pixel\'s 41732 doors run 5 (corpus)', async () => {
    const b = readFileSync(`${run5}/41732-downtown-gametest.mcaddon`);
    const load = () => readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, 'run5');
    const sim = new Simulation();
    sim.loadAddon(await load());
    await sim.run(20);
    const r = await runGametest(sim, sim.gametests.find('craftmatic_gt:doors_downtown_41732')!);
    const diffs = compareRows(verdictRows(parseCmgt(readFileSync(`${run5}/device/contentlog-run5.txt`, 'utf8'))), verdictRows(parseCmgt(r.lines.join('\n'))));
    expect(diffs.length).toBeGreaterThan(20);
    expect(diffs.filter(d => !d.match)).toEqual([]);
  }, 120000);
});
