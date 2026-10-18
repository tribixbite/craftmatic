/**
 * How many block probes the swept-footprint collision test costs per tick
 * (bedrock-vehicle.ts `sweepFootprint`, docs/physics-architecture.md §4.6),
 * for fixed, representative moves of real pack footprints in open air (a clear
 * move is exactly one sweep in `resolveMove`, so this is the per-tick count the
 * runtime's `sweepChecks` telemetry reports).
 *
 * The Pixel measured ~890 probes at 20-24 ms of a 50 ms tick (a 36-block barge,
 * 2026-09-25), so the count is a cost the device pays every tick a vehicle moves.
 *
 * Usage:
 *   bun scripts/_sweep_checks.ts [--impl=<bedrock-vehicle.ts>]… [--json=<out>]
 * Each `--impl` is a copy of bedrock-vehicle.ts (an older commit's, say: `git show <sha>:web/src/engine/bedrock-vehicle.ts`);
 * its `sweepFootprint` and `FOOTPRINT` are read from the text and transpiled, so
 * implementations of different commits are compared on identical moves. With
 * none, the current tree's file is measured.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One implementation: its sweep and its parameters. */
interface Impl { name: string; sweep: (from: Pose, to: Pose, fp: Fp, solid: (x: number, y: number, z: number) => boolean, P: Record<string, number>) => { blocked: boolean; checks: number }; P: Record<string, number> }
interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }
interface Fp { halfLength: number; halfWidth: number; lo: number; hi: number }

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const impls = args.filter(a => a.startsWith('--impl=')).map(a => a.slice(7));
if (!impls.length) impls.push(fileURLToPath(new URL('../web/src/engine/bedrock-vehicle.ts', import.meta.url)));

const transpiler = new Bun.Transpiler({ loader: 'ts' });
/** Read `sweepFootprint` and `FOOTPRINT` out of a bedrock-vehicle.ts text (both are self-contained by design: the runtime serialises them). */
const loadImpl = (file: string): Impl => {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('export function sweepFootprint(');
  const end = text.indexOf('\n}\n', start);
  const fpMatch = /export const FOOTPRINT = (\{[^}]*\}) as const;/.exec(text);
  if (start < 0 || end < 0 || !fpMatch) throw new Error(`${file}: no sweepFootprint / FOOTPRINT`);
  const js = transpiler.transformSync(`${text.slice(start + 'export '.length, end + 2)}\nexport { sweepFootprint };`);
  const body = js.replace(/export\s*\{[^}]*\};?/, '');
  const sweep = new Function(`${body}\nreturn sweepFootprint;`)() as Impl['sweep'];
  return { name: file.replace(/^.*[\\/]/, ''), sweep, P: new Function(`return ${fpMatch[1]};`)() as Record<string, number> };
};

// Footprints exactly as the runtime builds them (`scriptedVehicleRuntime`): a ship's band from 0.1 to its
// height less 0.1, a car's from `STEP_UP + 0.05` to its height less 0.1. Sizes are the shipped packs'
// vehicles.js CONFIG (76286 the Milano: noseReach 8.02, halfWidth 15, height 8.48; 42172: 3.49, 2.24, 1.79;
// car STEP_UP 1.05; ship MAX_SPEED 18 blocks/s, car MAX_SPEED 19 blocks/s).
const milano = (k: number): Fp => ({ halfLength: 8.02 * k, halfWidth: 15 * k, lo: 0.1, hi: Math.max(0.2, 8.48 * k - 0.1) });
const car: Fp = { halfLength: 3.49, halfWidth: 2.24, lo: 1.05 + 0.05, hi: Math.max(1.15, 1.79 - 0.1) };
const at: Pose = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0 };
/** Forward along +z (yaw 0) by `d` blocks with a vertical change and pitch. */
const move = (d: number, dy: number, pitch0 = 0, pitch1 = pitch0, dyaw = 0): [Pose, Pose] => [{ ...at, pitch: pitch0 }, { ...at, z: at.z + d, y: at.y + dy, yaw: dyaw, pitch: pitch1 }];
const CASES: Array<{ id: string; fp: Fp; poses: [Pose, Pose] }> = [
  { id: 'milano-cruise-level', fp: milano(1), poses: move(0.9, 0) },
  { id: 'milano-cruise-climbing', fp: milano(1), poses: move(0.9, 0.05, 2, 2.1) },
  { id: 'milano-cruise-descending', fp: milano(1), poses: move(0.9, -0.05, -2, -2.1) },
  { id: 'milano-cruise-turning', fp: milano(1), poses: move(0.9, 0, 0, 0, 4) },
  { id: 'milano-2x-cruise-climbing', fp: milano(2), poses: move(1.8, 0.1, 2, 2.1) },
  { id: 'milano-hover-sink', fp: milano(1), poses: move(0, -0.15) },
  { id: 'car-level', fp: car, poses: move(0.95, 0) },
  { id: 'car-descending-hill', fp: car, poses: move(0.5, -0.1) },
  { id: 'car-falling', fp: car, poses: move(0, -0.4) },
];

const open = (): boolean => false;
const loaded = impls.map(loadImpl);
const rows = CASES.map(c => ({ id: c.id, checks: Object.fromEntries(loaded.map(i => [i.name, i.sweep(c.poses[0], c.poses[1], c.fp, open, i.P).checks])) }));
console.log(`| case | ${loaded.map(i => i.name).join(' | ')} |\n|---|${loaded.map(() => '---:').join('|')}|`);
for (const r of rows) console.log(`| ${r.id} | ${loaded.map(i => r.checks[i.name]).join(' | ')} |`);
if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(rows, null, 1));
