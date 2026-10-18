/**
 * The interactivity stage's per-set report, read back out of built packs
 * (`craftmatic-diagnostics.json` -> `interactivity`, engine/interactivity-stage.ts):
 * per set, what was found, what stayed static and why, what another entity
 * owns, and every UNHANDLED candidate - a part whose description names a
 * door, drawer, seat, bed, lever... that no rule moves yet.
 *
 * Usage: bun scripts/_ix_audit_report.ts <pack.mcaddon | dir> [--md=<file>] [--json=<file>] [--verdict=unhandled,static]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import type { InteractivityReport } from '../web/src/engine/interactivity-stage.ts';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('usage: bun scripts/_ix_audit_report.ts <pack | dir> [--md=] [--json=] [--verdict=]'); process.exit(2); }
const opt = (k: string): string | undefined => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const verdicts = new Set((opt('verdict') ?? 'found,static,unhandled').split(','));
const files = statSync(target).isDirectory() ? readdirSync(target).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(target, f)) : [target];
const out: Array<{ set: string; report: InteractivityReport | null }> = [];
const md: string[] = ['| set | found | static | unhandled | owned by other entities |', '|---|---|---|---|---|'];
const detail: string[] = [];
for (const f of files) {
  const set = f.split(/[\\/]/).pop()!.replace(/\.mcaddon$/, '');
  const b = readFileSync(f);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const name = listZipEntries(buf).find(e => e.endsWith('/craftmatic-diagnostics.json'));
  const diag = name ? JSON.parse(new TextDecoder().decode(await extractFile(buf, name))) : null;
  const report: InteractivityReport | null = diag?.interactivity ?? null;
  out.push({ set, report });
  if (!report) { md.push(`| ${set} | (no report) | | | |`); continue; }
  const list = (v: string): string => report.rows.filter(r => r.verdict === v).map(r => `${r.cls} ${r.part} x${r.count}`).join(', ') || '-';
  const found = Object.entries(report.found).map(([k, n]) => `${n} ${k}`).join(', ') || '-';
  md.push(`| ${set} | ${found} | ${list('static')} | ${list('unhandled')} | ${report.totals.excluded} |`);
  for (const r of report.rows) if (verdicts.has(r.verdict)) detail.push(`${set.padEnd(8)} ${r.verdict.padEnd(9)} ${r.cls.padEnd(8)} ${r.part.padEnd(12)} x${String(r.count).padEnd(3)} ${r.description.slice(0, 60).padEnd(60)} ${r.reason ?? ''}  at ${r.at.slice(0, 2).map(p => p.join(',')).join(' ')}`);
}
console.log(detail.join('\n'));
const totals = { found: 0, static: 0, rides: 0, excluded: 0, unhandled: 0 };
for (const o of out) if (o.report) for (const [k, v] of Object.entries(o.report.totals)) totals[k as keyof typeof totals] += v;
console.log(`${files.length} packs: placements found ${totals.found}, static ${totals.static}, rides ${totals.rides}, owned ${totals.excluded}, unhandled ${totals.unhandled}`);
if (opt('md')) writeFileSync(opt('md')!, md.join('\n') + '\n');
if (opt('json')) writeFileSync(opt('json')!, JSON.stringify(out, null, 1));
