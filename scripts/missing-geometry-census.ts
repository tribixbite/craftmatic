#!/usr/bin/env bun
/**
 * Corpus-level census of geometry the 3D renderer cannot resolve.
 *
 * `check-missing-parts.mjs` answers "does THIS set render whole?" for a handful
 * of sets, against `.ldr` files only. This answers the different question the
 * renderer's quality actually depends on: **across the corpus, which part names
 * fail to resolve, how often, from which source class, and WHY** — so the fixes
 * can be aimed at classes rather than at whichever set someone happened to open.
 *
 * Three things it does that the per-set checker cannot:
 *   1. Reads every primary source format the app loads — `.ldr`/`.mpd` text,
 *      `.io` (ZipCrypto / WinZip-AES archives, via the app's own extractor) and
 *      `.lxf` (designID → LDraw filename through the same alignment tables the
 *      LXF parser uses). A census over `.ldr` only would silently exclude the
 *      896 authentic-`.io` sets, which are the highest-tier sources we have.
 *   2. Excludes names that are NOT holes: sub-files defined inline in the model
 *      (`0 FILE`), Studio `CustomParts/` shipped inside the `.io`, and names the
 *      alias ladder recovers. The per-set checker counts inline `0 FILE` names
 *      as references, which overstates misses on every MPD.
 *   3. Recurses INTO resolved parts to find the silent class: a part that loads
 *      but whose own sub-file references resolve nowhere, so it renders with
 *      holes and nothing is reported as missing (`unresolvedSubparts`).
 *
 * Resolution rules are IMPORTED from the renderer (`partAliasCandidates`), not
 * re-implemented, so the census cannot drift from what the app does.
 *
 * Usage:
 *   bun scripts/missing-geometry-census.ts                    # default sample
 *   bun scripts/missing-geometry-census.ts --per-class 20 --flagship 60
 *   bun scripts/missing-geometry-census.ts --sets 10316,75192 --json out.json
 *   bun scripts/missing-geometry-census.ts --no-subparts      # skip the deep pass
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { partAliasCandidates, candidateRelPaths, normId } from '../web/src/viewer/ldraw/parts.js';
import { extractIoModel } from '../web/src/engine/io-extractor.js';
import { extractFile } from '../web/src/engine/zip-utils.js';

// ── config ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n: string, d: string): string => {
  const i = args.indexOf(n);
  return i < 0 ? d : (args[i + 1] ?? d);
};
const has = (n: string): boolean => args.includes(n);

const BASE = flag('--base', 'https://craftmatic.click/ldraw-parts');
const CORPUS = flag('--corpus', 'C:/git/clego/lego_sets');
const INDEX = flag('--index', 'web/public/lego-models-index.json');
const PER_CLASS = parseInt(flag('--per-class', '18'), 10);
const FLAGSHIP = parseInt(flag('--flagship', '60'), 10);
const JSON_OUT = flag('--json', '');
const DO_SUBPARTS = !has('--no-subparts');
const EXPLICIT_SETS = flag('--sets', '').split(',').filter(Boolean);

// ── library resolution (one shared, cached lookup for the whole run) ─────────
/** normId(name) → .dat text, or null once every candidate path definitively missed. */
const library = new Map<string, string | null>();

/**
 * On-disk resolution cache. The deep sub-part pass walks thousands of parts, and
 * a cold run of it hit the mirror hard enough to be throttled — which this
 * script treats as fatal ON PURPOSE, because a throttled response looks exactly
 * like a missing part and would silently manufacture "holes". Persisting what
 * resolved makes a rerun nearly free and keeps the load off the mirror.
 *
 * The `.dat` library is immutable in practice; `--fresh` discards the cache when
 * a mirror sync needs re-measuring.
 */
const CACHE_FILE = flag('--cache', join(process.env['TEMP'] ?? '.', 'craftmatic-census-cache.json'));
// Local-library mode reads the filesystem and needs no cache; sharing one with
// the network mode would also let a prod answer masquerade as a local one.
const USE_CACHE = !args.includes('--lib');
if (USE_CACHE && existsSync(CACHE_FILE) && !has('--fresh')) {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, string | null>;
    for (const [k, v] of Object.entries(raw)) library.set(k, v);
    console.log(`cache:   ${library.size} names from ${CACHE_FILE}`);
  } catch { /* corrupt cache is not worth failing over — refetch instead */ }
}
function saveCache(): void {
  if (!USE_CACHE) return;
  try { writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(library))); } catch { /* best effort */ }
}

/**
 * Offline library roots (`--lib <official> <unofficial>`), each holding
 * `parts/`, `p/`, `p/48/`, `parts/s/`. Preferred over the network path: the
 * deep sub-part pass needs tens of thousands of lookups, and driving that
 * through the prod Worker gets it rate-limited into 503s — which are
 * indistinguishable from missing parts and would fabricate holes.
 *
 * Point these at the SAME upstream release archives the R2 mirror is synced
 * from (`library/updates/complete.zip` + `library/unofficial/ldrawunf.zip`, see
 * scripts/sync-ldraw-r2.mjs) and the answer equals prod without touching it.
 */
const LIB_ROOTS = flag('--lib', '').split(',').filter(Boolean);

/**
 * Names the offline archives could not resolve, which must still be checked
 * against prod before being called holes — see `resolveLocally`.
 */
const localMisses = new Set<string>();

/**
 * Filesystem pass over the archive roots.
 *
 * IMPORTANT: the archives are NOT what prod serves. The R2 mirror was first
 * seeded from the Studio-bundled library and the sync never deletes, so prod
 * keeps parts upstream does not ship — every `bl_*` Studio synthetic
 * (`bl_24246pb057` …, 144 placements in 21063 alone) and legacy/"Needs Work"
 * moulds like `3814`. Verified 2026-09-09: all three resolve on prod and exist
 * in neither release archive. So this pass RESOLVES in bulk but may only
 * DEFER a miss; `verifyMissesAgainstProd()` settles those few hundred names.
 */
function resolveLocally(names: string[]): void {
  for (const name of names) {
    const key = normId(name);
    if (!key || library.has(key)) continue;
    let text: string | null = null;
    for (const rel of candidateRelPaths(key)) {
      // `models/` is the client's last-resort probe and has no archive
      // equivalent; `UnOfficial/<rel>` maps onto the unofficial root.
      if (/^models\//i.test(rel)) continue;
      const unof = /^unofficial\//i.test(rel);
      const roots = unof ? LIB_ROOTS.slice(1) : LIB_ROOTS;
      const sub = unof ? rel.replace(/^unofficial\//i, '') : rel;
      for (const root of roots) {
        const p = join(root, sub);
        if (existsSync(p)) { text = readFileSync(p, 'utf8'); break; }
      }
      if (text !== null) break;
    }
    library.set(key, text);
    if (text === null) localMisses.add(key);
  }
}

/**
 * Settle the offline pass's misses against the live mirror. Small by
 * construction (hundreds, not tens of thousands), so it finishes well inside
 * the Worker's tolerance — which is the whole point of doing the bulk offline.
 */
async function verifyMissesAgainstProd(): Promise<void> {
  const todo = [...localMisses].filter(n => library.get(n) == null);
  if (!todo.length) return;
  const before = todo.length;
  for (const n of todo) library.delete(n);
  const saved = LIB_ROOTS.splice(0, LIB_ROOTS.length); // force the network path
  try {
    await resolveNames(todo);
  } finally {
    LIB_ROOTS.push(...saved);
  }
  const recovered = todo.filter(n => library.get(n) != null);
  console.log(`prod check: ${recovered.length}/${before} names absent from the release archives DO resolve on the mirror`);
  if (recovered.length) console.log(`            e.g. ${recovered.slice(0, 8).join(', ')}`);
}

/**
 * Resolve names against the mirror using the renderer's OWN candidate-path
 * list, so "unresolvable here" means "a hole in the app". `UnOfficial/` and
 * `models/` paths are dropped from the request exactly as `fetchDatText` does:
 * the worker's `_batch` checks the unofficial mirror per name itself.
 *
 * Requests are sliced, chunked and committed incrementally — see below.
 */
async function resolveNames(names: string[]): Promise<void> {
  if (LIB_ROOTS.length) { resolveLocally(names); return; }
  const outstanding = [...new Set(names.map(normId))].filter(n => n && !library.has(n));
  if (!outstanding.length) return;

  // Commit in SLICES. `_batch` returns the full TEXT of everything it finds, so
  // a wide burst of full batches makes the Worker do real work and it starts
  // shedding load with 503s (reproduced directly: 6 parallel 48-path batches →
  // one 503). Resolving a slice, committing it and persisting the cache means a
  // throttle costs one slice instead of the whole run, so the census resumes.
  const SLICE = 250;
  for (let s = 0; s < outstanding.length; s += SLICE) {
    const todo = outstanding.slice(s, s + SLICE);

    /** library-relative path → the names that would accept it. */
    const relToNames = new Map<string, string[]>();
    for (const n of todo) {
      for (const rel of candidateRelPaths(n)) {
        if (/^(unofficial|models)\//i.test(rel)) continue;
        const list = relToNames.get(rel);
        if (list) list.push(n); else relToNames.set(rel, [n]);
      }
    }
    const rels = [...relToNames.keys()];
    const chunks: string[][] = [];
    for (let i = 0; i < rels.length; i += 24) chunks.push(rels.slice(i, i + 24));

    const found = new Map<string, string>();
    const CONCURRENCY = 2;
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      await Promise.all(chunks.slice(i, i + CONCURRENCY).map(async chunk => {
        // A throttled response is INDISTINGUISHABLE from a missing part, so
        // waiting the window out is the only honest option and exhausting the
        // retries is fatal rather than silently reported as holes.
        let last = '';
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            const r = await fetch(`${BASE}/_batch?files=${encodeURIComponent(chunk.join(','))}`,
              { signal: AbortSignal.timeout(45000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json() as { found?: Record<string, string> };
            for (const [rel, text] of Object.entries(data.found ?? {})) {
              for (const n of relToNames.get(rel) ?? []) if (!found.has(n)) found.set(n, text);
            }
            return;
          } catch (e) {
            last = (e as Error).message;
            // Jittered backoff: in lockstep, concurrent retries collide on every
            // attempt, which is how one transient 503 became six failures.
            await new Promise(res => setTimeout(res, 800 * 2 ** attempt * (0.5 + Math.random())));
          }
        }
        // Name the chunk: a payload-shaped failure (one pathological filename)
        // and a throttle look identical from the retry loop, and only the chunk
        // contents tell them apart.
        throw new Error(`batch failed 6× (last: ${last}) on ${chunk.length} paths, e.g. ${chunk.slice(0, 3).join(' | ')}`);
      }));
    }
    for (const n of todo) library.set(n, found.get(n) ?? null);
    saveCache();
  }
}

/** Does `stem` resolve directly (no alias hop)? Assumes resolveStems() ran. */
const resolvesDirect = (name: string): boolean => library.get(normId(name)) != null;

/**
 * Follow the alias ladder the way `fetchDatText` does, recursively, and return
 * the name that actually resolved (or null). Needs every candidate already
 * resolved into `library` — see `expandAliases`.
 */
function aliasTarget(stem: string, depth = 0): string | null {
  if (resolvesDirect(stem)) return normId(stem);
  if (depth >= 5) return null;
  for (const a of partAliasCandidates(stem)) {
    const hit = aliasTarget(a, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Transitive closure of a name's alias candidates, so they can be batched. */
function expandAliases(stems: Iterable<string>): string[] {
  const out = new Set<string>();
  const stack = [...stems];
  while (stack.length) {
    const s = stack.pop()!;
    if (out.has(s)) continue;
    out.add(s);
    for (const a of partAliasCandidates(s)) if (!out.has(a)) stack.push(a);
  }
  return [...out];
}

// ── model reading ───────────────────────────────────────────────────────────
interface IndexModel { src: string; path: string; tier?: number; n?: number }
interface IndexEntry { name: string; year: string; parts: number; models: IndexModel[] }
const index = JSON.parse(readFileSync(INDEX, 'utf8')) as { sets: Record<string, IndexEntry> };

/** LXF designID → LDraw filename, from the same tables `lxf-parser.ts` loads. */
function loadLxfMaps(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [file, idx] of [['web/public/ldd-part-map.json', 0], ['web/public/ldd-measured-align.json', 0]] as const) {
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const entries = (raw.parts ?? raw) as Record<string, unknown[]>;
    for (const [designId, v] of Object.entries(entries)) {
      if (Array.isArray(v) && typeof v[idx] === 'string') m.set(designId, v[idx] as string);
    }
  }
  return m;
}
const LXF_MAP = loadLxfMaps();

interface ModelRefs {
  /** name (lowercased, no .dat) → placement count, external references only. */
  refs: Map<string, number>;
  /** names satisfied by an inline `0 FILE` block or an archive CustomPart. */
  inline: Set<string>;
  note?: string;
}

/** Type-1 references + inline `0 FILE` definitions from LDraw text. */
function scanLDrawText(text: string): ModelRefs {
  const refs = new Map<string, number>();
  const inline = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (t.charCodeAt(0) === 48) { // "0 " meta
      const m = /^0\s+(?:FILE|!DATA)\s+(.+)$/i.exec(t);
      if (m) inline.add(m[1].trim().toLowerCase().replace(/\.dat$/i, ''));
      continue;
    }
    if (t.charCodeAt(0) !== 49 || t[1] !== ' ') continue;
    const tok = t.split(/\s+/);
    if (tok.length < 15) continue;
    const name = tok.slice(14).join(' ').toLowerCase().replace(/\.dat$/i, '');
    refs.set(name, (refs.get(name) ?? 0) + 1);
  }
  return { refs, inline };
}

/** `.lxf` → the part names the LXF parser would ask the library for. */
function scanLxf(xml: string): ModelRefs {
  const refs = new Map<string, number>();
  for (const m of xml.matchAll(/<Part\b[^>]*\bdesignID="([^"]+)"/g)) {
    const mapped = LXF_MAP.get(m[1]) ?? `${m[1]}.dat`;
    const name = mapped.toLowerCase().replace(/\.dat$/i, '');
    refs.set(name, (refs.get(name) ?? 0) + 1);
  }
  return { refs, inline: new Set() };
}

/** Read a file as an ArrayBuffer the engine modules can consume. */
function readBuffer(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function readModel(relPath: string): Promise<ModelRefs> {
  const file = join(CORPUS, relPath);
  if (!existsSync(file)) throw new Error('not in local corpus');
  if (/\.lxf$/i.test(relPath)) {
    // `.lxf` is a ZIP wrapping IMAGE100.LXFML — a bare `.lxfml` is the same XML
    // unwrapped. Reading it as text yielded zero references and silently
    // reported the whole 1,524-set LXF class as "0 refs / clean".
    // Sniff the ZIP magic rather than trusting the extension, exactly as
    // `parseLxfWithDiagnostics` does.
    const buf = readBuffer(file);
    const head = new Uint8Array(buf.slice(0, 2));
    const xml = head[0] === 0x50 && head[1] === 0x4b
      ? new TextDecoder('utf-8').decode(await extractFile(buf, 'IMAGE100.LXFML'))
      : readFileSync(file, 'utf8');
    return scanLxf(xml);
  }
  if (/\.io$/i.test(relPath)) {
    const io = await extractIoModel(readBuffer(file));
    const out = scanLDrawText(io.text);
    // CustomParts ship INSIDE the archive; the renderer preloads them, so a
    // reference to one is not a hole even though no library path holds it.
    for (const k of io.customParts?.keys() ?? []) {
      out.inline.add(k.split('/').pop()!.toLowerCase().replace(/\.dat$/i, ''));
    }
    out.note = `${io.sourceEntry} · ${io.colorSpace}`;
    return out;
  }
  return scanLDrawText(readFileSync(file, 'utf8'));
}

// ── classification ──────────────────────────────────────────────────────────
type Verdict =
  | 'resolved' | 'alias' | 'inline' | 'lsynth'
  | 'missing:designid' | 'missing:customparts' | 'missing:marker'
  | 'missing:xname' | 'missing:subpart-name' | 'missing:other';

/** Why did this name not resolve? Mirrors the renderer's own fallbacks. */
function classify(name: string, inline: Set<string>): Verdict {
  if (inline.has(name)) return 'inline';
  if (resolvesDirect(name)) return 'resolved';
  if (aliasTarget(name)) return 'alias';
  // parts.ts synthesizes a placeholder cylinder for LSynth segment parts, which
  // ship with the LSynth tool and are absent from every LDraw library.
  if (/^ls\d{1,3}$/.test(name)) return 'lsynth';
  if (/^m[0-9a-f]{6,}_/.test(name)) return 'missing:customparts';
  if (/^(rename_|bl_)/.test(name)) return 'missing:marker';
  if (/^x\d+/.test(name)) return 'missing:xname';
  if (/^s[\\/]/.test(name) || name.includes('/') || name.includes('\\')) return 'missing:subpart-name';
  if (/^\d+[a-z]?$/.test(name)) return 'missing:designid';
  return 'missing:other';
}

// ── sample selection ────────────────────────────────────────────────────────
interface Target { set: string; src: string; path: string; parts: number; name: string }

function pickSample(): Target[] {
  const all: Target[] = Object.entries(index.sets)
    .filter(([, e]) => e.models?.length)
    .map(([set, e]) => ({
      set, src: e.models[0].src, path: e.models[0].path,
      parts: Number(e.parts) || 0, name: e.name,
    }));
  if (EXPLICIT_SETS.length) {
    const want = new Set(EXPLICIT_SETS.flatMap(s => [s, `${s}-1`]));
    return all.filter(t => want.has(t.set));
  }
  const byClass = new Map<string, Target[]>();
  for (const t of all) {
    const list = byClass.get(t.src);
    if (list) list.push(t); else byClass.set(t.src, [t]);
  }

  const chosen = new Map<string, Target>();
  // Flagships first: the sets most likely to be opened, and the ones whose
  // part variety exercises the most of the library.
  for (const t of [...all].sort((a, b) => b.parts - a.parts).slice(0, FLAGSHIP)) chosen.set(t.set, t);
  // Then a per-class stratum so no source class can hide behind the flagships.
  for (const [, list] of byClass) {
    const sorted = [...list].sort((a, b) => b.parts - a.parts);
    const take = [
      ...sorted.slice(0, Math.ceil(PER_CLASS / 2)),                 // biggest
      ...sorted.filter((_, i) => i % Math.max(1, Math.floor(sorted.length / PER_CLASS)) === 0)
        .slice(0, Math.floor(PER_CLASS / 2)),                        // spread
    ];
    for (const t of take) chosen.set(t.set, t);
  }
  return [...chosen.values()];
}

// ── main ────────────────────────────────────────────────────────────────────
interface SetResult {
  set: string; src: string; path: string; parts: number;
  totalRefs: number; missingPieces: number; missingTypes: number;
  aliasPieces: number; inlinePieces: number; error?: string; note?: string;
  missing: [string, number][];
}

const targets = pickSample();
console.log(`library: ${LIB_ROOTS.length ? LIB_ROOTS.join(' + ') : BASE}`);
console.log(`corpus:  ${CORPUS}`);
console.log(`sample:  ${targets.length} sets (flagship ${FLAGSHIP} + ${PER_CLASS}/class)\n`);

// Pass 1 — read every model, collect the union of referenced names.
const scans = new Map<string, ModelRefs>();
const errors = new Map<string, string>();
const union = new Set<string>();
for (const t of targets) {
  try {
    const s = await readModel(t.path);
    scans.set(t.set, s);
    for (const n of s.refs.keys()) if (!s.inline.has(n)) union.add(n);
  } catch (e) {
    errors.set(t.set, (e as Error).message);
  }
}
console.log(`read ${scans.size}/${targets.length} models · ${union.size} distinct part names referenced`);

// Pass 2 — one library resolution for the whole union, aliases included.
await resolveNames(expandAliases(union));
await verifyMissesAgainstProd();
console.log(`resolved ${[...library.values()].filter(v => v != null).length}/${library.size} candidate names against the mirror\n`);

// Pass 3 — the silent class: sub-file references INSIDE parts that did resolve.
const subHoles = new Map<string, { count: number; parents: Set<string> }>();
if (DO_SUBPARTS) {
  let frontier = new Set<string>();
  for (const n of union) { const t = aliasTarget(n); if (t) frontier.add(t); }
  const visited = new Set<string>();
  for (let depth = 0; depth < 6 && frontier.size; depth++) {
    const next = new Set<string>();
    const pending: string[] = [];
    for (const parent of frontier) {
      if (visited.has(parent)) continue;
      visited.add(parent);
      const text = library.get(parent);
      if (!text) continue;
      // Sub-file refs keep their directory prefix (`s\3001s01`, `48\4-4cyli`);
      // candidateRelPaths() consumes that prefix, so the full name is the key.
      for (const child of scanLDrawText(text).refs.keys()) {
        const name = normId(child);
        pending.push(name);
        next.add(name);
        if (!subHoles.has(name)) subHoles.set(name, { count: 0, parents: new Set() });
        subHoles.get(name)!.parents.add(parent);
      }
    }
    if (!pending.length) break;
    await resolveNames(expandAliases(pending));
    frontier = new Set([...next].filter(s => aliasTarget(s)));
  }
  await verifyMissesAgainstProd();
  for (const [name] of [...subHoles]) if (aliasTarget(name)) subHoles.delete(name);
  console.log(`sub-part pass: walked ${visited.size} resolved parts · ${subHoles.size} unresolved sub-file names\n`);
}

// Pass 4 — attribute, aggregate, report.
const results: SetResult[] = [];
interface NameStat { pieces: number; sets: Set<string>; classes: Set<string>; verdict: Verdict }
const nameStats = new Map<string, NameStat>();

for (const t of targets) {
  const s = scans.get(t.set);
  if (!s) {
    results.push({ ...t, totalRefs: 0, missingPieces: 0, missingTypes: 0, aliasPieces: 0, inlinePieces: 0, missing: [], error: errors.get(t.set) });
    continue;
  }
  let missingPieces = 0, aliasPieces = 0, inlinePieces = 0, totalRefs = 0;
  const missing: [string, number][] = [];
  for (const [name, count] of s.refs) {
    totalRefs += count;
    const v = classify(name, s.inline);
    if (v === 'resolved') continue;
    if (v === 'inline') { inlinePieces += count; continue; }
    if (v === 'alias') { aliasPieces += count; continue; }
    if (v === 'lsynth') continue; // synthesized placeholder, not a hole
    missingPieces += count;
    missing.push([name, count]);
    const st = nameStats.get(name) ?? { pieces: 0, sets: new Set(), classes: new Set(), verdict: v };
    st.pieces += count; st.sets.add(t.set); st.classes.add(t.src);
    nameStats.set(name, st);
  }
  missing.sort((a, b) => b[1] - a[1]);
  results.push({ ...t, totalRefs, missingPieces, missingTypes: missing.length, aliasPieces, inlinePieces, missing, note: s.note });
}

// ── report ──────────────────────────────────────────────────────────────────
const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(2)}%` : '—');

console.log('═══ BY SOURCE CLASS ═══');
console.log('class            sets  clean  refs      missing  types  loss     alias-subs');
const classAgg = new Map<string, { sets: number; clean: number; refs: number; miss: number; types: Set<string>; alias: number }>();
for (const r of results) {
  if (r.error) continue;
  const a = classAgg.get(r.src) ?? { sets: 0, clean: 0, refs: 0, miss: 0, types: new Set<string>(), alias: 0 };
  a.sets++; if (!r.missingPieces) a.clean++;
  a.refs += r.totalRefs; a.miss += r.missingPieces; a.alias += r.aliasPieces;
  for (const [n] of r.missing) a.types.add(n);
  classAgg.set(r.src, a);
}
for (const [cls, a] of [...classAgg].sort((x, y) => y[1].miss - x[1].miss)) {
  console.log(
    `${cls.padEnd(16)} ${String(a.sets).padStart(4)} ${String(a.clean).padStart(6)} ${String(a.refs).padStart(8)} ` +
    `${String(a.miss).padStart(8)} ${String(a.types.size).padStart(6)} ${pct(a.miss, a.refs).padStart(7)} ${String(a.alias).padStart(10)}`,
  );
}

console.log('\n═══ TOP UNRESOLVED NAMES ═══');
console.log('name                 pieces  sets  class                 why');
const ranked = [...nameStats].sort((a, b) => b[1].pieces - a[1].pieces);
for (const [name, st] of ranked.slice(0, 60)) {
  console.log(
    `${name.padEnd(20)} ${String(st.pieces).padStart(6)} ${String(st.sets.size).padStart(5)}  ` +
    `${[...st.classes].join(',').slice(0, 20).padEnd(21)} ${st.verdict}`,
  );
}

console.log('\n═══ BY FAILURE CLASS ═══');
const byVerdict = new Map<string, { pieces: number; names: number; sets: Set<string> }>();
for (const [, st] of nameStats) {
  const v = byVerdict.get(st.verdict) ?? { pieces: 0, names: 0, sets: new Set<string>() };
  v.pieces += st.pieces; v.names++; for (const s of st.sets) v.sets.add(s);
  byVerdict.set(st.verdict, v);
}
for (const [v, a] of [...byVerdict].sort((x, y) => y[1].pieces - x[1].pieces)) {
  console.log(`${v.padEnd(24)} ${String(a.pieces).padStart(7)} pieces  ${String(a.names).padStart(5)} names  ${String(a.sets.size).padStart(4)} sets`);
}

if (subHoles.size) {
  console.log('\n═══ UNRESOLVED SUB-FILE REFS (silent holes inside resolved parts) ═══');
  for (const [stem, v] of [...subHoles].sort((a, b) => b[1].parents.size - a[1].parents.size).slice(0, 30)) {
    console.log(`${stem.padEnd(24)} referenced by ${String(v.parents.size).padStart(4)} parts  e.g. ${[...v.parents].slice(0, 3).join(', ')}`);
  }
}

const worst = results.filter(r => r.missingPieces > 0).sort((a, b) => b.missingPieces - a.missingPieces);
console.log(`\n═══ WORST SETS (${worst.length} of ${results.length - errors.size} sampled have any hole) ═══`);
for (const r of worst.slice(0, 25)) {
  console.log(
    `${r.set.padEnd(10)} ${r.src.padEnd(15)} ${String(r.missingPieces).padStart(5)}/${String(r.totalRefs).padEnd(6)} ` +
    `${pct(r.missingPieces, r.totalRefs).padStart(7)}  ${r.missing.slice(0, 5).map(([n, c]) => `${n}×${c}`).join(' ')}`,
  );
}
if (errors.size) {
  console.log(`\n${errors.size} model(s) unreadable: ${[...errors].slice(0, 8).map(([s, e]) => `${s} (${e})`).join(', ')}`);
}

const totalRefs = results.reduce((s, r) => s + r.totalRefs, 0);
const totalMiss = results.reduce((s, r) => s + r.missingPieces, 0);
const totalAlias = results.reduce((s, r) => s + r.aliasPieces, 0);
console.log(`\nTOTAL: ${totalMiss} missing of ${totalRefs} placements (${pct(totalMiss, totalRefs)}) · ${totalAlias} rendered via alias substitution`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    base: BASE, generated: new Date().toISOString(), sample: targets.length,
    totals: { refs: totalRefs, missing: totalMiss, alias: totalAlias },
    byClass: Object.fromEntries([...classAgg].map(([k, v]) => [k, { ...v, types: v.types.size }])),
    names: Object.fromEntries(ranked.map(([n, st]) => [n, { pieces: st.pieces, sets: [...st.sets], classes: [...st.classes], verdict: st.verdict }])),
    subHoles: Object.fromEntries([...subHoles].map(([k, v]) => [k, { parents: [...v.parents] }])),
    sets: results,
  }, null, 1));
  console.log(`\nwrote ${JSON_OUT}`);
}
