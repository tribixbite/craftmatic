/**
 * Post-pass namespace and folder rewriter (X-03, BIZ-22; plan A sections 7.1 and 7.2).
 *
 * Takes the FINISHED file list of a dev add-on (as `buildPlayableAddon` returns it, or as unzipped from a
 * `.mcaddon`) and returns a new file list in which
 *
 *   - every `craftmatic:` id, `craftmatic_` family / file prefix, `geometry.craftmatic.*`, `animation.craftmatic.*`,
 *     `controller.{render,animation}.craftmatic.*` id and bare `craftmatic` word becomes the product namespace
 *     `<creator>_<pack>`, in JSON, `.lang`, `.mcfunction`, README text, the generated scripts (string literals, template
 *     literals and prefix constants alike: the scripts compute ids as `` `craftmatic:${x}` ``, so a literal-prefix
 *     rewrite reaches them) and the block palette of every `.mcstructure` (binary NBT, re-encoded with new lengths);
 *   - every content file moves from `<type>/<name>` to `<type>/<creator>/<pack>/<name>` (CADDONREQ101/104/111), with
 *     each path reference, `/function` id and `structure load` id rewritten in the same pass; the two pack roots are
 *     renamed `<rootStem>_BP` / `<rootStem>_RP`;
 *   - optionally the manifest uuids are swapped for a product's frozen ones.
 *
 * It is a post-pass on purpose (plan A 2.2): the dev pack, the emitters and every device-proven behaviour stay
 * untouched, and one module owns the rule. Its known risk is an id built in a way the token rules do not see, so
 * `rewritePack` ends with a whole-archive scan for any remaining `craftmatic` token (file names and bytes,
 * case-insensitive) and reports it; callers (`scripts/_marketplace_pack.ts`, the tests) refuse on a non-empty
 * `report.residual`.
 *
 * TODO(pack-ids): thread the namespace through the emitters (`PACK_NAMESPACE` is read in 19 files) once the
 * in-flight branches have merged, and retire this module's token rules.
 * TODO(pack-text): player-visible strings that name the tool (`'Craftmatic computer'`, the `[craftmatic seat]` log
 * prefix) are only renamed to the namespace here; the player text table belongs to X-05 (`pack-text/`).
 */
import { namespaceProblems } from '../../release/product.js';
import type { ProductIdentity, ProductUuids } from '../../release/types.js';

/** One file of an add-on archive. */
export interface PackFile { name: string; data: Uint8Array }

/** The dev namespace this pass removes. */
export const SOURCE_NAMESPACE = 'craftmatic';

/**
 * Content-type folders: a file inside one must sit at `<folder>/<creator>/<pack>/...` in a release.
 * Mirrors `RELEASE_CONTENT_FOLDERS` in `scripts/_mcaddon_check.py` (the gate); a test keeps the two equal.
 */
export const CONTENT_FOLDERS: readonly string[] = [
  'entities', 'blocks', 'items', 'structures', 'functions', 'animations', 'animation_controllers',
  'loot_tables', 'recipes', 'trading', 'spawn_rules', 'features', 'feature_rules', 'biomes',
  'entity', 'render_controllers', 'particles', 'attachables', 'materials', 'fogs',
  'models/entity', 'models/blocks', 'textures/blocks', 'textures/items', 'textures/entity',
  'textures/ui', 'textures/particle', 'textures/environment', 'textures/colormap',
];

/** Folders whose files are addressed by an id (`/function`, `structure load`), not by a path string. */
const ID_ADDRESSED_FOLDERS: readonly string[] = ['structures', 'functions'];

/** File extensions read and rewritten as UTF-8 text. Everything else is binary (copied, scanned, never edited). */
const TEXT_EXTENSIONS: readonly string[] = ['json', 'js', 'mjs', 'lang', 'txt', 'md', 'mcfunction', 'material', 'fragment', 'vertex', 'geometry'];

/** Files whose bytes may keep the tool's name (the credits file names the tool that made the pack). */
export const DEFAULT_TOKEN_ALLOWED = /(^|\/)CREDITS\.txt$/;

/** The rewrite could not be performed safely (ambiguous input); nothing was returned. */
export class RewriteError extends Error {
  constructor(message: string) { super(`marketplace rewrite: ${message}`); this.name = 'RewriteError'; }
}

/** What to rewrite the pack into. */
export interface RewriteOptions {
  /** Creator part of the namespace and of the `<creator>/<pack>` folders. Lowercase letters and digits (no underscore, so the namespace splits back). */
  creator: string;
  /** Pack part of the namespace and folders: `^[a-z][a-z0-9_]*$`. */
  pack: string;
  /** Pack root folders become `<rootStem>_BP` / `<rootStem>_RP`. Default: the namespace. */
  rootStem?: string;
  /** Frozen manifest uuids to install instead of the pack's own (X-01's identity). Omitted: the manifests keep theirs. */
  uuids?: ProductUuids;
  /** Files that may keep a `craftmatic` token (default: `CREDITS.txt`). */
  tokenAllowed?: RegExp;
}

/** `RewriteOptions` for a registered product: its namespace must be `<creator>_<pack>`. Throws on a null namespace. */
export function optionsFromIdentity(identity: ProductIdentity, creator: string): RewriteOptions {
  if (identity.namespace === null) throw new RewriteError('the product namespace is null (U1 is undecided); a release build refuses it');
  const prefix = `${creator}_`;
  if (!identity.namespace.startsWith(prefix)) throw new RewriteError(`namespace ${identity.namespace} does not start with ${prefix}`);
  return { creator, pack: identity.namespace.slice(prefix.length), rootStem: identity.folderStem, uuids: identity.uuids };
}

/** A `craftmatic` token that survived the pass. */
export interface ResidualToken { file: string; where: 'name' | 'content'; excerpt: string }

/** What the pass did. */
export interface RewriteReport {
  namespace: string;
  /** Archive path before and after, for every file whose path changed. */
  renamed: Array<{ from: string; to: string }>;
  /** Structure ids (`craftmatic:<tile>`) re-addressed to the folder form `<creator>:<pack>/<tile>`. */
  structureIds: Array<{ from: string; to: string }>;
  /** Files where the bare word `craftmatic` (log prefixes, UI titles, `generator`) was replaced by the namespace: player text for X-05 to own. */
  bareWords: Array<{ file: string; count: number }>;
  /** Tokens still present after the pass; the guard is that this is empty. */
  residual: ResidualToken[];
}

/** Escape a string for use inside a RegExp. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const encoder = new TextEncoder();
/** One char per byte, so a binary file is scanned without decoding errors. */
const latin1 = new TextDecoder('latin1');

const extensionOf = (name: string): string => {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
};
const isTextFile = (name: string): boolean => TEXT_EXTENSIONS.includes(extensionOf(name));

/** `a/b.c.json` -> `a/b.c` (the last extension only). */
const stripExtension = (path: string): string => {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(0, dot) : path;
};

/** The product's namespace, validated. */
function namespaceOf(o: RewriteOptions): string {
  if (!/^[a-z][a-z0-9]*$/.test(o.creator)) throw new RewriteError(`creator ${JSON.stringify(o.creator)} must match ^[a-z][a-z0-9]*$`);
  if (!/^[a-z][a-z0-9_]*$/.test(o.pack)) throw new RewriteError(`pack ${JSON.stringify(o.pack)} must match ^[a-z][a-z0-9_]*$`);
  const ns = `${o.creator}_${o.pack}`;
  const problems = namespaceProblems(ns);
  if (ns.includes(SOURCE_NAMESPACE)) problems.push(`namespace ${ns} still contains the dev name ${SOURCE_NAMESPACE}`);
  if (problems.length) throw new RewriteError(problems.join('; '));
  return ns;
}

// ---------------------------------------------------------------------------------------------------------------
// The token rules (text and NBT strings)
// ---------------------------------------------------------------------------------------------------------------

/** Compiled token rules for one namespace. */
interface TokenRules {
  /** Rewrite every dev-namespace token in `text`; `bare` collects how many bare words were replaced. */
  apply(text: string, bare?: { count: number }): string;
}

function tokenRules(ns: string): TokenRules {
  const NAME = SOURCE_NAMESPACE;
  // geometry.craftmatic.x, animation.craftmatic.x, controller.render.craftmatic.x, controller.animation.craftmatic.x
  const dotted = new RegExp(`(?<=\\b(?:geometry|animation|controller\\.render|controller\\.animation)\\.)${NAME}(?=\\.)`, 'gi');
  const colon = new RegExp(`${NAME}:`, 'gi');
  const underscore = new RegExp(`${NAME}_`, 'gi');
  const hyphen = new RegExp(`${NAME}-`, 'gi');
  // camelCase identifiers and labels (`craftmaticMinifigWand`): the next word starts with a capital.
  const camel = new RegExp(`[Cc]${NAME.slice(1)}(?=[A-Z])`, 'g');
  // The bare word: log prefixes, `generator`, UI titles. Not part of a longer identifier.
  const bareWord = new RegExp(`(?<![A-Za-z0-9_])${NAME}(?![A-Za-z0-9_])`, 'gi');
  return {
    apply(text, bare) {
      let out = text.replace(dotted, ns).replace(colon, `${ns}:`).replace(underscore, `${ns}_`).replace(hyphen, `${ns}-`).replace(camel, ns);
      out = out.replace(bareWord, () => { if (bare) bare.count++; return ns; });
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Bedrock NBT (little endian) string rewriting, for .mcstructure block palettes
// ---------------------------------------------------------------------------------------------------------------

/**
 * Re-encode a Bedrock (little-endian, headerless) NBT file with every string and compound key passed through `map`,
 * fixing the 16-bit length prefixes. Everything else is copied byte for byte. Throws on anything that does not parse
 * to exactly the end of the data (a half-edited length prefix would corrupt the structure silently).
 */
export function rewriteNbtStrings(input: Uint8Array, map: (s: string) => string): Uint8Array {
  // A copy: the input may come from another realm (a zip reader's Buffer), whose ArrayBuffer a DataView refuses.
  const data = Uint8Array.from(input);
  const view = new DataView(data.buffer);
  const out: Uint8Array[] = [];
  let pos = 0;
  let copyFrom = 0;
  const need = (n: number): void => { if (pos + n > data.length) throw new RewriteError('truncated NBT'); };
  const u8 = (): number => { need(1); return data[pos++]!; };
  const i32 = (): number => { need(4); const v = view.getInt32(pos, true); pos += 4; return v; };
  /** Read a length-prefixed string at `pos`; emit its mapped form when it changed. */
  const string = (): void => {
    need(2);
    const lenAt = pos;
    const len = view.getUint16(pos, true);
    pos += 2;
    need(len);
    const original = decoder.decode(data.subarray(pos, pos + len));
    const mapped = map(original);
    if (mapped !== original) {
      const bytes = encoder.encode(mapped);
      if (bytes.length > 0xffff) throw new RewriteError('NBT string too long after rewrite');
      out.push(data.subarray(copyFrom, lenAt));
      const prefix = new Uint8Array(2);
      new DataView(prefix.buffer).setUint16(0, bytes.length, true);
      out.push(prefix, bytes);
      copyFrom = pos + len;
    }
    pos += len;
  };
  const payload = (type: number): void => {
    switch (type) {
      case 1: need(1); pos += 1; return;
      case 2: need(2); pos += 2; return;
      case 3: case 5: need(4); pos += 4; return;
      case 4: case 6: need(8); pos += 8; return;
      case 7: { const n = i32(); need(n); pos += n; return; }
      case 8: string(); return;
      case 9: {
        const elem = u8(); const n = i32();
        if (n < 0) throw new RewriteError('negative NBT list length');
        for (let i = 0; i < n; i++) payload(elem);
        return;
      }
      case 10:
        for (;;) { const t = u8(); if (t === 0) return; string(); payload(t); }
      case 11: { const n = i32(); need(n * 4); pos += n * 4; return; }
      case 12: { const n = i32(); need(n * 8); pos += n * 8; return; }
      default: throw new RewriteError(`unknown NBT tag type ${type}`);
    }
  };
  const root = u8();
  if (root !== 10) throw new RewriteError(`NBT root is tag ${root}, expected a compound`);
  string();
  payload(10);
  if (pos !== data.length) throw new RewriteError(`NBT has ${data.length - pos} trailing bytes`);
  if (out.length === 0) return input;
  out.push(data.subarray(copyFrom));
  const total = out.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const p of out) { joined.set(p, at); at += p.length; }
  return joined;
}

// ---------------------------------------------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------------------------------------------

interface PackRoot { old: string; kind: 'BP' | 'RP'; neu: string }

/** Find the pack roots (the folders holding a manifest) and classify each by its module types. */
function findRoots(files: readonly PackFile[], rootStem: string): PackRoot[] {
  const roots: PackRoot[] = [];
  for (const f of files) {
    if (!f.name.endsWith('manifest.json')) continue;
    const slash = f.name.lastIndexOf('/');
    if (f.name.slice(slash + 1) !== 'manifest.json') continue;
    const old = f.name.slice(0, slash + 1);
    if (old.split('/').length > 2) continue; // only top-level pack folders
    let types: string[];
    try {
      const m = JSON.parse(decoder.decode(f.data)) as { modules?: Array<{ type?: string }> };
      types = (m.modules ?? []).map(x => String(x.type));
    } catch { throw new RewriteError(`${f.name} is not valid JSON`); }
    const kind = types.includes('resources') ? 'RP' : types.some(t => t === 'data' || t === 'script') ? 'BP' : undefined;
    if (!kind) throw new RewriteError(`${f.name} declares no resources, data or script module`);
    if (old === '') throw new RewriteError('a pack at the archive root cannot be told from its sibling; the archive needs one folder per pack');
    roots.push({ old, kind, neu: `${rootStem}_${kind}/` });
  }
  const kinds = roots.map(r => r.kind);
  if (new Set(kinds).size !== kinds.length) throw new RewriteError('two behaviour packs or two resource packs in one archive');
  if (roots.length === 0) throw new RewriteError('no pack manifest found');
  return roots;
}

/** Old-uuid -> new-uuid for the manifests, matched by slot. */
function uuidMap(files: readonly PackFile[], roots: readonly PackRoot[], uuids: ProductUuids): Map<string, string> {
  const map = new Map<string, string>();
  for (const root of roots) {
    const file = files.find(f => f.name === `${root.old}manifest.json`)!;
    const m = JSON.parse(decoder.decode(file.data)) as { header: { uuid: string }; modules: Array<{ type: string; uuid: string }> };
    if (root.kind === 'BP') {
      map.set(m.header.uuid, uuids.bpHeader);
      for (const mod of m.modules) { if (mod.type === 'data') map.set(mod.uuid, uuids.bpData); if (mod.type === 'script') map.set(mod.uuid, uuids.bpScript); }
    } else {
      map.set(m.header.uuid, uuids.rpHeader);
      for (const mod of m.modules) if (mod.type === 'resources') map.set(mod.uuid, uuids.rpResources);
    }
  }
  return map;
}

/**
 * Rewrite a dev add-on's files into the product namespace and folder layout.
 * Throws `RewriteError` for input it cannot rewrite safely; a token it merely does not recognise is returned in
 * `report.residual`.
 */
export function rewritePack(files: readonly PackFile[], options: RewriteOptions): { files: PackFile[]; report: RewriteReport } {
  const ns = namespaceOf(options);
  const folderPath = `${options.creator}/${options.pack}`;
  const rootStem = options.rootStem ?? ns;
  const rules = tokenRules(ns);
  const tokenAllowed = options.tokenAllowed ?? DEFAULT_TOKEN_ALLOWED;
  const sourcePattern = new RegExp(SOURCE_NAMESPACE, 'i');

  // A pack with no dev token is not a dev pack (or was rewritten already): relocating it again would nest its folders.
  const hasToken = files.some(f => sourcePattern.test(f.name) || sourcePattern.test(decoder.decode(f.data)));
  if (!hasToken) throw new RewriteError(`no ${SOURCE_NAMESPACE} token in the archive: it is not a dev pack, or it was already rewritten`);

  const roots = findRoots(files, rootStem);
  const rootOf = (name: string): PackRoot | undefined => roots.find(r => name.startsWith(r.old));

  // ---- 1. where every file goes ------------------------------------------------------------------------------
  const folders = [...CONTENT_FOLDERS].sort((a, b) => b.length - a.length);
  const movedPath = new Map<string, string>(); // old archive path -> new archive path
  /** Root-relative old path (token rules applied to the NAME, the way file contents will read it) -> root-relative new path. */
  const refMap = new Map<string, string>();
  /** Function ids: old (`craftmatic/nimbus`, `b_c95d14`) -> new (`cmt/nimbus/nimbus`). */
  const functionIds = new Map<string, string>();
  /** Structure ids: old tile name -> new folder-form id. */
  const structureTiles = new Map<string, string>();
  const structureIds: RewriteReport['structureIds'] = [];

  for (const f of files) {
    const root = rootOf(f.name);
    if (!root) throw new RewriteError(`${f.name} sits outside every pack folder`);
    const rel = f.name.slice(root.old.length);
    const folder = folders.find(x => rel.startsWith(`${x}/`));
    let newRel: string;
    if (!folder) {
      newRel = rules.apply(rel);
    } else {
      let rest = rel.slice(folder.length + 1);
      // `structures/craftmatic/x` and `functions/craftmatic/x`: the old namespace folder is replaced, not nested.
      const oldNs = ID_ADDRESSED_FOLDERS.includes(folder) && rest.toLowerCase().startsWith(`${SOURCE_NAMESPACE}/`);
      const idRest = rest; // the id as the dev pack addresses it
      if (oldNs) rest = rest.slice(SOURCE_NAMESPACE.length + 1);
      rest = rules.apply(rest);
      newRel = `${folder}/${folderPath}/${rest}`;
      if (folder === 'functions') {
        functionIds.set(stripExtension(idRest), stripExtension(`${folderPath}/${rest}`));
      } else if (folder === 'structures' && oldNs) {
        const tile = stripExtension(idRest.slice(SOURCE_NAMESPACE.length + 1));
        const neu = `${options.creator}:${options.pack}/${stripExtension(rest)}`;
        structureTiles.set(tile, neu);
        structureIds.push({ from: `${SOURCE_NAMESPACE}:${tile}`, to: neu });
      } else if (!ID_ADDRESSED_FOLDERS.includes(folder)) {
        const oldRef = `${folder}/${rules.apply(idRest)}`;
        refMap.set(oldRef, newRel);
        refMap.set(stripExtension(oldRef), stripExtension(newRel));
      }
    }
    const to = `${root.neu}${newRel}`;
    movedPath.set(f.name, to);
  }
  const distinct = new Set(movedPath.values());
  if (distinct.size !== movedPath.size) throw new RewriteError('two files map to the same path after the rewrite');

  // A tile that shares its name with an entity/block/item id could not be told apart in a script string.
  const jsonIds = new Set<string>();
  for (const f of files) {
    if (extensionOf(f.name) !== 'json') continue;
    for (const m of decoder.decode(f.data).matchAll(new RegExp(`"identifier"\\s*:\\s*"${SOURCE_NAMESPACE}:([^"]+)"`, 'g'))) jsonIds.add(m[1]!);
  }
  for (const tile of structureTiles.keys()) {
    if (jsonIds.has(tile)) throw new RewriteError(`structure ${SOURCE_NAMESPACE}:${tile} shares its id with an entity, block or item: its script references are ambiguous`);
  }

  // ---- 2. the text passes ------------------------------------------------------------------------------------
  const rootRenames = roots.map(r => [r.old, r.neu] as const).sort((a, b) => b[0].length - a[0].length);
  const uuids = options.uuids ? uuidMap(files, roots, options.uuids) : undefined;
  const pathAlt = folders.filter(f => !ID_ADDRESSED_FOLDERS.includes(f)).map(escapeRe).join('|');
  const pathRef = new RegExp(`(?<![\\w./-])((?:${pathAlt})/[\\w./-]*\\w)`, 'g');
  const functionRefs = [...functionIds.entries()].map(([from, to]) => ({
    re: new RegExp(`(\\bfunction\\s+)${escapeRe(from)}(?![\\w/-]|\\.\\w)`, 'g'), to,
  }));
  const structureRefs = [...structureTiles.entries()].map(([tile, neu]) => ({
    quoted: new RegExp(`(["'\`])${SOURCE_NAMESPACE}:${escapeRe(tile)}\\1`, 'gi'),
    command: new RegExp(`(\\bstructure\\s+(?:load|delete|save)\\s+)${SOURCE_NAMESPACE}:${escapeRe(tile)}(?![\\w:/])`, 'gi'),
    neu,
  }));

  const bareWords: RewriteReport['bareWords'] = [];
  const rewriteText = (name: string, text: string): string => {
    let out = text;
    for (const [from, to] of rootRenames) out = out.split(from).join(to);
    if (uuids && name.endsWith('manifest.json')) for (const [from, to] of uuids) out = out.split(from).join(to);
    for (const s of structureRefs) out = out.replace(s.quoted, (_m, q: string) => `${q}${s.neu}${q}`).replace(s.command, (_m, pre: string) => `${pre}${s.neu}`);
    for (const fn of functionRefs) out = out.replace(fn.re, (_m, pre: string) => `${pre}${fn.to}`);
    const bare = { count: 0 };
    out = rules.apply(out, bare);
    if (bare.count) bareWords.push({ file: movedPath.get(name)!, count: bare.count });
    out = out.replace(pathRef, (whole: string, ref: string) => refMap.get(ref) ?? whole);
    return out;
  };

  const result: PackFile[] = [];
  for (const f of files) {
    const to = movedPath.get(f.name)!;
    let data = f.data;
    if (tokenAllowed.test(f.name)) {
      // an allowed file (the credits) names the tool on purpose: its text is carried over untouched
    } else if (isTextFile(f.name)) {
      const text = decoder.decode(f.data);
      const next = rewriteText(f.name, text);
      if (next !== text) data = encoder.encode(next);
    } else if (extensionOf(f.name) === 'mcstructure') {
      data = rewriteNbtStrings(f.data, s => rules.apply(s));
    }
    result.push({ name: to, data });
  }
  result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // ---- 3. the guard ------------------------------------------------------------------------------------------
  const residual = scanForToken(result, tokenAllowed);
  const renamed = [...movedPath.entries()].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to })).sort((a, b) => (a.from < b.from ? -1 : 1));
  return { files: result, report: { namespace: ns, renamed, structureIds, bareWords, residual } };
}

/** Every remaining `craftmatic` token (case-insensitive) in file names and bytes, except in allowed files' content. */
export function scanForToken(files: readonly PackFile[], allowed: RegExp = DEFAULT_TOKEN_ALLOWED): ResidualToken[] {
  const out: ResidualToken[] = [];
  const re = new RegExp(SOURCE_NAMESPACE, 'i');
  for (const f of files) {
    if (re.test(f.name)) out.push({ file: f.name, where: 'name', excerpt: f.name });
    if (allowed.test(f.name)) continue;
    const text = latin1.decode(f.data);
    const at = text.search(re);
    if (at >= 0) out.push({ file: f.name, where: 'content', excerpt: text.slice(Math.max(0, at - 24), at + 32).replace(/[^\x20-\x7e]/g, '.') });
  }
  return out;
}

/** Throw when the pass left a token behind (the guard of plan A 7.1). */
export function assertNoResidual(report: RewriteReport): void {
  if (report.residual.length === 0) return;
  const lines = report.residual.slice(0, 8).map(r => `  ${r.file} (${r.where}): ...${r.excerpt}...`);
  throw new RewriteError(`${report.residual.length} ${SOURCE_NAMESPACE} token(s) survived:\n${lines.join('\n')}`);
}

/** Render controllers the game itself defines; a client entity may name them without shipping one. */
const VANILLA_RENDER_CONTROLLERS: readonly string[] = ['controller.render.default'];

/** A reference an entity makes that nothing in the pack defines. */
export interface DanglingReference { file: string; kind: 'geometry' | 'render_controller' | 'animation' | 'texture'; ref: string }

/**
 * Check what a rewrite must not break: every geometry, render controller, animation (or animation controller) and
 * texture a client entity names is defined by a file in the same pack. Pure over the file list; the Python gate
 * (`_mcaddon_check.py`) does the same on disk.
 */
export function findDanglingReferences(files: readonly PackFile[]): DanglingReference[] {
  const names = new Set(files.map(f => f.name));
  const defined = { geometry: new Set<string>(), render_controller: new Set<string>(), animation: new Set<string>() };
  const jsonOf = (f: PackFile): unknown => { try { return JSON.parse(decoder.decode(f.data)); } catch { return undefined; } };
  const parsed = files.filter(f => extensionOf(f.name) === 'json').map(f => ({ f, d: jsonOf(f) as Record<string, unknown> | undefined }));
  for (const { d } of parsed) {
    if (!d) continue;
    for (const g of (d['minecraft:geometry'] as Array<{ description?: { identifier?: string } }> | undefined) ?? []) {
      if (g.description?.identifier) defined.geometry.add(g.description.identifier);
    }
    for (const key of ['render_controllers']) for (const id of Object.keys((d[key] as object | undefined) ?? {})) defined.render_controller.add(id);
    for (const key of ['animations', 'animation_controllers']) for (const id of Object.keys((d[key] as object | undefined) ?? {})) defined.animation.add(id);
  }
  const out: DanglingReference[] = [];
  for (const { f, d } of parsed) {
    const desc = (d?.['minecraft:client_entity'] as { description?: Record<string, unknown> } | undefined)?.description;
    if (!desc) continue;
    const root = f.name.slice(0, f.name.indexOf('/') + 1);
    for (const ref of Object.values((desc.geometry as Record<string, string> | undefined) ?? {})) if (!defined.geometry.has(ref)) out.push({ file: f.name, kind: 'geometry', ref });
    for (const ref of (desc.render_controllers as unknown[] | undefined) ?? []) {
      const id = typeof ref === 'string' ? ref : Object.keys(ref as object)[0]!;
      if (!defined.render_controller.has(id) && !VANILLA_RENDER_CONTROLLERS.includes(id)) out.push({ file: f.name, kind: 'render_controller', ref: id });
    }
    for (const ref of Object.values((desc.animations as Record<string, string> | undefined) ?? {})) if (!defined.animation.has(ref)) out.push({ file: f.name, kind: 'animation', ref });
    for (const ref of Object.values((desc.textures as Record<string, string> | undefined) ?? {})) {
      if (!['.png', '.tga'].some(ext => names.has(`${root}${ref}${ext}`))) out.push({ file: f.name, kind: 'texture', ref });
    }
  }
  return out;
}
