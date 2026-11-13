/** Prints the library bounds and description of the parts the funfair fixtures use: bun scripts/_funfair_part_bounds.ts 91176 4079 ... */
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const provider = createPartGeometryProvider();
for (const id of process.argv.slice(2)) {
  const mesh = await provider.getPartMesh(`${id}.dat`);
  console.log(id, mesh ? `${mesh.description} | min ${mesh.bounds.min.map(Math.round)} max ${mesh.bounds.max.map(Math.round)}` : 'unresolved');
}
