/**
 * Reports: every scenario's result per pack as JSON (for tools) and markdown
 * (for people), and the unmodelled API members ranked by how often scripts
 * reached them across the run - the simulator's roadmap.
 */

import type { UnmodelledUse } from '../core/timeline.js';
import { tapReachOf, type ScenarioResult } from './runner.js';

/** Every scenario of one pack. */
export interface PackReport {
  pack: string;
  label?: string;
  results: ScenarioResult[];
  ms: number;
  /** A pack the run could not load or read (not a craftmatic pack, a bad archive). */
  error?: string;
}

/** Unmodelled members summed over results, most used first. */
export function unmodelledTotals(results: readonly ScenarioResult[]): UnmodelledUse[] {
  const by = new Map<string, UnmodelledUse>();
  for (const r of results) for (const u of r.unmodelled) {
    const cur = by.get(u.member) ?? { member: u.member, count: 0, sources: [], firstTick: u.firstTick };
    cur.count += u.count;
    for (const s of u.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
    by.set(u.member, cur);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.member.localeCompare(b.member));
}

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The markdown report of a run over packs. */
export function markdownReport(reports: readonly PackReport[], title = 'Simulator run'): string {
  const all = reports.flatMap(r => r.results);
  const count = (st: string): number => all.filter(r => r.status === st).length;
  const lines: string[] = [`# ${title}`, '', `${reports.length} packs, ${all.length} scenarios: ${count('pass')} pass, ${count('fail')} fail, ${count('unknown')} unknown (unmodelled API reached), ${count('error')} error.`, ''];
  lines.push('| pack | scenarios | pass | fail | unknown | error | violations | seconds |', '|---|---|---|---|---|---|---|---|');
  for (const r of reports) {
    const st = (s: string): number => r.results.filter(x => x.status === s).length;
    lines.push(`| ${esc(r.pack)}${r.error ? ` (${esc(r.error)})` : ''} | ${r.results.length} | ${st('pass')} | ${st('fail')} | ${st('unknown')} | ${st('error')} | ${r.results.reduce((n, x) => n + x.violations.length, 0)} | ${(r.ms / 1000).toFixed(1)} |`);
  }
  lines.push('', '## Violations', '');
  for (const r of reports) for (const res of r.results) {
    for (const v of res.violations) lines.push(`- **${esc(r.pack)}** \`${res.name}\` [${v.invariant}] tick ${v.tick}${v.step ? ` (${esc(v.step)})` : ''}: ${esc(v.message)}`);
    for (const s of res.steps.filter(x => !x.ok)) lines.push(`- **${esc(r.pack)}** \`${res.name}\` step ${esc(s.label)} ERROR: ${esc(s.error ?? '?')}`);
  }
  // Walked approaches (`--walk`): every tap target the child could not reach on foot (IX-04: invisible geometry may
  // unlock, never restrict - a target unreachable on foot is the model's or a restriction to read, never a failure).
  const walked = reports.flatMap(r => r.results.flatMap(res => tapReachOf(res.state).map(t => ({ pack: r.pack, scenario: res.name, ...t }))));
  if (walked.length) {
    const off = walked.filter(t => !t.onFoot);
    lines.push('', '## Tap targets unreachable on foot (`tap-target-unreachable-on-foot`)', '', `${walked.length} walked approaches: ${walked.length - off.length} reached on foot, ${off.length} not.`, '');
    if (off.length) {
      lines.push('| pack | scenario | target | why |', '|---|---|---|---|');
      for (const t of off) lines.push(`| ${esc(t.pack)} | ${esc(t.scenario)} | ${esc(t.label)} | ${esc(t.why ?? '')} |`);
    }
  }
  const ranking = unmodelledTotals(all);
  lines.push('', '## Unmodelled API members, by uses', '');
  if (!ranking.length) lines.push('None reached.');
  else { lines.push('| member | uses | scripts |', '|---|---|---|'); for (const u of ranking) lines.push(`| \`${esc(u.member)}\` | ${u.count} | ${u.sources.join(', ')} |`); }
  return `${lines.join('\n')}\n`;
}

/** A regression row: the case, what the old pack did, what the new one did. */
export interface RegressionRow {
  id: string; title: string; evidence: string; expectNew: string;
  old: { reproduced: boolean; attribution?: string; evidence: string; status: string; ms: number; untested?: string } | { error: string };
  new: { reproduced: boolean; attribution?: string; evidence: string; status: string; ms: number; untested?: string } | { error: string };
  verdict: string;
  limits?: string;
}

/** The regression table in markdown. */
export function regressionMarkdown(rows: readonly RegressionRow[]): string {
  const cell = (x: RegressionRow['old']): string => ('error' in x ? `ERROR ${esc(x.error)}` : `${x.reproduced ? 'REPRODUCED' : 'not reproduced'}${x.attribution ? ` (${x.attribution}'s)` : ''}${x.untested ? ` (UNTESTED: ${esc(x.untested)})` : ''} - ${esc(x.evidence)}`);
  const lines = ['# Regression set', ''];
  // Cases the simulator is KNOWN not to reproduce pass only their new-pack check: say so before the table, so a
  // green run is never read as "every device bug reproduces".
  const known = rows.filter(r => r.verdict.startsWith('KNOWN-UNREPRODUCED'));
  if (known.length) lines.push(`**${known.length} known-unreproduced case(s)** (the old pack does not show the device bug here; only the current pack's check ran): ${known.map(r => `\`${r.id}\``).join(', ')}`, '');
  // Open device defects: reproduced, and still reproduced on the current pack (no fix yet) - not a pass either.
  const open = rows.filter(r => r.verdict.startsWith('OPEN'));
  if (open.length) lines.push(`**${open.length} open case(s)** (a device defect the simulator reproduces, not fixed yet): ${open.map(r => `\`${r.id}\``).join(', ')}`, '');
  lines.push('| case | old pack (device) | current tree | expected now | verdict |', '|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${esc(r.title)} | ${cell(r.old)} | ${cell(r.new)} | ${r.expectNew} | ${r.verdict} |`);
  lines.push('', '## Evidence', '');
  for (const r of rows) lines.push(`- \`${r.id}\`: ${esc(r.evidence)}${r.limits ? ` Limits: ${esc(r.limits)}` : ''}`);
  return `${lines.join('\n')}\n`;
}
