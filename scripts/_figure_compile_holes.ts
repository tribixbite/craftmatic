/**
 * Every NPC figure of a SOURCE compiled in-process exactly as the pack does
 * (`compileLdrawEntityGeometry(..., 'figure', ...)`), then measured by
 * `figureHoles` in every animation pose: the see-through holes the device
 * would draw, before a pack is built. Prints per figure the cube count, the
 * compile's cull/carve diagnostics and the distinct holes (pose + bones).
 *
 * Usage: bun scripts/_figure_compile_holes.ts <source.ldr|.mpd>... [--px=0.1] [--min=0.05]
 *          [--quality=balanced] [--json=<out>] [--quiet]
 *          [--fig=<n>] only that figure (1-based)
 *          [--raw] do not discount holes the source parts have too (default: they are discounted)
 *          [--shot=<pose>:<view>:<out.png>[:<bone regex>]] draw that figure's view (see _figure_shot.ts)
 *          [--uvfloor=v|none|both|either|u] model of the device dropping zero-UV box faces (default v, measured)
 *          [--plain] compile WITHOUT the box-UV fix (boxUvFloorSafe false): the round-29b behaviour
 * Per figure also prints `lost`: the share of its visible surface (6 axis views, rest) that the
 * device does not draw under the UV model (a torso's print showing its white body through).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import sharp from 'sharp';
import { embeddedPartTexts, parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.ts';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.ts';
import { assembleMinifig } from '../web/src/engine/minifig-rig.ts';
import { visibleCoplanarHits, worldFaces, type AuditActor } from '../web/src/engine/bedrock-geometry-faces.ts';
import { droppedVisibleArea, entryFromCompiled, figureHoles, figureReferenceSurfaces, referenceAgreement, referenceOverlay, type FigurePoseName, type UvFloorModel } from '../web/src/engine/figure-holes.ts';
import { writeHoleShot } from './_figure_shot.ts';

const CLEGO = 'C:/git/clego';
setLDrawRoot(`${CLEGO}/extracted/studio_release/app/ldraw`);
if (!process.env.CRAFTMATIC_LDRAW_REF && existsSync(`${CLEGO}/ldraw_ref`)) process.env.CRAFTMATIC_LDRAW_REF = `${CLEGO}/ldraw_ref`;

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const px = Number(opt('px') ?? 0.1);
const minArea = Number(opt('min') ?? 0.05);
const quality = (opt('quality') ?? 'balanced') as 'balanced';
const jsonOut = opt('json');
const quiet = argv.includes('--quiet');
/** Count every enclosed miss, even where the source parts are see-through too. */
const raw = argv.includes('--raw');
const files = argv.filter(a => !a.startsWith('--'));
const onlyFig = opt('fig') ? Number(opt('fig')) : undefined;
const shotSpec = opt('shot')?.split(':');
const uvFloor = (opt('uvfloor') ?? 'v') as UvFloorModel;
const plain = argv.includes('--plain');

const report: Record<string, unknown[]> = {};
let figures = 0, holed = 0, cubesTotal = 0, distinctTotal = 0, lostArea = 0, lostFigures = 0, zfightTotal = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const doc = parseLDrawDocument(synthesizeLSynth(text).text);
  seedDatTexts([...embeddedPartTexts(doc)]);
  const bricks: ParsedBrick[] = doc.bricks;
  const provider = createPartGeometryProvider();
  const scene = await discoverSceneActors(bricks, provider);
  const set = basename(file).replace(/\.(ldr|mpd)$/i, '');
  const rows: unknown[] = [];
  let setHoled = 0;
  for (const [k, fig] of scene.figures.entries()) {
    if (onlyFig !== undefined && k + 1 !== onlyFig) continue;
    const geo = await compileLdrawEntityGeometry(`fig${k + 1}`, 'figure', fig.bricks, { partGeometry: provider, quality, boxUvFloorSafe: !plain });
    const entry = entryFromCompiled(geo);
    if (shotSpec) {
      const [pose, view, out, boneRe] = shotSpec as [FigurePoseName, string, string, string | undefined];
      await writeHoleShot(entry, pose, view, out, Number(opt('shotpx') ?? 0.05), boneRe ? (b => new RegExp(boneRe).test(b)) : undefined, uvFloor);
    }
    // The source's own triangles, so a through-hole the real parts have is not counted.
    const meshes = new Map<string, LdrawPartMesh | null>();
    for (const b of fig.bricks) meshes.set(b.part, await provider.getPartMesh(b.part));
    // The rig supplies moulds a source lacked (hips, legs, a torso): their meshes too.
    for (const b of assembleMinifig(fig.bricks, meshes).bricks) if (!meshes.has(b.part)) meshes.set(b.part, await provider.getPartMesh(b.part));
    const reference = raw ? undefined : figureReferenceSurfaces(fig.bricks, meshes, geo);
    const res = figureHoles(entry, { pixel: px, minArea, reference, uvFloor });
    const lost = droppedVisibleArea(entry, uvFloor, { views: ['+x', '-x', '+y', '-y', '+z', '-z'] });
    // Different-colour faces sharing a plane (hatching on the device), as _render_fault_audit.ts counts them, in block faces.
    const actor: AuditActor = { typeId: 'figure', kind: 'figure', entry: entry as AuditActor['entry'], at: { x: 0, y: 0, z: 0 }, yawDeg: 0 };
    const zfight = visibleCoplanarHits(worldFaces([actor]), { planeEps: 0.02 }).reduce((sum, h) => sum + h.area, 0) / 256;
    const iou = reference ? referenceAgreement(entry, reference) : [];
    const overlayOut = opt('overlay');
    if (overlayOut && reference) {
      for (const v of ['+x', '+y', '+z']) {
        const o = referenceOverlay(entry, reference, v, 0.05);
        await sharp(Buffer.from(o.rgb), { raw: { width: o.W, height: o.H, channels: 3 } }).png().toFile(overlayOut.replace(/\.png$/, `-fig${k + 1}${v}.png`));
      }
    }
    if (iou.some(v => v < 0.8)) console.log(`  WARNING fig${k + 1}: the reference does not lie on the compile (axis IoU ${iou.map(v => v.toFixed(2)).join(' ')})`);
    const d = geo.diagnostics;
    const distinct = new Map<string, { n: number; area: number; views: string[] }>();
    for (const h of res.holes) {
      const key = `${h.pose} ${h.bones.join('+')}`;
      const r = distinct.get(key) ?? { n: 0, area: 0, views: [] };
      r.n++; r.area = Math.max(r.area, h.unfaithfulArea); r.views.push(h.view);
      distinct.set(key, r);
    }
    figures++; cubesTotal += res.cubes; distinctTotal += distinct.size; lostArea += lost.area; if (lost.share > 0.001) lostFigures++; zfightTotal += zfight;
    if (distinct.size) { holed++; setHoled++; }
    rows.push({ figure: k + 1, system: geo.figure?.system, cubes: res.cubes, hiddenCubesCulled: d.hiddenCubesCulled, headCubesCarved: d.headCubesCarved, merged: d.mergedCubes, boxUvInflated: d.boxUvInflated, lostShare: lost.share, lostArea: lost.area, zfight, holes: [...distinct].map(([key, r]) => ({ key, ...r })) });
    if (!quiet) {
      console.log(`  ${set} fig${k + 1} ${geo.figure?.system ?? '?'}  ref IoU ${iou.length ? Math.min(...iou).toFixed(2) : '-'}  cubes ${res.cubes}  culled ${d.hiddenCubesCulled}  carved ${d.headCubesCarved}  inflated ${d.boxUvInflated}  z-fight ${zfight.toFixed(4)} bf  lost ${(100 * lost.share).toFixed(1)}% (${lost.area.toFixed(1)} u²)  distinct holes ${distinct.size}`);
      for (const [key, r] of [...distinct].sort((a, b) => b[1].area - a[1].area).slice(0, 6)) console.log(`      ${key}  max ${r.area.toFixed(2)} u²  ${r.n} views`);
    }
  }
  console.log(`${set}: figures ${scene.figures.length}, with holes ${setHoled}`);
  report[set] = rows;
}
console.log(`TOTAL figures ${figures}, with see-through holes ${holed}, distinct (pose, bones) holes ${distinctTotal}, cubes ${cubesTotal}, figures losing surface ${lostFigures}, lost ${lostArea.toFixed(1)} u², z-fight ${zfightTotal.toFixed(4)} block faces (uv model ${uvFloor}${plain ? ', PLAIN compile' : ''})`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
