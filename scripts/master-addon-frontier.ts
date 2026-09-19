/**
 * Coverage/cost frontier for a resident "master" LEGO part library on Bedrock.
 *
 * Re-examines the 2026-09-19 audit ("a resident part library is a NO-GO") with
 * the question it did not ask: not "what does EVERY part cost" but "how many
 * SETS are fully served by a library of a given cuboid cost, and what residue
 * does a set outside it have to ship itself". Reads only the cached census and
 * cost rows in output/master-addon-audit/ (the corpus itself is not touched):
 *
 *   corpus-part-census-ids.json      perSet[set].ids = {partId: placements}
 *   proto-cost-<q>.json + -s{k}of5   rows[partId] = {cuboids (body), studs (count), source, coarsened}
 *   part-bounds.json                 ext (LDU) per part, for the 30 px block bound
 *
 * Selections compared, each reported as a frontier of (parts, cuboids, sets fully
 * covered, residue distribution):
 *   naive     parts ranked by how many sets use them (the table under review)
 *   ratio     parts ranked by sets-per-cuboid
 *   greedy    cheapest-residual-set-first: repeatedly admit the set whose missing
 *             parts cost the least, until the cuboid budget is spent
 *
 * Run from C:/git/craftmatic:  bun scripts/master-addon-frontier.ts
 * Writes output/master-addon-audit/frontier.json and prints the tables.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const D = 'output/master-addon-audit/';
const readJson = <T,>(f: string): T => JSON.parse(readFileSync(D + f, 'utf8')) as T;

interface SetRow { src: string; placements: number; distinct: number; aligned: number; colours: number; ids?: Record<string, number> }
interface Census { parts: Record<string, { placements: number; sets: number }>; perSet: Record<string, SetRow>; placementsTotal: number; alignedTotal: number }
interface CostRow { cuboids: number; studs: number; source: string; coarsened: number; microcell: number; triangles: number }
type Quality = 'balanced' | 'high' | 'ultra';
const QUALITIES: Quality[] = ['balanced', 'high', 'ultra'];
const STUD_FACETS = 4;
const CEILING = 260_000;
const CAP: Record<Quality, number> = { balanced: 128, high: 256, ultra: 512 };

const census = readJson<Census>('corpus-part-census-ids.json');
const bounds = readJson<Record<string, { ext: [number, number, number] }>>('part-bounds.json');
const costRows: Record<Quality, Record<string, CostRow>> = { balanced: {}, high: {}, ultra: {} };
const unresolved = new Set<string>();
const shardOnlyIds = new Set<string>();
const top500Ids = new Set<string>();
for (const q of QUALITIES) {
  const files = [`proto-cost-${q}.json`, ...[0, 1, 2, 3, 4].map(k => `proto-cost-${q}-s${k}of5.json`)];
  for (const f of files) {
    const j = readJson<{ rows: Record<string, CostRow>; unresolved: string[] }>(f);
    Object.assign(costRows[q], j.rows);
    for (const u of j.unresolved) unresolved.add(u);
    if (q === 'balanced') for (const id of Object.keys(j.rows)) (f.includes('of5') ? shardOnlyIds : top500Ids).add(id);
  }
}
const allParts = Object.keys(census.parts);
const resolvable = new Set(Object.keys(costRows.balanced));
console.log(`parts ${allParts.length}; resolvable rows ${resolvable.size}; unresolved ${unresolved.size}`);

const partCost = (id: string, q: Quality, facets = STUD_FACETS): number => {
  const r = costRows[q][id];
  return r ? r.cuboids + r.studs * facets : 0;
};
const libraryCost = (ids: Iterable<string>, q: Quality, facets = STUD_FACETS): { body: number; studs: number; total: number } => {
  let body = 0, studs = 0;
  for (const id of ids) { const r = costRows[q][id]; if (r) { body += r.cuboids; studs += r.studs * facets; } }
  return { body, studs, total: body + studs };
};

// Per-set part lists.
const sets = Object.entries(census.perSet).filter(([, s]) => s.ids).map(([id, s]) => ({
  id, s,
  parts: Object.keys(s.ids!),
  resolvableParts: Object.keys(s.ids!).filter(p => resolvable.has(p)),
  hasUnresolved: Object.keys(s.ids!).some(p => !resolvable.has(p)),
}));
const setsWithUnresolved = sets.filter(s => s.hasUnresolved).length;
console.log(`sets with ids ${sets.length}; sets using >=1 unresolved id ${setsWithUnresolved} (${(100 * setsWithUnresolved / sets.length).toFixed(1)} %)`);
const partToSets = new Map<string, number[]>();
sets.forEach((s, i) => { for (const p of s.resolvableParts) { const l = partToSets.get(p); if (l) l.push(i); else partToSets.set(p, [i]); } });

const pct = (a: number, b: number): string => `${(100 * a / b).toFixed(1)} %`;
const quantile = (xs: number[], p: number): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };

/** Coverage + residue statistics of a library (a set of part ids) at a quality. */
function evaluate(lib: Set<string>, q: Quality, facets = STUD_FACETS) {
  let fullStrict = 0, fullResolvable = 0;
  const residueCost: number[] = [], residueParts: number[] = [];
  for (const s of sets) {
    const missing = s.resolvableParts.filter(p => !lib.has(p));
    const rc = missing.reduce((a, p) => a + partCost(p, q, facets), 0);
    residueCost.push(rc); residueParts.push(missing.length);
    if (missing.length === 0) { fullResolvable++; if (!s.hasUnresolved) fullStrict++; }
  }
  const c = libraryCost(lib, q, facets);
  const under = (t: number): number => residueCost.filter(x => x <= t).length;
  return {
    parts: lib.size, body: c.body, studs: c.studs, cuboids: c.total, xCeiling: +(c.total / CEILING).toFixed(2),
    setsFullResolvable: fullResolvable, setsFullStrict: fullStrict, setsTotal: sets.length,
    residue: {
      cost: { median: quantile(residueCost, 0.5), p75: quantile(residueCost, 0.75), p90: quantile(residueCost, 0.9), p99: quantile(residueCost, 0.99), max: Math.max(...residueCost), mean: +(residueCost.reduce((a, b) => a + b, 0) / residueCost.length).toFixed(1) },
      parts: { median: quantile(residueParts, 0.5), p90: quantile(residueParts, 0.9), max: Math.max(...residueParts) },
      setsUnder: { 0: under(0), 500: under(500), 1000: under(1000), 2000: under(2000), 5000: under(5000) },
    },
  };
}
type Eval = ReturnType<typeof evaluate>;
const fmtRow = (label: string, e: Eval): string =>
  `| ${label} | ${e.parts.toLocaleString()} | ${e.cuboids.toLocaleString()} (${e.studs.toLocaleString()} studs) | ${e.xCeiling}x | ${e.setsFullResolvable.toLocaleString()} (${pct(e.setsFullResolvable, e.setsTotal)}) | ${e.setsFullStrict.toLocaleString()} (${pct(e.setsFullStrict, e.setsTotal)}) | ${e.residue.cost.median} / ${e.residue.cost.p90} / ${e.residue.cost.max.toLocaleString()} | ${e.residue.parts.median} / ${e.residue.parts.p90} / ${e.residue.parts.max} |`;
const HEADER = '| library | parts | cuboids | x ceiling | sets fully covered (resolvable parts) | sets fully covered (strict) | residue cuboids median / p90 / max | residue parts median / p90 / max |\n|---|---|---|---|---|---|---|---|';

const out: Record<string, unknown> = { generated: new Date().toISOString(), parts: allParts.length, resolvable: resolvable.size, unresolved: unresolved.size, sets: sets.length, setsWithUnresolved };

// 0. Whole library, reconciling 472,244 vs 534,354.
{
  const whole = libraryCost(resolvable, 'balanced'), shards = libraryCost(shardOnlyIds, 'balanced'), t500 = libraryCost(top500Ids, 'balanced');
  out.reconcile = { wholeRows: resolvable.size, whole, shardRows: shardOnlyIds.size, shards, top500Rows: top500Ids.size, top500: t500 };
  console.log(`\nRECONCILE: whole library ${resolvable.size} rows = ${whole.total.toLocaleString()} (body ${whole.body.toLocaleString()} + studs ${whole.studs.toLocaleString()}); 5 shards only ${shardOnlyIds.size} rows = ${shards.total.toLocaleString()}; the unsharded top-500 file = ${t500.total.toLocaleString()}`);
  const studShare: Record<string, unknown> = {};
  for (const q of QUALITIES) {
    const c = libraryCost(resolvable, q);
    const c1 = libraryCost(resolvable, q, 1);
    studShare[q] = { total: c.total, body: c.body, studsAt4: c.studs, studsAt1: c1.studs };
    console.log(`  ${q}: total ${c.total.toLocaleString()} = body ${c.body.toLocaleString()} + studs@4 ${c.studs.toLocaleString()} (${pct(c.studs, c.total)} of total); studs@1 would be ${c1.studs.toLocaleString()} -> total ${c1.total.toLocaleString()}`);
  }
  out.studShare = studShare;
}

// A1. Naive ranking by set frequency over all ids (the table under review).
const bySets = [...allParts].sort((a, b) => census.parts[b]!.sets - census.parts[a]!.sets || census.parts[b]!.placements - census.parts[a]!.placements || a.localeCompare(b));
const bySetsResolvable = bySets.filter(p => resolvable.has(p));
const naive: Record<string, Eval & { costCallerStyle: number }> = {};
console.log(`\nA1. NAIVE ranking over all 14,278 ids (caller's construction; cost of an unresolved id = 0)`);
console.log(HEADER);
for (const n of [1000, 2000, 3000, 4000, 5000, 6000, 7139, 8514, 10000, 11454, 14278]) {
  const lib = new Set(bySets.slice(0, n));
  const e = evaluate(lib, 'balanced');
  // Caller-style cost: only the 5 shard files were merged, so the top-500 file's parts cost 0.
  const callerCost = [...lib].filter(p => !top500Ids.has(p)).reduce((a, p) => a + partCost(p, 'balanced'), 0);
  naive[n] = { ...e, costCallerStyle: callerCost };
  console.log(fmtRow(`top ${n.toLocaleString()} (caller cost ${callerCost.toLocaleString()})`, e));
}
out.naiveAllIds = naive;

console.log(`\nA2. NAIVE ranking over the 11,454 RESOLVABLE ids only (an unresolved id renders in no architecture)`);
console.log(HEADER);
const naiveR: Record<string, Eval> = {};
for (const n of [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11454]) {
  const e = evaluate(new Set(bySetsResolvable.slice(0, n)), 'balanced');
  naiveR[n] = e; console.log(fmtRow(`top ${n.toLocaleString()}`, e));
}
out.naiveResolvable = naiveR;

// A3. Ratio ranking: sets per cuboid.
const byRatio = [...bySetsResolvable].sort((a, b) => census.parts[b]!.sets / Math.max(1, partCost(b, 'balanced')) - census.parts[a]!.sets / Math.max(1, partCost(a, 'balanced')) || a.localeCompare(b));

// A4. Greedy cheapest-residual-set-first.
/** Admit sets in order of the cost of their still-missing parts; returns the library at each checkpoint budget. */
function greedyLibrary(q: Quality, budgets: number[], facets = STUD_FACETS): { checkpoints: Record<number, Set<string>>; order: string[] } {
  const lib = new Set<string>();
  const residual = new Float64Array(sets.length);
  const done = new Uint8Array(sets.length);
  sets.forEach((s, i) => { residual[i] = s.resolvableParts.reduce((a, p) => a + partCost(p, q, facets), 0); });
  // Binary heap of [residual, setIndex]; stale entries are skipped on pop.
  const heap: Array<[number, number]> = [];
  const push = (e: [number, number]): void => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p]![0] <= heap[i]![0]) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; } };
  const pop = (): [number, number] | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0]!; const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l; if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i]!, heap[m]!]; i = m; }
    }
    return top;
  };
  sets.forEach((_, i) => push([residual[i]!, i]));
  let spent = 0;
  const checkpoints: Record<number, Set<string>> = {};
  const order: string[] = [];
  const pending = [...budgets].sort((a, b) => a - b);
  while (heap.length && pending.length) {
    const [r, i] = pop()!;
    if (done[i]) continue;
    if (r !== residual[i]) continue; // stale entry; a fresh one was pushed when the residual changed
    const missing = sets[i]!.resolvableParts.filter(p => !lib.has(p));
    const add = missing.reduce((a, p) => a + partCost(p, q, facets), 0);
    while (pending.length && spent + add > pending[0]!) checkpoints[pending.shift()!] = new Set(lib);
    if (!pending.length) break;
    spent += add; done[i] = 1; order.push(sets[i]!.id);
    for (const p of missing) {
      lib.add(p);
      const c = partCost(p, q, facets);
      for (const j of partToSets.get(p) ?? []) if (!done[j]) { residual[j] = residual[j]! - c; push([residual[j]!, j]); }
    }
  }
  for (const b of pending) checkpoints[b] = new Set(lib);
  return { checkpoints, order };
}
const budgets = [25_000, 50_000, 75_000, 100_000, 130_000, 150_000, 175_000, 200_000, 218_000, 260_000, 325_000, 400_000, 534_354];
const greedy = greedyLibrary('balanced', budgets);
console.log(`\nA3/A4. Three selections at equal cuboid budgets (balanced, studs at 4 facets)`);
console.log(HEADER);
const frontier: Record<string, { naive: Eval; ratio: Eval; greedy: Eval }> = {};
const prefixUnderBudget = (ranked: string[], budget: number): Set<string> => { const lib = new Set<string>(); let spent = 0; for (const p of ranked) { const c = partCost(p, 'balanced'); if (spent + c > budget) break; spent += c; lib.add(p); } return lib; };
for (const b of budgets) {
  const eN = evaluate(prefixUnderBudget(bySetsResolvable, b), 'balanced');
  const eR = evaluate(prefixUnderBudget(byRatio, b), 'balanced');
  const eG = evaluate(greedy.checkpoints[b]!, 'balanced');
  frontier[b] = { naive: eN, ratio: eR, greedy: eG };
  console.log(fmtRow(`${b.toLocaleString()} naive`, eN));
  console.log(fmtRow(`${b.toLocaleString()} ratio`, eR));
  console.log(fmtRow(`${b.toLocaleString()} greedy`, eG));
}
out.frontier = frontier;
writeFileSync(D + 'frontier-greedy-260k-parts.json', JSON.stringify([...greedy.checkpoints[260_000]!]));

// B. Residue at the caller's three sizes and at the greedy checkpoints.
console.log(`\nB. Residue a set ships itself (cuboids of its resolvable parts NOT in the library, at library stud cost)`);
const residueReport: Record<string, Eval> = {};
for (const [label, lib] of [
  ['naive 4,000', new Set(bySetsResolvable.slice(0, 4000))], ['naive 6,000', new Set(bySetsResolvable.slice(0, 6000))], ['naive 8,514', new Set(bySetsResolvable.slice(0, 8514))],
  ['greedy @130k', greedy.checkpoints[130_000]!], ['greedy @218k', greedy.checkpoints[218_000]!], ['greedy @260k', greedy.checkpoints[260_000]!],
] as Array<[string, Set<string>]>) {
  const e = evaluate(lib, 'balanced');
  residueReport[label] = e;
  const u = e.residue.setsUnder;
  console.log(`  ${label}: ${e.parts.toLocaleString()} parts / ${e.cuboids.toLocaleString()} cuboids; residue cost median ${e.residue.cost.median} p75 ${e.residue.cost.p75} p90 ${e.residue.cost.p90} p99 ${e.residue.cost.p99} max ${e.residue.cost.max.toLocaleString()} mean ${e.residue.cost.mean}; residue parts median ${e.residue.parts.median} p90 ${e.residue.parts.p90} max ${e.residue.parts.max}; sets with residue 0: ${u[0]} (${pct(u[0], e.setsTotal)}), <=500: ${u[500]} (${pct(u[500], e.setsTotal)}), <=1000: ${u[1000]} (${pct(u[1000], e.setsTotal)}), <=2000: ${u[2000]} (${pct(u[2000], e.setsTotal)})`);
}
out.residue = residueReport;

// C1/C2. Where the cuboids go: studs, truncation, sources.
console.log(`\nC. Per-part cost anatomy`);
const anatomy: Record<string, unknown> = {};
for (const q of QUALITIES) {
  const rows = Object.entries(costRows[q]);
  const bySource: Record<string, { parts: number; body: number; studs: number; setUses: number; placements: number }> = {};
  let coarsened = 0, atCap = 0, coarsenedSetUses = 0, coarsenedPlacements = 0;
  const coarsenHist: Record<number, number> = {};
  for (const [id, r] of rows) {
    const s = bySource[r.source] ??= { parts: 0, body: 0, studs: 0, setUses: 0, placements: 0 };
    s.parts++; s.body += r.cuboids; s.studs += r.studs * STUD_FACETS; s.setUses += census.parts[id]?.sets ?? 0; s.placements += census.parts[id]?.placements ?? 0;
    coarsenHist[r.coarsened] = (coarsenHist[r.coarsened] ?? 0) + 1;
    if (r.coarsened > 0) { coarsened++; coarsenedSetUses += census.parts[id]?.sets ?? 0; coarsenedPlacements += census.parts[id]?.placements ?? 0; }
    if (r.cuboids >= CAP[q]) atCap++;
  }
  const bodyDist = rows.map(([, r]) => r.cuboids);
  const studDist = rows.map(([, r]) => r.studs).filter(x => x > 0);
  anatomy[q] = { bySource, coarsened, coarsenHist, atCap, coarsenedSetUses, coarsenedPlacements, body: { median: quantile(bodyDist, 0.5), p90: quantile(bodyDist, 0.9), max: Math.max(...bodyDist) }, studs: { partsWithStuds: studDist.length, median: quantile(studDist, 0.5), p90: quantile(studDist, 0.9), max: Math.max(...studDist) } };
  console.log(`  ${q}: sources ${JSON.stringify(bySource)}; coarsened>0 ${coarsened} parts (hist ${JSON.stringify(coarsenHist)}), ${coarsenedSetUses} set-uses / ${coarsenedPlacements} placements; body at cap ${atCap}; parts with studs ${studDist.length}, studs/part median ${quantile(studDist, 0.5)} p90 ${quantile(studDist, 0.9)} max ${Math.max(...studDist)}`);
}
out.anatomy = anatomy;
// Worst 50 parts by body cuboids at balanced — the decomposition test list.
const worst = Object.entries(costRows.balanced).sort((a, b) => b[1].cuboids - a[1].cuboids || (census.parts[b[0]]?.sets ?? 0) - (census.parts[a[0]]?.sets ?? 0)).slice(0, 50).map(([id, r]) => ({ id, body: r.cuboids, studs: r.studs, coarsened: r.coarsened, microcell: r.microcell, sets: census.parts[id]?.sets ?? 0, placements: census.parts[id]?.placements ?? 0 }));
out.worst50 = worst;
// The 50 parts whose cuboids matter most to a library (cost x sets using them).
const heaviestBySets = Object.entries(costRows.balanced).map(([id, r]) => ({ id, cost: r.cuboids + r.studs * STUD_FACETS, body: r.cuboids, studs: r.studs, coarsened: r.coarsened, sets: census.parts[id]?.sets ?? 0 })).sort((a, b) => b.cost * b.sets - a.cost * a.sets).slice(0, 50);
out.heaviestBySets = heaviestBySets;
writeFileSync(D + 'frontier-worst50.json', JSON.stringify({ worstByBody: worst.map(w => w.id), heaviestBySets: heaviestBySets.map(w => w.id) }));

// C4. Frequency-weighted quality: per-part quality by set-frequency tier.
console.log(`\nC4. Per-part quality by set-frequency tier, re-costing a fixed library`);
const lib260 = greedy.checkpoints[260_000]!;
const libNaive6000 = new Set(bySetsResolvable.slice(0, 6000));
const policies: Array<{ name: string; pick: (sets: number) => Quality }> = [
  { name: 'all balanced', pick: () => 'balanced' },
  { name: 'high if >=1000 sets', pick: s => s >= 1000 ? 'high' : 'balanced' },
  { name: 'high if >=100 sets', pick: s => s >= 100 ? 'high' : 'balanced' },
  { name: 'ultra >=1000, high >=100', pick: s => s >= 1000 ? 'ultra' : s >= 100 ? 'high' : 'balanced' },
  { name: 'high if >=10 sets', pick: s => s >= 10 ? 'high' : 'balanced' },
  { name: 'all high', pick: () => 'high' },
];
const mixed: Record<string, unknown> = {};
for (const [libName, lib] of [['greedy @260k', lib260], ['naive 6,000', libNaive6000]] as Array<[string, Set<string>]>) {
  for (const pol of policies) {
    let total = 0;
    const tiers: Record<Quality, { parts: number; cuboids: number; setUses: number }> = { balanced: { parts: 0, cuboids: 0, setUses: 0 }, high: { parts: 0, cuboids: 0, setUses: 0 }, ultra: { parts: 0, cuboids: 0, setUses: 0 } };
    for (const p of lib) { const q = pol.pick(census.parts[p]!.sets); const c = partCost(p, q); total += c; tiers[q].parts++; tiers[q].cuboids += c; tiers[q].setUses += census.parts[p]!.sets; }
    mixed[`${libName} / ${pol.name}`] = { total, xCeiling: +(total / CEILING).toFixed(2), tiers };
    console.log(`  ${libName} / ${pol.name}: ${total.toLocaleString()} cuboids (${(total / CEILING).toFixed(2)}x); ${JSON.stringify(tiers)}`);
  }
}
out.mixedQuality = mixed;

// D. Per-set block-route feasibility from the census (bounds + alignment).
console.log(`\nD. Block route per set: aligned share and the 30 px bound (100 LDU at minifig scale)`);
const LIMIT_LDU = 100;
const fits = (id: string): boolean => { const b = bounds[id]; return !!b && b.ext.every(e => e <= LIMIT_LDU + 1e-6); };
const alignedShare = sets.map(s => s.s.aligned / Math.max(1, s.s.placements));
const fitShare = sets.map(s => { let f = 0, n = 0; for (const [p, c] of Object.entries(s.s.ids!)) { n += c; if (fits(p)) f += c; } return f / Math.max(1, n); });
const upperTypes = sets.map(s => Math.min(s.s.aligned, s.s.distinct * s.s.colours * 24));
out.blockRoute = {
  alignedShare: { median: +quantile(alignedShare, 0.5).toFixed(3), p10: +quantile(alignedShare, 0.1).toFixed(3), p90: +quantile(alignedShare, 0.9).toFixed(3), setsOver90: alignedShare.filter(x => x >= 0.9).length, setsOver99: alignedShare.filter(x => x >= 0.99).length, setsFully: alignedShare.filter(x => x >= 1).length },
  fitShare: { median: +quantile(fitShare, 0.5).toFixed(3), p10: +quantile(fitShare, 0.1).toFixed(3), setsFully: fitShare.filter(x => x >= 1).length },
  distinctParts: { median: quantile(sets.map(s => s.s.distinct), 0.5), p90: quantile(sets.map(s => s.s.distinct), 0.9) },
  colours: { median: quantile(sets.map(s => s.s.colours), 0.5), p90: quantile(sets.map(s => s.s.colours), 0.9) },
  permutationUpperBound: { median: quantile(upperTypes, 0.5), p90: quantile(upperTypes, 0.9), max: Math.max(...upperTypes) },
};
console.log(`  aligned share per set: median ${quantile(alignedShare, 0.5).toFixed(3)}, p10 ${quantile(alignedShare, 0.1).toFixed(3)}; sets >=90 % aligned ${alignedShare.filter(x => x >= 0.9).length}, >=99 % ${alignedShare.filter(x => x >= 0.99).length}, 100 % ${alignedShare.filter(x => x >= 1).length} of ${sets.length}`);
console.log(`  placements fitting 30 px per set: median ${quantile(fitShare, 0.5).toFixed(3)}, p10 ${quantile(fitShare, 0.1).toFixed(3)}; sets fully inside ${fitShare.filter(x => x >= 1).length}`);
console.log(`  distinct parts median ${quantile(sets.map(s => s.s.distinct), 0.5)} p90 ${quantile(sets.map(s => s.s.distinct), 0.9)}; colours median ${quantile(sets.map(s => s.s.colours), 0.5)} p90 ${quantile(sets.map(s => s.s.colours), 0.9)}; permutation upper bound min(aligned, parts x colours x 24): median ${quantile(upperTypes, 0.5)} p90 ${quantile(upperTypes, 0.9)} max ${Math.max(...upperTypes)}`);

writeFileSync(D + 'frontier.json', JSON.stringify(out, null, 1));
console.log(`\n-> ${D}frontier.json`);
