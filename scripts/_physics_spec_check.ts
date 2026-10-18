/**
 * The staleness gate for `docs/physics-architecture.md`.
 *
 * The spec is written for people and agents, but four kinds of block in it are
 * MACHINE-READ, delimited by HTML comments so they render as ordinary tables:
 *
 *   <!-- physics-spec:exports <file> -->   every export of a physics module:
 *       | Export | Kind | Role |   (a row may name several `symbols` of one kind)
 *   <!-- physics-spec:consumers -->        files that run or host physics but
 *       | File | What it does |           whose exports are not inventoried
 *   <!-- physics-spec:not-physics -->      physics-NAMED files that are not physics
 *       | File | Why not |
 *   <!-- physics-spec:constants -->        every tuned number, its value and why
 *       | Constant | Where | Value | Units | Why |
 *
 * each closed by `<!-- /physics-spec:<kind> -->`.
 *
 * It fails (one line per problem) when:
 *   (a) a repo path written in backticks anywhere in the spec does not exist, or
 *       a symbol an exports table names is not exported by that file (or is a
 *       different kind: const / function / interface / type / class / enum);
 *   (b) a constants row's value differs from the code. `Where` is either
 *       `file` alone - the Constant is then an export path such as
 *       `COASTER_PHYSICS.GRAVITY`, imported and read - or `file` followed by a
 *       backticked source fragment in which `§` stands for one numeric literal
 *       (`options.gravity ?? §`), for numbers that live inside a function body.
 *       The value is compared to the precision it is written with;
 *   (c) a module with an exports table exports something the table does not
 *       list, or a file under `web/src/engine` / `web/src/ui` whose name looks
 *       like physics (`PHYSICS_NAME`) is in none of the three file lists.
 *
 * So adding a constant, a function or a whole module without documenting it
 * fails `bun run test` (test/physics-spec.test.ts), and so does changing a
 * documented value without changing the spec.
 *
 *   bun scripts/_physics_spec_check.ts             check; exit 1 on any problem
 *   bun scripts/_physics_spec_check.ts --list <f>  print a draft exports table for a file
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ts from 'typescript';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_PATH = 'docs/physics-architecture.md';
/** Directories scanned for physics-named files that the spec must classify. */
export const DISCOVERY_DIRS: readonly string[] = ['web/src/engine', 'web/src/ui'];
/** A basename that looks like physics: it must appear in the spec's exports, consumers or not-physics lists. */
export const PHYSICS_NAME = /(physic|coaster|pinball|vehicle|figure-life|train|ride|playable|walk|scale|motion|drive|flight|boat|gametest)/i;

export type ExportKind = 'const' | 'function' | 'interface' | 'type' | 'class' | 'enum' | 're-export';
export interface ExportedSymbol { name: string; kind: ExportKind }

export interface SpecExportRow { symbols: string[]; kind: string; line: number }
export interface SpecConstantRow { name: string; file: string; pattern?: string; value: string; units: string; why: string; line: number }
export interface ParsedSpec {
  exports: Map<string, SpecExportRow[]>;
  consumers: string[];
  notPhysics: string[];
  constants: SpecConstantRow[];
  /** Every backticked repo path in the document, with its line. */
  paths: Array<{ path: string; line: number }>;
  /** Blocks opened and never closed, unknown block kinds, malformed rows. */
  errors: string[];
}

/** Top-level exports of a TypeScript file, from its syntax tree (nothing is executed). */
export function collectExports(absPath: string): ExportedSymbol[] {
  const source = ts.createSourceFile(absPath, readFileSync(absPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: ExportedSymbol[] = [];
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause) && !statement.isTypeOnly) {
        for (const element of statement.exportClause.elements) out.push({ name: element.name.text, kind: 're-export' });
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, kind: 'const' });
    } else if (ts.isFunctionDeclaration(statement) && statement.name) out.push({ name: statement.name.text, kind: 'function' });
    else if (ts.isInterfaceDeclaration(statement)) out.push({ name: statement.name.text, kind: 'interface' });
    else if (ts.isTypeAliasDeclaration(statement)) out.push({ name: statement.name.text, kind: 'type' });
    else if (ts.isClassDeclaration(statement) && statement.name) out.push({ name: statement.name.text, kind: 'class' });
    else if (ts.isEnumDeclaration(statement)) out.push({ name: statement.name.text, kind: 'enum' });
  }
  return out;
}

/** Cells of a markdown table row (`| a | b |`), trimmed; null for a non-row or the `|---|` rule. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
  if (cells.every(c => /^:?-{3,}:?$/.test(c))) return null;
  return cells;
}
const ticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]!);

const PATH_IN_TICKS = /`((?:web|src|test|scripts|tools|docs)\/[^`\s]+?\.(?:ts|mjs|js|md|py|json))`/g;

/** Parse the machine-read blocks out of the spec's markdown. */
export function parseSpec(markdown: string): ParsedSpec {
  const spec: ParsedSpec = { exports: new Map(), consumers: [], notPhysics: [], constants: [], paths: [], errors: [] };
  const lines = markdown.split('\n');
  let block: { kind: string; arg?: string; line: number; header: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const no = i + 1;
    for (const m of line.matchAll(PATH_IN_TICKS)) spec.paths.push({ path: m[1]!, line: no });
    const open = /^<!-- physics-spec:([a-z-]+)(?: (\S+))? -->\s*$/.exec(line.trim());
    const close = /^<!-- \/physics-spec:([a-z-]+) -->\s*$/.exec(line.trim());
    if (open) {
      if (block) spec.errors.push(`line ${no}: block ${open[1]} opened inside ${block.kind} (line ${block.line})`);
      if (!['exports', 'consumers', 'not-physics', 'constants'].includes(open[1]!)) spec.errors.push(`line ${no}: unknown block kind ${open[1]}`);
      if (open[1] === 'exports') {
        if (!open[2]) spec.errors.push(`line ${no}: an exports block names its file`);
        else if (spec.exports.has(open[2])) spec.errors.push(`line ${no}: a second exports block for ${open[2]}`);
        else spec.exports.set(open[2], []);
      }
      block = { kind: open[1]!, ...(open[2] ? { arg: open[2] } : {}), line: no, header: false };
      continue;
    }
    if (close) {
      if (!block || block.kind !== close[1]) spec.errors.push(`line ${no}: closes ${close[1]} but ${block ? block.kind : 'nothing'} is open`);
      block = null;
      continue;
    }
    if (!block) continue;
    const cells = tableCells(line);
    if (!cells) continue;
    if (!block.header) { block.header = true; continue; } // the column-title row
    if (block.kind === 'exports') {
      const symbols = ticked(cells[0] ?? '');
      if (!symbols.length || cells.length < 3) { spec.errors.push(`line ${no}: an exports row is | \`symbol\`[, \`symbol\`...] | kind | role |`); continue; }
      if (!cells[2]) spec.errors.push(`line ${no}: ${symbols.join(', ')} has no role written`);
      spec.exports.get(block.arg!)?.push({ symbols, kind: cells[1]!, line: no });
    } else if (block.kind === 'consumers' || block.kind === 'not-physics') {
      const [file] = ticked(cells[0] ?? '');
      if (!file || !cells[1]) { spec.errors.push(`line ${no}: a ${block.kind} row is | \`file\` | reason |`); continue; }
      (block.kind === 'consumers' ? spec.consumers : spec.notPhysics).push(file);
    } else if (block.kind === 'constants') {
      if (cells.length < 5) { spec.errors.push(`line ${no}: a constants row is | Constant | Where | Value | Units | Why |`); continue; }
      // An export path is written in backticks; a literal inside a body has a plain-text name.
      const name = ticked(cells[0]!)[0] ?? cells[0]!;
      const where = ticked(cells[1]!);
      if (!name || !where.length) { spec.errors.push(`line ${no}: a constants row names a constant and \`file\` [\`fragment with §\`]`); continue; }
      if (where.length < 2 && !ticked(cells[0]!).length) { spec.errors.push(`line ${no}: "${name}" is not an export path, so its Where needs a \`fragment with §\``); continue; }
      spec.constants.push({ name, file: where[0]!, ...(where[1] ? { pattern: where[1] } : {}), value: cells[2]!, units: cells[3]!, why: cells[4]!, line: no });
    }
  }
  if (block) spec.errors.push(`line ${block.line}: block ${block.kind} is never closed`);
  return spec;
}

/** How far a written value may sit from the code's: half a unit in its last written digit. */
export function tolerance(written: string): number {
  const m = /^-?\d+(?:\.(\d+))?(?:e(-?\d+))?$/i.exec(written.trim());
  if (!m) return NaN;
  const decimals = (m[1]?.length ?? 0) - Number(m[2] ?? 0);
  return 0.5 * 10 ** -decimals + 1e-12;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NUMBER_SOURCE = '(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e-?\\d+)?)';

/** The number a `§` fragment captures in a source file, or a problem. */
export function valueFromFragment(sourceText: string, pattern: string): number | string {
  if (pattern.split('§').length !== 2) return `fragment \`${pattern}\` must contain exactly one §`;
  const [before, after] = pattern.split('§') as [string, string];
  const re = new RegExp(escapeRegExp(before).replace(/\s+/g, '\\s*') + NUMBER_SOURCE + escapeRegExp(after).replace(/\s+/g, '\\s*'), 'g');
  const hits = [...sourceText.matchAll(re)];
  if (hits.length !== 1) return `fragment \`${pattern}\` matches ${hits.length} places (needs exactly 1)`;
  return Number(hits[0]![1]);
}

/** Resolve `A.B.C` on a module namespace. */
function readPath(namespace: Record<string, unknown>, dotted: string): unknown {
  let value: unknown = namespace;
  for (const key of dotted.split('.')) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return value;
}

/** Every problem with the spec against the code; empty when it is current. */
export async function checkPhysicsSpec(root: string = REPO_ROOT, specPath: string = SPEC_PATH): Promise<string[]> {
  const specFile = join(root, specPath);
  if (!existsSync(specFile)) return [`${specPath} does not exist`];
  const spec = parseSpec(readFileSync(specFile, 'utf8'));
  const problems = spec.errors.map(e => `${specPath} ${e}`);
  const at = (line: number): string => `${specPath}:${line}`;

  // (a) Paths named anywhere in the document exist.
  for (const { path, line } of spec.paths) if (!existsSync(join(root, path))) problems.push(`${at(line)}: \`${path}\` does not exist`);

  // (a) + (c) Every inventoried module's table matches its exports exactly.
  for (const [file, rows] of spec.exports) {
    const abs = join(root, file);
    if (!existsSync(abs)) { problems.push(`${specPath}: exports block for missing file ${file}`); continue; }
    const actual = new Map(collectExports(abs).map(s => [s.name, s.kind]));
    const listed = new Set<string>();
    for (const row of rows) {
      for (const symbol of row.symbols) {
        if (listed.has(symbol)) problems.push(`${at(row.line)}: \`${symbol}\` is listed twice for ${file}`);
        listed.add(symbol);
        const kind = actual.get(symbol);
        if (!kind) problems.push(`${at(row.line)}: ${file} does not export \`${symbol}\``);
        else if (!row.kind.split(/[\s,(]/).includes(kind)) problems.push(`${at(row.line)}: \`${symbol}\` in ${file} is a ${kind}, the spec says "${row.kind}"`);
      }
    }
    for (const [name, kind] of actual) if (!listed.has(name)) problems.push(`${file} exports ${kind} \`${name}\`, which ${specPath} does not document (add it to that file's exports table)`);
  }
  for (const file of [...spec.consumers, ...spec.notPhysics]) if (!existsSync(join(root, file))) problems.push(`${specPath}: listed file ${file} does not exist`);

  // (c) A new physics-named module must be classified.
  const known = new Set([...spec.exports.keys(), ...spec.consumers, ...spec.notPhysics]);
  for (const dir of DISCOVERY_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (!/\.ts$/.test(name) || /\.d\.ts$/.test(name) || !PHYSICS_NAME.test(name)) continue;
      const rel = `${dir}/${name}`;
      if (!known.has(rel)) problems.push(`${rel} looks like a physics module (name matches ${PHYSICS_NAME}) but ${specPath} lists it nowhere: add an exports table, or a consumers / not-physics row`);
    }
  }

  // (b) Every constant's written value is the code's.
  const modules = new Map<string, Record<string, unknown>>();
  for (const row of spec.constants) {
    const abs = join(root, row.file);
    if (!existsSync(abs)) { problems.push(`${at(row.line)}: \`${row.file}\` does not exist`); continue; }
    if (!row.units || !row.why) problems.push(`${at(row.line)}: \`${row.name}\` needs units and a justification`);
    const tol = tolerance(row.value);
    if (!Number.isFinite(tol)) { problems.push(`${at(row.line)}: \`${row.name}\` value "${row.value}" is not a plain number`); continue; }
    let actual: unknown;
    if (row.pattern) {
      const found = valueFromFragment(readFileSync(abs, 'utf8'), row.pattern);
      if (typeof found === 'string') { problems.push(`${at(row.line)}: \`${row.name}\` in ${row.file}: ${found}`); continue; }
      actual = found;
    } else {
      let namespace = modules.get(row.file);
      if (!namespace) {
        try { namespace = await import(pathToFileURL(abs).href) as Record<string, unknown>; } catch (err) { problems.push(`${at(row.line)}: cannot import ${row.file}: ${String(err)}`); continue; }
        modules.set(row.file, namespace);
      }
      actual = readPath(namespace, row.name);
    }
    if (typeof actual !== 'number' || !Number.isFinite(actual)) { problems.push(`${at(row.line)}: \`${row.name}\` is not a finite number in ${row.file} (got ${String(actual)})`); continue; }
    if (Math.abs(actual - Number(row.value)) > tol) problems.push(`${at(row.line)}: \`${row.name}\` is ${actual} in ${row.file}, the spec says ${row.value}`);
  }
  return problems;
}

/** A draft exports table for a file (`--list`), to paste and then write the roles into. */
export function draftExportsTable(root: string, file: string): string {
  const rows = collectExports(join(root, file)).map(s => `| \`${s.name}\` | ${s.kind} | TODO |`);
  return [`<!-- physics-spec:exports ${file} -->`, '| Export | Kind | Role |', '|---|---|---|', ...rows, '<!-- /physics-spec:exports -->'].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--list') {
    for (const file of args.slice(1)) console.log(draftExportsTable(REPO_ROOT, file) + '\n');
    return;
  }
  const problems = await checkPhysicsSpec();
  if (problems.length) {
    console.error(`${SPEC_PATH} is stale: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`${SPEC_PATH}: current (paths, exports, constants and module discovery all check)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
