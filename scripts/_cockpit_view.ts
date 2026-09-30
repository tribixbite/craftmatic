/**
 * The DRIVER'S VIEW of every vehicle in a built pack, offline: place the
 * model in the headless simulator, mount each vehicle as a child does (a
 * hold), and report where the rider's eye is against what the vehicle
 * DRAWS - the horizon-ahead rays the `driver-sees-ahead` invariant judges
 * (`AHEAD`, cockpit-seat.ts), the wider `VIEW` fan, the eye in the vehicle's
 * own frame, how many opaque drawn cubes hold the eye - and render the
 * first-person picture to a PNG (`<dir>/cockpit-view.json` collects the
 * rows). The hotbar-9 cockpit view on
 * the device is this picture (the rider's own first person, looking along
 * the vehicle's heading).
 *
 * Usage: bun scripts/_cockpit_view.ts <pack.mcaddon>... --out=<dir> [--size=100] [--rotation=0]
 *          [--pitch=0]   look down (+) or up (-) from level, degrees (Bedrock's pitch sign)
 *          [--shift=x,y,z]   move the eye from where the seat put it (vehicle frame, +z the nose) to compare a candidate
 *          [--tag=cockpit]   the picture's name suffix
 *
 * The picture uses `firstPersonSnapshot` (70 degree field, the rasterizer of
 * `_pack_render.ts`); it shows the geometry, not Bedrock's lighting.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';
import { childPlay } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { CRAFTMATIC_ALLOWED_LINES } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { entityDrawn, forwardViewWorld, packAppearance } from '../web/src/sim/adapters/craftmatic/drawn.ts';
import { firstPersonSnapshot } from '../web/src/sim/adapters/craftmatic/snapshot.ts';
import { AHEAD, VIEW } from '../web/src/engine/cockpit-seat.ts';
import type { StepContext } from '../web/src/sim/scenario/types.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const files = args.filter(a => !a.startsWith('--'));
const outDir = flag('out');
if (!files.length || !outDir) { console.error('usage: bun scripts/_cockpit_view.ts <pack.mcaddon>... --out=<dir> [--size=100] [--rotation=0] [--pitch=0]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const size = Number(flag('size') ?? 100), rotation = Number(flag('rotation') ?? 0) as 0 | 90, pitch = Number(flag('pitch') ?? 0);
const shift = (flag('shift') ?? '0,0,0').split(',').map(Number);
const tag = flag('tag') ?? 'cockpit';
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

const report: Array<Record<string, unknown>> = [];
for (const file of files) {
  const b = readFileSync(file);
  const load = (): Promise<Awaited<ReturnType<typeof readAddon>>> => readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
  const addon = await load();
  const cp = childPlay(addon);
  if (!cp) { console.log(`${basename(file)}: not a craftmatic pack`); continue; }
  const appearance = packAppearance(addon);
  for (const type of cp.pack.vehicleTypes) {
    const handlers = {
      ...cp.handlers,
      /** Face the vehicle's heading, measure the eye, take the picture. */
      async cockpit(_step: unknown, ctx: StepContext) {
        const v = ctx.player.ridingOn;
        if (!v) { ctx.note('not riding'); return; }
        ctx.player.rotation.y = v.rotation.y;
        ctx.player.rotation.x = pitch;
        await ctx.run(1);
        if (shift.some(s => s !== 0)) {
          // A candidate eye: the rider moved by `--shift` in the vehicle's frame (+x as the seat's x, +z its nose), after the seat placed it.
          const a = v.rotation.y * Math.PI / 180;
          ctx.player.location = { x: ctx.player.location.x + shift[0]! * Math.cos(a) - shift[2]! * Math.sin(a), y: ctx.player.location.y + shift[1]!, z: ctx.player.location.z + shift[0]! * Math.sin(a) + shift[2]! * Math.cos(a) };
        }
        const drawn = entityDrawn(appearance, v) ?? [];
        const eye = ctx.player.headLocation();
        const view = forwardViewWorld(drawn, eye, v.rotation.y, VIEW);
        const ahead = forwardViewWorld(drawn, eye, v.rotation.y, AHEAD);
        const inside = drawn.filter(d => !d.glass && eye.x >= d.box.x0 && eye.x <= d.box.x1 && eye.y >= d.box.y0 && eye.y <= d.box.y1 && eye.z >= d.box.z0 && eye.z <= d.box.z1);
        const lo = { x: Math.min(...drawn.map(d => d.box.x0)), y: Math.min(...drawn.map(d => d.box.y0)), z: Math.min(...drawn.map(d => d.box.z0)) };
        const hi = { x: Math.max(...drawn.map(d => d.box.x1)), y: Math.max(...drawn.map(d => d.box.y1)), z: Math.max(...drawn.map(d => d.box.z1)) };
        const rgb = firstPersonSnapshot(ctx.sim.engine, appearance, ctx.player, { width: 960, height: 540 });
        const png = join(outDir!, `${basename(file, '.mcaddon')}-${type.replace(/[^a-z0-9_]+/gi, '_')}-${tag}.png`);
        await sharp(Buffer.from(rgb), { raw: { width: 960, height: 540, channels: 3 } }).png().toFile(png);
        const row = {
          pack: basename(file), type, ahead: `${ahead.clear}/${ahead.total}`, view: `${view.clear}/${view.total}`, eye: [r3(eye.x), r3(eye.y), r3(eye.z)],
          vehicle: { at: [r3(v.location.x), r3(v.location.y), r3(v.location.z)], yaw: r3(v.rotation.y) },
          // The eye relative to the vehicle's origin, turned into the vehicle's own frame (+z = its nose, Bedrock seat frame).
          eyeInVehicle: (() => { const a = v.rotation.y * Math.PI / 180, dx = eye.x - v.location.x, dz = eye.z - v.location.z; return [r3(dx * Math.cos(a) + dz * Math.sin(a)), r3(eye.y - v.location.y), r3(-dx * Math.sin(a) + dz * Math.cos(a))]; })(),
          drawnBounds: { lo: [r3(lo.x), r3(lo.y), r3(lo.z)], hi: [r3(hi.x), r3(hi.y), r3(hi.z)] },
          eyeInsideOpaqueCubes: inside.length, png,
        };
        ctx.state['cockpit'] = row;
      },
    };
    const r = await runScenario({
      name: `cockpit-${type}`,
      steps: [{ kind: 'place', size, rotation }, { kind: 'wait', ticks: 40 }, { kind: 'hold', target: { type } }, { kind: 'wait', ticks: 5 }, { kind: 'cockpit' } as never],
      allowLines: [...CRAFTMATIC_ALLOWED_LINES],
    }, [await load()], { handlers: handlers as never });
    const row = (r.state['cockpit'] as Record<string, unknown> | undefined) ?? { pack: basename(file), type, error: r.steps.filter(s => !s.ok).map(s => `${s.label}: ${s.error}`).join('; ') || r.notes.join('; ') };
    report.push(row);
    console.log(JSON.stringify(row));
  }
}
writeFileSync(join(outDir, 'cockpit-view.json'), JSON.stringify(report, null, 1));
