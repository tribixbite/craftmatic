/**
 * Which roller-coaster moulds does the track extractor NOT know?
 *
 * `coasterTrackProfile` carries a hand-measured profile per mould, and a mould
 * missing from it is invisible to the extractor: the piece is still drawn, but
 * it cannot join a route, so a ride comes out as isolated arcs with no circuit
 * and no warning that anything is missing.
 *
 * This finds the moulds the way the library names them — every part whose
 * LDraw description mentions a roller coaster or a track — and reports which
 * ones the table lacks, with how many corpus sets use each. Same shape as
 * `_converter_coverage_audit.ts`: the gap is found by sweeping the source of
 * truth, not by waiting for a set to look wrong.
 *
 * Usage: bun scripts/_coaster_mould_audit.ts [--corpus C:/git/clego/lego_sets]
 *        [--ldraw C:/git/clego/extracted/studio_release/app/ldraw] [--set 42703]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { coasterTrackProfile } from '../web/src/engine/coaster-track.ts';
import { partStem } from '../web/src/engine/part-id.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const LDRAW = flag('ldraw', 'C:/git/clego/extracted/studio_release/app/ldraw');
const CORPUS = flag('corpus', 'C:/git/clego/lego_sets');
const ONLY_SET = argv.includes('--set') ? flag('set', '') : '';

/** Description keywords that mark a mould as coaster running surface or support. */
const TRACK_WORDS = /roller\s*coaster|coaster\s*track/i;
/** Descriptions that match the words but are not running surface. */
const NOT_TRACK = /sticker|minifig|figure|sign|poster/i;

// ── every mould the library describes as coaster track ─────────────────────
interface Mould { id: string; description: string; dir: string }
const moulds = new Map<string, Mould>();

function scanPartsDir(dir: string, label: string): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.dat')) continue;
    let description: string;
    try {
      // The description is the first line — UNLESS the DAT opens with an MPD
      // style `0 FILE <name>` header, as Studio's BrickLink copies do. Reading
      // line 1 blindly gives "FILE bl_80566.dat", the mould reads as
      // undescribed, and it never reaches this audit — which is exactly how
      // 76417's entire vault rail hid from it while a profile for that design
      // already existed.
      const lines = readFileSync(join(dir, name), 'latin1').slice(0, 600).split('\n');
      const first = (lines[0] ?? '').replace(/^0\s*/, '').trim();
      description = /^FILE\b/i.test(first) ? (lines[1] ?? '').replace(/^0\s*/, '').trim() : first;
    } catch { continue; }
    if (!TRACK_WORDS.test(description) || NOT_TRACK.test(description)) continue;
    const id = name.slice(0, -4).toLowerCase();
    if (!moulds.has(id)) moulds.set(id, { id, description, dir: label });
  }
}
scanPartsDir(join(LDRAW, 'parts'), 'official');
scanPartsDir(join(LDRAW, 'UnOfficial', 'parts'), 'unofficial');

// ── how often each appears in the corpus, and in which sets ────────────────
const usage = new Map<string, Set<string>>();
const setOf = (rel: string): string => {
  const p = rel.split(/[/\\]/);
  return p.length >= 2 ? `${p[0]}/${p[1]!.replace(/\.[^.]+$/, '')}` : rel;
};

function walk(dir: string, rel: string): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { walk(full, childRel); continue; }
    if (!/\.(ldr|mpd)$/i.test(name)) continue;
    if (ONLY_SET && !childRel.includes(ONLY_SET)) continue;
    let text: string;
    try { text = readFileSync(full, 'latin1'); } catch { continue; }
    const set = setOf(childRel);
    for (const line of text.split('\n')) {
      if (line.charCodeAt(0) !== 49 /* '1' */) continue;
      const tokens = line.trim().split(/\s+/);
      if (tokens.length < 15) continue;
      const id = partStem(tokens.slice(14).join(' '));
      if (!moulds.has(id)) continue;
      let s = usage.get(id);
      if (!s) { s = new Set(); usage.set(id, s); }
      s.add(set);
    }
  }
}
walk(CORPUS, '');

// ── report ─────────────────────────────────────────────────────────────────
const rows = [...moulds.values()].map(m => ({
  ...m,
  known: coasterTrackProfile(`${m.id}.dat`) !== undefined,
  sets: usage.get(m.id)?.size ?? 0,
}));
const missing = rows.filter(r => !r.known).sort((a, b) => b.sets - a.sets);
const known = rows.filter(r => r.known).sort((a, b) => b.sets - a.sets);

console.log(`coaster mould audit — ${rows.length} moulds the library calls coaster track`);
console.log(`  profiled: ${known.length}    MISSING a profile: ${missing.length}`);

console.log('\nMISSING a profile — these pieces can never join a route:');
for (const r of missing) {
  console.log(`  ${String(r.sets).padStart(4)} sets  ${r.id.padEnd(12)} ${r.dir.padEnd(11)} ${r.description.slice(0, 74)}`);
}
console.log('\nProfiled:');
for (const r of known) {
  console.log(`  ${String(r.sets).padStart(4)} sets  ${r.id.padEnd(12)} ${r.dir.padEnd(11)} ${r.description.slice(0, 74)}`);
}

const reach = new Set<string>();
for (const r of missing) for (const s of usage.get(r.id) ?? []) reach.add(s);
console.log(`\nsets using at least one unprofiled coaster mould: ${reach.size}`);

// ── the check that does not depend on wording ──────────────────────────────
//
// Finding moulds by their DESCRIPTION missed 76417's entire vault rail twice
// over: `bl_80566.dat` opens with `0 FILE`, so line 1 is not a description at
// all, and its real description is `RAIL 13X13X3 1/3, 1/4 CIRCLE`, which says
// neither "roller coaster" nor "coaster track". Seven pieces of a profiled
// design were invisible and this audit reported full coverage.
//
// So ask the question that cannot be worded away: of every part id actually
// PLACED in the corpus, which ones fail to resolve to a profile while a
// sibling naming of the same design would resolve? Those are alias gaps, and
// each one silently removes real track from a model.
const placed = new Map<string, Set<string>>();
function collectPlaced(dir: string, rel: string): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { collectPlaced(full, childRel); continue; }
    if (!/\.(ldr|mpd)$/i.test(name)) continue;
    if (ONLY_SET && !childRel.includes(ONLY_SET)) continue;
    let text: string;
    try { text = readFileSync(full, 'latin1'); } catch { continue; }
    const set = setOf(childRel);
    for (const line of text.split('\n')) {
      if (line.charCodeAt(0) !== 49) continue;
      const tokens = line.trim().split(/\s+/);
      if (tokens.length < 15) continue;
      const id = partStem(tokens.slice(14).join(' '));
      if (!/^(bl_)?[0-9]/.test(id)) continue;
      let a = placed.get(id);
      if (!a) { a = new Set(); placed.set(id, a); }
      a.add(set);
    }
  }
}
collectPlaced(CORPUS, '');

/** Other ways the same design can be named in a file. */
const siblings = (id: string): string[] =>
  id.startsWith('bl_') ? [id.slice(3)] : [`bl_${id}`];

const aliasGaps: Array<{ id: string; via: string; sets: number }> = [];
const aliasUsed: Array<{ id: string; sets: number }> = [];
for (const [id, sets] of placed) {
  const direct = coasterTrackProfile(`${id}.dat`);
  const sib = siblings(id).find(v => coasterTrackProfile(`${v}.dat`) !== undefined);
  if (!direct && sib) aliasGaps.push({ id, via: sib, sets: sets.size });
  else if (direct && direct.partId !== id) aliasUsed.push({ id, sets: sets.size });
}
aliasGaps.sort((a, b) => b.sets - a.sets);
aliasUsed.sort((a, b) => b.sets - a.sets);

console.log(`\nALIAS GAPS - a placed id with no profile whose design IS profiled: ${aliasGaps.length}`);
for (const g of aliasGaps) {
  console.log(`  ${String(g.sets).padStart(4)} sets  ${g.id.padEnd(14)} would resolve as ${g.via}`);
}
if (aliasUsed.length) {
  console.log(`\nresolved through a frame alias (working):`);
  for (const a of aliasUsed) console.log(`  ${String(a.sets).padStart(4)} sets  ${a.id}`);
}

process.exit(missing.some(r => r.sets > 0) || aliasGaps.length > 0 ? 1 : 0);
