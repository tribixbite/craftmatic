/**
 * A device GameTest log replayed offline: the `CMGT <TAG> <json>` lines a
 * Pixel run wrote to its content log (web/src/engine/gametest-pack.ts and
 * scripts/_gametest_quirks.ts write them), read back into rows, and compared
 * row by row with the lines the SAME tests wrote in the simulator
 * (`scripts/sim-gametest.ts`).
 *
 * Every row is keyed by what identifies it in its test (a doorway's label, a
 * quirk subject's case) and compared on its VERDICT fields - the outcome a
 * walk reached, whether a part opened, where a teleported subject came to rest
 * - never on raw positions that depend on where the arena happened to be. A
 * mismatch where the simulator claims to model the fact is a finding: a new
 * or corrected quirk row, never a tuned test.
 */

/** One `CMGT` line: its tag and its JSON payload (undefined when it does not parse). */
export interface CmgtLine { tag: string; data: Record<string, unknown> | undefined; raw: string }

/** Read every `CMGT <TAG> <json>` line out of a content log or a simulator log (`CMGT_PAD` dropped). */
export function parseCmgt(text: string): CmgtLine[] {
  const out: CmgtLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /\bCMGT ([A-Z][A-Z0-9_]*) (\{.*\})\s*$/.exec(line);
    if (!m || m[1] === 'CMGT_PAD') continue;
    let data: Record<string, unknown> | undefined;
    try { data = JSON.parse(m[2]!) as Record<string, unknown>; } catch { data = undefined; }
    out.push({ tag: m[1]!, data, raw: line.slice(line.indexOf('CMGT ')) });
  }
  return out;
}

/** What one row compares: its tag, its key within the tag, and the verdict fields as text. */
export interface ReplayRow { tag: string; key: string; fields: Record<string, string> }

const r2 = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : v === undefined ? '-' : JSON.stringify(v));
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);

/** The last sample of a quirk subject's track (`[t, dx, dy, dz]`), as its rest position. */
function restOf(samples: unknown): string {
  const s = Array.isArray(samples) ? samples[samples.length - 1] as number[] | undefined : undefined;
  return s ? `${r2(s[1])},${r2(s[2])},${r2(s[3])}` : '-';
}

/**
 * The verdict rows of a log. Tags without a rule here (ARENA, PLACED, READY, RUN, PROBE, SMOKE positions...) are
 * context, not verdicts, and are left out.
 */
export function verdictRows(lines: readonly CmgtLine[]): ReplayRow[] {
  const rows: ReplayRow[] = [];
  const counts = new Map<string, number>();
  const push = (tag: string, key: string, fields: Record<string, string>): void => {
    // The same key twice in a log (a test run in two windows, a quirk case per method) gets an ordinal.
    const n = (counts.get(`${tag}|${key}`) ?? 0) + 1;
    counts.set(`${tag}|${key}`, n);
    rows.push({ tag, key: n > 1 ? `${key} #${n}` : key, fields });
  };
  for (const l of lines) {
    const d = l.data;
    if (!d) continue;
    switch (l.tag) {
      case 'DOOR': push(l.tag, String(d['label']), { closed: r2(get(d, 'closed.outcome')), open: r2(get(d, 'open.outcome')), opensBy: get(d, 'angleAfterInteract') !== get(d, 'angleClosed') ? 'interact' : get(d, 'angleAfterAttack') !== undefined && get(d, 'angleAfterAttack') !== get(d, 'angleClosed') ? 'hit' : 'none', pass: r2(d['pass']) }); break;
      case 'PART': push(l.tag, String(d['label']), { angles: r2(d['angles']), pass: r2(d['pass']) }); break;
      case 'SEAT': push(l.tag, String(d['label']), { pass: r2(d['pass']) }); break;
      case 'SUMMARY': push(l.tag, String(d['model']), { asPredicted: r2(d['asPredicted']), differ: r2(d['differ']) }); break;
      case 'PARTS_SUMMARY': push(l.tag, `${String(d['model'])} w${String(d['window'] ?? 0)}`, { passed: r2(d['passed']), failed: r2(d['failed']) }); break;
      case 'PINBALL': push(l.tag, 'pinball', { targetsOk: r2(d['targetsOk']), plungerOk: r2(d['plungerOk']), heldOk: r2(d['heldOk']), pass: r2(d['pass']) }); break;
      case 'FIGURE': push(l.tag, String(d['label']), { moved: r2(d['moved']), left: r2((d['outsideSamples'] as number | undefined ?? 0) > 0), belowGround: r2(d['belowGround']), endInsideWall: r2(d['endInsideWall']) }); break;
      case 'FIGURE_SUMMARY': push(l.tag, String(d['model']), { found: r2(d['found']), moved: r2(d['moved']), leftArea: r2(d['leftArea']), belowGround: r2(d['belowGround']), endInsideWall: r2(d['endInsideWall']) }); break;
      case 'VEHICLE': push(l.tag, String(d['label']), { checks: r2(d['checks']), pass: r2(d['pass']) }); break;
      case 'TRAIN': push(l.tag, String(d['label']), { checks: r2(d['checks']), pass: r2(d['pass']) }); break;
      case 'FLYER': push(l.tag, String(d['label']), { checks: r2(d['checks']), pass: r2(d['pass']) }); break;
      case 'CREATOR': push(l.tag, String(d['typeId']), { walked: r2((d['walkPath'] as number | undefined ?? 0) >= 2), held: r2((d['heldPath'] as number | undefined ?? 9) <= 0.2) }); break;
      case 'CREATOR_WAND': push(l.tag, String(d['model']), { results: r2(d['results']) }); break;
      // The quirk probe (scripts/_gametest_quirks.ts): where each subject came to rest relative to its target.
      case 'QTP': push(l.tag, `${String(d['layout'])}/${String(d['mat'])}/${String(d['d'])}/${String(d['method'])}/${String(d['who'])}`, { rest: restOf(d['samples']) }); break;
      case 'QDM': push(l.tag, `${String(d['test'] ?? 'quirk_dismount')}/${String(d['name'])}/${String(d['method'])}`, { off: r2(d['stillRiding'] === false), rest: restOf(d['samples']) }); break;
      case 'QREACH': push(l.tag, String(d['mode']), { hits: r2(((d['rows'] as unknown[][] | undefined) ?? []).filter(r => r[4] === true).map(r => `${String(r[0])}@${String(r[1])}`)), mounts: r2(((d['rows'] as unknown[][] | undefined) ?? []).filter(r => r[6] === true).map(r => `${String(r[0])}@${String(r[1])}`)) }); break;
      // The push probe: where each body ended (its last sample), the walker-walker gap, and the deepest overlap with the box.
      case 'QPUSH': push(l.tag, String(d['case']), { ends: r2(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'case').map(([k, v]) => [k, Array.isArray(v) && v.length ? (v[v.length - 1] as number[]).slice(1) : null]))) }); break;
      case 'QAABB': push(l.tag, 'aabb', { rows: r2(d['rows']) }); break;
      case 'QBANDS': push(l.tag, 'bands', { rows: r2(((d['rows'] as unknown[][] | undefined) ?? []).map(r => `${String(r[0]).split(' ')[0]}:${String(r[1])},${String(r[2])}=${String(r[3])}`)) }); break;
      default: break;
    }
  }
  return rows;
}

/** One compared row. */
export interface ReplayDiff { tag: string; key: string; field: string; device: string; sim: string; match: boolean }

/** Compare a device log's verdict rows with the simulator's; a row the simulator did not write compares as missing. */
export function compareRows(device: readonly ReplayRow[], sim: readonly ReplayRow[]): ReplayDiff[] {
  const byKey = new Map(sim.map(r => [`${r.tag}|${r.key}`, r]));
  const out: ReplayDiff[] = [];
  for (const d of device) {
    const s = byKey.get(`${d.tag}|${d.key}`);
    for (const [field, value] of Object.entries(d.fields)) {
      const sv = s ? s.fields[field] ?? '-' : 'missing';
      out.push({ tag: d.tag, key: d.key, field, device: value, sim: sv, match: sv === value });
    }
  }
  return out;
}

/** Whether a log is the quirk probe's (scripts/_gametest_quirks.ts) rather than a model pack's. */
export const isQuirkLog = (lines: readonly CmgtLine[]): boolean => lines.some(l => /^Q(TP|DM|REACH|BANDS|PUSH|AABB)/.test(l.tag) || (l.tag === 'READY' && l.data?.['probe'] === 'quirks'));

/** The diff as a markdown table. */
export function replayMarkdown(diffs: readonly ReplayDiff[], title: string): string {
  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  const bad = diffs.filter(d => !d.match);
  const lines = [`# ${title}`, '', `${diffs.length} verdict fields compared: ${diffs.length - bad.length} match, ${bad.length} differ.`, ''];
  lines.push('| tag | row | field | device | simulator | |', '|---|---|---|---|---|---|');
  for (const d of diffs) lines.push(`| ${d.tag} | ${esc(d.key)} | ${d.field} | ${esc(d.device).slice(0, 160)} | ${esc(d.sim).slice(0, 160)} | ${d.match ? 'ok' : '**DIFFERS**'} |`);
  return `${lines.join('\n')}\n`;
}
