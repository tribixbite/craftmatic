/**
 * Render-fault audit of built packs: coplanar different-colour faces (z-fight
 * hatching / strobing) inside one actor and between actors drawn together,
 * and near-zero-thickness cubes. See `web/src/ui/addon-render-audit.ts`.
 *
 * Usage: bun scripts/_render_fault_audit.ts [--json=<out>] [--top=N] <pack.mcaddon|dir>...
 *   A directory is searched (one level) for *.mcaddon.
 * Prints per pack: z-fight area within each actor and per actor pair, in
 * block faces (1.0 = one full block face), with the worst places.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAddonPreviewModel, placedPoint, entitySpawnsAt } from '../web/src/ui/addon-preview-data.ts';
import { visibleCoplanarHits, thinCubes, worldFaces, type AuditActor, type CoplanarHit } from '../web/src/engine/bedrock-geometry-faces.ts';

const args = process.argv.slice(2);
const jsonOut = args.find(a => a.startsWith('--json='))?.slice(7);
const top = Number(args.find(a => a.startsWith('--top='))?.slice(6) ?? 5);
const only = args.find(a => a.startsWith('--only='))?.slice(7);
const explain = Number(args.find(a => a.startsWith('--explain='))?.slice(10) ?? 0);
const inputs = args.filter(a => !a.startsWith('--'));
const files: string[] = [];
for (const p of inputs) {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p)) { if (f.endsWith('.mcaddon')) files.push(join(p, f)); }
  else files.push(p);
}

const report: Record<string, unknown> = {};
for (const file of files.sort()) {
  const bytes = readFileSync(file);
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const app = model.appearance;
  if (!app) { console.log(`${basename(file)}: no appearance`); continue; }
  const actors: AuditActor[] = [];
  for (const e of model.entities) {
    if (!entitySpawnsAt(e, 100)) continue;
    if (only && !only.split(',').some(k => e.kind === k)) continue;
    const entry = app.byType.get(e.typeId);
    if (!entry) continue;
    actors.push({ typeId: e.typeId, kind: e.kind, entry, at: placedPoint(e, model.dims, 100, 0), yawDeg: e.yaw });
  }
  const faces = worldFaces(actors);
  // Coaster cars all stand on the station point in the placement record; the
  // ride runtime spaces them along the track on spawn, so car-against-car
  // overlaps here are the record, not the game.
  const hits = visibleCoplanarHits(faces, { planeEps: Number(args.find(a => a.startsWith('--eps='))?.slice(6) ?? 0.02) }).filter(h => !(h.a.actor !== h.b.actor && actors[h.a.actor]!.kind === 'car' && actors[h.b.actor]!.kind === 'car'));
  const sameColourArea = 0;
  const pairArea = new Map<string, { area: number; n: number; worst: CoplanarHit[] }>();
  for (const h of hits) {
    const ka = actors[h.a.actor]!.typeId.replace(/^craftmatic:/, ''), kb = actors[h.b.actor]!.typeId.replace(/^craftmatic:/, '');
    const key = ka === kb ? ka : [ka, kb].sort().join(' x ');
    let r = pairArea.get(key);
    if (!r) pairArea.set(key, r = { area: 0, n: 0, worst: [] });
    r.area += h.area / 256; r.n++;
    r.worst.push(h);
  }
  const total = hits.reduce((s, h) => s + h.area, 0) / 256;
  const thin = actors.reduce((s, a) => s + thinCubes(a.entry), 0);
  console.log(`${basename(file)}  actors ${actors.length}  faces ${faces.length.toLocaleString()}  z-fight pairs ${hits.length.toLocaleString()}  area ${total.toFixed(2)} block faces  same-colour ${(sameColourArea / 256).toFixed(2)}  thin cubes ${thin}`);
  const rows = [...pairArea].sort((a, b) => b[1].area - a[1].area);
  for (const [key, r] of rows.slice(0, top)) {
    r.worst.sort((a, b) => b.area - a.area);
    const w = r.worst[0]!;
    console.log(`   ${key.padEnd(60)} ${String(r.n).padStart(6)} pairs ${r.area.toFixed(3).padStart(9)} bf   worst ${(w.area / 256).toFixed(3)} at [${w.at.map(v => v.toFixed(2)).join(', ')}] ${w.a.colour} / ${w.b.colour} gap ${w.gap.toFixed(3)}`);
  }
  if (explain) {
    const cubeOf = (r: CoplanarHit['a']) => { const g = actors[r.actor]!.entry.groups[r.group]!; const c = g.cubes[r.cube]!; const b = actors[r.actor]!.entry.bones.find(x => x.name === c.bone); return `${actors[r.actor]!.typeId.replace(/^craftmatic:/, '')} ${r.colour} ${r.face} bone ${c.bone}${b?.rotation ? ' rot ' + JSON.stringify(b.rotation) : ''} o ${JSON.stringify(c.origin)} s ${JSON.stringify(c.size)}${c.rotation ? ' crot ' + JSON.stringify(c.rotation) : ''}`; };
    for (const h of [...hits].sort((a, b) => b.area - a.area).slice(0, explain)) {
      console.log(`  * ${(h.area / 256).toFixed(3)} bf at [${h.at.map(v => v.toFixed(2)).join(', ')}] gap ${h.gap.toFixed(3)}
      A ${cubeOf(h.a)}
      B ${cubeOf(h.b)}`);
    }
  }
  report[basename(file)] = {
    actors: actors.length, faces: faces.length, hits: hits.length, area: total, sameColour: sameColourArea / 256, thin,
    pairs: Object.fromEntries(rows.map(([k, r]) => [k, { n: r.n, area: r.area, worst: r.worst.slice(0, 20).map(h => ({ area: h.area / 256, at: h.at, a: h.a.colour, b: h.b.colour, gap: h.gap, normal: h.normal })) }])),
  };
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
