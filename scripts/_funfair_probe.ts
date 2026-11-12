/** Finds the funfair rides in the fixtures against the local library: bun scripts/_funfair_probe.ts */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.js';
import { findFunfairRides } from '../web/src/engine/rides/funfair-detect.js';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
for (const file of process.argv.slice(2)) {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const scene = await discoverSceneActors(doc.bricks);
  const rides = findFunfairRides(doc.bricks, scene.meshes, scene.figureBricks);
  console.log(file, doc.bricks.length, 'parts;', rides.length, 'ride(s)');
  for (const r of rides) console.log(' ', r.kind, r.part, 'seats', r.seats.length, 'car', r.carBricks.length, 'rise LDU', r.seats[0]!.pathLdu[0]![1] - r.seats[0]!.pathLdu[1]![1], 'seat0', r.seats[0]!.pathLdu.map(p => p.map(Math.round).join(',')).join(' | '), 'exit', r.seats[0]!.exitLdu.map(Math.round).join(','));
}
