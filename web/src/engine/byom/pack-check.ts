/**
 * pack-check: structural validation of a built `.mcaddon` / `.zip`, in TypeScript (X-07, BIZ-24 / BIZ-38).
 *
 * A line-for-line port of `scripts/_mcaddon_check.py` (`check()` = the dev rules, `check_release()` = the
 * sell-side `--release` rules of X-06), so the converter can validate a pack in the creator's browser Worker, in
 * Bun and in vitest with the SAME verdict the Python gate gives. `test/byom-pack-check.test.ts` runs both over
 * the fixture zips, archives that trip every rule, real built packs and a marketplace-rewritten pack and demands
 * identical problems and notes.
 *
 * KEEP THEM IN STEP: a rule added to the Python script is added here in the same change; the parity test names
 * the divergence. Nothing here touches the DOM, `node:` modules or the network (only `fflate`).
 *
 * Fidelity notes (where JavaScript and Python differ, the port follows Python):
 *  - messages quote values with Python's `repr` (`pyRepr`), size totals round half-to-even (`fixed1`), and
 *    sorting is by code point;
 *  - a malformed archive or a JSON shape the Python script would crash on (`.get` on a list, `int('x')`, ...)
 *    is reported as `error` ("unreadable"), as the script prints `FAIL ... unreadable:`;
 *  - KNOWN LIMITS, TODO(pack-check-fidelity): a JSON `1.0` reprs as `1` (JS cannot tell it from `1`), floats
 *    beyond 1e16 print differently, zip names without the UTF-8 flag are decoded by fflate (latin-1), not cp437.
 */
import { unzipSync } from 'fflate';

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

/** What one run reports. `ok` is `problems.length === 0 && error === undefined`. */
export interface PackCheckResult {
  ok: boolean;
  /** One line per failed rule, in the order the Python script prints them (release rules prefixed `[release] `). */
  problems: string[];
  /** Informational lines (what was checked and found). */
  notes: string[];
  /** Set when the archive or a file in it could not be read at all (the script's `unreadable:` line). */
  error?: string;
}

export interface PackCheckOptions {
  /** Add the sell-side rules (`--release`). */
  release?: boolean;
  /** The archive's file name: only its `.zip` extension matters (the zip-without-root rule). */
  fileName?: string;
}

/**
 * Validate one archive. Never throws: an unreadable archive comes back with `error` set and `ok: false`.
 * Memory: every non-image member is inflated once; TODO(pack-check-limits): refuse archives whose declared
 * uncompressed size is beyond what a Worker can hold before inflating them.
 */
export function checkPack(zip: Uint8Array, options: PackCheckOptions = {}): PackCheckResult {
  try {
    const archive = new Archive(zip, options.release === true);
    let problems: string[];
    let notes: string[];
    ({ problems, notes } = checkDev(archive));
    if (options.release) {
      const r = checkRelease(archive, options.fileName ?? '');
      problems = [...problems, ...r.problems.map((x) => `[release] ${x}`)];
      notes = [...notes, ...r.notes];
    }
    return { ok: problems.length === 0, problems, notes };
  } catch (e) {
    const name = e instanceof PyError ? e.kind : e instanceof Error ? e.name : 'Error';
    return { ok: false, problems: [], notes: [], error: `${name}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The script's one-report text for a result: `OK  name   notes` then `       !! problem` lines. */
export function formatPackCheck(name: string, result: PackCheckResult): string {
  if (result.error !== undefined) return `FAIL ${name.padEnd(28)} unreadable: ${result.error}`;
  const head = `${result.ok ? 'OK  ' : 'FAIL'} ${name.padEnd(28)} ${result.notes.join('; ')}`;
  return [head, ...result.problems.map((p) => `       !! ${p}`)].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Python semantics the script relies on
// ---------------------------------------------------------------------------------------------------------------

type Json = unknown;
type Rec = Record<string, Json>;

/** A condition the Python script would crash on (`AttributeError`, `TypeError`, `ValueError`, ...). */
class PyError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

const isDict = (v: Json): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasKey = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `dict.get(key, default)`: raises like Python when `o` is not a dict. A present `null` stays `null` (None). */
function get(o: Json, key: string, dflt: Json = null): Json {
  if (!isDict(o)) throw new PyError('AttributeError', `'${typeof o}' object has no attribute 'get'`);
  return hasKey(o, key) ? o[key] : dflt;
}

/** Python truthiness. */
function truthy(v: Json): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** `x or {}` / `x or []`. */
const orElse = (v: Json, d: Json): Json => (truthy(v) ? v : d);

/** Python `bool` is an `int`, so JSON `true` counts as a number in `isinstance(v, (int, float))`. */
const isNum = (v: Json): v is number | boolean => typeof v === 'number' || typeof v === 'boolean';
const num = (v: Json): number => {
  if (!isNum(v)) throw new PyError('TypeError', 'unsupported operand type');
  return Number(v);
};

/** Iterating a value as Python does: list items, dict keys, string characters. `None` and numbers raise. */
function iter(v: Json): Json[] {
  if (Array.isArray(v)) return v;
  if (isDict(v)) return Object.keys(v);
  if (typeof v === 'string') return Array.from(v);
  throw new PyError('TypeError', `'${v === null ? 'NoneType' : typeof v}' object is not iterable`);
}

/** `.items()`: raises unless a dict. */
function items(v: Json): Array<[string, Json]> {
  if (!isDict(v)) throw new PyError('AttributeError', "object has no attribute 'items'");
  return Object.entries(v);
}

/** `item in container` for list / dict / str containers. */
function pyIn(item: Json, container: Json): boolean {
  if (Array.isArray(container)) return container.some((x) => x === item);
  if (isDict(container)) return typeof item === 'string' && hasKey(container, item);
  if (typeof container === 'string') {
    if (typeof item !== 'string') throw new PyError('TypeError', "'in <string>' requires string as left operand");
    return container.includes(item);
  }
  throw new PyError('TypeError', 'argument of type is not iterable');
}

/** Python `len()` in code points. */
function pyLen(v: Json): number {
  if (typeof v === 'string') return Array.from(v).length;
  if (Array.isArray(v)) return v.length;
  if (isDict(v)) return Object.keys(v).length;
  throw new PyError('TypeError', 'object has no len()');
}

const cmpCodePoints = (a: string, b: string): number => {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
};

/** `sorted(strings)` by code point. */
const sortedStrings = (xs: Iterable<string>): string[] => [...xs].sort(cmpCodePoints);

/** `sorted(values)` of a set of JSON scalars: all strings, all numbers, or a `TypeError` as in Python. */
function sortedValues(xs: Iterable<Json>): Json[] {
  const a = [...xs];
  if (a.every((x) => typeof x === 'string')) return sortedStrings(a as string[]);
  if (a.every(isNum)) return a.sort((x, y) => Number(x) - Number(y));
  if (a.length <= 1) return a;
  throw new PyError('TypeError', "'<' not supported between instances");
}

const PY_ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Python `repr()` of a JSON value (`None`, `True`, quote selection, `\xNN` escapes, dict and list forms). */
export function pyRepr(v: Json): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of v) {
      const cp = ch.codePointAt(0)!;
      if (ch === quote) out += `\\${ch}`;
      else if (PY_ESCAPES[ch] !== undefined) out += PY_ESCAPES[ch];
      else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0xa0) || cp === 0xad) out += `\\x${cp.toString(16).padStart(2, '0')}`;
      else out += ch;
    }
    return out + quote;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  return `{${Object.entries(v as Rec).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`;
}

/** `str(v)`: strings as they are, everything else as its repr. */
const pyStr = (v: Json): string => (typeof v === 'string' ? v : pyRepr(v));

/** The characters Python's `str.isspace()` accepts (what `strip()` removes). */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'g');
const PY_LSTRIP = new RegExp(`^[${PY_SPACE}]+`);
const pyStrip = (s: string): string => s.replace(PY_STRIP, '');

/** `str.splitlines()`: splits on \n \r \r\n \v \f \x1c-\x1e \x85 \u2028 \u2029; no trailing empty line. */
function splitLines(s: string): string[] {
  const parts = s.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** `'%.1f' % (bytes / 1048576)`: exact integer arithmetic, ties to even (JavaScript's toFixed rounds ties up). */
export function fixed1(bytes: number): string {
  const scaled = bytes * 10;
  const q = Math.floor(scaled / 1048576);
  const r = scaled - q * 1048576;
  const tenths = r * 2 > 1048576 || (r * 2 === 1048576 && q % 2 === 1) ? q + 1 : q;
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** `f'{n:,}'` for a non-negative integer. */
const commas = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `tuple(int(x) for x in str(v).split('.')[:3])`; `int()` of a non-integer string raises. */
function fmt(v: Json): number[] {
  return pyStr(v)
    .split('.')
    .slice(0, 3)
    .map((x) => {
      if (!/^\s*[+-]?\d+\s*$/.test(x)) throw new PyError('ValueError', `invalid literal for int() with base 10: ${pyRepr(x)}`);
      return parseInt(x, 10);
    });
}

/** Python tuple `<`. */
function tupleLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i];
  return a.length < b.length;
}

// ---------------------------------------------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------------------------------------------

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LENIENT_UTF8 = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

interface Entry {
  name: string;
  /** Declared uncompressed size (`ZipInfo.file_size`). */
  size: number;
}

/** A zip with its members inflated once (images only in release mode, where their headers are read). */
class Archive {
  /** Every entry name in archive order, directories (trailing `/`) included: Python's `namelist()`. */
  readonly names: string[] = [];
  /** `infolist()` without directories. */
  readonly files: Entry[] = [];
  private readonly data: Record<string, Uint8Array>;
  private readonly nameSet: Set<string>;

  constructor(bytes: Uint8Array, withImages: boolean) {
    try {
      this.data = unzipSync(bytes, {
        filter: (f) => {
          this.names.push(f.name);
          if (!f.name.endsWith('/')) this.files.push({ name: f.name, size: f.originalSize });
          return withImages || !/\.(png|tga)$/.test(f.name);
        },
      });
    } catch (e) {
      throw new PyError('BadZipFile', e instanceof Error ? e.message : String(e));
    }
    this.nameSet = new Set(this.names);
  }

  has = (name: string): boolean => this.nameSet.has(name);

  bytes(name: string): Uint8Array {
    const b = this.data[name];
    if (b === undefined) throw new PyError('KeyError', `no member ${pyRepr(name)}`);
    return b;
  }

  /** `.decode('utf-8-sig')`: one leading BOM dropped, invalid UTF-8 raises. */
  text(name: string): string {
    try {
      const s = STRICT_UTF8.decode(this.bytes(name));
      return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
    } catch (e) {
      if (e instanceof PyError) throw e;
      throw new PyError('UnicodeDecodeError', `${name} is not UTF-8`);
    }
  }

  /** `.decode('utf-8')`: a leading BOM is kept. */
  textPlain(name: string): string {
    try {
      return STRICT_UTF8.decode(this.bytes(name));
    } catch (e) {
      if (e instanceof PyError) throw e;
      throw new PyError('UnicodeDecodeError', `${name} is not UTF-8`);
    }
  }

  /** `.decode('utf-8-sig', 'replace')`. */
  textLenient(name: string): string {
    const s = LENIENT_UTF8.decode(this.bytes(name));
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }

  /** `json.loads(...)`: a parse failure raises `ValueError` (which only the release rules catch). */
  json(name: string): Json {
    const text = this.text(name);
    try {
      return JSON.parse(text) as Json;
    } catch (e) {
      throw new PyError('JSONDecodeError', e instanceof Error ? e.message : String(e));
    }
  }
}

/** `_json()` where a bad file is skipped by the caller: `undefined` on unreadable text or JSON. */
function tryJson(a: Archive, name: string): Json | undefined {
  try {
    return a.json(name);
  } catch (e) {
    if (e instanceof PyError && (e.kind === 'JSONDecodeError' || e.kind === 'UnicodeDecodeError')) return undefined;
    throw e;
  }
}

/** The folder prefix a manifest's pack occupies. */
const packRoot = (manifest: string): string => manifest.slice(0, manifest.lastIndexOf('manifest.json'));

/** True when `name` belongs to the pack at `root`: the DEEPEST pack root that prefixes it. */
const ownedBy = (name: string, root: string, roots: string[]): boolean =>
  name.startsWith(root) && !roots.some((other) => other.length > root.length && name.startsWith(other));

// ---------------------------------------------------------------------------------------------------------------
// Dev rules (`check()`)
// ---------------------------------------------------------------------------------------------------------------

/** Entity components Bedrock's current format rejects. */
const DROPPED_COMPONENTS = ['minecraft:pushable'];
// Python's `$` also matches before one trailing newline, hence `\n?$`.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n?$/i;
const IDENT_OK = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*\n?$/;
const VANILLA_NORMAL_EVENTS = ['default', 'fall', 'jump', 'land', 'step'];

interface Findings {
  problems: string[];
  notes: string[];
}

/** `re.match(IDENT_OK, v)`: a non-string raises `TypeError`. */
function identOk(v: Json): boolean {
  if (typeof v !== 'string') throw new PyError('TypeError', 'expected string or bytes-like object');
  return IDENT_OK.test(v);
}

/** Number of values of one block state: `{min,max}` range or a list. */
function stateCount(sdef: Json): number {
  const vals = isDict(sdef) ? get(sdef, 'values') : sdef;
  if (isDict(vals)) {
    if (!hasKey(vals, 'min') || !hasKey(vals, 'max')) throw new PyError('KeyError', "'min'");
    return num(vals.max) - num(vals.min) + 1;
  }
  return pyLen(orElse(vals, []));
}

/** `perms *= max(1, count)` over one block's states, exact (Python ints do not overflow). */
function permutationsOf(blk: Json, onState?: (name: string, count: number) => void): bigint {
  let perms = 1n;
  for (const [sname, sdef] of items(orElse(get(orElse(get(blk, 'description'), {}), 'states'), {}))) {
    const count = stateCount(sdef);
    if (!Number.isInteger(count)) throw new PyError('TypeError', `non-integer state size ${count}`);
    onState?.(sname, count);
    perms *= BigInt(Math.max(1, count));
  }
  return perms;
}

function checkDev(a: Archive): Findings {
  const { names } = a;
  const problems: string[] = [];
  const notes: string[] = [];
  const manifests = names.filter((n) => n.endsWith('manifest.json'));
  if (manifests.length !== 2) problems.push(`expected 2 manifests, found ${manifests.length}: ${pyRepr(manifests)}`);

  interface Manifest { uuid: Json; kinds: Set<Json>; d: Json }
  const mans = new Map<string, Manifest>();
  for (const m of manifests) {
    const d = a.json(m);
    const h = get(d, 'header', {});
    if (!UUID.test(pyStr(get(h, 'uuid', '')))) problems.push(`${m}: bad header uuid ${pyRepr(get(h, 'uuid'))}`);
    if (!Array.isArray(get(h, 'version'))) problems.push(`${m}: bad header version`);
    const mods = iter(get(d, 'modules', []));
    const kinds = new Set<Json>(mods.map((mo) => get(mo, 'type')));
    for (const mo of mods) if (!UUID.test(pyStr(get(mo, 'uuid', '')))) problems.push(`${m}: bad module uuid`);
    mans.set(m, { uuid: get(h, 'uuid'), kinds, d });
    notes.push(`${m.split('/')[0]}: modules=${pyRepr(sortedValues(kinds))}`);
  }
  const bp = [...mans.keys()].filter((k) => ['data', 'script'].some((t) => mans.get(k)!.kinds.has(t)));
  const rp = [...mans.keys()].filter((k) => mans.get(k)!.kinds.has('resources'));
  if (bp.length && rp.length) {
    const deps = iter(get(mans.get(bp[0])!.d, 'dependencies', [])).map((x) => pyStr(get(x, 'uuid')));
    const rpUuid = mans.get(rp[0])!.uuid;
    if (typeof rpUuid !== 'string' || !deps.includes(rpUuid)) problems.push('behaviour pack does not depend on the resource pack uuid');
  }

  // Check the emitted assets, not the exporter's prediction of which actor branches use PBR.
  const roots = manifests.map(packRoot);
  for (const manifest of rp) {
    const root = packRoot(manifest);
    const sets = names.filter((n) => n.endsWith('.texture_set.json') && ownedBy(n, root, roots));
    if (sets.length && !pyIn('pbr', get(mans.get(manifest)!.d, 'capabilities', []))) {
      problems.push(`${manifest}: ${sets.length} texture sets but no pbr capability`);
    }
    for (const textureSet of sets) {
      const channels = get(a.json(textureSet), 'minecraft:texture_set', {});
      const slash = textureSet.lastIndexOf('/');
      const folder = (slash < 0 ? textureSet : textureSet.slice(0, slash)) + '/';
      for (const channel of ['color', 'metalness_emissive_roughness', 'normal', 'heightmap']) {
        const value = get(channels, channel);
        // Uniform channel values are valid; image references are relative to the set's folder, no extension.
        if (typeof value === 'string' && !['.png', '.tga'].some((ext) => a.has(folder + value + ext))) {
          problems.push(`${textureSet}: ${channel} image ${pyRepr(value)} has no file`);
        }
      }
    }
    if (sets.length) notes.push(`${sets.length} PBR texture sets, capability and image references checked`);
  }

  // scripts
  for (const [m, { d }] of mans) {
    for (const mo of iter(get(d, 'modules', []))) {
      if (get(mo, 'type') !== 'script') continue;
      const ep = get(mo, 'entry');
      if (typeof ep !== 'string') throw new PyError('TypeError', 'can only concatenate str to str');
      const full = packRoot(m) + ep;
      if (!a.has(full)) problems.push(`script entry missing: ${full}`);
      else notes.push(`script entry ok: ${ep}`);
    }
  }

  // Actor identifiers Bedrock will accept (a leading digit is rejected and the entity never exists).
  let nServer = 0;
  const rideables: string[] = [];
  for (const n of names.filter((x) => x.includes('/entities/') && x.endsWith('.json'))) {
    const d = a.json(n);
    const ident = get(orElse(get(orElse(get(d, 'minecraft:entity'), {}), 'description'), {}), 'identifier');
    if (!truthy(ident)) {
      problems.push(`${n}: no entity identifier`);
      continue;
    }
    nServer++;
    if (!identOk(ident)) problems.push(`${n}: Bedrock rejects the identifier ${pyRepr(ident)}`);
    const ent = orElse(get(d, 'minecraft:entity'), {});
    const scopes: Array<[string, Json]> = [['components', orElse(get(ent, 'components'), {})]];
    for (const [g, c] of items(orElse(get(ent, 'component_groups'), {}))) scopes.push([`group ${g}`, c]);
    for (const [where, comps] of scopes) {
      for (const dropped of DROPPED_COMPONENTS) {
        if (pyIn(dropped, comps)) problems.push(`${n}: ${where} uses ${pyRepr(dropped)}, which format 1.26.30 dropped (the entity fails to load)`);
      }
      if (pyIn('minecraft:rideable', comps) && !rideables.includes(ident as string)) rideables.push(ident as string);
      // A tap / interact box: a square width x height about a 3-number pivot.
      const hit = get(comps, 'minecraft:custom_hit_test');
      if (hit !== null) {
        const boxes = isDict(hit) ? get(hit, 'hitboxes') : null;
        if (!Array.isArray(boxes) || !boxes.length) problems.push(`${n}: ${where} custom_hit_test has no hitboxes`);
        iter(orElse(boxes, [])).forEach((b, i) => {
          const ok =
            isDict(b) &&
            isNum(b.width) && Number(b.width) > 0 &&
            isNum(b.height) && Number(b.height) > 0 &&
            Array.isArray(b.pivot) && b.pivot.length === 3 && b.pivot.every(isNum);
          if (!ok) problems.push(`${n}: ${where} custom_hit_test hitbox ${i} is not a positive width x height about a 3-number pivot: ${pyRepr(b)}`);
        });
      }
    }
    // An int/float property whose range is not wider than one value drops the entity's whole property component.
    for (const [pname, prop] of items(orElse(get(orElse(get(ent, 'description'), {}), 'properties'), {}))) {
      const rng = isDict(prop) ? get(prop, 'range') : null;
      const type = get(prop, 'type');
      if ((type === 'int' || type === 'float') && Array.isArray(rng) && rng.length === 2 && !pyGreater(rng[1], rng[0])) {
        problems.push(`${n}: property ${pyRepr(pname)} range ${pyRepr(rng)} is not wider than one value (Bedrock drops every property of the entity)`);
      }
    }
  }
  notes.push(`${nServer} server entities`);

  // Every rideable needs its dismount hint in EVERY language file the pack ships.
  const langs = names.filter((x) => /\/texts\/[^/]+\.lang\n?$/.test(x));
  if (rideables.length && !langs.length) problems.push(`${rideables.length} rideable entities but no texts/*.lang (every dismount hint shows its raw key)`);
  for (const lf of langs) {
    const keys = new Set(
      splitLines(a.text(lf))
        .filter((ln) => ln.includes('=') && !ln.replace(PY_LSTRIP, '').startsWith('#'))
        .map((ln) => pyStrip(ln.slice(0, ln.indexOf('=')))),
    );
    const missing = rideables.filter((r) => !keys.has(`action.hint.exit.${r}`));
    if (missing.length) {
      problems.push(
        `${lf}: no action.hint.exit line for ${missing.length} rideable entit${missing.length === 1 ? 'y' : 'ies'} (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', ...' : ''}): the raw key shows while riding`,
      );
    }
  }
  if (rideables.length) notes.push(`${rideables.length} rideable entities, dismount hints checked in ${langs.length} language file(s)`);

  // Any entity moved through the air makes the client log a 'fly' sound line unless the RP silences it.
  if (nServer) {
    const soundFiles = names.filter((x) => /_RP\/sounds\.json\n?$/.test(x));
    let normal: Json = null;
    for (const sf of soundFiles) {
      const found = get(orElse(get(orElse(get(a.json(sf), 'interactive_sounds'), {}), 'block_sounds'), {}), 'normal');
      normal = orElse(found, normal);
    }
    const events = isDict(normal) ? get(normal, 'events') : null;
    if (!isDict(events) || get(events, 'fly') !== '') {
      problems.push(
        `${nServer} entities but no silent interactive_sounds.block_sounds.normal.events.fly in ${soundFiles.length ? pyRepr(soundFiles) : 'an RP sounds.json'}: the content log fills with "event type 'fly'" lines`,
      );
    } else {
      const lost = VANILLA_NORMAL_EVENTS.filter((e) => !hasKey(events, e));
      if (lost.length) problems.push(`interactive_sounds.block_sounds.normal lacks vanilla's ${lost.join(', ')} event(s): if the key replaces vanilla's, those sounds go silent`);
      else notes.push('RP silences the block-material fly sound (block_sounds.normal carries vanilla\'s events + fly "")');
    }
  }

  // geometries the pack defines; box-UV cubes under one unit lose faces on the device
  const geoIds = new Set<string>();
  const thinByFile = new Map<string, number>();
  for (const n of names.filter((x) => x.endsWith('.geo.json'))) {
    for (const g of iter(get(a.json(n), 'minecraft:geometry', []))) {
      const gid = get(orElse(get(g, 'description'), {}), 'identifier');
      if (truthy(gid)) geoIds.add(gid as string);
      for (const b of iter(orElse(get(g, 'bones'), []))) {
        for (const c of iter(orElse(get(b, 'cubes'), []))) {
          if (!Array.isArray(get(c, 'uv'))) continue;
          if (iter(get(c, 'size', [1, 1, 1])).some((s) => pyLess(s, 1))) thinByFile.set(n, (thinByFile.get(n) ?? 0) + 1);
        }
      }
    }
  }
  if (thinByFile.size) {
    const worst = [...thinByFile.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
    const total = [...thinByFile.values()].reduce((s, v) => s + v, 0);
    problems.push(
      `${total} box-UV cubes in ${thinByFile.size} geometr${thinByFile.size === 1 ? 'y' : 'ies'} declare a size under 1 unit: the device drops their faces (declare size + 2 with inflate -1); worst: ` +
        worst.map(([k, v]) => `${k.slice(k.lastIndexOf('/') + 1)} ${v}`).join(', '),
    );
  }
  const texFiles = new Set(names.filter((x) => /\.(png|tga)$/.test(x)).map((x) => x.slice(0, x.lastIndexOf('.'))));
  let nClient = 0;
  for (const n of names.filter((x) => x.includes('/entity/') && x.endsWith('.json'))) {
    const ce = get(a.json(n), 'minecraft:client_entity');
    if (!truthy(ce)) continue;
    nClient++;
    const desc = get(ce, 'description', {});
    for (const [, gid] of items(orElse(get(desc, 'geometry'), {}))) {
      if (typeof gid !== 'string' || !geoIds.has(gid)) problems.push(`${n}: geometry ${pyRepr(gid)} is not defined in the pack`);
    }
    for (const [, tpath] of items(orElse(get(desc, 'textures'), {}))) {
      let found = false;
      for (const t of texFiles) {
        if (typeof tpath !== 'string') throw new PyError('TypeError', 'endswith first arg must be str');
        if (t.endsWith(tpath)) {
          found = true;
          break;
        }
      }
      if (!found) problems.push(`${n}: texture ${pyRepr(tpath)} has no file`);
    }
    if (!truthy(get(desc, 'materials'))) problems.push(`${n}: no materials`);
  }
  notes.push(`${nClient} client entities, ${geoIds.size} geometries, ${texFiles.size} textures`);

  // Custom blocks: identifiers, state limits, permutations and collision boxes.
  const blockIds = new Set<string>();
  let registered = 0n;
  for (const n of names.filter((x) => x.includes('/blocks/') && x.endsWith('.json'))) {
    const d = a.json(n);
    const blk = get(d, 'minecraft:block');
    if (!truthy(blk)) continue;
    const ident = get(orElse(get(blk, 'description'), {}), 'identifier');
    if (!truthy(ident) || !identOk(ident)) {
      problems.push(`${n}: Bedrock rejects the block identifier ${pyRepr(ident)}`);
      continue;
    }
    blockIds.add(ident as string);
    const perms = permutationsOf(blk, (sname, count) => {
      if (count > 16) problems.push(`${n}: state ${pyRepr(sname)} has ${count} values (Bedrock allows 16)`);
    });
    registered += perms;
    if (perms > 65536n) problems.push(`${n}: ${perms} registered permutations (a block may have 65,536)`);
    const boxSets: Array<[string, Json]> = [['components', get(orElse(get(blk, 'components'), {}), 'minecraft:collision_box')]];
    iter(orElse(get(blk, 'permutations'), [])).forEach((p, i) => boxSets.push([`permutation ${i}`, get(orElse(get(p, 'components'), {}), 'minecraft:collision_box')]));
    for (const [where, cb] of boxSets) {
      if (cb === null || typeof cb === 'boolean') continue;
      const boxes = Array.isArray(cb) ? cb : [cb];
      if (Array.isArray(cb) && (tupleLess(fmt(get(d, 'format_version', '0')), [1, 26, 0]) || cb.length > 16)) {
        problems.push(`${n}: ${where} collision_box is an array of ${cb.length} (needs format 1.26.0+ and at most 16), format ${pyStr(get(d, 'format_version'))}`);
      }
      for (const b of boxes) {
        const o = get(b, 'origin', [-8, 0, -8]);
        const s = get(b, 'size', [16, 16, 16]);
        const lo = [-8, 0, -8];
        const hi = [8, 24, 8];
        const at = (arr: Json, k: number): number => {
          if (!Array.isArray(arr) || k >= arr.length) throw new PyError('IndexError', 'index out of range');
          return num(arr[k]);
        };
        let outside = false;
        for (let k = 0; k < 3 && !outside; k++) outside = at(o, k) < lo[k] || at(o, k) + at(s, k) > hi[k] || at(s, k) < 0;
        if (outside) problems.push(`${n}: ${where} collision box ${pyRepr(b)} leaves the block`);
      }
    }
  }
  if (registered) notes.push(`${blockIds.size} custom blocks, ${registered} registered permutations`);
  if (registered > 65536n) problems.push(`${registered} custom block permutations (a world should stay under 65,536)`);

  // Every collider form the shipped runs reference has its block (run value = v*136 + pair).
  for (const n of names.filter((x) => x.endsWith('scripts/placement.js'))) {
    const m = /(?:^|\n)const CONFIG = (\{[^\n]*\});(?=\n|$)/.exec(a.textPlain(n));
    let cols: Json = null;
    if (m) {
      try {
        cols = get(JSON.parse(m[1]) as Json, 'colliders');
      } catch (e) {
        if (e instanceof PyError) throw e;
        throw new PyError('JSONDecodeError', e instanceof Error ? e.message : String(e));
      }
    }
    if (!truthy(cols)) continue;
    const runsValue = get(cols, 'runs', '');
    if (typeof runsValue !== 'string') throw new PyError('TypeError', 'ord() expected string');
    const runs = Array.from(runsValue).map((c) => c.codePointAt(0)!);
    const used = new Set<number>();
    for (let k = 0; k < runs.length - 1; k += 2) if (runs[k] - 40 > 0) used.add(Math.floor((runs[k] - 40 - 1) / 136));
    // The namespace is the pack's own: the dev pack's `craftmatic`, or a rewritten product's (X-03).
    const colliderBlock = sortedStrings(blockIds).find((b) => b.endsWith(':collider'));
    const ns = colliderBlock !== undefined ? colliderBlock.slice(0, colliderBlock.lastIndexOf(':')) : 'craftmatic';
    const ids = new Map<number, string>([[0, `${ns}:collider`]]);
    for (const v of used) {
      if (v === 0) continue;
      const kind = Math.floor((v - 1) / 14);
      const shape = ((v - 1) % 14) + 1;
      if (kind > 2) throw new PyError('IndexError', 'string index out of range');
      ids.set(v, `${ns}:collider_${'wfc'[kind]}${shape}`);
    }
    for (const v of [...used].sort((x, y) => x - y)) {
      if (!blockIds.has(ids.get(v)!)) problems.push(`the collider runs use ${pyRepr(ids.get(v))} (variant ${v}) but the pack defines no such block`);
    }
    if (used.size > 1) notes.push(`${used.size - 1} collider forms in use`);
  }
  return { problems, notes };
}

/** Python `a > b` over JSON scalars (numbers, or two strings); anything else is a `TypeError`. */
function pyGreater(x: Json, y: Json): boolean {
  if (isNum(x) && isNum(y)) return Number(x) > Number(y);
  if (typeof x === 'string' && typeof y === 'string') return cmpCodePoints(x, y) > 0;
  throw new PyError('TypeError', "'>' not supported between instances");
}

/** Python `x < y`. */
const pyLess = (x: Json, y: Json): boolean => pyGreater(y, x);

// ---------------------------------------------------------------------------------------------------------------
// Release rules (`check_release()`)
// ---------------------------------------------------------------------------------------------------------------

const RELEASE_MAX_PERMUTATIONS = 10_000n;
const RELEASE_MAX_BYTES = 25 * 1024 * 1024;
const RELEASE_MAX_FILES = 3_500;
const RELEASE_MAX_TEXTURE_PX: Record<string, number> = { blocks: 256, items: 256 };
const RELEASE_DEFAULT_TEXTURE_PX = 2048;
const RELEASE_FORBIDDEN_NAMESPACES = ['craftmatic', 'minecraft'];
const RELEASE_EXAMPLES = 4;

/** Content-type folders: a file inside one must sit at `<folder>/<creator>/<pack>/...`. */
const RELEASE_CONTENT_FOLDERS = [
  'entities', 'blocks', 'items', 'structures', 'functions', 'animations', 'animation_controllers',
  'loot_tables', 'recipes', 'trading', 'spawn_rules', 'features', 'feature_rules', 'biomes',
  'entity', 'render_controllers', 'particles', 'attachables', 'materials', 'fogs',
  'models/entity', 'models/blocks', 'textures/blocks', 'textures/items', 'textures/entity',
  'textures/ui', 'textures/particle', 'textures/environment', 'textures/colormap',
];

/**
 * Vanilla texture paths a pack must not overwrite. A pattern list, not a full resource-pack inventory.
 * TODO(vanilla-list): regenerate from the vanilla resource pack once the Marketplace review confirms the set
 * (the same TODO as the Python script; keep the two lists identical).
 */
const RELEASE_VANILLA_TEXTURE_PATTERNS = [
  /^textures\/blocks\/(concrete|concrete_powder|wool_colored|stained_glass|glazed_terracotta|hardened_clay_stained)_[a-z_]+\.(png|tga)\n?$/,
  /^textures\/blocks\/(stone|dirt|grass_(top|side|side_carried)|cobblestone|sand|gravel|bedrock|glass|brick|bookshelf|obsidian|netherrack|iron_block|gold_block|diamond_block|emerald_block|coal_block|planks_[a-z_]+|log_[a-z_]+|leaves_[a-z_]+|sandstone_[a-z_]+|water_still|lava_still)\.(png|tga)\n?$/,
  /^textures\/items\/(apple|stick|diamond|iron_ingot|gold_ingot|coal|bread|bucket_[a-z]+)\.(png|tga)\n?$/,
  /^textures\/entity\/(steve|alex|creeper|zombie|skeleton|pig|cow|sheep|chicken|villager|enderman|horse|wolf|cat|boat)(\/.*|\.(png|tga))\n?$/,
];
/**
 * The atlas files are NOT listed by path: a resource pack ships its own `textures/terrain_texture.json` to give its
 * custom blocks their textures (Microsoft's custom-block tutorials do exactly this; the game merges it with vanilla's).
 * They are judged by CONTENT (`atlasVanilla`), as `_mcaddon_check.py` does since D-08b. Value: the vanilla texture path
 * a short name in that atlas stands for, or null where keys are not texture names.
 */
const RELEASE_ATLAS_FILES: Readonly<Record<string, string | null>> = {
  'terrain_texture.json': 'textures/blocks/{}.png',
  'item_texture.json': 'textures/items/{}.png',
  'flipbook_textures.json': null,
};

/** True when `path` (with or without an extension) is a vanilla texture path a pack must not overwrite. */
function isVanillaTexture(path: string): boolean {
  const candidates = /\.(png|tga)$/.test(path) ? [path] : [`${path}.png`];
  return RELEASE_VANILLA_TEXTURE_PATTERNS.some((pat) => candidates.some((c) => pat.test(c)));
}

/** Every texture path an atlas entry names: a string, a {path} / {textures} / {variations} object, or a list of them. */
function* atlasTexturePaths(node: unknown): Generator<string> {
  if (typeof node === 'string') yield node;
  else if (Array.isArray(node)) for (const x of node) yield* atlasTexturePaths(x);
  else if (node && typeof node === 'object') {
    for (const k of ['path', 'textures', 'variations']) if (k in node) yield* atlasTexturePaths((node as Record<string, unknown>)[k]);
  }
}

/** Vanilla short names and vanilla texture paths an atlas file redefines (a pack's own keys and paths are fine). */
function atlasVanilla(rel: string, data: unknown): string[] {
  const hits: string[] = [];
  if (rel.endsWith('flipbook_textures.json')) {
    for (const entry of Array.isArray(data) ? data : []) {
      const ref = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['flipbook_texture'] : undefined;
      if (typeof ref === 'string' && isVanillaTexture(ref)) hits.push(ref);
    }
    return hits;
  }
  const template = RELEASE_ATLAS_FILES[rel.slice(rel.lastIndexOf('/') + 1)] ?? null;
  const textureData = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)['texture_data'] : undefined;
  const entries = textureData && typeof textureData === 'object' ? Object.entries(textureData as Record<string, unknown>) : [];
  for (const [key, entry] of entries) {
    if (template && isVanillaTexture(template.replace('{}', key))) hits.push(key);
    const textures = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>)['textures'] : undefined;
    for (const path of atlasTexturePaths(textures)) if (isVanillaTexture(path)) hits.push(path);
  }
  return hits;
}
/** Download hosts / words that make a link an "external download" (CurseForge, MCPEDL). */
const RELEASE_DOWNLOAD_LINK =
  /https?:\/\/\S*(mediafire|mega\.nz|dropbox|drive\.google|1drv\.ms|adf\.ly|linkvertise|anonfiles|gofile|sharemods)\S*|https?:\/\/\S*download\S*/i;
const RELEASE_TEXT_SUFFIXES = ['.txt', '.md', '.lang'];

/** (width, height) from the first bytes of a PNG or TGA, or null when neither. */
function imageSize(head: Uint8Array): [number, number] | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length >= 24 && png.every((b, i) => head[i] === b)) return [dv.getUint32(16), dv.getUint32(20)];
  if (head.length >= 16 && [2, 3, 10, 11].includes(head[2])) return [dv.getUint16(12, true), dv.getUint16(14, true)];
  return null;
}

/** `'a, b, c, d (+N more)'`. */
function brief(xs: Iterable<string>, limit = RELEASE_EXAMPLES): string {
  const sorted = sortedStrings(xs);
  const more = sorted.length > limit ? ` (+${sorted.length - limit} more)` : '';
  return sorted.slice(0, limit).join(', ') + more;
}

/** `{namespace: [file, ...]}` over every entity/block/item/geometry/animation/render-controller id. */
function packNamespaces(a: Archive): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (ns: string, where: string): void => {
    found.set(ns, [...(found.get(ns) ?? []), where]);
  };
  for (const n of a.names) {
    if (!n.endsWith('.json')) continue;
    const d = tryJson(a, n);
    if (!isDict(d)) continue;
    for (const key of ['minecraft:entity', 'minecraft:client_entity', 'minecraft:block', 'minecraft:item']) {
      const body = get(d, key);
      const desc = isDict(body) ? get(body, 'description') : null;
      const ident = isDict(desc) ? get(desc, 'identifier') : null;
      if (typeof ident === 'string' && ident.includes(':')) add(ident.split(':', 1)[0], n);
    }
    for (const g of iter(orElse(get(d, 'minecraft:geometry'), []))) {
      let gid: Json = '';
      if (isDict(g)) gid = get(orElse(get(g, 'description'), {}), 'identifier', '');
      if (typeof gid !== 'string') throw new PyError('AttributeError', "object has no attribute 'startswith'");
      if (gid.startsWith('geometry.') && gid.split('.').length - 1 >= 2) add(gid.split('.')[1], n);
    }
    for (const [key, prefix] of [['animations', 'animation.'], ['animation_controllers', 'controller.animation.'], ['render_controllers', 'controller.render.']]) {
      const table = get(d, key);
      for (const ident of isDict(table) ? Object.keys(table) : []) {
        if (ident.startsWith(prefix) && ident.slice(prefix.length).includes('.')) add(ident.slice(prefix.length).split('.')[0], n);
      }
    }
  }
  return found;
}

/** The pack root (deepest) that prefixes `name`, or null. */
function owner(name: string, roots: string[]): string | null {
  const hits = roots.filter((r) => name.startsWith(r));
  return hits.length ? hits.reduce((best, r) => (r.length > best.length ? r : best)) : null;
}

function checkRelease(a: Archive, fileName: string): Findings {
  const infos = a.files;
  const names = infos.map((i) => i.name);
  const problems: string[] = [];
  const notes: string[] = [];
  const manifests = names.filter((n) => n.endsWith('manifest.json'));
  const roots = manifests.map(packRoot);
  const mans = new Map<string, Json>();
  for (const m of manifests) {
    const d = tryJson(a, m);
    if (d === undefined) problems.push(`${m}: manifest is not JSON`);
    else mans.set(m, d);
  }
  const kindOf = (d: Json): Set<Json> => new Set(iter(get(d, 'modules', [])).map((mo) => get(mo, 'type')));
  const entries = [...mans.entries()];
  const bp = entries.find(([, d]) => ['data', 'script'].some((t) => kindOf(d).has(t)))?.[0] ?? null;
  const rp = entries.find(([, d]) => kindOf(d).has('resources'))?.[0] ?? null;

  // 1. pack_scope, 2. mutual dependencies.
  if (rp) {
    const scope = get(orElse(get(mans.get(rp), 'header'), {}), 'pack_scope');
    if (scope !== 'world') problems.push(`${rp}: header.pack_scope is ${pyRepr(scope)}, a release resource pack must declare "world"`);
  }
  const depsOf = (d: Json): Set<string> =>
    new Set(iter(get(d, 'dependencies', [])).filter((x): x is Rec => isDict(x) && hasKey(x, 'uuid')).map((x) => pyStr(x.uuid)));
  if (bp && rp) {
    const bpUuid = get(orElse(get(mans.get(bp), 'header'), {}), 'uuid');
    const rpUuid = get(orElse(get(mans.get(rp), 'header'), {}), 'uuid');
    if (typeof bpUuid !== 'string' || !depsOf(mans.get(rp)).has(bpUuid)) problems.push(`${rp}: resource pack does not depend on the behaviour pack header uuid ${pyStr(bpUuid)}`);
    if (typeof rpUuid !== 'string' || !depsOf(mans.get(bp)).has(rpUuid)) problems.push(`${bp}: behaviour pack does not depend on the resource pack header uuid ${pyStr(rpUuid)}`);
  } else if (manifests.length) {
    problems.push('release needs one behaviour pack (data/script module) and one resource pack (resources module)');
  }

  // 3. one namespace, not craftmatic / minecraft.
  const spaces = packNamespaces(a);
  if (spaces.size > 1) {
    problems.push(
      'more than one namespace across entity/block/item/geometry/animation/render-controller ids: ' +
        sortedStrings(spaces.keys()).map((ns) => `${pyRepr(ns)} in ${new Set(spaces.get(ns)).size} file(s)`).join('; '),
    );
  }
  for (const ns of RELEASE_FORBIDDEN_NAMESPACES) {
    if (!spaces.has(ns)) continue;
    const why = ns === 'minecraft' ? 'redefines vanilla content' : 'is the development namespace';
    const files = new Set(spaces.get(ns));
    problems.push(`namespace ${pyRepr(ns)} ${why} (${files.size} file(s), e.g. ${brief(files, 2)}); a release uses its own`);
  }
  if (spaces.size === 1) notes.push(`namespace ${pyRepr([...spaces.keys()][0])}`);

  // 4. <type>/<creator>/<pack>/ folders, no loose files, one creator/pack pair.
  const loose: string[] = [];
  const pairs = new Set<string>();
  for (const n of names) {
    const own = owner(n, roots);
    if (own === null) continue;
    const rel = n.slice(own.length);
    const folder = RELEASE_CONTENT_FOLDERS.find((f) => rel.startsWith(`${f}/`));
    if (folder === undefined) continue;
    const parts = rel.slice(folder.length + 1).split('/');
    if (parts.length < 3) loose.push(rel);
    else pairs.add(`${parts[0]}/${parts[1]}`);
  }
  if (loose.length) problems.push(`${loose.length} file(s) not under <type>/<creator>/<pack>/: ${brief(loose)}`);
  if (pairs.size > 1) problems.push(`content folders use ${pairs.size} different <creator>/<pack> pairs: ${brief(pairs)}`);

  // 5. vanilla texture paths.
  const vanilla: string[] = [];
  for (const n of names) {
    const own = owner(n, roots);
    const rel = own !== null ? n.slice(own.length) : n;
    if (RELEASE_VANILLA_TEXTURE_PATTERNS.some((p) => p.test(rel))) vanilla.push(rel);
  }
  if (vanilla.length) problems.push(`${vanilla.length} file(s) at a vanilla texture path: ${brief(vanilla)}`);
  for (const n of names) {
    const own = owner(n, roots);
    const rel = own !== null ? n.slice(own.length) : n;
    if (!Object.keys(RELEASE_ATLAS_FILES).some((f) => rel === `textures/${f}`)) continue;
    let redefined: string[];
    try {
      redefined = atlasVanilla(rel, a.json(n));
    } catch {
      problems.push(`${rel} is not a readable texture atlas`);
      continue;
    }
    if (redefined.length) problems.push(`${rel} redefines vanilla texture(s): ${brief(new Set(redefined))}`);
  }

  // 6. registered permutations (dev mode allows 65,536).
  let registered = 0n;
  for (const n of names.filter((x) => x.includes('/blocks/') && x.endsWith('.json'))) {
    const parsed = tryJson(a, n);
    if (parsed === undefined) continue;
    const blk = get(parsed, 'minecraft:block');
    if (!isDict(blk)) continue;
    registered += permutationsOf(blk);
  }
  if (registered > RELEASE_MAX_PERMUTATIONS) problems.push(`${registered} registered block permutations (a release allows ${commas(Number(RELEASE_MAX_PERMUTATIONS))})`);
  notes.push(`${registered} permutations`);

  // 7. size and file count.
  const total = infos.reduce((s, i) => s + i.size, 0);
  if (total > RELEASE_MAX_BYTES) problems.push(`${fixed1(total)} MiB uncompressed (a release allows ${RELEASE_MAX_BYTES / 1048576} MiB)`);
  if (infos.length > RELEASE_MAX_FILES) problems.push(`${infos.length} files (a release allows ${commas(RELEASE_MAX_FILES)})`);
  notes.push(`${fixed1(total)} MiB, ${infos.length} files`);

  // 8. texture dimensions.
  const oversize: string[] = [];
  for (const i of infos) {
    if (!/\.(png|tga)$/.test(i.name)) continue;
    const rel = i.name.slice((owner(i.name, roots) ?? '').length);
    if (!rel.startsWith('textures/') || rel.split('/').length - 1 < 2) continue;
    const size = imageSize(a.bytes(i.name).subarray(0, 32));
    if (size === null) {
      problems.push(`${rel}: not a readable PNG/TGA`);
      continue;
    }
    const limit = RELEASE_MAX_TEXTURE_PX[rel.split('/')[1]] ?? RELEASE_DEFAULT_TEXTURE_PX;
    if (Math.max(...size) > limit) oversize.push(`${rel} ${size[0]}x${size[1]} > ${limit}`);
  }
  if (oversize.length) {
    problems.push(`${oversize.length} texture(s) over the size limit (block/item ${RELEASE_MAX_TEXTURE_PX.blocks} px, others ${RELEASE_DEFAULT_TEXTURE_PX}): ${brief(oversize)}`);
  }

  // 9. no -beta script modules.
  for (const [m, d] of mans) {
    const beta = iter(get(d, 'dependencies', []))
      .filter((x): x is Rec => isDict(x) && pyStr(get(x, 'version', '')).toLowerCase().includes('beta'))
      .map((x) => `${pyStr(get(x, 'module_name'))}@${pyStr(get(x, 'version'))}`);
    if (beta.length) problems.push(`${m}: beta script module(s) ${beta.join(', ')} (a release uses stable modules only)`);
  }

  // 10. no minecraft: definitions (the namespace rule names the ids; this names the files).
  const overrides = sortedStrings(new Set(spaces.get('minecraft') ?? []));
  if (overrides.length) problems.push(`${overrides.length} file(s) define minecraft: ids: ${brief(overrides)}`);

  // 11. no diagnostics file.
  const diag = names.filter((n) => n.slice(n.lastIndexOf('/') + 1).endsWith('-diagnostics.json'));
  if (diag.length) problems.push(`dev diagnostics shipped: ${brief(diag)}`);

  // 12. zip without root (CurseForge / MCPEDL): a .zip must not wrap everything in one folder.
  if (fileName.toLowerCase().endsWith('.zip')) {
    const tops = new Set(names.map((n) => n.split('/', 1)[0]));
    if (names.length && names.every((n) => n.includes('/')) && tops.size === 1) problems.push(`zip is wrapped in one root folder ${pyRepr([...tops][0])}; zip the pack folders themselves`);
  }

  // 13. no external download links (BIZ-54).
  const links: string[] = [];
  for (const n of names) {
    if (!RELEASE_TEXT_SUFFIXES.some((s) => n.endsWith(s)) && !n.endsWith('manifest.json')) continue;
    for (const ln of splitLines(a.textLenient(n))) {
      if (RELEASE_DOWNLOAD_LINK.test(ln)) links.push(`${n.slice(n.lastIndexOf('/') + 1)}: ${Array.from(pyStrip(ln)).slice(0, 60).join('')}`);
    }
  }
  if (links.length) problems.push(`${links.length} external download link(s): ${brief(links)}`);
  return { problems, notes };
}
