/**
 * Runs the funfair detector over model files against the local library and lists every ride it finds: a false
 * positive would move a ring out of a model that has none (the detector must find nothing in the favourites).
 *
 *   bun scripts/_funfair_scan.ts <model.ldr>...
 *   bun scripts/_funfair_scan.ts --favourites      (DbixConvV3/<set>.ldr for the 40 favourite sets that have one)
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.js';
import { findFunfairRides } from '../web/src/engine/rides/funfair-detect.js';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const FAVOURITES = '10261 10303 10326 10337 10341 10354 10365 11371 11374 21061 21063 21318 21360 31141 41395 41703 41732 42172 42639 42652 42663 42670 43267 60380 60446 71040 71043 75397 76269 76286 76417 76419 76435 76457 77092 80049 910004 910032 910047 910049'.split(' ');
const args = process.argv.slice(2);
const files = args.includes('--favourites') ? FAVOURITES.map(s => `C:/git/clego/lego_sets/DbixConvV3/${s}.ldr`).filter(existsSync) : args;
let found = 0;
for (const file of files) {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const scene = await discoverSceneActors(doc.bricks);
  const rides = findFunfairRides(doc.bricks, scene.meshes, scene.figureBricks);
  found += rides.length;
  console.log(`${file}: ${doc.bricks.length} parts, ${rides.length} funfair ride(s)${rides.map(r => ` [${r.kind} ${r.seats.length} seats]`).join('')}`);
}
console.log(`${files.length} model(s), ${found} funfair ride(s) found`);
