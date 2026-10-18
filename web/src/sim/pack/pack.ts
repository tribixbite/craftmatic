/**
 * A Bedrock add-on as the game receives it: the `.mcaddon` / `.mcpack` zip,
 * split into its behaviour and resource packs by their manifests. Nothing is
 * interpreted here; the world, entity and script modules read what they need
 * from the file maps, exactly as shipped.
 */

// TODO(standalone): the zip reader is generic and lives in craftmatic's engine
// folder today; move it under web/src/sim/core when the engine is split out.
import { extractMatching } from '../../engine/zip-utils.js';

/** One pack of an add-on: its manifest and its files, keyed by path from the pack root. */
export interface Pack {
  /** `behavior` (a `data` or `script` module) or `resource` (`resources`). */
  kind: 'behavior' | 'resource';
  /** The folder the pack sits in inside the archive ('' at the root). */
  folder: string;
  name: string;
  uuid: string;
  version: number[];
  /** The script module's entry (`scripts/main.js`), behaviour packs only. */
  scriptEntry?: string;
  /** `@minecraft/*` module dependencies by name → version. */
  scriptModules: Record<string, string>;
  files: Map<string, Uint8Array>;
}

/** A loaded add-on: every pack it carries and where it came from. */
export interface Addon {
  source: string;
  packs: Pack[];
}

const utf8 = new TextDecoder();

/** A file's text (UTF-8). */
export function packText(pack: Pack, path: string): string | undefined {
  const data = pack.files.get(path);
  return data ? utf8.decode(data) : undefined;
}

/** Every file of a pack under a folder prefix with an extension (`entities/`, `.json`). */
export function packFiles(pack: Pack, prefix: string, extension: string): Array<[string, Uint8Array]> {
  return [...pack.files].filter(([p]) => p.startsWith(prefix) && p.endsWith(extension));
}

interface ManifestJson {
  header?: { name?: string; uuid?: string; version?: number[] };
  modules?: Array<{ type?: string; entry?: string }>;
  dependencies?: Array<{ module_name?: string; version?: string }>;
}

/**
 * Read an add-on archive into its packs. Every `manifest.json` in the archive
 * starts a pack; each file belongs to the deepest manifest folder above it.
 */
export async function readAddon(bytes: ArrayBuffer | Uint8Array, source = 'addon'): Promise<Addon> {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer : bytes;
  const all = await extractMatching(buffer, name => !name.endsWith('/'));
  const manifests = [...all.keys()].filter(n => n === 'manifest.json' || n.endsWith('/manifest.json'))
    .map(n => n.slice(0, n.length - 'manifest.json'.length))
    .sort((a, b) => b.length - a.length);
  const packs: Pack[] = [];
  const byFolder = new Map<string, Pack>();
  for (const folder of manifests) {
    const manifest = JSON.parse(utf8.decode(all.get(`${folder}manifest.json`)!)) as ManifestJson;
    const types = (manifest.modules ?? []).map(m => m.type);
    const script = (manifest.modules ?? []).find(m => m.type === 'script');
    const scriptModules: Record<string, string> = {};
    for (const d of manifest.dependencies ?? []) if (d.module_name) scriptModules[d.module_name] = String(d.version ?? '');
    const pack: Pack = {
      kind: types.includes('resources') ? 'resource' : 'behavior',
      folder: folder.replace(/\/$/, ''),
      name: manifest.header?.name ?? folder,
      uuid: manifest.header?.uuid ?? '',
      version: manifest.header?.version ?? [],
      ...(script?.entry ? { scriptEntry: script.entry } : {}),
      scriptModules,
      files: new Map(),
    };
    packs.push(pack); byFolder.set(folder, pack);
  }
  for (const [name, data] of all) {
    const folder = manifests.find(f => name.startsWith(f));
    if (folder === undefined) continue;
    byFolder.get(folder)!.files.set(name.slice(folder.length), new Uint8Array(data));
  }
  return { source, packs };
}

/** The behaviour packs of an add-on, in archive order. */
export const behaviorPacks = (addon: Addon): Pack[] => addon.packs.filter(p => p.kind === 'behavior');
/** The resource packs of an add-on. */
export const resourcePacks = (addon: Addon): Pack[] => addon.packs.filter(p => p.kind === 'resource');
