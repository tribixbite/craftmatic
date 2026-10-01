/**
 * Visible surface the device does not draw because a box-UV cube DECLARES a
 * size under one unit, for EVERY entity of a built pack (shells, vehicles,
 * props, figures), measured from the pack's own geometry.
 *
 * Bedrock floors a box-UV cube's declared size before laying out its UV, and a
 * side face whose HEIGHT floors to 0 is not drawn (Pixel probe 2026-09-29,
 * `UvFloorModel` `v` in `web/src/engine/figure-holes.ts`). Figures have been
 * written safe since then (`boxUvSafeCube`); this tool measures what the other
 * kinds lose: the share of each entity's drawn silhouette (the six axis views,
 * rest pose, back-face culled, nearest face per pixel) whose face the device
 * drops, plus the count of box-UV cubes declared under one unit.
 *
 * Usage: bun scripts/_box_uv_loss.ts <pack.mcaddon|dir>... [--type=<regex>] [--uvfloor=v]
 *          [--px=<units>] fixed pixel size (default: the entity's largest extent / 600, at least 0.1)
 *          [--json=<out>]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';
import { droppedVisibleArea, type UvFloorModel } from '../web/src/engine/figure-holes.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const typeFilter = flag('type');
const uvFloor = (flag('uvfloor') ?? 'v') as UvFloorModel;
const fixedPx = flag('px') !== undefined ? Number(flag('px')) : undefined;
const jsonOut = flag('json');
const AXIS_VIEWS = ['+x', '-x', '+y', '-y', '+z', '-z'];

const files: string[] = [];
for (const p of args.filter(a => !a.startsWith('--'))) {
  if (statSync(p).isDirectory()) { for (const f of readdirSync(p)) if (f.endsWith('.mcaddon')) files.push(join(p, f)); }
  else files.push(p);
}
if (!files.length) { console.error('usage: bun scripts/_box_uv_loss.ts <pack.mcaddon|dir>... [--type=<regex>]'); process.exit(2); }

interface Row { typeId: string; kind: string; cubes: number; thinCubes: number; lostShare: number; lostArea: number; pixel: number }
const report: Record<string, Row[]> = {};
for (const file of files.sort()) {
  const bytes = readFileSync(file);
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const app = model.appearance;
  if (!app) continue;
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const e of model.entities) {
    if (seen.has(e.typeId)) continue;
    seen.add(e.typeId);
    if (typeFilter && !new RegExp(typeFilter).test(e.typeId)) continue;
    const entry = app.byType.get(e.typeId);
    if (!entry) continue;
    let cubes = 0, thin = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const g of entry.groups) {
      if (g.far) continue;
      for (const c of g.cubes) {
        cubes++;
        // The DECLARED size is what the device floors (an inflated cube declares more than it draws).
        const declared = c.uvSize ?? c.size;
        if (!c.faceUv && declared.some(s => Math.abs(s) < 1)) thin++;
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, c.origin[k]!); hi[k] = Math.max(hi[k]!, c.origin[k]! + c.size[k]!); }
      }
    }
    if (!cubes) continue;
    const extent = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
    const pixel = fixedPx ?? Math.max(0.1, extent / 600);
    const res = droppedVisibleArea(entry, uvFloor, { pixel, views: AXIS_VIEWS });
    rows.push({ typeId: e.typeId, kind: e.kind, cubes, thinCubes: thin, lostShare: res.share, lostArea: res.area, pixel });
    console.log(`  ${e.typeId.replace(/^craftmatic:/, '').padEnd(52)} ${String(e.kind).padEnd(9)} cubes ${String(cubes).padStart(6)}  thin ${String(thin).padStart(6)}  lost ${(100 * res.share).toFixed(1).padStart(5)} %  (${(res.area / 256).toFixed(2)} block faces, px ${pixel.toFixed(2)})`);
  }
  const worst = rows.reduce((m, r) => Math.max(m, r.lostShare), 0);
  console.log(`${basename(file)}: entities ${rows.length}, thin cubes ${rows.reduce((s, r) => s + r.thinCubes, 0)}, worst lost ${(100 * worst).toFixed(1)} %`);
  report[basename(file)] = rows;
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
