#!/usr/bin/env node
/**
 * Report which part names a set's model file cannot resolve against a parts
 * library — the offline equivalent of the LEGO tab's
 * "⚠ N piece(s) of M part type(s) not in library" banner.
 *
 * Exists because that banner was the only detector we had, and it only fires
 * after a full browser load. This runs the same resolution rules against
 * whichever library you point it at, so a parts-mirror regression (or a fix)
 * is verifiable in seconds, for many sets at once.
 *
 * Resolution mirrors web/src/viewer/ldraw/parts.ts: candidate paths
 * parts/ · p/ · parts/s/ · p/48/ (+ the unofficial mirror), then the
 * mould/decoration ALIAS ladder (`6538c` → `6538`, `98138pb042` → `98138`).
 *
 * Usage:
 *   node scripts/check-missing-parts.mjs 10316 10333 75397
 *   node scripts/check-missing-parts.mjs --base https://craftmatic.click/ldraw-parts 10316
 *   node scripts/check-missing-parts.mjs --local C:/git/clego/extracted/studio_release/app/ldraw 10316
 *   node scripts/check-missing-parts.mjs --recent 10        # 10 newest big sets
 *
 * Model files come from the same index + R2 corpus the app uses, so "the app
 * would report X" is what this prints.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Hundreds of keep-alive sockets are still open when the report finishes;
// exiting resets them and Node surfaces that as an unhandled ECONNRESET AFTER
// the output. It is teardown noise, not a failed probe (a failed probe is a
// non-ok response, handled inline) — swallowing it keeps the report readable.
process.on('uncaughtException', (e) => { if (e?.code !== 'ECONNRESET') throw e; });

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };

const BASE = flag('--base', 'https://craftmatic.click/ldraw-parts');
const LOCAL = flag('--local', '');
const MODELS = flag('--models', 'https://craftmatic.click/lego-models');
const INDEX = flag('--index', new URL('../web/public/lego-models-index.json', import.meta.url).pathname.replace(/^\//, ''));
const RECENT = parseInt(flag('--recent', '0'), 10) || 0;
const sets = args.filter(a => /^\d/.test(a) && !args[args.indexOf(a) - 1]?.startsWith('--'));

// ── resolution rules (kept in lockstep with parts.ts) ───────────────────────
const CANDIDATE_DIRS = ['parts', 'p', 'parts/s', 'p/48'];

// Design-id → LDraw-name map, read from the single source of truth the
// renderer uses so the two can never drift apart.
const ALIAS_SRC = readFileSync(new URL('../web/src/engine/ldraw-part-aliases.ts', import.meta.url), 'utf8');
const EXPLICIT = Object.fromEntries(
  [...ALIAS_SRC.matchAll(/^\s*'([^']+)':\s*'([^']+)'/gm)].map(m => [m[1], m[2]]),
);

export function aliasCandidates(stem) {
  const out = [];
  const seen = new Set([stem]);
  if (EXPLICIT[stem]) { out.push(EXPLICIT[stem]); seen.add(EXPLICIT[stem]); }
  let s = stem;
  for (let hop = 0; hop < 4; hop++) {
    const m = s.match(/^(.+?\d[a-z]?)(?:d\d+|v\d+|p[a-z]{0,2}\d+[a-z]?\d*)$/)
      ?? s.match(/^(.*\d[a-z]?)[a-z]$/);
    const next = m?.[1];
    if (!next || seen.has(next)) break;
    seen.add(next); out.push(next); s = next;
  }
  return out;
}

/** Local-directory library: one filesystem scan, then pure set lookups. */
function localIndex(root) {
  const have = new Set();
  for (const prefix of ['', 'UnOfficial/']) {
    for (const d of [...CANDIDATE_DIRS, 'p/8']) {
      let names;
      try { names = readdirSync(join(root, prefix + d)); } catch { continue; }
      for (const f of names) if (f.toLowerCase().endsWith('.dat')) have.add(f.slice(0, -4).toLowerCase());
    }
  }
  return have;
}

/**
 * Remote library, exactly like the client: /_batch first (R2-only — that's all
 * the batch endpoint reads), then a per-path probe for the leftovers, which
 * goes through the worker's upstream library.ldraw.org fallback. Skipping the
 * second pass would over-report misses, since a part can be absent from the R2
 * mirror yet still render in the app.
 */
async function remoteResolve(base, stems) {
  const found = new Set();
  const rels = [];
  for (const s of stems) for (const d of CANDIDATE_DIRS) rels.push(`${d}/${s}.dat`);
  for (let i = 0; i < rels.length; i += 48) {
    const chunk = rels.slice(i, i + 48);
    const r = await fetch(`${base}/_batch?files=${encodeURIComponent(chunk.join(','))}`);
    if (!r.ok) throw new Error(`_batch → HTTP ${r.status}`);
    const data = await r.json();
    for (const rel of Object.keys(data.found ?? {})) found.add(rel.split('/').pop().replace(/\.dat$/i, '').toLowerCase());
  }
  const leftover = stems.filter(s => !found.has(s));
  const mirrorOnly = new Set(found);
  for (let i = 0; i < leftover.length; i += 8) {
    await Promise.all(leftover.slice(i, i + 8).map(async s => {
      for (const d of CANDIDATE_DIRS) {
        const r = await fetch(`${base}/${d}/${s}.dat`);
        if (r.ok) { found.add(s); return; }
      }
    }));
  }
  return { found, mirrorOnly };
}

// ── model sourcing ──────────────────────────────────────────────────────────
const index = JSON.parse(readFileSync(INDEX, 'utf8'));

function pickModel(set) {
  const e = index.sets[set] ?? index.sets[`${set}-1`];
  if (!e) return null;
  const m = e.models?.find(m => m.path.toLowerCase().endsWith('.ldr'));
  return m ? { entry: e, path: m.path, src: m.src } : null;
}

async function loadModel(path) {
  // Prefer a local clego checkout (fast, offline); else the same-origin corpus.
  const local = join('C:/git/clego/lego_sets', path);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  const r = await fetch(`${MODELS}/${path}`);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.text();
}

function partCounts(text) {
  const counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.charCodeAt(0) !== 49 || t[1] !== ' ') continue; // type-1 lines only
    const tok = t.split(/\s+/);
    if (tok.length < 15) continue;
    const name = tok.slice(14).join(' ').toLowerCase().replace(/\.dat$/, '');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

// ── main ────────────────────────────────────────────────────────────────────
let targets = sets;
if (RECENT) {
  targets = Object.entries(index.sets)
    .filter(([, v]) => +v.year >= 2024 && v.parts > 800 && v.models?.some(m => m.path.endsWith('.ldr')))
    .sort((a, b) => b[1].parts - a[1].parts)
    .slice(0, RECENT)
    .map(([k]) => k);
}
if (!targets.length) { console.error('give set numbers, or --recent N'); process.exit(1); }

const have = LOCAL ? localIndex(LOCAL) : null;
console.log(`library: ${LOCAL || BASE}\n`);

let worst = 0;
for (const set of targets) {
  const m = pickModel(set);
  if (!m) { console.log(`${set}: not in index`); continue; }
  let counts;
  try { counts = partCounts(await loadModel(m.path)); }
  catch (e) { console.log(`${set}: ${e.message}`); continue; }

  // The renderer resolves aliases RECURSIVELY (72154d13 → 72154 → 30292a), so
  // expand transitively or the checker under-reports what actually renders.
  const stems = [...counts.keys()];
  const probe = new Set(stems);
  for (const s of [...probe]) {
    const stack = [s];
    while (stack.length) for (const a of aliasCandidates(stack.pop())) if (!probe.has(a)) { probe.add(a); stack.push(a); }
  }
  const remote = have ? null : await remoteResolve(BASE, [...probe]);
  const resolved = have ?? remote.found;
  const ok = (n, depth = 0) =>
    resolved.has(n) || (depth < 5 && aliasCandidates(n).some(a => ok(a, depth + 1)));

  const missing = [...counts].filter(([n]) => !ok(n)).sort((a, b) => b[1] - a[1]);
  const aliased = [...counts].filter(([n]) => !resolved.has(n) && ok(n));
  // Parts the app renders only because the worker fell back to the throttled
  // upstream — the class the R2 mirror exists to eliminate.
  const upstreamOnly = remote ? [...counts].filter(([n]) => resolved.has(n) && !remote.mirrorOnly.has(n)) : [];
  const pieces = missing.reduce((s, [, c]) => s + c, 0);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  worst = Math.max(worst, missing.length);
  const aliasNote = aliased.length ? `  (${aliased.reduce((s, [, c]) => s + c, 0)} pieces via alias)` : '';
  console.log(
    `${set.padEnd(8)} ${m.src.padEnd(14)} ${String(total).padStart(5)} refs  →  ` +
    (missing.length
      ? `MISSING ${pieces} piece(s) / ${missing.length} type(s): ${missing.slice(0, 8).map(([n, c]) => `${n}×${c}`).join(' ')}${missing.length > 8 ? ' …' : ''}`
      : 'all parts resolve') + aliasNote,
  );
}
process.exit(worst ? 2 : 0);
