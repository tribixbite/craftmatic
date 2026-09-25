/**
 * Where is a seat mould's sitting surface? For each part id given, the part's
 * local bounds and the topmost surface a vertical line meets at its footprint
 * centre (`seatPanLocalY`), against the fixed `origin - 8` the moulded-seat
 * rule uses (4079: the origin is under the pan).
 *
 * Usage: bun scripts/_seat_pan_probe.ts <part.dat>...
 */
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.ts';
import { seatPanLocalY } from '../web/src/engine/bedrock-scene-actors.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const provider = createPartGeometryProvider();
for (const part of process.argv.slice(2)) {
  const m = await provider.getPartMesh(part);
  if (!m) { console.log(`${part}: not found`); continue; }
  console.log(`${part} "${m.description}": bounds y ${m.bounds.min[1]}..${m.bounds.max[1]}, x ${m.bounds.min[0]}..${m.bounds.max[0]}, z ${m.bounds.min[2]}..${m.bounds.max[2]}; pan at centre y ${seatPanLocalY(m)} (mould rule: -8)`);
}
