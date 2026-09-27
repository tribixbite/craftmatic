/**
 * Seat audit: export each set the way the LEGO tab does (label `Name (set-1)`,
 * so the vehicle classifier reads the title) and read back the export's seat
 * census (engine/seat-census.ts): every place the source sits a minifig or a
 * mini-doll - seat and furniture moulds, saddles, steering wheels, ship's
 * wheels, figures the source sat down, brick-built seats - and whether the
 * pack gives the PLAYER a seat there (the driver's, a passenger's, a scene
 * seat, a coaster car or ride), a seat a figure already rides, or nothing
 * and why. Counts are given per part (raw) and per distinct place.
 *
 * Usage: bun scripts/_seat_audit.ts [set…] [--out DIR] [--keep] [--mirror=<url>] [--before=DIR]
 *   no sets: the 40 favourites and the five Gabby sets (scripts/favourite-sets.ts).
 *   --keep    reuse DIR/<set>.json when present.
 *   --before  a previous audit's DIR: adds the before/after table.
 * Output: DIR/<set>.mcaddon, DIR/<set>.json (the export report), DIR/audit.json, DIR/audit.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.ts';
import { PLAYER_SEAT_USES, type SeatCensus, type SeatUse } from '../web/src/engine/seat-census.ts';
import { FAVOURITES, GABBY_SETS } from './favourite-sets.ts';

const INDEX = 'C:/git/clego/lego-models-index.json';
const CORPUS = 'C:/git/clego/lego_sets';

const argv = process.argv.slice(2);
const valueOf = (name: string): string | undefined => {
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const OUT = valueOf('out') ?? 'output/seat-audit';
const BEFORE = valueOf('before');
const KEEP = argv.includes('--keep');
const MIRROR = argv.find(a => a.startsWith('--mirror='));
const flagValues = new Set([OUT, BEFORE].filter(Boolean));
const targets = argv.filter(a => !a.startsWith('--') && !flagValues.has(a));
const sets = (JSON.parse(readFileSync(INDEX, 'utf8')) as {
  sets: Record<string, { name?: string; models?: IndexModel[]; parts?: number; catalogParts?: number }>;
}).sets;
mkdirSync(OUT, { recursive: true });

/** One set's census as the audit keeps it. */
export interface SeatAuditRow { set: string; name: string; label: string; src: string; ok: boolean; error?: string; seconds: number; census: SeatCensus | null }

const USES: SeatUse[] = ['driver', 'passenger', 'seat', 'coaster', 'ride', 'occupied', 'none'];
const playerCount = (t: Record<SeatUse, number>): number => [...PLAYER_SEAT_USES].reduce((n, u) => n + (t[u] ?? 0), 0);

const rows: SeatAuditRow[] = [];
for (const set of (targets.length ? targets : [...FAVOURITES, ...GABBY_SETS])) {
  const entry = sets[set];
  if (!entry?.models?.length) { console.log(`${set}: not in index`); continue; }
  const model = entry.models[indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts)[0]!]!;
  const file = `${CORPUS}/${model.path}`;
  const label = `${entry.name ?? set} (${set}-1)`;
  const pack = `${OUT}/${set}.mcaddon`, reportPath = `${OUT}/${set}.json`;
  const row: SeatAuditRow = { set, name: entry.name ?? '', label, src: model.path, ok: false, seconds: 0, census: null };
  if (!existsSync(file)) { row.error = `source missing: ${file}`; rows.push(row); console.log(`${set}: ${row.error}`); continue; }
  const started = Date.now();
  if (!(KEEP && existsSync(reportPath))) {
    // One export at a time (the prod mirror throttles parallel ones); no `shell: true` (paths with spaces).
    const run = spawnSync('bun', ['scripts/_playable_ref.ts', file, pack, `--label=${label}`, ...(MIRROR ? [MIRROR] : [])], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (run.status !== 0 || !existsSync(pack)) {
      row.error = (run.stderr || run.stdout || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
      rows.push(row); console.log(`${set}: EXPORT FAILED ${row.error}`); continue;
    }
    writeFileSync(reportPath, run.stdout);
  }
  row.seconds = Math.round((Date.now() - started) / 100) / 10;
  const text = readFileSync(reportPath, 'utf8');
  const report = JSON.parse(text.slice(text.indexOf('{'))) as { seats?: SeatCensus | null };
  row.ok = true;
  row.census = report.seats ?? null;
  rows.push(row);
  const c = row.census;
  console.log(`${set}: ${c ? `${c.places.length} places (${c.rows.length} parts), player ${playerCount(c.counts.distinct)}/${c.places.length} distinct, ${playerCount(c.counts.raw)}/${c.rows.length} raw` : 'no census'}  (${row.seconds}s)`);
}

writeFileSync(`${OUT}/audit.json`, JSON.stringify({ rows }, null, 1));
writeFileSync(`${OUT}/audit.md`, markdown(rows, BEFORE ? readBefore(BEFORE) : null));
console.log(`\nwrote ${OUT}/audit.json and ${OUT}/audit.md`);

function readBefore(dir: string): SeatAuditRow[] | null {
  const path = `${dir}/audit.json`;
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { rows: SeatAuditRow[] }).rows : null;
}

/** Totals over every set: distinct places and parts, by use. */
function totals(list: readonly SeatAuditRow[]): { distinct: Record<SeatUse, number>; raw: Record<SeatUse, number>; places: number; parts: number } {
  const zero = (): Record<SeatUse, number> => Object.fromEntries(USES.map(u => [u, 0])) as Record<SeatUse, number>;
  const out = { distinct: zero(), raw: zero(), places: 0, parts: 0 };
  for (const r of list) {
    if (!r.census) continue;
    out.places += r.census.places.length; out.parts += r.census.rows.length;
    for (const u of USES) { out.distinct[u] += r.census.counts.distinct[u] ?? 0; out.raw[u] += r.census.counts.raw[u] ?? 0; }
  }
  return out;
}

function markdown(all: readonly SeatAuditRow[], before: SeatAuditRow[] | null): string {
  const t = totals(all);
  const lines: string[] = [
    '# Seat audit',
    '',
    `Sets: ${all.length} (${all.filter(r => r.ok).length} exported). Labels as the LEGO tab writes them (\`Name (set-1)\`).`,
    'A **place** is one spot a figure sits (the parts that name it clustered within 28 LDU across, 30 up); a **part** row is each source part or seated figure that names it.',
    'Player uses: `driver` (drives the vehicle), `passenger`, `seat` (a scene seat), `coaster`, `ride`. `occupied` = a scene seat a source figure rides (the player cannot sit there while it does). `none` = nothing to sit on.',
    '',
    '## Totals',
    '',
    '| count | places (distinct) | parts (raw) |',
    '|---|---|---|',
    `| all | ${t.places} | ${t.parts} |`,
    `| **player can sit** | **${playerCount(t.distinct)}** | **${playerCount(t.raw)}** |`,
    ...USES.map(u => `| ${u} | ${t.distinct[u]} | ${t.raw[u]} |`),
    '',
  ];
  if (before) {
    const b = totals(before);
    lines.push('## Before / after', '', '| count | places before | places after | parts before | parts after |', '|---|---|---|---|---|',
      `| all | ${b.places} | ${t.places} | ${b.parts} | ${t.parts} |`,
      `| player can sit | ${playerCount(b.distinct)} | ${playerCount(t.distinct)} | ${playerCount(b.raw)} | ${playerCount(t.raw)} |`,
      ...USES.map(u => `| ${u} | ${b.distinct[u]} | ${t.distinct[u]} | ${b.raw[u]} | ${t.raw[u]} |`), '');
    lines.push('| set | places before -> after | player before -> after |', '|---|---|---|');
    for (const r of all) {
      const p = before.find(x => x.set === r.set);
      const pb = p?.census, pa = r.census;
      const s = (c: SeatCensus | null | undefined): string => c ? `${c.places.length}` : '-';
      const pl = (c: SeatCensus | null | undefined): string => c ? `${playerCount(c.counts.distinct)}` : '-';
      if (s(pb) !== s(pa) || pl(pb) !== pl(pa)) lines.push(`| ${r.set} | ${s(pb)} -> ${s(pa)} | ${pl(pb)} -> ${pl(pa)} |`);
    }
    lines.push('');
  }
  lines.push('## Per set', '', '| set | places | player | driver | passenger | seat | coaster | ride | occupied | none | parts (raw) | player (raw) |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of all) {
    if (!r.census) { lines.push(`| ${r.set} ${r.name} | ${r.ok ? 'no census' : `export failed: ${r.error ?? ''}`} |||||||||||`); continue; }
    const d = r.census.counts.distinct;
    lines.push(`| ${r.set} ${r.name} | ${r.census.places.length} | ${playerCount(d)} | ${USES.map(u => d[u]).join(' | ')} | ${r.census.rows.length} | ${playerCount(r.census.counts.raw)} |`);
  }
  lines.push('', '## Every place', '', '| set | place | parts (kinds) | use | where it went / why not | point LDU |', '|---|---|---|---|---|---|');
  for (const r of all) {
    if (!r.census) continue;
    r.census.places.forEach((p, k) => lines.push(`| ${r.set} | ${k + 1} | ${p.parts.join(', ')} (${p.kinds.join(', ')}) | ${p.use} | ${p.detail.replace(/\|/g, '/')} | ${p.pointLdu.join(', ')} |`));
  }
  // Why the not-usable places are not usable, grouped.
  const reasons = new Map<string, { places: number; sets: Set<string> }>();
  for (const r of all) for (const p of r.census?.places ?? []) {
    if (PLAYER_SEAT_USES.has(p.use)) continue;
    const key = `${p.use}: ${p.detail.replace(/^[^:]*_[^:]*: /, '').replace(/scene seat \d+/, 'scene seat N').replace(/\d+ passenger seats?/, 'N passenger seats')}`;
    const e = reasons.get(key) ?? { places: 0, sets: new Set<string>() };
    e.places++; e.sets.add(r.set); reasons.set(key, e);
  }
  lines.push('', '## Why not (places the player cannot sit at, grouped)', '', '| reason | places | sets |', '|---|---|---|');
  for (const [k, v] of [...reasons].sort((a, b) => b[1].places - a[1].places)) lines.push(`| ${k} | ${v.places} | ${[...v.sets].join(' ')} |`);
  return `${lines.join('\n')}\n`;
}
