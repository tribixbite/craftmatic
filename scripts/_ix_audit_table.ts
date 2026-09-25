/**
 * The 40-set interactivity audit table (docs/bedrock-interactivity.md "The
 * 40-set audit"): for each set, what the interactivity stage FOUND (read from
 * the pack's own diagnostics), what a person looking at renders of the source
 * SAW (output/interactivity-0924/audit-visual/<set>.json, one per set), the
 * difference per class (MISSED where fewer were found than seen; MORE where
 * more were found - hidden interiors or false positives, read the rows), what
 * the stage left STATIC and why, the doorways a player walks through at 100 %
 * and at the recommended size, and the in-game GameTest verdict when a
 * device log is given (`CMGT` lines, one file per set).
 *
 * Usage: bun scripts/_ix_audit_table.ts <sweep dir> [--visual=<dir>] [--walk=<favorites-ix.json>]
 *        [--gametest=<dir with <set>.log>] [--md=<file>] [--json=<file>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import type { InteractivityReport } from '../web/src/engine/interactivity-stage.ts';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--'));
if (!dir) { console.error('usage: bun scripts/_ix_audit_table.ts <sweep dir> [--visual=] [--walk=] [--gametest=] [--md=] [--json=]'); process.exit(2); }
const opt = (k: string): string | undefined => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const visualDir = opt('visual') ?? 'output/interactivity-0924/audit-visual';
const walk = opt('walk') ? JSON.parse(readFileSync(opt('walk')!, 'utf8')) as Array<{ set: string; at100: Record<string, number>; atPassSize?: Record<string, number>; doorways: number }> : [];
const gtDir = opt('gametest');

/** The visual audit's classes, folded onto the stage's. */
const CLASS_OF: Record<string, string> = {
  door: 'door', gate: 'gate', 'window/shutter': 'window', window: 'window', 'hatch/trap door': 'hatch', hatch: 'hatch',
  'cupboard/drawer/chest lid': 'container', seat: 'seat', bed: 'bed', 'lever/crank': 'lever',
  "turntable/steering wheel/ship's wheel/propeller/rotor": 'turnable', 'turntable/steering wheel': 'turnable', 'other mechanism': 'mechanism',
};
const STAGE_TO: Record<string, string> = { door: 'door', gate: 'gate', window: 'window', hatch: 'hatch', cabinet: 'container', drawer: 'container', lid: 'container', seat: 'seat', bed: 'bed', lever: 'lever', turnable: 'turnable' };
const ORDER = ['door', 'gate', 'window', 'hatch', 'container', 'seat', 'bed', 'lever', 'turnable', 'mechanism'];

interface Row { set: string; found: Record<string, number>; seen: Record<string, number>; seenBrick: Record<string, number>; missed: Record<string, number>; more: Record<string, number>; statics: string[]; walk: string; gametest: string }
const rows: Row[] = [];
for (const f of readdirSync(dir).filter(n => n.endsWith('.mcaddon')).sort()) {
  const set = f.replace(/\.mcaddon$/, '');
  const b = readFileSync(join(dir, f));
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const name = listZipEntries(buf).find(e => e.endsWith('/craftmatic-diagnostics.json'));
  const report: InteractivityReport | null = name ? JSON.parse(new TextDecoder().decode(await extractFile(buf, name))).interactivity ?? null : null;
  const found: Record<string, number> = {};
  for (const [k, n] of Object.entries(report?.found ?? {})) found[STAGE_TO[k] ?? k] = (found[STAGE_TO[k] ?? k] ?? 0) + (n ?? 0);
  const seen: Record<string, number> = {}, seenBrick: Record<string, number> = {};
  const vf = join(visualDir, `${set}.json`);
  if (existsSync(vf)) {
    const v = JSON.parse(readFileSync(vf, 'utf8')) as { items?: Array<{ class: string; count?: number; builtFrom?: string; confidence?: string }> };
    for (const it of v.items ?? []) {
      // Low-confidence sightings are listed in the JSON but not counted: a guess is not a miss.
      if ((it.confidence ?? '').toLowerCase() === 'low') continue;
      const c = CLASS_OF[(it.class ?? '').toLowerCase()] ?? 'mechanism';
      seen[c] = (seen[c] ?? 0) + (it.count ?? 1);
      if ((it.builtFrom ?? '') === 'brick-built') seenBrick[c] = (seenBrick[c] ?? 0) + (it.count ?? 1);
    }
  }
  const missed: Record<string, number> = {}, more: Record<string, number> = {};
  for (const c of ORDER) {
    const d = (seen[c] ?? 0) - (found[c] ?? 0);
    if (d > 0) missed[c] = d; else if (d < 0) more[c] = -d;
  }
  const statics = (report?.rows ?? []).filter(r => r.verdict === 'static').map(r => `${r.part} x${r.count}: ${r.reason}`);
  const w = walk.find(x => x.set === set);
  const walkText = w ? (w.doorways ? `${w.at100.OK ?? 0}/${w.doorways} at 100 %${w.atPassSize && (w.atPassSize.OK ?? 0) > (w.at100.OK ?? 0) ? `, ${w.atPassSize.OK} at its size` : ''}` : 'no doorways') : '';
  let gametest = '';
  if (gtDir && existsSync(join(gtDir, `${set}.log`))) {
    const log = readFileSync(join(gtDir, `${set}.log`), 'utf8');
    const doors = [...log.matchAll(/CMGT SUMMARY (\{.*\})/g)].map(m => JSON.parse(m[1]!));
    const parts = [...log.matchAll(/CMGT PARTS_SUMMARY (\{.*\})/g)].map(m => JSON.parse(m[1]!));
    const dOk = doors.reduce((n, d) => n + d.asPredicted, 0), dAll = doors.reduce((n, d) => n + d.doorways, 0);
    const pOk = parts.reduce((n, p) => n + p.passed, 0), pAll = parts.reduce((n, p) => n + p.parts + p.seats, 0);
    const failed = [...doors.flatMap(d => d.differ), ...parts.flatMap(p => p.failed)];
    gametest = `${dAll ? `doors ${dOk}/${dAll}` : ''}${dAll && pAll ? ', ' : ''}${pAll ? `parts+seats ${pOk}/${pAll}` : ''}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}` || 'ran, nothing to test';
  }
  rows.push({ set, found, seen, seenBrick, missed, more, statics, walk: walkText, gametest });
}
const fmt = (r: Record<string, number>): string => ORDER.filter(c => r[c]).map(c => `${r[c]} ${c}`).join(', ') || '-';
const md = ['| set | found | seen in renders (brick-built) | missed | found more | doorways walked | GameTest |', '|---|---|---|---|---|---|---|'];
for (const r of rows) {
  const seenText = ORDER.filter(c => r.seen[c]).map(c => `${r.seen[c]} ${c}${r.seenBrick[c] ? ` (${r.seenBrick[c]})` : ''}`).join(', ') || '-';
  md.push(`| ${r.set} | ${fmt(r.found)} | ${seenText} | ${fmt(r.missed)} | ${fmt(r.more)} | ${r.walk || '-'} | ${r.gametest || 'not run'} |`);
}
console.log(md.join('\n'));
if (opt('md')) writeFileSync(opt('md')!, md.join('\n') + '\n');
if (opt('json')) writeFileSync(opt('json')!, JSON.stringify(rows, null, 1));
