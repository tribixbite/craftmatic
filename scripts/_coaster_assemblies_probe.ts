/**
 * Throwaway measurement harness for `engine/coaster-assemblies.ts`: run the
 * track extraction and the assembly detection on a source file against the
 * local LDraw library, print the measured spec, and write the full result as
 * JSON for the runtime agent.
 *
 * Usage: bun scripts/_coaster_assemblies_probe.ts <model.ldr|.mpd> [more files…]
 * Output: output/coaster-assemblies/<stem>.json (gitignored `output/`).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.ts';
import { detectCoasterAssemblies } from '../web/src/engine/coaster-assemblies.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: bun scripts/_coaster_assemblies_probe.ts <model.ldr|.mpd> [more…]'); process.exit(2); }

const fmt = (v: readonly number[]): string => `[${v.map(n => n.toFixed(1)).join(', ')}]`;
for (const file of files) {
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const bricks = doc.bricks;
  const provider = createPartGeometryProvider({ document: doc });
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const tracks = extractCoasterTrackRoutes(bricks, { isGeometryAvailable: (_id, b) => (meshes.get(b.part)?.triangles.length ?? 0) > 0 });
  const result = detectCoasterAssemblies(bricks, meshes, tracks);

  console.log(`\n=== ${file}: ${bricks.length} bricks, ${meshes.size} parts (${provider.report().unresolved.length} unresolved)`);
  for (const [i, route] of tracks.routes.entries()) {
    const len = route.points.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - route.points[k]![0], p[1] - route.points[k]![1], p[2] - route.points[k]![2]), 0);
    console.log(`route ${i} ${route.label}: ${route.closed ? 'closed' : 'open'} ${route.fragmentIds.length} moulds ${len.toFixed(1)} LDU start=${fmt(route.points[0]!)} end=${fmt(route.points.at(-1)!)}`);
  }
  console.log(`cars: ${result.cars.length} (ride ${result.cars.filter(c => c.route).length}, stray ${result.strays.length}); originAboveDatum=${result.originAboveDatumLdu}`);
  for (const car of result.cars) {
    const r = car.route;
    console.log(`  ${car.id.padEnd(9)} ${car.chassis.part.padEnd(13)} origin=${fmt(car.frame.originLdu)} travel=${fmt(car.frame.travelWorld)} up=${fmt(car.frame.upWorld)}`);
    console.log(`            members=${car.bricks.length} wheels=${car.wheels.length} extent=${fmt(car.extentLocalLdu.min)}..${fmt(car.extentLocalLdu.max)} L/W/H=${car.lengthLdu}/${car.widthLdu}/${car.heightLdu}${car.wheelGeometry ? ` axle=${car.wheelGeometry.axleBelowOriginLdu} flange=${car.wheelGeometry.flangeRadiusLdu}` : ''}`);
    console.log(`            seats=${car.seats.map(s => `${s.source}@local${fmt(s.localLdu)}`).join(' ') || 'none'}${r ? ` route=${r.routeIndex} arc=${r.arcLdu} offset=${r.offsetLdu} above=${r.originAboveDatumLdu} heading=${r.heading}` : ' OFF-ROUTE'}`);
    const parts = new Map<string, number>();
    for (const i of car.bricks) parts.set(bricks[i]!.part, (parts.get(bricks[i]!.part) ?? 0) + 1);
    console.log(`            parts: ${[...parts].map(([p, n]) => `${p.replace(/\.dat$/, '')}x${n}`).join(' ')}`);
  }
  for (const train of result.trains) console.log(`train on route ${train.routeIndex} (${train.routeClosed ? 'closed' : 'open'}, ${train.routeLengthLdu} LDU): ${train.carIds.length} cars, pitches ${train.pitchesLdu.join('/')} mean ${train.meanPitchLdu}, extent ${train.extentLdu}`);
  for (const stray of result.strays) console.log(`stray ${stray.car.id} ${stray.car.chassis.part} at ${fmt(stray.car.frame.originLdu)}: nearest fragment ${stray.nearestFragmentId} at ${stray.nearestFragmentDistanceLdu} LDU`);
  for (const lift of result.lifts) {
    if (lift.kind === 'chain') {
      console.log(`lift CHAIN on route ${lift.routeIndex}: arcs ${lift.arcStartLdu}..${lift.arcEndLdu} rise ${lift.riseLdu} climbDirection ${lift.climbDirection}; sprockets ${lift.sprockets.map(i => `${bricks[i]!.part}@${fmt([bricks[i]!.x, bricks[i]!.y, bricks[i]!.z])}`).join(' ')}; links ${lift.links.length}`);
    } else {
      console.log(`lift PLATFORM: ${lift.bricks.length} members tilt ${lift.tiltDeg} deg, frame origin ${fmt(lift.frame.originLdu)} travel ${fmt(lift.frame.travelWorld)} up ${fmt(lift.frame.upWorld)}`);
      console.log(`    extent local ${fmt(lift.extentLocalLdu.min)}..${fmt(lift.extentLocalLdu.max)}; deck top localY ${lift.deck.topLocalY} over ${lift.deck.memberCount} members: A=${fmt(lift.deck.aLdu)} B=${fmt(lift.deck.bLdu)}; carOriginAboveDeck=${lift.carOriginAboveDeckLdu}`);
      const p = lift.parked, d = lift.travel.deliveredAt;
      console.log(`    parked: docks deck ${p.deckEnd} ${fmt(p.deckCarOriginLdu)} to ${p.routeLabel}:${p.end} terminal ${fmt(p.terminalLdu)} (car-origin ${fmt(p.terminalCarOriginLdu)}) misfit ${fmt(p.misfitLdu)} = ${p.misfitDistanceLdu}`);
      console.log(`    travel: axis ${fmt(lift.travel.axisWorld)} distance ${lift.travel.distanceLdu} -> deck ${d.deckEnd} ${fmt(d.deckCarOriginLdu)} meets ${d.routeLabel}:${d.end} terminal ${fmt(d.terminalLdu)} (car-origin ${fmt(d.terminalCarOriginLdu)}) misfit ${fmt(d.misfitLdu)} = ${d.misfitDistanceLdu}`);
      const parts = new Map<string, number>();
      for (const i of lift.bricks) parts.set(bricks[i]!.part, (parts.get(bricks[i]!.part) ?? 0) + 1);
      console.log(`    parts: ${[...parts].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p.replace(/\.dat$/, '')}x${n}`).join(' ')}`);
    }
  }
  for (const w of result.warnings) console.log(`warning: ${w}`);
  for (const w of tracks.warnings) console.log(`track warning: ${w.slice(0, 160)}`);

  mkdirSync('output/coaster-assemblies', { recursive: true });
  const out = `output/coaster-assemblies/${basename(file).replace(/\.[^.]+$/, '')}.json`;
  writeFileSync(out, JSON.stringify({ source: file, bricks: bricks.length, routes: tracks.routes.map(r => ({ label: r.label, closed: r.closed, moulds: r.fragmentIds.length, points: r.points.length })), ...result }, null, 1));
  console.log(`wrote ${out}`);
}
