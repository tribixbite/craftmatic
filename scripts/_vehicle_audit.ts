/**
 * Vehicle audit: export each set the way the LEGO tab does (the set's NAME in
 * the label, `Name (set-1)`, because the vehicle classifier reads the title),
 * then read back out of the pack what the vehicle pipeline decided for every
 * rideable entity: its kind (car / plane / boat), nose and the votes behind
 * it, seats, wheels and wheel bones, collision box, movement, size and the
 * chase camera. A set with no rideable entity is reported as `static`.
 *
 * `_favorites_export_sweep.ts` labels a pack with the bare set NUMBER, which
 * no vehicle word matches, so it never exercises the vehicle path at all —
 * this is the sweep that does.
 *
 * Usage: bun scripts/_vehicle_audit.ts [set…] [--out DIR] [--keep] [--md] [--seats]
 *   no sets: the 40 favourites plus the vehicle-heavy extras below.
 *   --keep  reuse DIR/<set>.mcaddon + DIR/<set>.json when present.
 *   --mirror=<url>  part mirror for _playable_ref.ts (e.g. a running dev server's /ldraw-parts).
 *   --md    print the markdown table (docs/bedrock-addon-guide.md, "Vehicle audit").
 *   --seats print the seat table (docs/bedrock-addon-guide.md, "Where the player sits"): the
 *           cockpit evidence, the driver's eye, the shipped seat, its offset from the cockpit
 *           seat (eye - RIDER_EYE_ABOVE_SEAT) and the wand size from which a player's body fits (cockpit-seat.ts).
 * Output: DIR/<set>.mcaddon, DIR/<set>.json (the export report), DIR/audit.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.ts';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { RIDER_EYE_ABOVE_SEAT } from '../web/src/engine/cockpit-seat.ts';
import { FAVOURITES } from './favourite-sets.ts';
import { drawnCubeBox } from '../web/src/engine/bedrock-geometry-faces.ts';

const INDEX = 'C:/git/clego/lego-models-index.json';
const CORPUS = 'C:/git/clego/lego_sets';

export { FAVOURITES };
/** Vehicle-heavy sets beside the favourites: cars, trucks, trains, boats, ships, planes, helicopters, a spaceship. */
export const VEHICLE_EXTRAS = [
  '10295', '42143', '76139', '10242', '75892', '42128', '60253',
  '10277', '60198',
  '31109', '60266', '60221', '6286', '70618',
  '60367', '42066', '7140', '75301', '42092', '60405', '10497',
];

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const OUT = outIndex >= 0 ? argv[outIndex + 1]! : 'output/vehicle-audit';
const KEEP = argv.includes('--keep');
const MD = argv.includes('--md');
const SEATS = argv.includes('--seats');
/** `--mirror=<url>`: passed to `_playable_ref.ts` (the prod part mirror throttles parallel exports). */
const MIRROR = argv.find(a => a.startsWith('--mirror='));
const targets = argv.filter((a, i) => !a.startsWith('--') && !(outIndex >= 0 && i === outIndex + 1));
const sets = (JSON.parse(readFileSync(INDEX, 'utf8')) as {
  sets: Record<string, { name?: string; models?: IndexModel[]; parts?: number; catalogParts?: number }>;
}).sets;
mkdirSync(OUT, { recursive: true });

/** One rideable entity as the pack ships it. */
export interface VehicleRow {
  entity: string;
  role: 'main' | 'extra';
  /** `hover`: a hover craft (family `hover`, whatever its geometry kind). */
  kind: 'car' | 'plane' | 'boat' | 'hover';
  /** Nose in the LDraw frame and how it was decided (`vehicle-facing.ts`). */
  nose: string | null; noseSource: string | null; agreement: number | null; votes: string[];
  seats: number; seat: number[] | null;
  cockpit: string | null;
  /** The driver's EYE the compiler found (blocks, entity frame before the JSON X mirror) and the evidence detail. */
  cockpitEye: [number, number, number] | null; cockpitDetail: string | null;
  /** Every seat position the pack ships (driver first). */
  seatPositions: number[][];
  /** The compiler's seat plan (`seatPlan` diagnostics), when the pack carries one. */
  seatPlan: unknown;
  /** Wheel/tyre placements the compiler found, and how many became spinning wheel bones. */
  wheels: number | null; wheelBones: number | null;
  collision: { width: number; height: number } | null;
  size: { width: number; height: number; length: number } | null;
  movement: number | null;
  /** Native components that define how it drives. */
  controls: string[];
  cameraRadius: number | null;
  animations: string[];
}
export interface AuditRow {
  set: string; name: string; label: string; src: string;
  ok: boolean; error?: string; seconds: number;
  scale: number | null; scaleCue: string | null;
  components: Array<{ id: string; kind: string; provenance: string }>;
  vehicles: VehicleRow[];
  sha256: string | null;
}

const rows: AuditRow[] = [];
const list = targets.length ? targets : [...FAVOURITES, ...VEHICLE_EXTRAS];
for (const set of list) {
  const entry = sets[set];
  if (!entry?.models?.length) { console.log(`${set}: not in index`); continue; }
  const model = entry.models[indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts)[0]!]!;
  const file = `${CORPUS}/${model.path}`;
  // The LEGO tab's label (ui/lego.ts `exportLabel`): the set's name and number.
  const label = `${entry.name ?? set} (${set}-1)`;
  const pack = `${OUT}/${set}.mcaddon`, reportPath = `${OUT}/${set}.json`;
  const row: AuditRow = { set, name: entry.name ?? '', label, src: model.path, ok: false, seconds: 0, scale: null, scaleCue: null, components: [], vehicles: [], sha256: null };
  if (!existsSync(file)) { row.error = `source missing: ${file}`; rows.push(row); console.log(`${set}: ${row.error}`); continue; }
  const started = Date.now();
  if (!(KEEP && existsSync(pack) && existsSync(reportPath))) {
    // No `shell: true`: a first-pick path may contain spaces (see _favorites_export_sweep.ts).
    const run = spawnSync('bun', ['scripts/_playable_ref.ts', file, pack, `--label=${label}`, ...(MIRROR ? [MIRROR] : [])], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (run.status !== 0 || !existsSync(pack)) {
      row.error = (run.stderr || run.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
      row.seconds = Math.round((Date.now() - started) / 100) / 10;
      rows.push(row); console.log(`${set}: EXPORT FAILED ${row.error}`); continue;
    }
    writeFileSync(reportPath, run.stdout);
  }
  row.seconds = Math.round((Date.now() - started) / 100) / 10;
  const text = readFileSync(reportPath, 'utf8');
  const report = JSON.parse(text.slice(text.indexOf('{'))) as {
    scale?: { scale: number; cue?: string }; components?: Array<{ id: string; kind: string; provenance: string }>;
    entities?: Record<string, any>; sha256?: string;
  };
  row.ok = true;
  row.scale = report.scale?.scale ?? null;
  row.scaleCue = report.scale?.cue ?? null;
  row.components = (report.components ?? []).map(c => ({ id: c.id, kind: c.kind, provenance: c.provenance }));
  row.sha256 = report.sha256 ?? null;
  row.vehicles = await packVehicles(readFileSync(pack), report.entities ?? {});
  rows.push(row);
  const v = row.vehicles;
  console.log(`${set}: ${v.length ? v.map(x => `${x.kind}${x.role === 'extra' ? '(extra)' : ''} nose ${x.nose}/${x.noseSource} seats ${x.seats} wheels ${x.wheels ?? '-'}/${x.wheelBones ?? '-'} box ${x.collision?.width}x${x.collision?.height}`).join('; ') : 'static'}  (${row.seconds}s)`);
}

writeFileSync(`${OUT}/audit.json`, JSON.stringify({ rows }, null, 1));
console.log(`\nwrote ${OUT}/audit.json (${rows.filter(r => r.ok).length}/${rows.length} exported)`);
if (MD) console.log(`\n${markdownTable(rows)}`);
if (SEATS) console.log(`\n${seatTable(rows)}`);

/** Every rideable (`craftmatic_vehicle`) entity in a pack, with the diagnostics the pack ships for it. */
async function packVehicles(bytes: Buffer, diagnostics: Record<string, any>): Promise<VehicleRow[]> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const files = await extractMatching(buffer, n => /_BP\/entities\/.*\.json$|_BP\/cameras\/presets\/.*\.json$|_RP\/entity\/.*\.entity\.json$|_RP\/models\/entity\/.*\.geo\.json$/.test(n));
  const read = (n: string): any => JSON.parse(new TextDecoder().decode(files.get(n)!).replace(/^\uFEFF/, ''));
  const out: VehicleRow[] = [];
  let first = true;
  for (const name of [...files.keys()].filter(n => /_BP\/entities\//.test(n)).sort()) {
    const ent = read(name)['minecraft:entity'];
    const c = ent?.components ?? {};
    const family: string[] = c['minecraft:type_family']?.family ?? [];
    if (!family.includes('craftmatic_vehicle')) continue;
    const id: string = ent.description.identifier;
    const cid = id.replace(/^[^:]*:/, '');
    const kind = (['hover', 'car', 'plane', 'boat'] as const).find(k => family.includes(k)) ?? 'car';
    const ride = c['minecraft:rideable'] ?? {};
    const seats = Array.isArray(ride.seats) ? ride.seats : ride.seats ? [ride.seats] : [];
    const d = diagnostics[cid] ?? null;
    const preset = [...files.keys()].find(n => n.endsWith(`/cameras/presets/${cid}_chase.json`));
    const client = [...files.keys()].find(n => n.endsWith(`/entity/${cid}.entity.json`));
    const anims = client ? Object.keys(read(client)['minecraft:client_entity']?.description?.animations ?? {}) : [];
    // Size from the shipped cubes of this entity's own geometries (not its LOD hull).
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const g of [...files.keys()].filter(n => new RegExp(`/models/entity/${cid}\\.geo\\.json$`).test(n))) {
      for (const geo of read(g)['minecraft:geometry'] ?? []) for (const bone of geo.bones ?? []) for (const cube of bone.cubes ?? []) {
        const { origin, size } = drawnCubeBox(cube);
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, origin[k]!); max[k] = Math.max(max[k]!, origin[k]! + size[k]!); }
      }
    }
    const size = Number.isFinite(min[0]) ? { width: r2((max[0]! - min[0]!) / 16), height: r2((max[1]! - min[1]!) / 16), length: r2((max[2]! - min[2]!) / 16) } : null;
    const controls = ['minecraft:input_ground_controlled', 'minecraft:free_camera_controlled', 'minecraft:dash_action', 'minecraft:buoyant', 'minecraft:can_fly', 'minecraft:underwater_movement', 'minecraft:behavior.float']
      .filter(k => k in c).map(k => k.replace('minecraft:', ''));
    out.push({
      entity: cid, role: first ? 'main' : 'extra', kind,
      nose: d?.facing?.nose ?? null, noseSource: d?.facing?.source ?? null, agreement: d?.facing?.agreement ?? null,
      votes: (d?.facing?.votes ?? []).map((v: any) => v.signal),
      seats: ride.seat_count ?? seats.length, seat: seats[0]?.position ?? null,
      cockpit: d?.cockpit?.source ?? null,
      cockpitEye: Array.isArray(d?.cockpit?.units) ? d.cockpit.units.map((u: number) => r2(u / 16)) as [number, number, number] : null,
      cockpitDetail: d?.cockpit?.detail ?? null,
      seatPositions: seats.map((s: any) => s?.position ?? null),
      seatPlan: d?.seatPlan ?? null,
      wheels: d?.wheels?.placements ?? null, wheelBones: d?.wheels?.bones?.length ?? null,
      collision: c['minecraft:collision_box'] ?? null, size,
      movement: c['minecraft:movement']?.value ?? null,
      controls,
      cameraRadius: preset ? read(preset)['minecraft:camera_preset']?.radius ?? null : null,
      animations: anims,
    });
    first = false;
  }
  return out;
}

function r2(v: number): number { return Math.round(v * 100) / 100; }

/** The guide's table: one line per set, the main vehicle first. */
export function markdownTable(all: AuditRow[]): string {
  const lines = [
    '| set | detected | nose (source, agreement) | seats | wheels / bones | size w×h×l | box w×h | camera r | scale |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of all) {
    if (!r.ok) { lines.push(`| ${r.set} ${r.name} | export failed | | | | | | | |`); continue; }
    if (!r.vehicles.length) { lines.push(`| ${r.set} ${r.name} | static | | | | | | | ${r.scale ?? ''} |`); continue; }
    const v = r.vehicles[0]!;
    const extra = r.vehicles.length > 1 ? ` +${r.vehicles.length - 1} extra ${[...new Set(r.vehicles.slice(1).map(x => x.kind))].join('/')}` : '';
    lines.push(`| ${r.set} ${r.name} | ${v.kind}${extra} | ${v.nose ?? '?'} (${v.noseSource ?? '?'}, ${v.agreement === null ? '?' : Math.round(v.agreement * 100) + '%'}) | ${v.seats} | ${v.wheels ?? '-'} / ${v.wheelBones ?? '-'} | ${v.size ? `${v.size.width}×${v.size.height}×${v.size.length}` : '?'} | ${v.collision ? `${v.collision.width}×${v.collision.height}` : '?'} | ${v.cameraRadius ?? '?'} | ${r.scale ?? ''} |`);
  }
  return lines.join('\n');
}

/**
 * Where the player sits in every rideable: the cockpit evidence and the
 * driver's eye (blocks, entity frame), the seat the pack ships, how far that
 * seat is from the cockpit seat (the eye less `RIDER_EYE_ABOVE_SEAT`; the
 * shipped seat is in the entity frame, nose +Z, so its z is flipped back),
 * and from which wand size the seated body fits (null: at none up to 400 %).
 */
export function seatTable(all: AuditRow[]): string {
  const f2 = (v: number): string => (Math.round(v * 100) / 100).toString();
  const lines = [
    '| set | entity | kind | scale | cockpit (evidence) | eye x,y,z | seat shipped | offset from cockpit seat | body fits from | rider |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of all) {
    for (const v of r.vehicles) {
      const seat = v.seatPositions[0] ?? v.seat;
      const eye = v.cockpitEye;
      const plan = v.seatPlan as { fitScale: number | null; steps: Array<{ f: number; head: number; torso: number }> } | null;
      const off = seat && eye ? [seat[0]! - eye[0], seat[1]! - (eye[1] - RIDER_EYE_ABOVE_SEAT), -seat[2]! - eye[2]].map(f2).join(', ') : '?';
      const fits = plan ? (plan.fitScale === null ? 'never (to 400 %)' : `${plan.fitScale * 100} %`) : '?';
      const at100 = plan?.steps.find(s => s.f === 1);
      const rider = plan ? (plan.fitScale === 1 ? 'drawn in the seat' : 'hidden at 100 %, eye at the driver\'s') + (at100 ? ` (head ${Math.round(at100.head * 100)} %, torso ${Math.round(at100.torso * 100)} % inside)` : '') : '?';
      lines.push(`| ${r.set} | ${v.entity} | ${v.kind} | ${r.scale ?? ''} | ${v.cockpit ?? '?'} | ${eye ? eye.map(f2).join(', ') : '?'} | ${seat ? seat.map(f2).join(', ') : '?'} | ${off} | ${fits} | ${rider} |`);
    }
  }
  return lines.join('\n');
}
