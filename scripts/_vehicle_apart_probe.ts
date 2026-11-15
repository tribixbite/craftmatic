/**
 * What `vehicleApartFromScenery` leaves out of a titled vehicle (audit 2026-11-15, generalisation 2): the parts it
 * reads as scenery standing apart, by mould and description, so a split can be judged before a pack is built.
 * Usage: bun scripts/_vehicle_apart_probe.ts <source.ldr|.mpd> <car|boat>
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { vehicleApartFromScenery } from '../web/src/engine/scene-vehicles.ts';
import { withoutBuildTools } from '../web/src/engine/build-tools.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';

const [file, kind] = process.argv.slice(2) as [string, 'car' | 'boat'];
// The CLI's library (scripts/_playable_ref.ts): the Studio snapshot, then clego's local mirror copy.
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
if (!process.env.CRAFTMATIC_LDRAW_REF) process.env.CRAFTMATIC_LDRAW_REF = 'C:/git/clego/ldraw_ref';
const bricks = withoutBuildTools(parseLDrawDocument(readFileSync(file, 'utf8')).bricks).bricks;
const provider = createPartGeometryProvider();
const meshes = new Map<string, LdrawPartMesh | null>();
await Promise.all([...new Set(bricks.map(b => b.part))].map(async p => { meshes.set(p, await provider.getPartMesh(p)); }));
const apart = vehicleApartFromScenery(bricks, meshes, kind);
if (!apart) { console.log('no split: the whole model stays the vehicle'); process.exit(0); }
console.log(apart.reason);
const byPart = new Map<string, number>();
for (const b of apart.scenery) { const k = `${b.part} ${meshes.get(b.part)?.description ?? ''}`; byPart.set(k, (byPart.get(k) ?? 0) + 1); }
for (const [k, n] of [...byPart].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${k}`);
