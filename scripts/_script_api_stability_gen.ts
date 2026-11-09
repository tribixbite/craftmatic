/**
 * Generate `scripts/script-api-typings/stability.json`: which Script API names exist ONLY after the
 * manifest-declared stable version, or only in the beta (BIZ-24, M15).
 *
 * Why a table when the vendored stable typings already type-check a script: the packs pass `world` /
 * `system` into their runtimes as PARAMETERS (`(function runtime(world, system) {...}).toString()`), so
 * inside the runtime they are implicit `any` and TypeScript cannot say `world.afterEvents.itemStartUse`
 * does not exist. A name that is in no stable declaration but is in the beta one is still a beta API, and
 * is found by NAME on those untyped receivers (`_script_api_audit.ts` `nameFindings`).
 *
 * Usage (the tarballs of `npm pack @minecraft/server@<v>` etc. unpacked anywhere):
 *   bun scripts/_script_api_stability_gen.ts --beta-server=<dir with index.d.ts> --beta-ui=<dir with index.d.ts>
 * The stable inputs are the typings vendored in `scripts/script-api-typings/` (see `STABLE_TYPINGS`).
 * Output is deterministic (sorted), so a re-run on the same inputs leaves the file byte-identical.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

/** Vendored stable typings, oldest (the version packs declare today) first. */
export const STABLE_TYPINGS = {
  /** The versions the generated packs' manifests declare (`engine/mcpack.ts`, `playable-addon.ts`). */
  declared: { server: '2.9.0', 'server-ui': '2.1.0', common: '1.3.0' },
  /** The newest stable release at vendoring time (npm `latest`, 2026-11-09). */
  latest: { server: '2.11.0', 'server-ui': '2.3.0' },
} as const;

/** The beta release the names are compared against (npm `beta` tag, 2026-11-09). */
export const BETA_LABEL = { server: '2.12.0-beta.1.26.63-stable', 'server-ui': '2.4.0-beta.1.26.63-stable' } as const;

/** What the generator writes and the audit reads. */
export interface StabilityTable {
  /** Provenance: the exact typings the table was derived from. */
  derivedFrom: { declared: Record<string, string>; latest: Record<string, string>; beta: Record<string, string> };
  /** Names present in the latest stable typings but not in the declared ones: name -> `<module>@<first version vendored with it>`. */
  addedAfterDeclared: Record<string, string>;
  /** Names present only in the beta typings. */
  betaOnly: string[];
}

/** Every declared name of one `.d.ts`: exports (classes, enums, interfaces, functions, consts, types) and all their members. */
export function declaredNames(dtsText: string): Set<string> {
  const names = new Set<string>();
  const src = ts.createSourceFile('x.d.ts', dtsText, ts.ScriptTarget.Latest, true);
  const add = (n: ts.PropertyName | ts.BindingName | ts.EntityName | undefined): void => {
    if (!n) return;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) names.add(n.text);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isModuleDeclaration(node)
    ) add(node.name as ts.Identifier | undefined);
    else if (ts.isVariableDeclaration(node)) add(node.name);
    else if (
      ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isEnumMember(node)
    ) add(node.name);
    ts.forEachChild(node, visit);
  };
  visit(src);
  return names;
}

/** Union of {@link declaredNames} over several files. */
function unionNames(paths: readonly string[]): Set<string> {
  const all = new Set<string>();
  for (const p of paths) for (const n of declaredNames(readFileSync(p, 'utf8'))) all.add(n);
  return all;
}

/** Path of a vendored typings file. */
export function typingsPath(root: string, mod: string, version: string): string {
  return join(root, 'script-api-typings', `${mod}@${version}`, 'index.d.ts');
}

/** Build the table from the vendored stable typings and the two beta `index.d.ts` paths. */
export function buildStabilityTable(scriptsDir: string, betaServer: string, betaUi: string): StabilityTable {
  const d = STABLE_TYPINGS.declared;
  const l = STABLE_TYPINGS.latest;
  const base = unionNames([typingsPath(scriptsDir, 'server', d.server), typingsPath(scriptsDir, 'server-ui', d['server-ui']), typingsPath(scriptsDir, 'common', d.common)]);
  const latestNames = new Map<string, string>(); // name -> `<module>@<version>` of the first latest-stable file declaring it
  for (const [mod, ver] of [['server', l.server], ['server-ui', l['server-ui']]] as const) {
    for (const n of declaredNames(readFileSync(typingsPath(scriptsDir, mod, ver), 'utf8'))) if (!latestNames.has(n)) latestNames.set(n, `${mod}@${ver}`);
  }
  const addedAfterDeclared: Record<string, string> = {};
  for (const [n, v] of [...latestNames].sort(([a], [b]) => a.localeCompare(b))) if (!base.has(n)) addedAfterDeclared[n] = v;
  const beta = unionNames([betaServer, betaUi]);
  const betaOnly = [...beta].filter(n => !base.has(n) && !latestNames.has(n)).sort((a, b) => a.localeCompare(b));
  return {
    derivedFrom: { declared: { ...d }, latest: { ...l }, beta: { ...BETA_LABEL } },
    addedAfterDeclared,
    betaOnly,
  };
}

if (import.meta.main) {
  const flag = (n: string): string | undefined => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const server = flag('beta-server');
  const ui = flag('beta-ui');
  if (!server || !ui) { console.error('usage: bun scripts/_script_api_stability_gen.ts --beta-server=<dir> --beta-ui=<dir>'); process.exit(2); }
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const table = buildStabilityTable(scriptsDir, join(server, 'index.d.ts'), join(ui, 'index.d.ts'));
  const out = join(scriptsDir, 'script-api-typings', 'stability.json');
  writeFileSync(out, JSON.stringify(table, null, 1) + '\n');
  console.log(`${out}: ${Object.keys(table.addedAfterDeclared).length} names added after the declared versions, ${table.betaOnly.length} beta-only`);
}
