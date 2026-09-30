/**
 * Tap audit over built packs (`test/_ix-tap-audit.ts`): for every moving part,
 * how many standing spots within touch reach see one of its tap boxes first,
 * from how many the real runtime accepted the tap, and from how many of those
 * a second tap at the OPEN part closes it again. Exit 1 when a part is
 * reachable but refuses every tap; a part that opens but closes from none of
 * those spots is listed (OPENS ONLY) - a player walks round to shut it.
 *
 * Usage: bun scripts/_ix_tap_probe.ts <pack.mcaddon | dir> [--reach=3] [--all]
 *          [--trace=<label regex>] [--clipped] [--runtime=<bedrock-interactives.ts>] [--json=<out.json>]
 *
 *   --clipped   stand the player where its box overlaps a collider form (where
 *               the device leaves a player it placed or teleported into one)
 *               instead of the free spots; refusals there are listed, not failed.
 *   --runtime   run the `interactivesScript` of another copy of
 *               web/src/engine/bedrock-interactives.ts (a base commit's
 *               archive) over the same packs: the before of a runtime change.
 *   --json      every part's counts and (with --trace or --json) every spot.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditPackTaps, type TapAuditOptions } from '../test/_ix-tap-audit.ts';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('usage: bun scripts/_ix_tap_probe.ts <pack.mcaddon | dir> [--reach=3] [--all] [--trace=<re>] [--clipped] [--runtime=<file>] [--json=<out>]'); process.exit(2); }
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const reach = Number(flag('reach') ?? 3);
const all = args.includes('--all');
const traceRe = flag('trace');
const clipped = args.includes('--clipped');
const runtime = flag('runtime');
const jsonOut = flag('json');
const script = runtime ? ((await import(pathToFileURL(resolve(runtime)).href)) as { interactivesScript: NonNullable<TapAuditOptions['script']> }).interactivesScript : undefined;
const files = statSync(target).isDirectory() ? readdirSync(target).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(target, f)) : [target];
let refused = 0, unreachable = 0, oneWay = 0, total = 0;
const report: Array<{ pack: string; parts: unknown[] }> = [];
for (const f of files) {
  const b = readFileSync(f);
  const audit = await auditPackTaps(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), { reach, trace: !!traceRe || !!jsonOut, spots: clipped ? 'clipped' : 'free', ...(script ? { script } : {}) });
  const name = f.split(/[\\/]/).pop()!;
  report.push({ pack: name, parts: audit.parts });
  for (const p of audit.parts) {
    total++;
    const bad = p.reachable > 0 && p.accepted === 0;
    // Opens from somewhere but closes again from none of those spots: a player must walk round to shut it.
    const stuck = p.accepted > 0 && p.closable === 0;
    if (bad) refused++;
    if (stuck) oneWay++;
    if (!p.reachable) unreachable++;
    if (all || bad || stuck || (!p.reachable && !clipped)) console.log(`${name.padEnd(44)} ${p.label.padEnd(20)} reachable ${String(p.reachable).padStart(4)}  accepted ${String(p.accepted).padStart(4)}  closes ${String(p.closable).padStart(4)}  boxes ${p.boxes} (unreached ${p.unreachedBoxes})${bad ? '  REFUSED' : stuck ? '  OPENS ONLY' : !p.reachable ? '  OUT OF REACH' : ''}`);
    if (traceRe && new RegExp(traceRe, 'i').test(p.label)) for (const s of p.spots ?? []) console.log(`   ${s.ok ? (s.closes ? 'ok     ' : 'OPENS  ') : 'REFUSED'} feet ${s.at.map(v => v.toFixed(2)).join(', ')}`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
console.log(`${files.length} packs, ${total} parts${clipped ? ' (CLIPPED spots: the player overlapping a collider form)' : ''}: ${refused} refuse every tap, ${oneWay} open but close again from no spot that opened them, ${unreachable} out of reach from any ${clipped ? 'clipped' : 'standing'} spot`);
process.exit(refused && !clipped ? 1 : 0);
