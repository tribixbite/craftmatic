/**
 * The namespace a craftmatic pack was built under (M14, BIZ-22).
 *
 * A dev pack's ids all start `craftmatic:` (entities, blocks, items, dynamic-property keys, event ids) and its
 * type families are `craftmatic_<role>`. X-03's rewriter renames every one to the product namespace
 * `<creator>_<pack>` (`cmt_batcave:ix`, family `cmt_batcave_vehicle`). The adapter therefore never writes the
 * literal: it reads the namespace from the pack (`CraftmaticPack.namespace`) and builds each name here.
 */
import { IX_KEYS } from '../../../engine/bedrock-interactives.js';
import { SIZE_EVENT_PREFIX } from '../../../engine/bedrock-placement-pack.js';

/** The dev namespace the engine emitters write. */
export const DEV_NAMESPACE = 'craftmatic';

/** `<ns>:<name>`: an entity, block or item identifier, a dynamic-property key, a property or an event id. */
export const nsId = (ns: string, name: string): string => `${ns}:${name}`;

/** `<ns>_<role>`: a `minecraft:type_family` (`craftmatic_vehicle`, `cmt_batcave_vehicle`). */
export const packFamily = (ns: string, role: string): string => `${ns}_${role}`;

/** A namespaced id with its namespace taken off (`craftmatic:b_1_shell` -> `b_1_shell`); other ids are returned as given. */
export const bareName = (id: string): string => id.slice(id.indexOf(':') + 1);

/** The interactives' dynamic-property keys under `ns` (the engine's `IX_KEYS`, which are written `craftmatic:`). */
export const ixKeys = (ns: string): typeof IX_KEYS =>
  Object.fromEntries(Object.entries(IX_KEYS).map(([k, v]) => [k, nsId(ns, bareName(v))])) as unknown as typeof IX_KEYS;

/**
 * A dev-namespace name the engine exports as a constant (`HOP_TAGS`, `COASTER_FAMILY`, `COLLIDER_STATES`, ...) as it
 * is written under `ns`: a leading `craftmatic:` or `craftmatic_` takes the pack's namespace, anything else is returned
 * as given. The identity for a dev pack.
 */
export const retarget = (ns: string, devName: string): string =>
  devName.startsWith(`${DEV_NAMESPACE}:`) || devName.startsWith(`${DEV_NAMESPACE}_`) ? `${ns}${devName.slice(DEV_NAMESPACE.length)}` : devName;

/** The namespace an identifier is written under (`cmt_batcave:b_1_shell` -> `cmt_batcave`); the dev name for a bare id. */
export const namespaceOfId = (id: string): string => (id.includes(':') ? id.slice(0, id.indexOf(':')) : DEV_NAMESPACE);

/**
 * The event that sizes an entity to a wand step (`<ns>:size_<pct>`, `SIZE_EVENT_PREFIX` in the engine), written in the
 * namespace of the entity's own identifier: an entity triggers the events its own definition declares.
 */
export const sizeEventOf = (typeId: string, pct: number): string => retarget(namespaceOfId(typeId), `${SIZE_EVENT_PREFIX}${pct}`);

/** The property or dynamic-property key `<ns>:<name>` in the namespace of an entity's own identifier (`entityKey('cmt_x:cart', 'fl_pitch')` = `cmt_x:fl_pitch`). */
export const entityKey = (typeId: string, name: string): string => nsId(namespaceOfId(typeId), name);
