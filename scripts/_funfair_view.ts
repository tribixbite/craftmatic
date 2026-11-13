/**
 * Renders what a rider of a funfair pack sees, offline (BIZ-20): the drop tower's seat at the top of its mast and the
 * sky swing's seat at full extension, through `_pack_render.ts` (the simulator's rasteriser over the pack's own
 * geometry), with the ride's ring carried to its pose by `--lift`. The pose comes from the SAME profile the pack runs
 * (`funfairKit`, with the constants the pack shipped), the seat from its own `ridePath`.
 *
 *   bun scripts/_funfair_view.ts <pack.mcaddon> <out dir> [--size=100]
 *
 * Writes `<out>/<kind>-rider-top.png` (the drop: out over the ring's edge, down), `<out>/<kind>-rider-full.png` (the
 * swing at full extension: along the chain's swing), `<out>/<kind>-overview.png` (the whole ride in its pose), 1280 x 720.
 * The rider's eye is `EYE_ABOVE_SEAT` over the seat (measured on the device, quirk `rider-eye-above-seat`).
 */
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { funfairKit, type FunfairConstants } from '../web/src/engine/rides/funfair-physics.js';

const EYE_ABOVE_SEAT = 1.12;
const [pack, outDir] = process.argv.slice(2);
if (!pack || !outDir) throw new Error('usage: bun scripts/_funfair_view.ts <pack.mcaddon> <out dir> [--size=100]');
const sizePct = Number(process.argv.find(a => a.startsWith('--size='))?.slice('--size='.length) ?? 100);
const f = sizePct / 100;
mkdirSync(outDir, { recursive: true });

const bytes = readFileSync(pack);
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const entries = listZipEntries(buffer);
const text = async (name: string): Promise<string> => new TextDecoder().decode(await extractFile(buffer, name));
const bp = entries.find(e => e.endsWith('_BP/manifest.json'))!.replace('manifest.json', '');
const configOf = async (script: string): Promise<any> => JSON.parse(/^const CONFIG = (\{.*\});$/m.exec(await text(`${bp}scripts/${script}`))![1]!);
const placement = await configOf('placement.js'), funfair = await configOf('rides-funfair.js');
const ride = funfair.rides[0] as { kind: 'drop' | 'swing'; carType?: string };
const seats = (placement.actors as any[]).filter(a => a.typeId === funfair.seatType);
const lead = seats[0]!.ridePath as number[][];
const [foot, top, axis] = [lead[0]!, lead[1]!, lead[2]!];
const r0 = Math.hypot(foot[0]! - axis[0]!, foot[2]! - axis[2]!) * f, height = (top[1]! - foot[1]!) * f;
const kit = funfairKit(funfair.constants as FunfairConstants);
const trip = ride.kind === 'drop' ? kit.drop(height, f) : kit.swing(height, r0, f);

/** The first moment of `phase`'s second half: the drop's hold at the top, the swing's full speed. */
const phase = ride.kind === 'drop' ? 'hold' : 'full';
let t = 0;
while (trip.at(t).phase !== phase && t < trip.duration) t += 0.05;
const state = trip.at(t + 1);
const phi0 = Math.atan2(foot[2]! - axis[2]!, foot[0]! - axis[0]!), phi = phi0 + state.turn;
const radius = r0 + state.out;
// World-frame blocks from the placement corner, as `_pack_render` draws (every length times the wand factor).
const A = [axis[0]! * f, axis[2]! * f] as const;
const seat: [number, number, number] = ride.kind === 'drop' ? [foot[0]! * f, foot[1]! * f + state.rise, foot[2]! * f] : [A[0] + radius * Math.cos(phi), foot[1]! * f + state.rise - state.sag, A[1] + radius * Math.sin(phi)];
const eye: [number, number, number] = [seat[0], seat[1] + EYE_ABOVE_SEAT, seat[2]];
// A drop's rider faces outward; a swing's along the way it travels.
const heading: [number, number] = ride.kind === 'drop' ? [Math.cos(phi0), Math.sin(phi0)] : [-Math.sin(phi), Math.cos(phi)];
/** A point `d` blocks along `heading` from the eye, `slope` blocks down per block (the view direction's pitch). */
const at = (d: number, slope: number, dir: readonly [number, number] = heading): [number, number, number] => [eye[0] + dir[0] * d, eye[1] - slope * d, eye[2] + dir[1] * d];
const lift = `--lift=${ride.carType!.split(':').pop()}:${state.rise}${ride.kind === 'swing' ? `:${(state.turn * 180 / Math.PI) % 360}` : ''}`;
const common = ['--size=' + sizePct, '--image=1280x720', '--uvfloor=v', lift];
const render = (name: string, args: string[]): void => {
  const out = join(outDir, `${ride.kind}-${name}.png`);
  const r = Bun.spawnSync(['bun', 'scripts/_pack_render.ts', pack, `--out=${out}`, ...common, ...args], { stdout: 'pipe', stderr: 'pipe' });
  console.log(new TextDecoder().decode(r.stdout).trim().split('\n').pop(), r.exitCode === 0 ? '' : new TextDecoder().decode(r.stderr));
};
console.log(`${ride.kind}: t ${t.toFixed(1)} s of ${trip.duration.toFixed(1)}, phase ${state.phase}, rise ${state.rise.toFixed(1)}, out ${state.out.toFixed(2)}, tilt ${(state.tilt * 180 / Math.PI).toFixed(1)} deg, seat ${seat.map(v => v.toFixed(2))}`);
// The rider's view. The simulator draws no terrain or sky, so what shows is the ride itself: along the ring (the
// neighbouring seats, its arms, the mast) and straight down (the base, the whole drop under the rider).
const tangent: [number, number] = [-Math.sin(phi), Math.cos(phi)];
render(ride.kind === 'drop' ? 'rider-top' : 'rider-full', [`--eye=${eye.join(',')}`, `--at=${at(30, 0.25, tangent).join(',')}`, '--fov=75']);
render('rider-down', [`--eye=${eye.join(',')}`, `--at=${at(3, 12).join(',')}`, '--fov=75']);
// The overview: from a point off the ride at the ring's height, looking at it, the whole mast in frame.
const cx = A[0], cz = A[1];
render('overview', [`--eye=${cx + 26 * f},${eye[1] - 16 * f},${cz + 26 * f}`, `--at=${cx},${eye[1] - 2 * f},${cz}`, '--fov=80']);
