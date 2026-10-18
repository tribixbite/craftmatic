/**
 * Entity TYPES as the game loads them from the behaviour packs'
 * `entities/*.json`: the components, component groups, events and actor
 * properties - and the device-measured reasons a definition is REFUSED or
 * crippled, applied exactly as the content log reports them:
 *
 *   - an identifier whose name begins with a digit is refused (quirk
 *     `entity-id-leading-digit`): the type does not exist;
 *   - a definition declaring a component format 1.26.30 dropped
 *     (`minecraft:pushable`) fails to parse (quirk `pushable-dropped`);
 *   - a `float` property written with an integer literal loses the entity its
 *     WHOLE property component (quirk `float-property-int-literal`).
 *
 * Each refusal is a `content-log` line on the engine's timeline, where a
 * device round would have found it.
 */

import { isIntegerLiteral, parseJsonWithLiterals } from '../pack/json.js';

/** Components by name, as the JSON declares them. */
export type Components = Record<string, unknown>;

/** An actor property's declaration. */
export interface PropertyDef {
  type: 'float' | 'int' | 'bool' | 'enum';
  default: number | boolean | string;
  range?: [number, number];
  values?: string[];
}

/** One event's effect: groups to add and remove (and anything the engine does not model, kept to report). */
export interface EventDef {
  add: string[];
  remove: string[];
  /** Keys of the event the engine does not apply (`sequence`, `randomize`, `trigger`, `set_property`...). */
  unmodelled: string[];
}

/** A loaded entity type. */
export interface EntityDefinition {
  identifier: string;
  components: Components;
  groups: Record<string, Components>;
  events: Record<string, EventDef>;
  /** Declared actor properties; empty when the component was refused. */
  properties: Record<string, PropertyDef>;
  /** Whether the property component was refused (an int literal on a float, ...): every property access then fails. */
  propertiesRefused: boolean;
  /** Families from `minecraft:type_family`. */
  families: string[];
}

/** Components a definition may no longer declare (format 1.26.30); the definition then fails to parse. */
export const DROPPED_COMPONENTS: readonly string[] = ['minecraft:pushable'];

/** The loaded types and the content-log lines their loading produced. */
export class EntityDefinitions {
  private readonly types = new Map<string, EntityDefinition>();
  /** Content-log lines: refused definitions and dropped property components. */
  readonly contentLog: string[] = [];

  get(identifier: string): EntityDefinition | undefined { return this.types.get(identifier); }
  has(identifier: string): boolean { return this.types.has(identifier); }
  all(): EntityDefinition[] { return [...this.types.values()]; }

  /** Load one `entities/<id>.json`; returns the type, or undefined when the game would refuse it. */
  load(path: string, text: string): EntityDefinition | undefined {
    let parsed: ReturnType<typeof parseJsonWithLiterals>;
    try { parsed = parseJsonWithLiterals(text); }
    catch (e) { this.contentLog.push(`[Json] ${path}: ${(e as Error).message}`); return undefined; }
    const root = (parsed.value as { 'minecraft:entity'?: Record<string, unknown> })['minecraft:entity'];
    const description = root?.['description'] as { identifier?: string; properties?: Record<string, Record<string, unknown>> } | undefined;
    const identifier = description?.identifier;
    if (!root || !identifier) { this.contentLog.push(`[Actor] ${path}: no minecraft:entity description`); return undefined; }
    const name = identifier.replace(/^[^:]*:/, '');
    if (/^\d/.test(name)) { this.contentLog.push(`[Actor] ${identifier}: identifier may not begin with a digit - the type is not registered`); return undefined; }
    const components = (root['components'] as Components | undefined) ?? {};
    const groups = (root['component_groups'] as Record<string, Components> | undefined) ?? {};
    for (const dropped of DROPPED_COMPONENTS) {
      if (dropped in components || Object.values(groups).some(g => dropped in g)) {
        this.contentLog.push(`[Actor] ${identifier}: ${dropped} is not a valid component (dropped in format 1.26.30) - the definition failed to parse`);
        return undefined;
      }
    }
    const events: Record<string, EventDef> = {};
    for (const [ev, body] of Object.entries((root['events'] as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      const add = ((body['add'] as { component_groups?: string[] } | undefined)?.component_groups) ?? [];
      const remove = ((body['remove'] as { component_groups?: string[] } | undefined)?.component_groups) ?? [];
      events[ev] = { add, remove, unmodelled: Object.keys(body).filter(k => k !== 'add' && k !== 'remove') };
    }
    const properties: Record<string, PropertyDef> = {};
    let propertiesRefused = false;
    const esc = (k: string): string => k.replace(/~/g, '~0').replace(/\//g, '~1');
    for (const [prop, def] of Object.entries(description?.properties ?? {})) {
      const type = def['type'] as PropertyDef['type'];
      const base = `/minecraft:entity/description/properties/${esc(prop)}`;
      if (type === 'float') {
        // The measured refusal is the DEFAULT's literal (CLAUDE.md); an integer range is not known to be refused, so it is not.
        // # TODO(sim-entity): a device probe of `"range": [0, 90]` on a float property would settle the range too.
        if (isIntegerLiteral(parsed.numberLiterals.get(`${base}/default`))) {
          this.contentLog.push(`[Actor] ${identifier}: property ${prop}: 'default' value does not match the specified type 'float' - the property component is dropped`);
          propertiesRefused = true;
        }
      }
      properties[prop] = {
        type, default: (def['default'] as number | boolean | string) ?? (type === 'bool' ? false : type === 'enum' ? '' : 0),
        ...(Array.isArray(def['range']) ? { range: def['range'] as [number, number] } : {}),
        ...(Array.isArray(def['values']) ? { values: def['values'] as string[] } : {}),
      };
    }
    const families = ((components['minecraft:type_family'] as { family?: string[] } | undefined)?.family) ?? [];
    const d: EntityDefinition = { identifier, components, groups, events, properties: propertiesRefused ? {} : properties, propertiesRefused, families };
    this.types.set(identifier, d);
    return d;
  }
}
