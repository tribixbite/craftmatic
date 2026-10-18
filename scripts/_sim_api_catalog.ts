/**
 * Generate the simulator's catalog of the REAL Script API surface
 * (`web/src/sim/script-host/api-catalog.ts`) from the published type
 * declarations of `@minecraft/server`, `@minecraft/server-ui` and (optional)
 * `@minecraft/server-gametest`.
 *
 * Why: the simulator's mock answers an API member it does not implement by
 * throwing `Unmodelled` and recording it - but only when the game HAS that
 * member. A name the game lacks reads `undefined` on the device too, so a
 * feature probe (`entity.someNewMethod?.()`) must not be reported. The catalog
 * is how the mock tells the two apart. Each enum also carries its VALUES
 * (`values`: a numeric enum such as `InputPermissionCategory` has numbers, a
 * string enum such as `EntityComponentTypes` has its id strings), so the mock
 * hands scripts the device's values, not the member names.
 *
 * Usage (the tarballs from the npm registry, unpacked anywhere):
 *   bun scripts/_sim_api_catalog.ts <server/index.d.ts> <server-ui/index.d.ts> [<server-gametest/index.d.ts>] [--out=<file>]
 * The versions must be the ones the packs' manifests declare
 * (`@minecraft/server` 2.9.0, `@minecraft/server-ui` 2.1.0 on 2026-09-30;
 * `@minecraft/server-gametest` 1.0.0-beta.1.26.52-stable, the beta 1.26.5x
 * ships, on 2026-10-08 - the test variant declares `1.0.0-beta`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as ts from 'typescript';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const files = args.filter(a => !a.startsWith('--'));
if (files.length !== 2 && files.length !== 3) { console.error('usage: bun scripts/_sim_api_catalog.ts <server/index.d.ts> <server-ui/index.d.ts> [<server-gametest/index.d.ts>] [--out=<file>]'); process.exit(2); }
const out = flag('out') ?? 'web/src/sim/script-host/api-catalog.ts';

interface Entry { kind: 'class' | 'interface' | 'enum'; extends: string[]; members: Set<string>; statics: Set<string>; values: Map<string, string | number>; restricted: Set<string> }

/**
 * Whether a member's doc comment says it may not run in restricted-execution (read-only) mode - the mode a
 * before-event callback runs in ("Event callbacks are executed in read-only mode", `World.beforeEvents`):
 * "This function can't be called in restricted-execution mode" / "This property can't be edited in ...".
 */
function isRestricted(m: ts.Node, src: ts.SourceFile): boolean {
  return ts.getJSDocCommentsAndTags(m).some(d => /can't be (called|edited) in restricted-execution mode/.test(d.getText(src)));
}

/** An enum member's initialiser: a string or (signed) numeric literal; undefined for anything else. */
function literalOf(e: ts.Expression | undefined): string | number | undefined {
  if (!e) return undefined;
  if (ts.isStringLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
  return undefined;
}

function read(path: string, base?: Map<string, Entry>): { entries: Map<string, Entry>; exports: string[]; version: string } {
  const text = readFileSync(path, 'utf8');
  const src = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const entries = new Map<string, Entry>();
  const exports: string[] = [];
  const version = /@minecraft\/[\w-]+@?\s*([\d.]+)/.exec(text)?.[1] ?? /"version":\s*"([^"]+)"/.exec(text)?.[1] ?? '';
  const nameOf = (n: ts.PropertyName | undefined): string | undefined => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined);
  const fresh = (kind: Entry['kind']): Entry => ({ kind, extends: [], members: new Set(), statics: new Set(), values: new Map(), restricted: new Set() });
  for (const st of src.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isClassDeclaration(st) && st.name) {
      const e = fresh('class');
      for (const h of st.heritageClauses ?? []) for (const t of h.types) e.extends.push(t.expression.getText(src));
      for (const m of st.members) {
        const n = nameOf(m.name);
        if (!n) continue;
        const isStatic = ts.canHaveModifiers(m) && ts.getModifiers(m)?.some(k => k.kind === ts.SyntaxKind.StaticKeyword);
        (isStatic ? e.statics : e.members).add(n);
        if (isRestricted(m, src)) e.restricted.add(n);
      }
      entries.set(st.name.text, e);
      if (exported) exports.push(st.name.text);
    } else if (ts.isInterfaceDeclaration(st)) {
      const e = fresh('interface');
      for (const h of st.heritageClauses ?? []) for (const t of h.types) e.extends.push(t.expression.getText(src));
      for (const m of st.members) { const n = nameOf(m.name); if (n) { e.members.add(n); if (isRestricted(m, src)) e.restricted.add(n); } }
      entries.set(st.name.text, e);
    } else if (ts.isEnumDeclaration(st)) {
      const e = fresh('enum');
      for (const m of st.members) {
        const n = nameOf(m.name);
        if (!n) continue;
        e.members.add(n);
        const v = literalOf(m.initializer);
        if (v !== undefined) e.values.set(n, v);
      }
      entries.set(st.name.text, e);
      if (exported) exports.push(st.name.text);
    } else if (ts.isVariableStatement(st) && exported) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) exports.push(d.name.text);
    } else if (ts.isFunctionDeclaration(st) && st.name && exported) exports.push(st.name.text);
  }
  // Flatten inheritance so each entry lists every member it answers to. A parent named through another module's
  // namespace (`minecraftserver.Player`, the GameTest's SimulatedPlayer) resolves in `base` (the server's entries).
  const resolve = (name: string, seen = new Set<string>()): Set<string> => {
    const bare = name.replace(/<.*$/, '');
    const local = entries.get(bare);
    const e = local ?? base?.get(bare.replace(/^\w+\./, ''));
    if (!e || seen.has(bare)) return new Set();
    seen.add(bare);
    const all = new Set(e.members);
    for (const p of e.extends) for (const m of (local ? resolve(p, seen) : resolveIn(base!, p, seen))) all.add(m);
    return all;
  };
  // Restricted members are inherited too (a Player's `teleport` is Entity's).
  const restrictedOf = (name: string, seen = new Set<string>()): Set<string> => {
    const bare = name.replace(/<.*$/, '');
    const local = entries.get(bare);
    const e = local ?? base?.get(bare.replace(/^\w+\./, ''));
    if (!e || seen.has(bare)) return new Set();
    seen.add(bare);
    const all = new Set(e.restricted);
    for (const p of e.extends) for (const m of restrictedOf(p, seen)) all.add(m);
    return all;
  };
  const restricted = new Map([...entries.keys()].map(n => [n, restrictedOf(n)]));
  for (const [name, e] of entries) { e.members = resolve(name); e.restricted = restricted.get(name)!; }
  return { entries, exports, version };
}

/** Members of an entry of another module (already flattened when that module was read). */
function resolveIn(entries: Map<string, Entry>, name: string, _seen: Set<string>): Set<string> {
  return new Set(entries.get(name.replace(/<.*$/, '').replace(/^\w+\./, ''))?.members ?? []);
}

const server = read(files[0]!), ui = read(files[1]!);
const gametest = files[2] ? read(files[2], server.entries) : undefined;
const lines: string[] = [];
lines.push('/**');
lines.push(' * GENERATED by `bun scripts/_sim_api_catalog.ts` from the published type');
lines.push(' * declarations of `@minecraft/server`, `@minecraft/server-ui` and');
lines.push(' * `@minecraft/server-gametest` (the versions the packs\' manifests declare).');
lines.push(' * Do not edit by hand: re-run the generator.');
lines.push(' *');
lines.push(' * Every class/interface of the real API with the members it answers to');
lines.push(' * (inherited ones included), each enum with its members and their values,');
lines.push(' * and each module\'s exports. The mock consults it to tell an UNMODELLED member');
lines.push(' * (the game has it, the simulator does not: throw and record) from a name the');
lines.push(' * game lacks (`undefined`, as on the device), and hands scripts the enums\'');
lines.push(' * real values (numbers for a numeric enum).');
lines.push(' */');
lines.push('');
lines.push('/**');
lines.push(' * One API type: its kind and member names (instance members; `statics` for a class\'s static ones; `values` for an');
lines.push(' * enum\'s members; `restricted`: the members that may not run in restricted-execution (read-only) mode, the mode a');
lines.push(' * before-event callback runs in).');
lines.push(' */');
lines.push('export interface ApiType { kind: \'class\' | \'interface\' | \'enum\'; members: readonly string[]; statics?: readonly string[]; values?: Readonly<Record<string, string | number>>; restricted?: readonly string[] }');
lines.push('');
const dump = (label: string, prefix: string, r: ReturnType<typeof read>): void => {
  lines.push(`/** \`${label}\`: exports. */`);
  lines.push(`export const ${prefix}_EXPORTS: readonly string[] = ${JSON.stringify(r.exports.sort())};`);
  lines.push('');
  lines.push(`/** \`${label}\`: types by name. */`);
  lines.push(`export const ${prefix}_TYPES: Readonly<Record<string, ApiType>> = {`);
  for (const [name, e] of [...r.entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    const statics = e.statics.size ? `, statics: ${JSON.stringify([...e.statics].sort())}` : '';
    const values = e.values.size ? `, values: ${JSON.stringify(Object.fromEntries(e.values))}` : '';
    const restricted = e.restricted.size ? `, restricted: ${JSON.stringify([...e.restricted].sort())}` : '';
    lines.push(`  ${JSON.stringify(name)}: { kind: '${e.kind}', members: ${JSON.stringify([...e.members].sort())}${statics}${values}${restricted} },`);
  }
  lines.push('};');
  lines.push('');
};
dump('@minecraft/server', 'SERVER', server);
dump('@minecraft/server-ui', 'SERVER_UI', ui);
if (gametest) dump('@minecraft/server-gametest', 'GAMETEST', gametest);
writeFileSync(out, lines.join('\n'));
console.log(`${out}: ${server.entries.size} server types, ${ui.entries.size} ui types${gametest ? `, ${gametest.entries.size} gametest types` : ''}; exports ${server.exports.length} + ${ui.exports.length}${gametest ? ` + ${gametest.exports.length}` : ''}`);
