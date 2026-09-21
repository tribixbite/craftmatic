/**
 * Device QA pack for the ride-cart runtime: a 12x4 stone pad and ONE measured
 * 10-block straight route, built through the real add-on writer. It is small
 * enough (about 33 kB) to import over wireless ADB in seconds, and keeps the
 * same pack identity every time (stem "Coaster QA" -> deterministic manifest
 * UUIDs), so a rebuilt pack upgrades the one already activated in the isolated
 * CoasterQA world instead of installing beside it.
 *
 * Usage: bun scripts/_coaster_qa_pack.ts [out.mcaddon] [--loop]
 *   --loop  also emits a closed 16-point vertical loop route, for pitch/roll
 *           animation checks that a flat straight cannot show.
 *
 * Output defaults to output/bedrock-entity-qa/coaster-qa.mcaddon (gitignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { BlockGrid } from '../src/schem/types.ts';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.ts';
import type { CoasterRoute } from '../web/src/engine/bedrock-coaster.ts';

const positional = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
const out = positional[0] ?? 'output/bedrock-entity-qa/coaster-qa.mcaddon';
const withLoop = process.argv.includes('--loop');

const WIDTH = 12, LENGTH = 4;
const grid = new BlockGrid(WIDTH, 2, LENGTH);
for (let x = 0; x < WIDTH; x++) for (let z = 0; z < LENGTH; z++) grid.set(x, 0, z, 'minecraft:stone');

const routes: CoasterRoute[] = [
  { label: 'QA straight', points: [[0, 1, 0], [10, 1, 0]], closed: false, maxSegmentLength: 10 },
];
if (withLoop) {
  // A closed vertical circle in the XY plane: every frame of pitch and roll is
  // exercised, including the inverted apex.
  const SEGMENTS = 16, RADIUS = 4;
  const loop: [number, number, number][] = Array.from({ length: SEGMENTS }, (_, index) => {
    const angle = index / SEGMENTS * Math.PI * 2;
    return [5 + Math.sin(angle) * RADIUS, 1 + RADIUS - Math.cos(angle) * RADIUS, 2] as [number, number, number];
  });
  // A closed route must repeat its first point exactly; a recomputed one would
  // not be bit-identical (sin(2*PI) is -2.4e-16, not 0).
  loop.push([...loop[0]!] as [number, number, number]);
  routes.push({ label: 'QA loop', points: loop, closed: true, maxSegmentLength: 2 });
}

const pack = await buildPlayableAddon(grid, { stem: 'Coaster QA', coasterRoutes: routes });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, pack.bytes);
console.log(`${out}\n  ${pack.bytes.byteLength} bytes  sha256=${createHash('sha256').update(pack.bytes).digest('hex')}`);
console.log(`  routes: ${routes.map(route => `${route.label} (${route.points.length} pts, ${route.closed ? 'closed' : 'open'})`).join(', ')}`);
for (const warning of pack.warnings ?? []) console.log(`  warning: ${warning}`);
