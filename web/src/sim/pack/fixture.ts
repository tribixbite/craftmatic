/**
 * Packs built in memory: a behaviour pack from a map of files, exactly as
 * `readAddon` would have split it out of an archive - for tests and probes
 * that run ONE serialised runtime (or a handful of definitions) without
 * zipping a whole add-on first. Nothing here interprets content; the engine
 * loads a fixture pack through the same `loadAddon` path as a shipped one, so
 * its entity and block definitions are refused, parsed and applied as the
 * game does.
 */

import type { Addon, Pack } from './pack.js';

/** A file's content: text, bytes, or a JSON value (serialised by the pack's JSON writer, `FixturePackOptions.json`). */
export type FixtureFile = string | Uint8Array | Record<string, unknown> | unknown[];

export interface FixturePackOptions {
  /** Files by path from the pack root (`scripts/main.js`, `entities/cart.json`, `blocks/collider_0.json`). */
  files: Record<string, FixtureFile>;
  /** The script module's entry; default `scripts/main.js` when that file exists. */
  scriptEntry?: string;
  /** The pack's name and folder (default `fixture` / `fixture_BP`). */
  name?: string;
  folder?: string;
  /** `@minecraft/*` dependencies by module name → version (default: none declared). */
  scriptModules?: Record<string, string>;
  /**
   * The JSON writer for object files (default `JSON.stringify`). A pack whose
   * writer controls number LITERALS (a float default written `0.0`, which the
   * game requires) passes its own, so the fixture carries the literal the
   * game reads - the entity loader refuses an integer literal on a float.
   */
  json?: (value: unknown) => string;
}

const enc = new TextEncoder();

function bytesOf(content: FixtureFile, json: (value: unknown) => string): Uint8Array {
  if (content instanceof Uint8Array) return content;
  return enc.encode(typeof content === 'string' ? content : json(content));
}

/** A behaviour pack from in-memory files. */
export function fixturePack(o: FixturePackOptions): Pack {
  const files = new Map<string, Uint8Array>();
  const json = o.json ?? ((v: unknown) => JSON.stringify(v));
  for (const [path, content] of Object.entries(o.files)) files.set(path, bytesOf(content, json));
  const entry = o.scriptEntry ?? (files.has('scripts/main.js') ? 'scripts/main.js' : undefined);
  const name = o.name ?? 'fixture';
  return {
    kind: 'behavior', folder: o.folder ?? `${name}_BP`, name, uuid: '', version: [],
    ...(entry ? { scriptEntry: entry } : {}),
    scriptModules: { ...(o.scriptModules ?? {}) },
    files,
  };
}

/** An add-on of one or more in-memory behaviour packs. */
export function fixtureAddon(packs: FixturePackOptions | readonly FixturePackOptions[], source = 'fixture'): Addon {
  return { source, packs: (Array.isArray(packs) ? packs : [packs]).map(p => fixturePack(p)) };
}

/** What an entity definition declares, in the file's own vocabulary. */
export interface EntityDefinitionSpec {
  components?: Record<string, unknown>;
  component_groups?: Record<string, Record<string, unknown>>;
  events?: Record<string, unknown>;
  /** Actor properties, as `description.properties`. */
  properties?: Record<string, Record<string, unknown>>;
  /** Default `1.26.30`, the format the generated packs declare. */
  format_version?: string;
  is_spawnable?: boolean;
  is_summonable?: boolean;
}

/** An `entities/*.json` document for `identifier`. */
export function entityDefinition(identifier: string, spec: EntityDefinitionSpec = {}): Record<string, unknown> {
  const description: Record<string, unknown> = { identifier, is_spawnable: spec.is_spawnable ?? true, is_summonable: spec.is_summonable ?? true };
  if (spec.properties) description['properties'] = spec.properties;
  const entity: Record<string, unknown> = { description, components: spec.components ?? {} };
  if (spec.component_groups) entity['component_groups'] = spec.component_groups;
  if (spec.events) entity['events'] = spec.events;
  return { format_version: spec.format_version ?? '1.26.30', 'minecraft:entity': entity };
}

/** The file path the game would read an entity definition from (the identifier made path-safe). */
export const entityFilePath = (identifier: string): string => `entities/${identifier.replace(/[^a-z0-9_]/gi, '_')}.json`;
