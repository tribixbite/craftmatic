/**
 * How much floor the figures would reach if the planner read a clearance
 * form's REAL boxes instead of its whole vertical extent (FIG-01 "figures
 * stuck in 1-4 cells"; the `TODO` at `blockSpan` in bedrock-figure-life.ts).
 *
 * For every roaming figure of each pack, the planner's reach (`exploreWalkable`
 * over the pack's collider cells, at 100 %) three ways:
 *
 *   shipped   a form counts as its whole vertical extent (`blockSpan` today);
 *   centre    a form counts only where its boxes meet the figure's footprint
 *             STANDING AT THE CELL CENTRE (the cell it plans through) - an
 *             upper bound: it does not test the move between two cells, where
 *             a band on the shared face still walls them apart;
 *   crossing  as `centre`, and a move between two cells must also pass the
 *             bands on their shared face (the footprint swept from centre to
 *             centre at the higher feet).
 *
 * A figure whose `crossing` reach is no larger than its `shipped` one is not
 * kept small by the block-granular reading of the forms.
 *
 * Usage: bun scripts/_figure_form_reach.ts <pack.mcaddon>... [--json=out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadAddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';
import { exploreWalkable, FIGURE_TUNING, standFeetAt, startCell, type SpanLookup } from '../web/src/engine/bedrock-figure-life.ts';
import { COLLIDER_KIT } from '../web/src/engine/collider-form.ts';
import type { SourceCell } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) { console.error('usage: bun scripts/_figure_form_reach.ts <pack.mcaddon>... [--json=out.json]'); process.exit(2); }

/** A form's boxes in block units (x/z as the KIT means them: the device's world placement after the x mirror fix). */
function formBoxes(c: SourceCell): Array<{ x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }> {
  return COLLIDER_KIT.formBoxes(c.v ?? 0, c.lo, c.hi).map(b => ({ x0: b.x0 / 16, x1: b.x1 / 16, y0: b.y0 / 16, y1: b.y1 / 16, z0: b.z0 / 16, z1: b.z1 / 16 }));
}

const out: unknown[] = [];
for (const file of files) {
  const bytes = readFileSync(file);
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const grid = new Map(model.cells.map(c => [`${c.x},${c.y},${c.z}`, c]));
  const ground = (y: number): number[] | null => (y < 0 ? [y, y + 1] : null);
  /** The shipped reading: a form's whole vertical extent (blockSpan's rule for `<block>_<w|f|c>` ids). */
  const shipped: SpanLookup = (x, y, z) => {
    const c = grid.get(`${x},${y},${z}`);
    if (!c) return ground(y);
    if (!(c.hi > c.lo)) return null;
    const kind = c.v ? COLLIDER_KIT.VARIANTS[c.v]!.kind : -1;
    return kind < 0 || !c.v ? [y + c.lo / 16, y + c.hi / 16] : [y + (kind === 2 ? 0 : c.lo) / 16, y + (kind === 1 ? 16 : c.hi) / 16];
  };
  /** The real boxes met by a footprint of half width `h` centred in the cell: their vertical extent, or none. */
  const centreSpan = (h: number): SpanLookup => (x, y, z) => {
    const c = grid.get(`${x},${y},${z}`);
    if (!c) return ground(y);
    if (!(c.hi > c.lo)) return null;
    if (!c.v) return [y + c.lo / 16, y + c.hi / 16];
    let lo = Infinity, hi = -Infinity;
    for (const b of formBoxes(c)) if (b.x1 > 0.5 - h && b.x0 < 0.5 + h && b.z1 > 0.5 - h && b.z0 < 0.5 + h) { lo = Math.min(lo, b.y0); hi = Math.max(hi, b.y1); }
    return lo < hi ? [y + lo, y + hi] : null;
  };
  /** Whether a footprint of half width `h` at feet `feet`, height `body`, moving from cell a's centre to cell b's crosses a real box. */
  const crossBlocked = (h: number, body: number) => (ax: number, az: number, bx: number, bz: number, feet: number): boolean => {
    for (let s = 0; s <= 1.0001; s += 0.1) {
      const px = ax + 0.5 + (bx - ax) * s, pz = az + 0.5 + (bz - az) * s;
      for (let y = Math.floor(feet); y <= Math.floor(feet + body - 1e-9); y++) for (const [cx, cz] of [[ax, az], [bx, bz]] as const) {
        const c = grid.get(`${cx},${y},${cz}`);
        if (!c || !c.v || !(c.hi > c.lo)) continue;
        for (const b of formBoxes(c)) {
          const x0 = cx + b.x0, x1 = cx + b.x1, z0 = cz + b.z0, z1 = cz + b.z1, y0 = y + b.y0, y1 = y + b.y1;
          if (px + h > x0 && px - h < x1 && pz + h > z0 && pz - h < z1 && feet + body > y0 + 1e-6 && feet < y1 - 1e-6) return true;
        }
      }
    }
    return false;
  };
  const area = { x0: 0, z0: 0, x1: model.dims.width, z1: model.dims.length };
  const inArea = (x: number, z: number): boolean => x + 0.5 >= area.x0 && x + 0.5 <= area.x1 && z + 0.5 >= area.z0 && z + 0.5 <= area.z1;
  const rows: unknown[] = [];
  for (const f of model.entities.filter(e => e.kind === 'figure' && e.rideOf === undefined)) {
    const body = model.entityCollision.get(f.typeId)?.height ?? 1.8;
    const h = (model.entityCollision.get(f.typeId)?.width ?? 0.6) / 2;
    const reachWith = (span: SpanLookup, edge?: (ax: number, az: number, bx: number, bz: number, feet: number) => boolean): number => {
      const start = startCell(span, f.x, f.z, f.y, body, FIGURE_TUNING.maxUp, FIGURE_TUNING.maxDown, standFeetAt, inArea, 1);
      if (!start) return 0;
      const cells = exploreWalkable(span, start, body, FIGURE_TUNING.maxUp, FIGURE_TUNING.maxDown, (x, z, ff) => inArea(x, z) && Math.abs(ff - start.feet) <= FIGURE_TUNING.band && (x + 0.5 - f.x) ** 2 + (z + 0.5 - f.z) ** 2 <= FIGURE_TUNING.radius ** 2, FIGURE_TUNING.maxNodes, standFeetAt);
      if (!edge) return cells.length;
      // Keep only the cells whose path from the start never crosses a band (each cell's parent link).
      const ok = new Array<boolean>(cells.length).fill(false);
      ok[0] = true;
      for (let i = 1; i < cells.length; i++) { const c = cells[i]!, p = cells[c.parent]!; ok[i] = ok[c.parent]! && !edge(p.x, p.z, c.x, c.z, Math.max(p.feet, c.feet)); }
      return ok.filter(Boolean).length;
    };
    const centre = centreSpan(h);
    const row = { pack: basename(file), figure: f.label ?? f.typeId, shipped: reachWith(shipped), centre: reachWith(centre), crossing: reachWith(centre, crossBlocked(h, body)) };
    rows.push(row);
    console.log(`${row.pack.padEnd(16)} ${String(row.figure).padEnd(30)} shipped ${String(row.shipped).padStart(4)}  centre ${String(row.centre).padStart(4)}  crossing ${String(row.crossing).padStart(4)}`);
  }
  out.push(...rows);
}
if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(out, null, 1));
