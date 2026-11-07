/**
 * Generality census probe (VEH-20): for sets the export shipped with NO rideable,
 * what do the parts say? A whole model that IS a vehicle but whose title carries
 * no vehicle word ("Airshow Aces", "Skull Motorbike", "Batwing Battle ...") is
 * left static by `classifyVehicleKind` (title words only), and the scene finder
 * (`findSceneVehicles`) skips it because a vehicle there must be at most a
 * quarter of the scene.
 *
 * Per set it prints the whole-model part evidence (`vehicleKindFromParts`), the
 * share of placements in the largest connected object, and what the scene finder
 * judged. Read it to rank the miss classes by DISTINCT sets before changing a rule.
 *
 * Usage: bun scripts/_untitled_vehicle_probe.ts <census-dir> [set…]
 *   no sets: every set the census vehicle log (`<census-dir>/../census-vehicle.log`) reports `static`.
 * Output: one TSV row per set on stdout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { vehicleKindFromParts } from '../web/src/engine/playable-components.ts';
import { findSceneVehicles, placementBox } from '../web/src/engine/scene-vehicles.ts';
import { connectedClusters } from '../web/src/engine/ldraw-entity-compiler.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const [dir, ...only] = process.argv.slice(2);
if (!dir) { console.error('usage: bun scripts/_untitled_vehicle_probe.ts <census-dir> [set…]'); process.exit(2); }

/** The sets the vehicle audit reported static (its progress lines read `<set>: static`). */
function staticSets(): string[] {
  const log = join(dirname(dir), 'census-vehicle.log');
  return readFileSync(log, 'utf8').split('\n').map(l => /^(\d+): static\b/.exec(l)?.[1]).filter((s): s is string => !!s);
}

const targets = only.length ? only : staticSets();
console.log(['set', 'label', 'bricks', 'largest-object share', 'parts kind', 'parts evidence', 'scene judged'].join('\t'));
for (const set of targets) {
  const reportFile = join(dir, `${set}.json`);
  if (!existsSync(reportFile)) { console.log(`${set}\t(no report)`); continue; }
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { file: string; label: string };
  if (!/\.(ldr|mpd)$/i.test(report.file)) { console.log(`${set}\t${report.label}\t(source ${report.file.split('.').pop()}: not read by this probe)`); continue; }
  const doc = parseLDrawDocument(readFileSync(report.file, 'utf8'));
  const provider = createPartGeometryProvider({ document: doc });
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const describe = (part: string): string => meshes.get(part)?.description ?? '';
  const evidence = vehicleKindFromParts(doc.bricks, describe);
  const boxes = doc.bricks.map(b => placementBox(b, meshes.get(b.part)));
  const largest = Math.max(0, ...connectedClusters(boxes, 4).map(c => c.length));
  const scene = findSceneVehicles(doc.bricks, meshes).candidates.filter(c => c.kind || c.wheels || c.oars || c.hull)
    .map(c => `${c.kind ?? '-'}(${c.parts}: ${c.reason})`).join('; ');
  console.log([set, report.label, doc.bricks.length, (largest / Math.max(1, doc.bricks.length)).toFixed(2), evidence.kind ?? '-', evidence.reason, scene || '-'].join('\t'));
}
