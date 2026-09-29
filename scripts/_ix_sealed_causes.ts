/**
 * WHY is a doorway not walkable? For every doorway of built packs that the
 * passability walk does not call OK at a size (SEALED, ONE-WAY, SMALL,
 * NO-APPROACH, STEP, FAIL), walk it again over counterfactual worlds and name
 * the cause:
 *
 * 1. The MODEL: an exact-box lattice walk (`fineWalk`, 1/8 block) of a 0.6 x
 *    1.8 player over the part geometry itself - clearance's layer footprints
 *    (`_ix_cell_geometry.ts`), or with `--drawn` the pack's drawn cuboids -
 *    with the opening forced passable. When it cannot get through:
 *      model:<what>  what stops it one block out on the side it cannot reach,
 *                    measured along the leaf's normal: `solid` (geometry at
 *                    body height - furniture, a wall, a railing), `drop`,
 *                    `rise`, `narrow`, or `route` (a way exists one block out
 *                    but not through). `measure` has the numbers.
 *    A minifig is 1.8 blocks tall at 100 % but only 1 stud (0.375 block)
 *    deep, so a door opening onto a railing or furniture a stud away stops
 *    the player where a minifig still stands.
 * 2. When the model lets the player through, the COLLIDERS:
 *      passSize             the opening was under the passable size at this size;
 *      collider:<refusal>   applying clearance's refused trims of that kind alone
 *                           (walkable-top, door-cut, door-leaf, leak) passes it;
 *      collider:refusals    only all refused trims together pass it;
 *      harness:route        a 0.6 x 1.8 box sweeps through the colliders (the
 *                           lattice), so the passability walk's route refused;
 *      collider:<blame>     otherwise, the collider cells standing where the
 *                           geometry walk stood (`form` a clearance form wider
 *                           than its geometry, `tight` a full cell whose layers
 *                           are full, `refused:<why>`, `no-geometry`, `tread`,
 *                           `other-leaf`), weighted by the lattice points each
 *                           blocks (`measure.blame`).
 *    `--kit8` adds the verdict with every applied trim re-covered by
 *    eighth-block bands (would a finer shape vocabulary pass it?), and every
 *    row says whether the geometry walk passes when it may leave the doorway
 *    sideways once through (`wide`).
 *
 * Usage: bun scripts/_ix_sealed_causes.ts <pack dir> <geometry dir> [--sizes=100,150] [--json=out.json] [--drawn] [--kit8]
 *   geometry dir: <set>.json per pack from `_ix_cell_geometry.ts` (or the sweep's `--geometry`).
 *   DEBUG_DOOR=<set>/<label>/<size> prints both lattice reaches for one doorway.
 * Turn 0 only: the geometry world is the model at the size, unturned.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entitySpawnsAt, loadAddonPreviewModel, placedPoint, readAddonPreviewFiles, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { worldFaces, type AuditActor } from '../web/src/engine/bedrock-geometry-faces.ts';
import { boxFree, verdictOf, walkThroughDoorway, type DoorwayWalkPack, type DoorwayWalkResult, type Verdict } from '../web/src/engine/interactive-walk.ts';
import { WalkWorld, playerBox, worldPointToModel, type Box, type SolidBox, type WalkWorldOptions } from '../web/src/engine/addon-walk.ts';
import { ixClosedBlocks, ixWorldBlocks, type InteractiveRuntimeItem } from '../web/src/engine/bedrock-interactives.ts';
import { COLLIDER_KIT, colliderFormKit } from '../web/src/engine/collider-form.ts';
import { layerBoxes } from '../web/src/engine/collider-clearance.ts';
import type { QuarterTurn, SourceCell } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sizes = (flag('sizes') ?? '100,150').split(',').map(Number);
/** `--drawn`: the geometry is the pack's own drawn cuboids (world AABBs) instead of clearance's layer footprints. */
const DRAWN = process.argv.includes('--drawn');
/**
 * `--kit8`: for a collider-caused doorway, also walk it with every applied wall trim re-covered by a kit
 * of EIGHTH-block bands (every band from a face in 1/8 steps, and the centred [2,14], [4,12]): would a finer
 * shape vocabulary let the player through?
 */
const KIT8 = process.argv.includes('--kit8');
const EIGHTH_BANDS: Array<[number, number]> = [];
for (let b = 2; b <= 14; b += 2) EIGHTH_BANDS.push([0, b], [b, 16]);
EIGHTH_BANDS.push([2, 14], [4, 12]);
const KIT8_FORMS = colliderFormKit(EIGHTH_BANDS);
const [packDir, geoDir] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!packDir || !geoDir) { console.error('usage: bun scripts/_ix_sealed_causes.ts <pack dir> <geometry dir> [--sizes=100,150] [--json=out.json]'); process.exit(2); }

/** A cell's part geometry as boxes in grid blocks (consecutive equal layer footprints merged). */
function cellBoxes(i: number, a: Uint8Array, H: number, L: number): Box[] {
  const x = Math.floor(i / (H * L)), y = Math.floor(i / L) % H, z = i % L;
  const out: Box[] = [];
  let run: { l0: number; l1: number; f: number[] } | null = null;
  const flush = (): void => { if (run) out.push({ x0: x + run.f[0]! / 16, x1: x + run.f[1]! / 16, y0: y + run.l0 / 16, y1: y + run.l1 / 16, z0: z + run.f[2]! / 16, z1: z + run.f[3]! / 16 }); run = null; };
  for (let l = 0; l < 16; l++) {
    const k = 4 * l;
    if (a[k] === 255) { flush(); continue; }
    const f = [a[k]!, a[k + 1]!, a[k + 2]!, a[k + 3]!];
    if (run && run.f.every((v, j) => v === f[j])) { run.l1 = l + 1; continue; }
    flush();
    run = { l0: l, l1: l + 1, f };
  }
  flush();
  return out;
}

/**
 * The model's own geometry as a walk world at size `f` (turn 0): every part
 * box scaled, plus the pack's colliders that hold NO geometry (treads,
 * stairs), which a player walks on as shipped.
 */
class GeometryWorld extends WalkWorld {
  private readonly byColumn = new Map<string, SolidBox[]>();
  constructor(options: WalkWorldOptions, boxes: readonly Box[]) {
    super(options);
    const f = options.sizePct / 100;
    for (const b of boxes) {
      const s: SolidBox = { x0: b.x0 * f, x1: b.x1 * f, y0: b.y0 * f, y1: b.y1 * f, z0: b.z0 * f, z1: b.z1 * f, tread: false, ground: false };
      for (let x = Math.floor(s.x0 + 1e-6); x < s.x1 - 1e-6; x++) for (let z = Math.floor(s.z0 + 1e-6); z < s.z1 - 1e-6; z++) {
        const key = `${x},${z}`;
        const list = this.byColumn.get(key);
        if (list) list.push(s); else this.byColumn.set(key, [s]);
      }
    }
  }
  override boxesInColumn(x: number, z: number): SolidBox[] {
    return [...super.boxesInColumn(x, z), ...(this.byColumn.get(`${x},${z}`) ?? []).map(b => ({ ...b, x0: Math.max(b.x0, x), x1: Math.min(b.x1, x + 1), z0: Math.max(b.z0, z), z1: Math.min(b.z1, z + 1) }))];
  }
  override solidsNear(box: Box, dx: number, dy: number, dz: number): SolidBox[] {
    const out = super.solidsNear(box, dx, dy, dz);
    const x0 = Math.floor(Math.min(box.x0, box.x0 + dx) - 1e-6), x1 = Math.floor(Math.max(box.x1, box.x1 + dx) + 1e-6);
    const z0 = Math.floor(Math.min(box.z0, box.z0 + dz) - 1e-6), z1 = Math.floor(Math.max(box.z1, box.z1 + dz) + 1e-6);
    const seen = new Set<SolidBox>();
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (const b of this.byColumn.get(`${x},${z}`) ?? []) seen.add(b);
    return [...out, ...seen];
  }
}

/**
 * Can a 0.6 x 1.8 player move through the doorway over `world`'s EXACT
 * boxes? A breadth-first walk on a 1/8-block lattice (the route graph of
 * interactive-walk.ts is column-granular, built for collider forms; part
 * geometry is not): from the leaf plane outward along the doorway's
 * corridor (the walk's `halfSpan`), stepping up at most a jump (1.25) and,
 * two-way, down at most a jump; a side is reached at a spot 0.9 block (x
 * size) past the plane within a jump of the door's floor. A side reached
 * only by dropping further (up to 3 blocks x size) is one-way.
 */
function fineWalk(world: WalkWorld, centre: { x: number; y: number; z: number }, n: { x: number; z: number }, halfSpan: number, k: number, debug = false, wide = false): { two: Set<number>; one: Set<number>; nodes: Array<[number, number, number]> } {
  const STEP = 1 / 8, JUMP = 1.25, u = { x: -n.z, z: n.x }, t0 = centre.y;
  const reach = Math.ceil(4 * k / STEP), lat = Math.floor(Math.max(0, halfSpan - 0.3) / STEP);
  // `wide`: through the doorway within its span, then anywhere within 3 blocks across (a door onto a
  // hallway that runs sideways); a side is reached once the player's box is wholly past the leaf (0.6).
  const CLEAR = wide ? 0.6 : 0.9, latWide = Math.ceil(3 * k / STEP);
  const latAt = (a: number): number => wide && Math.abs(a * STEP) >= 0.6 * k - 1e-9 ? latWide : lat;
  const at = (a: number, l: number): { x: number; z: number } => ({ x: centre.x + n.x * a * STEP + u.x * l * STEP, z: centre.z + n.z * a * STEP + u.z * l * STEP });
  /** Solid tops under the player's footprint at (x, z) between y0 and y1, and the ground. */
  const tops = (x: number, z: number, y0: number, y1: number): number[] => {
    const box = { x0: x - 0.3, x1: x + 0.3, y0, y1, z0: z - 0.3, z1: z + 0.3 };
    const out = new Set<number>([0]);
    for (const s of world.solidsNear(box, 0, 0, 0)) {
      if (s.ground) continue;
      if (s.x1 <= box.x0 + 1e-7 || s.x0 >= box.x1 - 1e-7 || s.z1 <= box.z0 + 1e-7 || s.z0 >= box.z1 - 1e-7) continue;
      if (s.y1 >= y0 - 1e-6 && s.y1 <= y1 + 1e-6) out.add(Math.round(s.y1 * 16) / 16);
    }
    return [...out].filter(t => t >= y0 - 1e-6 && t <= y1 + 1e-6).sort((a, b) => b - a);
  };
  /** Where the player lands stepping from height y into (x, z): the highest free support within [y - drop, y + JUMP]. */
  const land = (x: number, z: number, y: number, drop: number): number | undefined => {
    for (const t of tops(x, z, y - drop, y + JUMP)) if (boxFree(world, x, t + 1e-3, z)) return t;
    return undefined;
  };
  const key = (a: number, l: number, t: number): string => `${a},${l},${Math.round(t * 16)}`;
  const two = new Set<number>(), one = new Set<number>();
  const nodes: Array<[number, number, number]> = [];
  const search = (drop: number, sides: Set<number>): void => {
    const best = new Map<string, number>();
    const q: Array<[number, number, number]> = [];
    const seen = new Set<string>();
    for (let l = -lat; l <= lat; l++) for (const a of [0, 1, -1]) {
      const p = at(a, l);
      for (const t of tops(p.x, p.z, t0 - JUMP * k, t0 + JUMP * k)) {
        if (Math.abs(t - t0) > k + 1e-6 || !boxFree(world, p.x, t + 1e-3, p.z)) continue;
        const kk = key(a, l, t);
        if (!seen.has(kk)) { seen.add(kk); q.push([a, l, t]); }
        break;
      }
    }
    for (let h = 0; h < q.length; h++) {
      const [a, l, t] = q[h]!;
      const along = a * STEP;
      if (debug) best.set(`${a},${l}`, Math.max(best.get(`${a},${l}`) ?? -99, t));
      if (sides === two) { const p = at(a, l); nodes.push([p.x, t, p.z]); }
      if (Math.abs(t - t0) <= JUMP * k + 1e-6) for (const s of [-1, 1]) if (along * s >= CLEAR * k - 1e-9) sides.add(s);
      for (const [da, dl] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const na = a + da, nl = l + dl;
        if (Math.abs(na) > reach || Math.abs(nl) > latAt(na)) continue;
        const from = at(a, l), p = at(na, nl);
        const t2 = land(p.x, p.z, t, drop);
        if (t2 === undefined) continue;
        // Moving across at the higher of the two floors must be free at both ends (a jump's head room, a drop's step off).
        const hi = Math.max(t, t2);
        if (!boxFree(world, from.x, hi + 1e-3, from.z) || !boxFree(world, p.x, hi + 1e-3, p.z)) continue;
        const kk = key(na, nl, t2);
        if (seen.has(kk)) continue;
        seen.add(kk); q.push([na, nl, t2]);
      }
    }
    if (debug) {
      // One row per 1/4 block along the normal, one column per 1/8 across: the highest floor reached, quarter blocks from the door floor (0 = level, '.' unreached).
      console.log(`reach (drop ${drop}), t0 ${t0}, rows along ${-reach * STEP}..${reach * STEP}:`);
      for (let a = -reach; a <= reach; a += 2) {
        let line = '';
        for (let l = -lat; l <= lat; l++) { const b = best.get(`${a},${l}`); line += b === undefined ? '.' : 'abcdefghijklmnopqrstuvwxyzABCDEFGH'[Math.max(0, Math.min(33, Math.round((b - t0) * 4) + 16))]; }
        console.log(`${(a * STEP).toFixed(2).padStart(6)} ${line}`);
      }
    }
  };
  search(JUMP, two);
  if (two.size < 2) search(3 * k, one);
  return { two, one, nodes };
}

interface Row {
  set: string; label: string; size: number; verdict: Verdict; cause: string; opening?: { width: number; height: number }; passSize?: number;
  missing?: string; measure?: Record<string, number | string>;
  /** The geometry walk entered straight and left sideways (`fineWalk` wide). */
  wide?: string;
  /** `--kit8`: the passability verdict with eighth-block collider shapes. */
  kit8?: string;
  /** The doorway's centre (feet height at its floor) and normal, world blocks at the size. */
  centre?: { x: number; y: number; z: number }; normal?: { x: number; z: number };
}
const rows: Row[] = [];
const REFUSALS = ['walkable-top', 'door-cut', 'door-leaf', 'leak'] as const;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const LDU = 53.333;

for (const name of readdirSync(packDir).filter(n => n.endsWith('.mcaddon')).sort()) {
  const set = name.replace('.mcaddon', '');
  const bytes = readFileSync(join(packDir, name));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const model = await loadAddonPreviewModel(ab);
  const cfg = model.interactives;
  if (!cfg) continue;
  const doorways = cfg.items.map((it, i) => ({ it, i })).filter(({ it }) => it.passSize !== undefined && it.blocking.length);
  if (!doorways.length) continue;
  const diag = JSON.parse((await readAddonPreviewFiles(ab)).diagnosticsJson ?? '{}') as { clearance?: { entries?: Array<Array<number | string>> } };
  const entries = diag.clearance?.entries ?? [];
  const entryAt = new Map(entries.map(e => [`${e[0]},${e[1]},${e[2]}`, e]));
  const cellAt = new Set(model.cells.map(c => `${c.x},${c.y},${c.z}`));
  const geoPath = join(geoDir, `${set}.json`);
  const geo = existsSync(geoPath) ? JSON.parse(readFileSync(geoPath, 'utf8')) as { width: number; height: number; length: number; cells: string } : undefined;
  const geoBoxes: Box[] = [];
  const geoCells = new Set<string>();
  const geoLayers = new Map<string, Uint8Array>();
  if (DRAWN && model.appearance) {
    // The DRAWN model: every cuboid of the building shell and of the moving parts that are not
    // doorways (a window, a cabinet: their closed boxes stay colliders), as its world AABB.
    const passTypes = new Set(cfg.items.filter(x => x.passSize !== undefined).map(x => x.type));
    const actors: AuditActor[] = [];
    for (const e of model.entities) {
      if (!entitySpawnsAt(e, 100) || passTypes.has(e.typeId) || !['shell', 'door', 'other'].includes(e.kind)) continue;
      const entry = model.appearance.byType.get(e.typeId);
      if (entry) actors.push({ typeId: e.typeId, kind: e.kind, entry, at: placedPoint(e, model.dims, 100, 0), yawDeg: e.yaw });
    }
    const cube = new Map<string, Box>();
    for (const f of worldFaces(actors)) {
      const key = `${f.actor}/${f.group}/${f.cube}`;
      const b = cube.get(key) ?? { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
      for (const c of f.corners) { b.x0 = Math.min(b.x0, c[0] / 16); b.x1 = Math.max(b.x1, c[0] / 16); b.y0 = Math.min(b.y0, c[1] / 16); b.y1 = Math.max(b.y1, c[1] / 16); b.z0 = Math.min(b.z0, c[2] / 16); b.z1 = Math.max(b.z1, c[2] / 16); }
      cube.set(key, b);
    }
    for (const b of cube.values()) if (b.x1 - b.x0 > 1e-3 && b.y1 - b.y0 > 1e-3 && b.z1 - b.z0 > 1e-3) {
      geoBoxes.push(b);
      for (let x = Math.floor(b.x0); x < b.x1; x++) for (let y = Math.floor(b.y0); y < b.y1; y++) for (let z = Math.floor(b.z0); z < b.z1; z++) geoCells.add(`${x},${y},${z}`);
    }
  } else if (geo) {
    const buf = Buffer.from(geo.cells, 'base64');
    for (let at = 0; at + 68 <= buf.length; at += 68) {
      const i = buf.readInt32LE(at);
      const a = new Uint8Array(buf.subarray(at + 4, at + 68));
      geoBoxes.push(...cellBoxes(i, a, geo.height, geo.length));
      const cellKey = `${Math.floor(i / (geo.height * geo.length))},${Math.floor(i / geo.length) % geo.height},${i % geo.length}`;
      geoCells.add(cellKey);
      geoLayers.set(cellKey, a);
    }
  }
  const shippedTreads = (s: number, r: QuarterTurn) => treadBlocksAt(model, s, r);
  const basePack: DoorwayWalkPack = { cells: model.cells, dims: model.dims, interactives: cfg, shippedTreads };
  /** The pack with refused clearance trims of the given kinds applied (cells and every doorway's recorded neighbours). */
  const withTrims = (kinds: ReadonlySet<string>): DoorwayWalkPack => {
    const to = new Map<string, [number, number, number]>();
    for (const e of entries) if (e[10] && kinds.has(String(e[10])) && e[3] === 0) to.set(`${e[0]},${e[1]},${e[2]}`, [Number(e[7]), Number(e[8]), Number(e[9])]);
    const patch = <T extends { x: number; y: number; z: number; lo: number; hi: number; v?: number }>(c: T): T => { const t = to.get(`${c.x},${c.y},${c.z}`); return t ? { ...c, v: t[0], lo: t[1], hi: t[2] } : c; };
    const cells = model.cells.map(patch);
    const items: InteractiveRuntimeItem[] = cfg.items.map(it => ({ ...it, neighbours: it.neighbours.map(n => { const t = to.get(`${n[0]},${n[1]},${n[2]}`); return t ? [n[0], n[1], n[2], t[1], t[2], ...(t[0] ? [t[0]] : [])] as typeof n : n; }) }));
    return { cells, dims: model.dims, interactives: { ...cfg, items }, shippedTreads };
  };
  // Colliders holding no geometry (treads, stairs) stay in the geometry world.
  const nonGeoCells: SourceCell[] = model.cells.filter(c => !geoCells.has(`${c.x},${c.y},${c.z}`));

  const walkVerdict = (pack: DoorwayWalkPack, i: number, size: number, forcePass = false): { verdict: Verdict; open: DoorwayWalkResult } => {
    const it = pack.interactives.items[i]!;
    const p = forcePass ? { ...pack, interactives: { ...pack.interactives, items: pack.interactives.items.map((x, k) => k === i || it.pairs?.includes(k) ? { ...x, passSize: 100 } : x) } } : pack;
    const open = walkThroughDoorway(p, i, size, 0, true), closed = walkThroughDoorway(p, i, size, 0, false);
    return { verdict: verdictOf(open, closed, size > 100 && walkThroughDoorway(p, i, 100, 0, true).outcome === 'passed'), open };
  };

  for (const { it, i } of doorways) for (const size of sizes) {
    const base = walkVerdict(basePack, i, size);
    if (base.verdict === 'OK') continue;
    const row: Row = { set, label: it.label, size, verdict: base.verdict, cause: '?', ...(it.opening ? { opening: it.opening } : {}), ...(it.passSize !== undefined ? { passSize: it.passSize } : {}) };
    row.centre = { x: r2(base.open.centre.x), y: r2(base.open.centre.y), z: r2(base.open.centre.z) };
    row.normal = { x: r2(base.open.normal.x), z: r2(base.open.normal.z) };
    row.missing = base.open.directions.filter(d => d.outcome !== 'passed').map(d => `${d.from}:${d.reason ?? d.outcome}`).join(' ');
    // 1. Does the MODEL let a player through? (the opening forced passable, as a minifig would use it)
    if (!geo && !DRAWN) { row.cause = 'no-geometry-dump'; rows.push(row); continue; }
    const gWorld = new GeometryWorld({ cells: nonGeoCells, dims: model.dims, sizePct: size, rotation: 0, treads: 'shipped', shippedTreads }, geoBoxes);
    // Every OTHER doorway's leaf closed, as the walk lays it; this one's group lifted.
    const group = new Set([i, ...(it.pairs ?? [])]);
    gWorld.setOverlayBlocks(ixClosedBlocks(cfg.items.map((x, j) => group.has(j) ? { ...x, blocking: [] } : { ...x, neighbours: [] }), model.dims, size / 100, 0, () => false));
    const own = [...ixWorldBlocks(it.blocking, model.dims, size / 100, 0, COLLIDER_KIT).keys()].map(s => s.split(',').map(Number) as [number, number, number]);
    const nrm = base.open.normal, uu = { x: -nrm.z, z: nrm.x }, cc = base.open.centre;
    const halfSpan = Math.max(...own.map(([x, , z]) => Math.abs((x + 0.5 - cc.x) * uu.x + (z + 0.5 - cc.z) * uu.z))) + 0.5 + 0.3;
    const debug = process.env.DEBUG_DOOR === `${set}/${it.label}/${size}`;
    if (debug) console.log('GEOMETRY');
    const fw = fineWalk(gWorld, cc, nrm, halfSpan, size / 100, debug);
    const gv = fw.two.size === 2 ? 'OK' : new Set([...fw.two, ...fw.one]).size === 2 ? 'ONE-WAY' : 'SEALED';
    // The same geometry with the doorway entered straight and then left sideways (a hallway behind the door).
    const fwWide = fineWalk(gWorld, cc, nrm, halfSpan, size / 100, false, true);
    row.wide = fwWide.two.size === 2 ? 'OK' : new Set([...fwWide.two, ...fwWide.one]).size === 2 ? 'ONE-WAY' : 'SEALED';
    const g = { verdict: gv, open: { ...base.open, directions: [-1, 1].map(s => ({ from: s as -1 | 1, outcome: (fw.two.has(s) || fw.one.has(s) ? 'passed' : 'no-approach') as 'passed' | 'no-approach', ticks: 0, crossed: 0 })) } };
    if (g.verdict === 'OK' || g.verdict === 'ONE-WAY') {
      // 2. Collider-caused: which counterfactual unseals it?
      if (base.verdict === 'SMALL' || (it.passSize ?? 0) > size) {
        const forced = walkVerdict(basePack, i, size, true);
        row.cause = forced.verdict === 'OK' ? 'passSize' : `passSize+collider(${forced.verdict})`;
        if (forced.verdict !== 'OK') {
          for (const k of REFUSALS) if (walkVerdict(withTrims(new Set([k])), i, size, true).verdict === 'OK') { row.cause = `passSize+collider:${k}`; break; }
        }
      } else {
        let found = '';
        for (const k of REFUSALS) if (walkVerdict(withTrims(new Set([k])), i, size).verdict === 'OK') { found = `collider:${k}`; break; }
        if (!found && walkVerdict(withTrims(new Set(REFUSALS)), i, size).verdict === 'OK') found = 'collider:refusals';
        if (!found) {
          // The colliders themselves, swept by the same exact-box lattice walk: if a player's box
          // fits through them, the column-granular route of the passability walk is what refuses.
          const cWorld = new WalkWorld({ cells: model.cells, dims: model.dims, sizePct: size, rotation: 0, treads: 'shipped', shippedTreads });
          cWorld.setOverlayBlocks(ixClosedBlocks(cfg.items.map((x, j) => group.has(j) ? { ...x, blocking: [] } : x), model.dims, size / 100, 0, () => false));
          if (debug) console.log('COLLIDERS');
          const cw = fineWalk(cWorld, cc, nrm, halfSpan, size / 100, debug);
          if (cw.two.size === 2) found = 'harness:route';
          else {
            // Which collider cells stand where the geometry lets the player stand? Every lattice node the
            // geometry walk reached and the colliders refuse, blamed on the cells whose boxes it meets.
            const blame = new Map<string, number>();
            for (const [x, t, z] of fw.nodes) {
              if (boxFree(cWorld, x, t + 1e-3, z)) continue;
              const box = playerBox({ x, y: t + 1e-3, z });
              for (const s of cWorld.solidsNear(box, 0, 0, 0)) {
                if (s.ground || !(box.x1 > s.x0 + 1e-7 && box.x0 < s.x1 - 1e-7 && box.y1 > s.y0 + 1e-7 && box.y0 < s.y1 - 1e-7 && box.z1 > s.z0 + 1e-7 && box.z0 < s.z1 - 1e-7)) continue;
                const b = s.block;
                if (!b) continue;
                const m = worldPointToModel({ x: b.x + 0.5, y: b.row + 0.5, z: b.z + 0.5 }, model.dims, size / 100, 0);
                const cell = `${Math.floor(m.x)},${Math.floor(m.y)},${Math.floor(m.z)}`;
                const e = entryAt.get(cell);
                const why = s.tread ? 'tread' : !cellAt.has(cell) ? 'other-leaf' : e ? (e[10] ? `refused:${e[10]}` : 'form') : geoCells.has(cell) ? 'tight' : 'no-geometry';
                const k2 = `${why} ${cell}`;
                blame.set(k2, (blame.get(k2) ?? 0) + 1);
              }
            }
            const byWhy = new Map<string, number>();
            for (const [k2, n] of blame) { const w = k2.split(' ')[0]!; byWhy.set(w, (byWhy.get(w) ?? 0) + n); }
            const top = [...byWhy].sort((a, b) => b[1] - a[1]);
            found = `collider:${top[0]?.[0] ?? 'unknown'}`;
            row.measure = { blame: [...blame].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k2, n]) => `${k2} x${n}`).join('; ') };
          }
        }
        row.cause = found || 'collider:form';
        if (KIT8) {
          // Every applied wall trim re-covered by the eighth-band kit (a subset of its quarter-band cover).
          const boxes8: Box[] = [];
          const replaced = new Set<string>();
          for (const e of entries) {
            if (e[10] || e[3] !== 0) continue;
            const key = `${e[0]},${e[1]},${e[2]}`, a = geoLayers.get(key);
            if (!a) continue;
            const f8 = KIT8_FORMS.cover(layerBoxes(a));
            if (!f8) continue;
            replaced.add(key);
            const [x, y, z] = [Number(e[0]), Number(e[1]), Number(e[2])];
            for (const b of KIT8_FORMS.formBoxes(f8.v, f8.lo, f8.hi)) boxes8.push({ x0: x + b[0] / 16, x1: x + b[1] / 16, y0: y + b[2] / 16, y1: y + b[3] / 16, z0: z + b[4] / 16, z1: z + b[5] / 16 });
          }
          const cells8 = model.cells.filter(c => !replaced.has(`${c.x},${c.y},${c.z}`));
          const pack8: DoorwayWalkPack = { cells: cells8, dims: model.dims, interactives: cfg, shippedTreads, makeWorld: o => new GeometryWorld({ ...o, cells: cells8 }, boxes8) };
          row.kit8 = walkVerdict(pack8, i, size).verdict;
        }
      }
      if (g.verdict === 'ONE-WAY') row.cause += ' (model one-way)';
    } else {
      // 3. Model-caused: measure the side the geometry walk cannot reach, along the normal.
      const w = g.open;
      const bad = w.directions.find(d => d.outcome !== 'passed') ?? w.directions[0];
      const side = bad?.from ?? 1;
      const world = new GeometryWorld({ cells: nonGeoCells, dims: model.dims, sizePct: size, rotation: 0, treads: 'shipped', shippedTreads }, geoBoxes);
      const t0 = w.centre.y, n = w.normal, k = size / 100;
      const measure: Record<string, number | string> = { side, doorFloor: r2(t0), centre: `${r2(w.centre.x)},${r2(w.centre.z)}`, normal: `${r2(n.x)},${r2(n.z)}` };
      const causes: string[] = [];
      for (const d of [1, 2]) {
        const px = w.centre.x + n.x * side * d * k, pz = w.centre.z + n.z * side * d * k;
        // The highest place a player's box fits at this point between a drop and a jump from the door floor.
        let stand: number | undefined;
        for (let h = t0 + 1.25 * k; h >= Math.max(0, t0 - 3 * k); h -= 1 / 16) {
          if (boxFree(world, px, h, pz) && (h <= 1e-6 || !boxFree(world, px, h - 1 / 16, pz))) { stand = h; break; }
        }
        // Lateral free width at body height (door floor + a step), across the corridor.
        const u = { x: -n.z, z: n.x };
        let free = 0, best = 0;
        for (let s = -1.5; s <= 1.5; s += 1 / 16) {
          const ok = boxFree(world, px + u.x * s * k, t0 + 0.6, pz + u.z * s * k);
          free = ok ? free + 1 / 16 : 0; best = Math.max(best, free);
        }
        measure[`d${d}.stand`] = stand === undefined ? 'none' : r2(stand - t0);
        measure[`d${d}.freeWidth`] = r2(best > 0 ? best + 0.6 : 0);
        if (d === 1) {
          if (stand === undefined) causes.push(boxFree(world, px, t0 + 0.6, pz) ? 'drop' : 'solid');
          else if (stand - t0 > 1.25 * k) causes.push('rise');
          else if (stand - t0 < -1.25 * k) causes.push('drop');
          else if (best <= 1e-6) causes.push('narrow');
        }
      }
      measure.openingLdu = it.opening ? `${Math.round(it.opening.width * LDU)}x${Math.round(it.opening.height * LDU)}` : '';
      row.cause = `model:${causes[0] ?? 'route'}`;
      row.measure = measure;
    }
    rows.push(row);
  }
}

// Report: every row, then counts by cause (raw rows and distinct doorways).
for (const r of rows) console.log(`${r.set.padEnd(7)} ${r.label.padEnd(8)} @${r.size} ${r.verdict.padEnd(11)} ${r.cause.padEnd(28)} wide:${r.wide ?? '-'}${r.kit8 ? ` kit8:${r.kit8}` : ''} ${r.missing ?? ''} ${r.opening ? `opening ${r.opening.width}x${r.opening.height} pass>=${r.passSize}` : ''} ${r.measure ? JSON.stringify(r.measure) : ''}`);
for (const size of sizes) {
  const at = rows.filter(r => r.size === size);
  const by = new Map<string, number>();
  for (const r of at) by.set(r.cause, (by.get(r.cause) ?? 0) + 1);
  console.log(`\n@${size}: ${at.length} not OK — ${[...by].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}`);
}
const distinct = new Map<string, Set<string>>();
for (const r of rows) { const s = distinct.get(r.cause) ?? new Set(); s.add(`${r.set}/${r.label}`); distinct.set(r.cause, s); }
console.log(`distinct doorways by cause (any size): ${[...distinct].sort((a, b) => b[1].size - a[1].size).map(([c, s]) => `${c} ${s.size}`).join(', ')}`);
const out = flag('json');
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
