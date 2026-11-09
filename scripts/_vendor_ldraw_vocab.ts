/**
 * Vendors the brick vocabulary's official LDraw parts, and regenerates the
 * runtime data derived from them.
 *
 *   bun scripts/_vendor_ldraw_vocab.ts            copy parts + every reached subfile/primitive from the
 *                                                  official library into test/fixtures/ldraw-vocab/, write
 *                                                  LICENSE.md and web/src/brickgen/vocab/vocabulary.generated.ts
 *   bun scripts/_vendor_ldraw_vocab.ts --check    verify the fixtures hold every reached file, LICENSE.md
 *                                                  lists each, and the generated data equals a rebuild; exit 1 if not
 *   --library <dir>                                official library root (default C:/git/clego/ldraw_ref/official)
 *
 * Reads ONLY the official library (parts/ and p/), never Studio's unofficial tree.
 * LDraw parts are licensed CC BY (see each file's `0 !LICENSE` line); LICENSE.md
 * carries the per-file authors that the attribution requires.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELEMENT_SPECS, MOVED_PARTS } from '../web/src/brickgen/vocab/elements.ts';
import { buildVocabulary } from '../web/src/brickgen/vocab/index.ts';
import { readHeader, reachableFiles, type PartSource } from '../web/src/brickgen/vocab/occupancy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test/fixtures/ldraw-vocab');
const GENERATED = path.join(ROOT, 'web/src/brickgen/vocab/vocabulary.generated.ts');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const libIdx = argv.indexOf('--library');
const LIBRARY = libIdx >= 0 ? argv[libIdx + 1]! : 'C:/git/clego/ldraw_ref/official';

/** Where a normalised reference lives under a library-shaped root: parts/ first, then p/. */
function locate(root: string, name: string): string | undefined {
  for (const dir of ['parts', 'p']) {
    const f = path.join(root, dir, name);
    if (existsSync(f)) return f;
  }
  return undefined;
}

const sourceOf = (root: string): PartSource => name => {
  const f = locate(root, name);
  return f ? readFileSync(f, 'utf8') : undefined;
};

/** Every file the vocabulary needs, as library-relative paths (`parts/3001.dat`, `p/stud.dat`). */
function neededFiles(root: string): { rel: string; name: string }[] {
  const src = sourceOf(root);
  const names = new Set<string>();
  for (const spec of ELEMENT_SPECS) {
    const { files, missing } = reachableFiles(spec.part, src);
    if (missing.length) throw new Error(`${spec.part}: not in ${root}: ${missing.join(', ')}`);
    for (const f of files) names.add(f);
  }
  // Moved-name aliases are vendored too (and checked below), so a test can prove each really is "~Moved to <target>".
  for (const alias of Object.keys(MOVED_PARTS)) names.add(alias);
  return [...names].sort().map(name => ({ name, rel: path.relative(root, locate(root, name)!).split(path.sep).join('/') }));
}

/** Problems with the MOVED_PARTS table against a library-shaped root: each alias must be one identity reference to its target element. */
function movedPartProblems(root: string): string[] {
  const src = sourceOf(root);
  const elements = new Set(ELEMENT_SPECS.map(s => s.part));
  const out: string[] = [];
  for (const [alias, target] of Object.entries(MOVED_PARTS)) {
    const text = src(alias);
    if (text === undefined) { out.push(`${alias}: not in ${root}`); continue; }
    if (!elements.has(target)) out.push(`${alias} -> ${target}: target is not a vocabulary element`);
    if (!/^0 ~Moved to /m.test(text)) out.push(`${alias}: is not a "~Moved to" file`);
    const refs = text.split(/\r?\n/).filter(l => l.startsWith('1 ')).map(l => l.trim().split(/\s+/));
    const identity = refs.length === 1 && refs[0]!.slice(2, 14).join(' ') === '0 0 0 1 0 0 0 1 0 0 0 1' && refs[0]!.slice(14).join(' ').toLowerCase() === target;
    if (!identity) out.push(`${alias}: is not a single identity reference to ${target}`);
  }
  return out;
}

function licenceMarkdown(files: { rel: string }[]): string {
  const rows = files.map(f => {
    const h = readHeader(readFileSync(path.join(FIXTURES, f.rel), 'utf8'));
    return `| ${f.rel} | ${h.author || '(none stated)'} | ${h.licence || '(none stated)'} |`;
  });
  return [
    '# Vendored LDraw parts',
    '',
    'These files are copies of OFFICIAL LDraw library parts and primitives (ldraw.org), used as test',
    'fixtures for the brick vocabulary (`web/src/brickgen/vocab`). They are licensed CC BY (the',
    'licence line of each file is quoted below); each author is credited here as the licence requires.',
    'Not endorsed by LDraw.org. Regenerate with `bun scripts/_vendor_ldraw_vocab.ts`.',
    '',
    '| File | Author | Licence |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Frames carry measured floats; 4 decimals is far below any LDraw coordinate resolution. */
const round = (n: number): number => Math.round(n * 1e4) / 1e4;

function generatedTs(): string {
  const records = buildVocabulary(sourceOf(FIXTURES)).map(({ element: e, frame }) => ({
    part: e.part,
    footprint: e.footprint,
    heightPlates: e.heightPlates,
    frame: { centreX: round(frame.centreX), centreZ: round(frame.centreZ), topY: round(frame.topY), bottomY: round(frame.bottomY) },
    occupancy: e.occupancy ? [...e.occupancy].join('') : null,
    studsTop: e.connections.studsTop,
    antiStudsBottom: e.connections.antiStudsBottom,
    licence: e.licence,
    author: e.author,
  }));
  return [
    '// GENERATED by scripts/_vendor_ldraw_vocab.ts from test/fixtures/ldraw-vocab/. Do not edit; re-run the script.',
    '// Geometry-derived data for the vocabulary parts (see vocab/occupancy.ts). A test asserts this equals a rebuild.',
    '',
    'export interface VocabRecord {',
    '  part: string;',
    '  footprint: readonly [number, number];',
    '  heightPlates: number;',
    '  /** Body box against the part origin, LDU, LDraw axes (y down). */',
    '  frame: { centreX: number; centreZ: number; topY: number; bottomY: number };',
    '  /** One char per cell, `x + fx * (z + fz * layer)`, layer 0 lowest; null for a full cuboid. */',
    '  occupancy: string | null;',
    '  studsTop: ReadonlyArray<readonly [number, number]>;',
    '  antiStudsBottom: ReadonlyArray<readonly [number, number]>;',
    '  licence: string;',
    '  author: string;',
    '}',
    '',
    `export const VOCAB_RECORDS: readonly VocabRecord[] = ${JSON.stringify(records, null, 1)};`,
    '',
  ].join('\n');
}

if (!CHECK) {
  const problems = movedPartProblems(LIBRARY);
  if (problems.length) { for (const p of problems) console.error(p); process.exit(1); }
  const files = neededFiles(LIBRARY);
  for (const f of files) {
    const dest = path.join(FIXTURES, f.rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    // LF on disk: the library ships CRLF, the repo's .gitattributes normalises to LF (a CRLF copy shows as modified until staged).
    writeFileSync(dest, readFileSync(path.join(LIBRARY, f.rel), 'utf8').replace(/\r\n/g, '\n'));
  }
  writeFileSync(path.join(FIXTURES, 'LICENSE.md'), licenceMarkdown(files));
  writeFileSync(GENERATED, generatedTs());
  console.log(`vendored ${files.length} files for ${ELEMENT_SPECS.length} elements`);
} else {
  let bad = 0;
  for (const p of movedPartProblems(FIXTURES)) { bad++; console.error(p); }
  const src = sourceOf(FIXTURES);
  for (const spec of ELEMENT_SPECS) {
    const { missing } = reachableFiles(spec.part, src);
    if (missing.length) { bad++; console.error(`${spec.part}: missing ${missing.join(', ')}`); }
  }
  const files = neededFiles(FIXTURES);
  const license = readFileSync(path.join(FIXTURES, 'LICENSE.md'), 'utf8');
  for (const f of files) if (!license.includes(f.rel)) { bad++; console.error(`LICENSE.md lacks ${f.rel}`); }
  if (readFileSync(GENERATED, 'utf8') !== generatedTs()) { bad++; console.error('vocabulary.generated.ts is stale'); }
  if (bad) process.exit(1);
  console.log(`ok: ${files.length} vendored files, every reached subfile present, generated data current`);
}
