/**
 * See-through holes in a built pack's FIGURES, measured from the pack's own
 * geometry in every pose the figure animations put it in.
 *
 * For each figure entity (kind `figure`, plus anything matching `--type=`),
 * for each pose (rest, the two walk extremes, sitting, the head turned), the
 * figure is rasterised ORTHOGRAPHICALLY from 26 directions (6 axes, 12 edges,
 * 8 corners) with back-face culling, as the device draws it. A pixel that
 * misses every cube but is not connected to the image border through other
 * missing pixels is a HOLE: the viewer sees the world through the figure.
 * Each hole component is reported with its area (model units², 1 unit = 1/16
 * block) and the bones of the faces around it, which names the joint or part.
 *
 * Only holes that SEE THROUGH are found this way; a dent is not. A real part
 * can have a through-hole (a minifig hand's clip); read the bones.
 *
 * Usage: bun scripts/_figure_holes.ts <pack.mcaddon|dir>... [--type=<regex>]
 *          [--px=0.1] [--min=0.05] [--poses=rest,walkA,walkB,sit,look]
 *          [--json=<out>] [--verbose] [--uvfloor=none|either|both]
 *        bun scripts/_figure_holes.ts <pack.mcaddon> --shot=<type regex>:<pose>:<view>:<out.png> [--px=0.05]
 *          one view drawn flat-shaded in the swatch colours, enclosed holes MAGENTA, the world grey
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';
import { figureHoles, FIGURE_POSES, type FigurePoseName, type UvFloorModel } from '../web/src/engine/figure-holes.ts';
import { writeHoleShot } from './_figure_shot.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const typeFilter = flag('type');
const px = Number(flag('px') ?? 0.1);
const minArea = Number(flag('min') ?? 0.05);
const poses = (flag('poses')?.split(',') ?? Object.keys(FIGURE_POSES)) as FigurePoseName[];
const jsonOut = flag('json');
const verbose = args.includes('--verbose');
/** Model the device dropping zero-UV box faces: none | either | both (figure-holes.ts UvFloorModel). */
const uvFloor = (flag('uvfloor') ?? 'none') as UvFloorModel;
const files: string[] = [];
for (const p of args.filter(a => !a.startsWith('--'))) {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) { if (f.endsWith('.mcaddon')) files.push(join(p, f)); }
  else files.push(p);
}

const shotSpec = flag('shot');
if (shotSpec) {
  const [typeRe, pose, viewName, out] = shotSpec.split(':') as [string, FigurePoseName, string, string];
  const bytes = readFileSync(files[0]!);
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const hit = model.entities.find(e => new RegExp(typeRe).test(e.typeId));
  const entry = hit ? model.appearance?.byType.get(hit.typeId) : undefined;
  if (!entry) throw new Error(`no entity matching ${typeRe}`);
  await writeHoleShot(entry, pose, viewName, out, Number(flag('px') ?? 0.05), undefined, uvFloor);
  process.exit(0);
}

const report: Record<string, unknown> = {};
let grandHoles = 0, grandFigures = 0, grandHoled = 0;
for (const file of files.sort()) {
  const bytes = readFileSync(file);
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const app = model.appearance;
  if (!app) continue;
  const rows: unknown[] = [];
  let packHoles = 0, packHoled = 0, packFigures = 0;
  for (const e of model.entities) {
    const isFigure = e.kind === 'figure';
    if (typeFilter ? !new RegExp(typeFilter).test(e.typeId) : !isFigure) continue;
    const entry = app.byType.get(e.typeId);
    if (!entry) continue;
    packFigures++;
    const res = figureHoles(entry, { pixel: px, minArea, poses, uvFloor });
    const holes = res.holes;
    if (holes.length) packHoled++;
    packHoles += holes.length;
    rows.push({ typeId: e.typeId, cubes: res.cubes, holes });
    const byPose = new Map<string, number>();
    for (const h of holes) byPose.set(h.pose, (byPose.get(h.pose) ?? 0) + 1);
    if (holes.length || verbose) {
      console.log(`  ${e.typeId.replace(/^craftmatic:/, '')}  cubes ${res.cubes}  holes ${holes.length}  ${[...byPose].map(([p, n]) => `${p}:${n}`).join(' ')}`);
      // Distinct holes: the same gap is seen from many directions; group by pose + bones.
      const distinct = new Map<string, { n: number; area: number; views: string[]; centre: number[] }>();
      for (const h of holes) {
        const key = `${h.pose} ${h.bones.join('+')}`;
        const d = distinct.get(key) ?? { n: 0, area: 0, views: [], centre: h.centre };
        d.n++; d.area = Math.max(d.area, h.area); d.views.push(h.view);
        distinct.set(key, d);
      }
      for (const [k, d] of [...distinct].sort((a, b) => b[1].area - a[1].area).slice(0, verbose ? 50 : 8)) {
        console.log(`      ${k}  max ${d.area.toFixed(2)} u²  in ${d.n} views (${d.views.slice(0, 4).join(',')}${d.views.length > 4 ? ',…' : ''})  at ${d.centre.map(v => v.toFixed(1)).join(',')}`);
      }
    }
  }
  console.log(`${basename(file)}: figures ${packFigures}, with holes ${packHoled}, hole sightings ${packHoles}`);
  grandFigures += packFigures; grandHoled += packHoled; grandHoles += packHoles;
  report[basename(file)] = rows;
}
console.log(`TOTAL figures ${grandFigures}, with holes ${grandHoled}, hole sightings ${grandHoles}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
