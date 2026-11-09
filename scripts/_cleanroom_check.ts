/**
 * Clean-room clearance: score a finished design against the corpus files of the landmark it depicts (plan A 3.3).
 *
 *   bun scripts/_cleanroom_check.ts <design.ldr> --keywords "notre dame,eiffel" --by <checker-id>
 *        [--corpus <lego_sets>] [--index <index.json>] [--log <provenance.json>] [--at <iso-time>]
 *
 * Run by a DIFFERENT agent than the designer, after the design is final. For every LDraw text file (.ldr/.mpd) of
 * every denylisted set it computes the similarity core's numbers, prints a table for the checker, and emits the
 * provenance `clearance` rows (`CleanroomResult[]`, the compared path hashed) on stdout as JSON. With `--log` the rows
 * are appended to that provenance log's `clearance`. A `review` verdict is a flag for the user and the lawyer, not an
 * automatic fail; the designer never sees the compared file.
 *
 * Exit code: 0 = every comparison independent, 1 = at least one `review`, 2 = usage error.
 * TODO(cleanroom-binary-sources): `.io` / `.lxf` corpus files are not compared (text LDraw only); a landmark whose
 * only corpus copy is an `.io` is reported as `skipped` rather than as independent.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { sourceHash12 } from '../web/src/engine/pipeline-version.ts';
import {
  cleanroomResult, compareFingerprints, fingerprintBricks, matchDenylist, verdictOf, type DenylistIndex,
} from '../web/src/engine/byom/fingerprint.ts';
import type { CleanroomResult } from '../web/src/brickgen/types.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const design = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const keywords = (flag('keywords') ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const by = flag('by');
if (!design || keywords.length === 0 || !by) {
  console.error('usage: bun scripts/_cleanroom_check.ts <design.ldr> --keywords "a,b" --by <checker> [--corpus dir] [--index file] [--log provenance.json] [--at iso]');
  process.exit(2);
}
const corpus = flag('corpus') ?? 'C:/git/clego/lego_sets';
const index = JSON.parse(readFileSync(flag('index') ?? 'web/public/lego-models-index.json', 'utf8')) as DenylistIndex;
const at = flag('at') ?? new Date().toISOString();

const designBytes = new Uint8Array(readFileSync(design));
const query = fingerprintBricks(parseLDraw(new TextDecoder().decode(designBytes)), { hash12: sourceHash12(designBytes), orientations: true });
if (query.count === 0) { console.error(`${design} has no placed parts`); process.exit(2); }

const rows: CleanroomResult[] = [];
let skipped = 0;
console.error(`design ${design}: ${query.count} parts`);
console.error('verdict      score  inv   lay   cos   iou   file');
for (const entry of matchDenylist(index, keywords)) {
  for (const path of entry.paths) {
    const file = join(corpus, path);
    if (!/\.(ldr|mpd)$/i.test(path) || !existsSync(file)) { skipped++; continue; }
    const bytes = new Uint8Array(readFileSync(file));
    const bricks = parseLDraw(new TextDecoder().decode(bytes));
    if (bricks.length === 0) { skipped++; continue; }
    const sim = compareFingerprints(query, fingerprintBricks(bricks, { hash12: sourceHash12(bytes), orientations: false }));
    rows.push(cleanroomResult(sim, path, by, at));
    console.error(`${verdictOf(sim).padEnd(12)} ${sim.score.toFixed(2)}  ${sim.inventory.toFixed(2)}  ${sim.layout.toFixed(2)}  ${sim.cosine.toFixed(2)}  ${(sim.placementIoU ?? 0).toFixed(2)}  ${entry.setId} ${path}`);
  }
}
console.error(`${rows.length} files compared, ${skipped} skipped (not text LDraw or absent)`);
if (rows.length === 0) console.error('WARNING: nothing was compared, so this is NOT a clearance');

const logPath = flag('log');
if (logPath) {
  const log = JSON.parse(readFileSync(logPath, 'utf8')) as { clearance: CleanroomResult[] };
  log.clearance = [...(log.clearance ?? []), ...rows];
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);
}
console.log(JSON.stringify(rows, null, 2));
process.exit(rows.length === 0 || rows.some((r) => r.verdict === 'review') ? 1 : 0);
