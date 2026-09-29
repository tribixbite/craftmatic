/**
 * WHY is a doorway not walkable? For every doorway of built packs that the
 * passability walk does not call OK at a size (SEALED, ONE-WAY, SMALL,
 * NO-APPROACH, FAIL), walk it again over counterfactual worlds and name the
 * cause from the first world in which it passes:
 *
 *   collider:<refusal>  the pack's colliders with clearance's refused trims
 *                       of that kind applied (walkable-top, door-cut,
 *                       door-leaf, leak) - the refusal alone seals it;
 *   collider:refusals   only every refused trim together unseals it;
 *   collider:form       the model's own part geometry (the layer footprints
 *                       clearance reasons on, `_ix_cell_geometry.ts`) lets a
 *                       player through, but no collider form expresses it
 *                       (a corner, two walls in a cell, a band off the grid);
 *   passSize            the opening is under the player's passage rule at
 *                       this size, and the geometry walk passes it;
 *   model:<what>        the geometry itself stops a 0.6 x 1.8 player on the
 *                       side it cannot reach (`drop`, `rise`, `solid` - body
 *                       height geometry in front, `low` - head room under 1.8,
 *                       `narrow` - the corridor straight through is under a
 *                       player's width), measured along the leaf's normal.
 *
 * A minifig is 1.8 blocks tall at 100 % and wider at the hips (2 studs =
 * 0.75 block) than the 0.6 player, so where the GEOMETRY stops the player
 * it stops a minifig too, and a `collider:*` doorway is one the pack
 * seals by rounding alone.
 *
 * Usage: bun scripts/_ix_sealed_causes.ts <pack dir> <geometry dir> [--sizes=100,150] [--json=out.json]
 *   geometry dir: <set>.json per pack from `_ix_cell_geometry.ts`.
 * Turn 0 only: the geometry world is the model at the size, unturned.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddonPreviewModel, readAddonPreviewFiles, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { boxFree, verdictOf, walkThroughDoorway, type DoorwayWalkPack, type DoorwayWalkResult, type Verdict } from '../web/src/engine/interactive-walk.ts';
import { WalkWorld, type Box, type SolidBox, type WalkWorldOptions } from '../web/src/engine/addon-walk.ts';
import type { InteractiveRuntimeItem } from '../web/src/engine/bedrock-interactives.ts';
import type { QuarterTurn, SourceCell } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sizes = (flag('sizes') ?? '100,150').split(',').map(Number);
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

interface Row {
  set: string; label: string; size: number; verdict: Verdict; cause: string; opening?: { width: number; height: number }; passSize?: number;
  missing?: string; measure?: Record<string, number | string>;
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
  const geoPath = join(geoDir, `${set}.json`);
  const geo = existsSync(geoPath) ? JSON.parse(readFileSync(geoPath, 'utf8')) as { width: number; height: number; length: number; cells: string } : undefined;
  const geoBoxes: Box[] = [];
  const geoCells = new Set<string>();
  if (geo) {
    const buf = Buffer.from(geo.cells, 'base64');
    for (let at = 0; at + 68 <= buf.length; at += 68) {
      const i = buf.readInt32LE(at);
      const a = new Uint8Array(buf.subarray(at + 4, at + 68));
      geoBoxes.push(...cellBoxes(i, a, geo.height, geo.length));
      geoCells.add(`${Math.floor(i / (geo.height * geo.length))},${Math.floor(i / geo.length) % geo.height},${i % geo.length}`);
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
  const geoPack: DoorwayWalkPack | undefined = geo ? {
    cells: nonGeoCells, dims: model.dims,
    // In the geometry world every doorway's static neighbours are the geometry: only the leaf cells stay.
    interactives: { ...cfg, items: cfg.items.map(it => ({ ...it, neighbours: [] })) },
    shippedTreads,
    makeWorld: o => new GeometryWorld({ ...o, cells: nonGeoCells }, geoBoxes),
  } : undefined;

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
    row.missing = base.open.directions.filter(d => d.outcome !== 'passed').map(d => `${d.from}:${d.reason ?? d.outcome}`).join(' ');
    // 1. Does the MODEL let a player through? (the opening forced passable, as a minifig would use it)
    const g = geoPack ? walkVerdict(geoPack, i, size, true) : undefined;
    if (!g) { row.cause = 'no-geometry-dump'; rows.push(row); continue; }
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
        row.cause = found || 'collider:form';
      }
      if (g.verdict === 'ONE-WAY') row.cause += ' (model one-way)';
    } else {
      // 3. Model-caused: measure the side the geometry walk cannot reach, along the normal.
      const w = g.open;
      const bad = w.directions.find(d => d.outcome !== 'passed') ?? w.directions[0];
      const side = bad?.from ?? 1;
      const world = new GeometryWorld({ cells: nonGeoCells, dims: model.dims, sizePct: size, rotation: 0, treads: 'shipped', shippedTreads }, geoBoxes);
      const t0 = w.centre.y, n = w.normal, k = size / 100;
      const measure: Record<string, number | string> = { side, doorFloor: r2(t0) };
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
for (const r of rows) console.log(`${r.set.padEnd(7)} ${r.label.padEnd(8)} @${r.size} ${r.verdict.padEnd(11)} ${r.cause.padEnd(28)} ${r.missing ?? ''} ${r.opening ? `opening ${r.opening.width}x${r.opening.height} pass>=${r.passSize}` : ''} ${r.measure ? JSON.stringify(r.measure) : ''}`);
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
