/**
 * Does a source's coaster track stitch into a route, and if not, why not?
 *
 * A set whose track does not stitch looks like scattered arcs in game with no
 * warning that anything is wrong, and the cause is never obvious from the
 * picture. This separates the three it can be:
 *
 *   - a mould the extractor has no profile for (it is invisible to routing),
 *   - pieces that TOUCH but whose tangents disagree (a profile or orientation
 *     fault), and
 *   - pieces that are simply APART in the source (nothing to stitch).
 *
 * It also flags whether each mould has an LDD→LDraw alignment entry, because
 * a mould with none is placed from its raw LDD origin and lands studs away —
 * which is exactly why 42703 Mermaid Roller Coaster Ride routes nothing while
 * its three ALIGNED pieces join each other and its seven unaligned ones do not.
 *
 * Usage: bun scripts/_coaster_route_probe.ts <model.ldr> [more.ldr …]
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.ts';
import { coasterTrackProfile, extractCoasterTrackFragments, extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.ts';
import { stitchCoasterTrackFragments } from '../web/src/engine/coaster-path.ts';
import { partStem } from '../web/src/engine/part-id.ts';

/** The endpoint tolerance and tangent agreement the extractor itself uses. */
const TOLERANCE_LDU = 3;
const MIN_TANGENT_DOT = 0.97;

const partMap = JSON.parse(readFileSync('web/public/ldd-part-map.json', 'utf8')) as Record<string, unknown>;
const mapEntries = (partMap['entries'] ?? partMap) as Record<string, unknown>;
const measured = JSON.parse(readFileSync('web/public/ldd-measured-align.json', 'utf8')) as Record<string, unknown>;
const measEntries = (measured['entries'] ?? measured) as Record<string, unknown>;
const alignmentOf = (mould: string): string =>
  mapEntries[mould] ? 'ldraw.xml'
    : measEntries[mould] ? 'measured'
    : 'NONE';

const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: bun scripts/_coaster_route_probe.ts <model.ldr> [more.ldr …]');
  process.exit(64);
}

for (const file of files) {
  const label = file.replace(/.*lego_sets[/\\]/, '');
  let bricks;
  try { bricks = parseLDrawDocument(readFileSync(file, 'latin1')).bricks; }
  catch (err) { console.log(`\n=== ${label}: UNREADABLE — ${(err as Error).message}`); continue; }

  const known = new Map<string, number>();
  for (const b of bricks) {
    const p = coasterTrackProfile(b.part);
    if (p) known.set(p.partId, (known.get(p.partId) ?? 0) + 1);
  }
  console.log(`\n=== ${label} — ${bricks.length} bricks ===`);
  if (!known.size) { console.log('  no recognised track moulds'); continue; }

  console.log('  track moulds, and whether an LDD→LDraw alignment exists for each:');
  for (const [id, n] of [...known].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)} x ${id.padEnd(8)} alignment: ${alignmentOf(partStem(id))}`);
  }

  const routes = extractCoasterTrackRoutes(bricks);
  console.log(`  routes: ${routes.routes.length}`);
  for (const [i, r] of routes.routes.entries()) {
    const pts = r.points ?? [];
    let len = 0;
    for (let k = 1; k < pts.length; k++) {
      len += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1], pts[k]![2] - pts[k - 1]![2]);
    }
    console.log(`    route ${i}: ${(len / 20).toFixed(1)} studs, closed=${(r as { closed?: boolean }).closed ?? '?'}`);
  }

  const graph = stitchCoasterTrackFragments(extractCoasterTrackFragments(bricks), {
    endpointToleranceLdu: TOLERANCE_LDU, minTangentDot: MIN_TANGENT_DOT, overlapToleranceLdu: 8,
  });
  console.log('  components (a lone mould is a piece that joined nothing):');
  for (const c of [...graph.components].sort((a, b) => b.length - a.length)) {
    const moulds = c.map(id => id.split(':')[0]!);
    console.log(`    ${String(c.length).padStart(2)}: ` + moulds.map(m => `${m}[${alignmentOf(m)}]`).join(' + '));
  }

  // For every endpoint that joined nothing, say how far the nearest one is and
  // whether the tangents would have allowed the join.
  const d = (p: readonly number[], q: readonly number[]): number =>
    Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
  const open = graph.endpoints.filter(e => !graph.connections.some(c => c.a === e.key || c.b === e.key));
  if (open.length) {
    let touching = 0, apart = 0;
    for (const e of open) {
      let best: { o: typeof e; dist: number } | null = null;
      for (const o of graph.endpoints) {
        if (o.fragmentId === e.fragmentId) continue;
        const dist = d(e.point, o.point);
        if (!best || dist < best.dist) best = { o, dist };
      }
      if (!best) continue;
      if (best.dist <= TOLERANCE_LDU) touching++; else apart++;
    }
    console.log(`  open endpoints: ${open.length} — ${touching} within ${TOLERANCE_LDU} LDU of another (a profile or tangent fault), ${apart} genuinely apart`);
  }
}
