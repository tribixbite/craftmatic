/**
 * Does the converter have a function for every instruction the sources carry?
 *
 * The reader was grown set by set: whatever the model in front of it happened
 * to use got handled, and a directive nobody had looked at was a silent no-op.
 * That failure mode is invisible by construction — no error, no warning, just
 * a model that is missing a hose, painted from the wrong palette, or carrying
 * parts the file excluded.
 *
 * This walks EVERY source file in the corpus, classifies every line-type-0
 * LDraw directive and every LXFML element and attribute against the coverage
 * tables in `web/src/engine/ldraw-directives.ts` and `lxfml-schema.ts`, and
 * reports three things:
 *
 *   UNKNOWN    — in the corpus, absent from the table. A gap nobody has looked
 *                at. The audit FAILS on these.
 *   UNHANDLED  — in the table, marked as not acted on, and able to change the
 *                model. A known gap, with what it would cost.
 *   HANDLED    — acted on, listed so a regression that stops reading one is
 *                visible as a count going to zero.
 *
 * Usage:
 *   bun scripts/_converter_coverage_audit.ts
 *   bun scripts/_converter_coverage_audit.ts --root C:/git/clego/lego_sets
 *   bun scripts/_converter_coverage_audit.ts --json out.json
 *   bun scripts/_converter_coverage_audit.ts --class OMR      (one corpus class)
 *   bun scripts/_converter_coverage_audit.ts --no-archives   (skip .lxf/.io)
 *
 * Exit code 1 when an unknown directive or element is found, so it can gate CI.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { ioEntryTexts } from '../web/src/engine/io-extractor.ts';
import { classifyDirective, directiveKey, LDRAW_DIRECTIVES, type DirectiveSpec } from '../web/src/engine/ldraw-directives.ts';
import { LXFML_ATTRIBUTES, LXFML_ELEMENTS, lxfmlElementSpec, type LxfmlSpec } from '../web/src/engine/lxfml-schema.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const ROOT = flag('--root', 'C:/git/clego/lego_sets');
const ONLY_CLASS = argv.includes('--class') ? flag('--class', '') : '';
const JSON_OUT = argv.includes('--json') ? flag('--json', 'coverage-audit.json') : '';
const QUIET = argv.includes('--quiet');
/** `.lxf`/`.io` are archives; opening 23,724 of them costs minutes. */
const SKIP_ARCHIVES = argv.includes('--no-archives');

interface Tally {
  lines: number;
  files: number;
  sets: Set<string>;
  example: string;
  exampleFile: string;
}

const ldraw = new Map<string, Tally>();
const elements = new Map<string, Tally>();
const attributes = new Map<string, Tally>();
const seenInFile = new Set<string>();
let ldrawFiles = 0, xmlFiles = 0, archives = 0, archiveErrors = 0;

function bump(map: Map<string, Tally>, key: string, set: string, file: string, example: string): void {
  let t = map.get(key);
  if (!t) { t = { lines: 0, files: 0, sets: new Set(), example: example.trim().slice(0, 150), exampleFile: file }; map.set(key, t); }
  t.lines++;
  t.sets.add(set);
  const fk = `${key}\u0000${file}`;
  if (!seenInFile.has(fk)) { seenInFile.add(fk); t.files++; }
}

/** `<class>/<set>` — the unit a user actually exports. */
function setOf(rel: string): string {
  const p = rel.split('/');
  return p.length >= 2 ? `${p[0]}/${p[1]!.replace(/\.[^.]+$/, '')}` : rel;
}

function scanLdraw(text: string, set: string, file: string): void {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.charCodeAt(0) !== 48 /* '0' */) continue;
    const key = directiveKey(line);
    if (key === null) continue;   // a comment or a model title, not a command
    bump(ldraw, key, set, file, line);
  }
}

const TAG = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)/g;
const ATTR = /([\w.:-]+)\s*=\s*"([^"]*)"/g;

function scanXml(text: string, set: string, file: string): void {
  for (const m of text.matchAll(TAG)) {
    const el = m[1]!;
    if (el === '?xml') continue;
    bump(elements, el, set, file, m[0]!);
    for (const a of (m[2] ?? '').matchAll(ATTR)) {
      const key = `${el}@${a[1]}`;
      // Only attributes of elements we track individually; a purely `view`
      // element is covered by its own entry.
      if (LXFML_ATTRIBUTES[key] || trackedElements.has(el)) {
        bump(attributes, key, set, file, `${a[1]}="${(a[2] ?? '').slice(0, 60)}"`);
      }
    }
  }
}

/** Elements whose attributes are audited one by one. */
const trackedElements = new Set(
  Object.keys(LXFML_ATTRIBUTES).map(k => k.split('@')[0]!),
);

/**
 * `.lxf` and `.io` are ZIP ARCHIVES, and an audit that reads only loose files
 * skips 23,724 of them — the same blind spot it exists to find. `.lxf` wraps
 * IMAGE100.LXFML; `.io` wraps an LDraw model, encrypted on older files.
 */
async function scanArchive(full: string, childRel: string, set: string): Promise<void> {
  const bytes = readFileSync(full);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (/\.lxf$/i.test(childRel)) {
    const found = await extractMatching(buffer, n => /\.lxfml$/i.test(n));
    if (!found) throw new Error('no .lxfml entry');
    xmlFiles++;
    scanXml(new TextDecoder('latin1').decode(found.data), set, `${childRel}!${found.name}`);
    return;
  }
  // `.io`: every LDraw entry, so an embedded part definition is audited too.
  const texts = await ioEntryTexts(buffer);
  let any = false;
  for (const [name, text] of texts) {
    if (!/\.(ldr|mpd|dat)$/i.test(name)) continue;
    any = true;
    ldrawFiles++;
    scanLdraw(text, set, `${childRel}!${name}`);
  }
  if (!any) throw new Error('no LDraw entry');
}

const archiveQueue: Array<{ full: string; childRel: string; set: string }> = [];

function walk(dir: string, rel: string): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (!rel && ONLY_CLASS && name !== ONLY_CLASS) continue;
      walk(full, childRel);
      continue;
    }
    const isLdraw = /\.(ldr|mpd|dat)$/i.test(name);
    const isXml = /\.lxfml$/i.test(name);
    const isArchive = !SKIP_ARCHIVES && /\.(lxf|io)$/i.test(name);
    if (isArchive) { archiveQueue.push({ full, childRel, set: setOf(childRel) }); continue; }
    if (!isLdraw && !isXml) continue;
    let text: string;
    try { text = readFileSync(full, 'latin1'); } catch { continue; }
    const set = setOf(childRel);
    if (isLdraw) { ldrawFiles++; scanLdraw(text, set, childRel); }
    else { xmlFiles++; scanXml(text, set, childRel); }
  }
}

const t0 = Date.now();
walk(ROOT, '');

for (const job of archiveQueue) {
  archives++;
  try { await scanArchive(job.full, job.childRel, job.set); }
  catch { archiveErrors++; }
  if (!QUIET && archives % 2000 === 0) console.error(`  …${archives}/${archiveQueue.length} archives`);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

// ── classify ────────────────────────────────────────────────────────────────

interface Row { key: string; tally: Tally; spec: DirectiveSpec | LxfmlSpec | null }

type Lookup = (key: string) => DirectiveSpec | LxfmlSpec | undefined;

function split(map: Map<string, Tally>, lookup: Lookup): {
  unknown: Row[]; unhandled: Row[]; expansion: Row[]; handled: Row[];
} {
  const unknown: Row[] = [], unhandled: Row[] = [], expansion: Row[] = [], handled: Row[] = [];
  for (const [key, tally] of map) {
    const spec = lookup(key);
    if (!spec) { unknown.push({ key, tally, spec: null }); continue; }
    if (spec.handled) handled.push({ key, tally, spec });
    else if (spec.viaExpansion) expansion.push({ key, tally, spec });
    else unhandled.push({ key, tally, spec });
  }
  const bySets = (a: Row, b: Row): number => b.tally.sets.size - a.tally.sets.size;
  return {
    unknown: unknown.sort(bySets), unhandled: unhandled.sort(bySets),
    expansion: expansion.sort(bySets), handled: handled.sort(bySets),
  };
}

const ld = split(ldraw, k => LDRAW_DIRECTIVES[k]);
const el = split(elements, lxfmlElementSpec);
const at = split(attributes, k => LXFML_ATTRIBUTES[k]);

/** Only effects that can change what the exported model looks like. */
const CHANGES_MODEL = new Set(['geometry', 'colour', 'appearance']);
const changesModel = (r: Row): boolean => r.spec !== null && CHANGES_MODEL.has(r.spec.effect);

function report(title: string, rows: Row[], withNote: boolean): void {
  if (!rows.length) { console.log(`\n${title}: none`); return; }
  console.log(`\n${title}: ${rows.length}`);
  for (const r of rows) {
    const t = r.tally;
    console.log(`  ${String(t.sets.size).padStart(5)} sets ${String(t.lines).padStart(9)} lines   ${r.key}`);
    if (withNote && r.spec) console.log(`        ${r.spec.effect}: ${r.spec.note}`);
    if (!r.spec) console.log(`        e.g. ${t.example}\n        in  ${t.exampleFile}`);
  }
}

console.log(`converter coverage audit — ${ldrawFiles} LDraw files, ${xmlFiles} LXFML files, ${elapsed}s`);
console.log(`archives opened: ${archives}${archiveErrors ? ` (${archiveErrors} unreadable)` : ''}${SKIP_ARCHIVES ? ' — skipped (--no-archives)' : ''}`);
console.log(`root: ${ROOT}${ONLY_CLASS ? `  class: ${ONLY_CLASS}` : ''}`);

console.log('\n' + '='.repeat(72));
console.log('LDraw line-type-0 directives');
console.log('='.repeat(72));
report('UNKNOWN — in the corpus, missing from the coverage table', ld.unknown, false);
report('GAP — unhandled and able to change the model', ld.unhandled.filter(changesModel), true);
report('described by a meta we ignore, but WRITTEN OUT as ordinary geometry we read', ld.expansion, false);
report('UNHANDLED, no effect on the exported model', ld.unhandled.filter(r => !changesModel(r)), false);
report('HANDLED', ld.handled, false);

console.log('\n' + '='.repeat(72));
console.log('LXFML elements');
console.log('='.repeat(72));
report('UNKNOWN — in the corpus, missing from the schema table', el.unknown, false);
report('GAP — unhandled and able to change the model', el.unhandled.filter(changesModel), true);
report('restated elsewhere; the placement we read already carries it', el.expansion, false);
console.log(`\nUNHANDLED, instruction-only: ${el.unhandled.filter(r => !changesModel(r)).length}`);
report('HANDLED', el.handled, false);

console.log('\n' + '='.repeat(72));
console.log('LXFML attributes on model-bearing elements');
console.log('='.repeat(72));
report('UNKNOWN — in the corpus, missing from the schema table', at.unknown, false);
report('GAP — unhandled and able to change the model', at.unhandled.filter(changesModel), true);
report('restated elsewhere; the placement we read already carries it', at.expansion, false);
report('HANDLED', at.handled, false);

// ── verdict ─────────────────────────────────────────────────────────────────

const unknownTotal = ld.unknown.length + el.unknown.length + at.unknown.length;
const modelGaps = [...ld.unhandled, ...el.unhandled, ...at.unhandled].filter(changesModel);
const setsAffected = new Set<string>();
for (const r of modelGaps) for (const s of r.tally.sets) setsAffected.add(s);

console.log('\n' + '='.repeat(72));
console.log(`UNKNOWN directives/elements/attributes: ${unknownTotal}`);
console.log(`known gaps that can change the model:  ${modelGaps.length}, touching ${setsAffected.size} sets`);
console.log('='.repeat(72));

if (JSON_OUT) {
  const dump = (rows: Row[]): unknown[] => rows.map(r => ({
    key: r.key, sets: r.tally.sets.size, lines: r.tally.lines, files: r.tally.files,
    effect: r.spec?.effect ?? null, handled: r.spec?.handled ?? null, viaExpansion: r.spec?.viaExpansion ?? false,
    note: r.spec?.note ?? null, example: r.tally.example, exampleFile: r.tally.exampleFile,
  }));
  await Bun.write(JSON_OUT, JSON.stringify({
    root: ROOT, ldrawFiles, xmlFiles,
    ldraw: { unknown: dump(ld.unknown), unhandled: dump(ld.unhandled), expansion: dump(ld.expansion), handled: dump(ld.handled) },
    elements: { unknown: dump(el.unknown), unhandled: dump(el.unhandled), expansion: dump(el.expansion), handled: dump(el.handled) },
    attributes: { unknown: dump(at.unknown), unhandled: dump(at.unhandled), expansion: dump(at.expansion), handled: dump(at.handled) },
  }, null, 1));
  if (!QUIET) console.log(`wrote ${JSON_OUT}`);
}

process.exit(unknownTotal > 0 ? 1 : 0);
