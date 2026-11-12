/**
 * The rider's view at the crest of a generated coaster (WP-C02): place the pack on the simulator, board its lead train,
 * ride to the top of the highest climb and take the picture the Pixel client would draw from the seat, looking along
 * the track over the drop.
 *
 *   bun scripts/_coaster_crest_view.ts <pack.mcaddon> <out-dir> [--client=pixel|saga] [--width=1280] [--height=720]
 *
 * Writes `<out-dir>/crest-view.png` (each side under 2000 px) and `crest-view.json` (the camera and what was drawn).
 * It is a SIMULATED picture: the client's draw distance, cull and box-UV rules are modelled, not measured on a phone.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';
import { CORE_HANDLERS } from '../web/src/sim/scenario/runner.ts';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { attachClient, clientProfile, type ClientProfileName } from '../web/src/sim/client/camera.ts';
import { clientInvariants } from '../web/src/sim/client/invariants.ts';
import { clientSteps, craftmaticSeatCamera, type ClientShot } from '../web/src/sim/adapters/craftmatic/client-steps.ts';
import { packAppearance } from '../web/src/sim/adapters/craftmatic/drawn.ts';
import { packFamily } from '../web/src/sim/adapters/craftmatic/namespace.ts';
import { packText } from '../web/src/sim/pack/pack.ts';
import { coasterScriptConfig } from '../web/src/sim/adapters/craftmatic/coaster.ts';
import { teleport } from '../web/src/sim/script-host/facades.ts';
import type { Step, StepContext } from '../web/src/sim/scenario/types.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const [file, outDir] = args.filter(a => !a.startsWith('--'));
if (!file || !outDir) { console.error('usage: bun scripts/_coaster_crest_view.ts <pack.mcaddon> <out-dir> [--client=pixel|saga] [--width=] [--height=]'); process.exit(2); }
const profile = (flag('client') ?? 'pixel') as ClientProfileName;
const width = Math.min(1999, Number(flag('width') ?? 1280)), height = Math.min(1999, Number(flag('height') ?? 720));

const bytes = readFileSync(file);
const addon = await readAddon(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, file);
const pack = readCraftmaticPack(addon);
if (!pack) { console.error('not a craftmatic pack'); process.exit(1); }
const config = coasterScriptConfig(packText(pack.pack, 'scripts/coaster.js')!);
const route = config.routes[0]!;
const family = packFamily(pack.namespace, 'coaster');
// The crest: the route's highest sample, in the model frame; the ride stops when the lead car's height is within a block of it.
const crestY = Math.max(...route.path.points.map(p => p[1]));

const ride = async (ctx: StepContext): Promise<string | undefined> => {
  const front = [...ctx.sim.engine.entities.values()].find(e => e.valid && e.families().includes(family) && e.dynamic.get('craftmatic:coaster_car') === 0);
  if (!front) return 'no lead car';
  teleport(ctx.sim.host, ctx.player, { x: front.location.x + 3, y: front.location.y + 1, z: front.location.z });
  await ctx.run(10);
  await CORE_HANDLERS['hold']!({ kind: 'hold', target: { family, where: e => e === front }, label: 'board the lead train' }, ctx);
  if (ctx.player.ridingOn !== front) return 'the hold did not seat the child';
  // World height = the pin's + the route's: read the pin's height off the car's own arc on the route.
  const arcAt = Number(front.dynamic.get('craftmatic:coaster_distance'));
  let i = 0; while (i < route.path.cumulative.length - 2 && route.path.cumulative[i + 1]! < arcAt) i++;
  const pinY = front.location.y - route.path.points[i]![1];
  let prev = { ...front.location };
  for (let t = 0; t < 20_000 && ctx.player.ridingOn === front; t++) {
    await ctx.run(1);
    const p = front.location;
    if (p.y >= pinY + crestY - 1) {
      // At the top: look along the direction of travel, a little below the horizon (over the lip of the drop).
      const dx = p.x - prev.x, dz = p.z - prev.z;
      if (Math.hypot(dx, dz) > 1e-4) ctx.player.rotation = { x: 8, y: Math.atan2(-dx, dz) * 180 / Math.PI };
      ctx.state['crestAt'] = { x: p.x, y: p.y, z: p.z, tick: t, speed: front.dynamic.get('craftmatic:coaster_speed') };
      return undefined;
    }
    prev = { ...p };
  }
  return 'the car never reached the crest';
};

const steps: Step[] = [
  { kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 },
  { kind: 'expect', label: 'ride-to-crest', check: ride },
  { kind: 'wait', ticks: 2 },
  { kind: 'snapshot', here: true, name: 'crest-view', width, height },
];
const r = await runScenario({ name: 'crest-view', steps }, [addon], {
  handlers: { ...craftmaticHandlers(pack, addon), ...clientSteps(pack, packAppearance(addon), { lod: true }, profile) },
  invariants: clientInvariants({ seatCamera: craftmaticSeatCamera() }),
  prepare: (sim, player) => { attachClient(sim, player, clientProfile(profile)); },
});
console.log(`${basename(file)}: ${r.status}, ${r.violations.length} violation(s), ${r.ticks} ticks`);
for (const v of r.violations.slice(0, 6)) console.log(`  [${v.invariant}] ${v.message.slice(0, 200)}`);
for (const s of r.steps.filter(x => !x.ok)) console.log(`  step ${s.label} ERROR: ${s.error}`);
const shot = ((r.state['snapshots'] as ClientShot[] | undefined) ?? []).find(s => s.name === 'crest-view');
if (!shot) { console.error('no picture was taken'); process.exit(1); }
mkdirSync(outDir, { recursive: true });
await sharp(Buffer.from(shot.rgb), { raw: { width: shot.width, height: shot.height, channels: 3 } }).png().toFile(join(outDir, 'crest-view.png'));
writeFileSync(join(outDir, 'crest-view.json'), JSON.stringify({ pack: basename(file), client: profile, crestRouteY: crestY, at: r.state['crestAt'], camera: shot.camera, metrics: shot.metrics, simulated: true }, null, 1));
console.log(`picture ${shot.width}x${shot.height} at ${JSON.stringify(r.state['crestAt'])}, camera ${JSON.stringify(shot.camera)}`);
